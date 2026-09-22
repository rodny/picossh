// Saved servers, snippets and SSH keys, kept as JSON files under data/. Secrets
// (server passwords, private keys, key passphrases) are encrypted with
// AES-256-GCM using a key derived from APP_SECRET, and never leave this module
// in API output; only the key download route gets a private key back.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { utils: sshUtils } = require('ssh2');
const skKeys = require('./sk-keys');

const AUTH_TYPES = ['password', 'key'];
// Key types the app generates, with the allowed sizes (first one is the default).
const KEY_TYPES = { ed25519: [], rsa: [4096, 3072, 2048], ecdsa: [256, 384, 521] };
const KEY_LABELS = { ed25519: 'Ed25519', rsa: 'RSA', ecdsa: 'ECDSA' };
// Keys whose private half lives in a phone's secure enclave (see sk-keys.js):
// nothing here is secret, and there is no private key to store or download.
const ENCLAVE = 'enclave';

const fingerprint = (key) => 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');

// SHA256 fingerprint of a one-line OpenSSH public key.
const fingerprintOf = (publicLine) => fingerprint(sshUtils.parseKey(publicLine).getPublicSSH());

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw new Error(`could not parse ${file}: ${err.message}`);
  }
}

// APP_SECRET wins. Without it, a random key is generated once into
// data/secret.key; losing that file makes stored secrets unreadable.
function loadSecret(dataDir, envSecret) {
  if (envSecret) return envSecret;
  const file = path.join(dataDir, 'secret.key');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const secret = crypto.randomBytes(32).toString('base64');
  fs.writeFileSync(file, secret + '\n', { mode: 0o600 });
  console.log(`APP_SECRET is not set: generated ${file}. Back it up, or set APP_SECRET in the environment; stored server secrets depend on it.`);
  return secret;
}

function createCipher(secret) {
  const keys = new Map(); // scrypt is deliberately slow, so cache per salt
  const keyFor = (salt) => {
    const id = salt.toString('base64');
    if (!keys.has(id)) keys.set(id, crypto.scryptSync(secret, salt, 32));
    return keys.get(id);
  };

  return {
    encrypt(plain) {
      const salt = crypto.randomBytes(16);
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', keyFor(salt), iv);
      const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
      return ['v1', salt, iv, cipher.getAuthTag(), ct].map((p) => (Buffer.isBuffer(p) ? p.toString('base64') : p)).join(':');
    },
    decrypt(value) {
      if (!value) return undefined;
      const [version, ...parts] = value.split(':');
      if (version !== 'v1' || parts.length !== 4) throw new HttpError(500, 'Stored secret is damaged or in a format this version cannot read.');
      const [salt, iv, tag, ct] = parts.map((p) => Buffer.from(p, 'base64'));
      // A tag or IV of the wrong length (a damaged file) fails here, before
      // decrypting: the same answer as a wrong key.
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', keyFor(salt), iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
      } catch {
        throw new HttpError(500, 'Stored secret could not be decrypted. Was APP_SECRET changed?');
      }
    },
  };
}

const newId = () => crypto.randomBytes(9).toString('base64url');
const str = (v, max = 1000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const CONTROL = /[\x00-\x1f\x7f]/;

// A port as a number or a string of digits; anything else is NaN.
function parsePort(value) {
  if (value === undefined || value === '') return 22;
  if (typeof value === 'number') return value;
  return typeof value === 'string' && /^\s*\d+\s*$/.test(value) ? Number(value) : NaN;
}

// A key's name is also the comment on its one-line public key.
function keyName(value) {
  const name = str(value, 100);
  if (CONTROL.test(name)) throw new HttpError(400, 'Name must not contain line breaks or control characters');
  return name;
}

function createStore({ dataDir, secret }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const serversFile = path.join(dataDir, 'servers.json');
  const snippetsFile = path.join(dataDir, 'snippets.json');
  const servers = readJson(serversFile, { servers: [] });
  const keysFile = path.join(dataDir, 'keys.json');
  const snippets = readJson(snippetsFile, { snippets: [] });
  const keys = readJson(keysFile, { keys: [] });
  const cipher = createCipher(secret);

  // Each change builds a new list, saves it, and only then makes it current:
  // a failed save leaves the running state as it is on disk.
  const commit = (file, data, field) => (list) => {
    writeJsonAtomic(file, { ...data, [field]: list });
    data[field] = list;
  };
  const saveServers = commit(serversFile, servers, 'servers');
  const saveSnippets = commit(snippetsFile, snippets, 'snippets');
  const saveKeys = commit(keysFile, keys, 'keys');
  const replace = (list, old, record) => list.map((x) => (x === old ? record : x));

  const publicServer = ({ secret: s, passphrase, ...rest }) => ({ ...rest, hasSecret: !!s });
  const publicKey = ({ private: p, passphrase, credentialId, point, ...rest }) => ({ ...rest, hasPassphrase: !!passphrase });

  function findKey(id) {
    const key = keys.keys.find((k) => k.id === id);
    if (!key) throw new HttpError(404, 'Key not found');
    return key;
  }

  function findServer(id) {
    const server = servers.servers.find((s) => s.id === id);
    if (!server) throw new HttpError(404, 'Server not found');
    return server;
  }

  // Applies a create/update body onto a record. A saved password is only
  // replaced when a non-empty value is sent, so edits keep what was stored.
  function applyServer(record, body) {
    const name = str(body.name, 100);
    const host = str(body.host, 255);
    const user = str(body.user, 100);
    const port = parsePort(body.port);
    const auth = body.auth || 'password';

    if (!host) throw new HttpError(400, 'Host is required');
    if (/\s/.test(host) || CONTROL.test(host)) throw new HttpError(400, 'Host must not contain spaces or control characters');
    if (!user) throw new HttpError(400, 'User is required');
    if (CONTROL.test(user)) throw new HttpError(400, 'User must not contain control characters');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, 'Port must be 1-65535');
    if (!AUTH_TYPES.includes(auth)) throw new HttpError(400, 'Unknown auth type');

    if (auth === 'key') {
      // Key servers point at a managed key; they never hold a secret themselves.
      const keyId = str(body.keyId, 50);
      if (!keyId) throw new HttpError(400, 'Choose an SSH key');
      if (!keys.keys.some((k) => k.id === keyId)) throw new HttpError(400, 'Unknown SSH key');
      record.keyId = keyId;
      delete record.secret;
      delete record.passphrase;
    } else {
      const secretIn = typeof body.secret === 'string' && body.secret !== '' ? body.secret : null;
      if (record.auth === 'key') delete record.secret; // a key server switching to password
      delete record.keyId;
      delete record.passphrase;
      if (secretIn) record.secret = cipher.encrypt(secretIn);
      else if (body.clearSecret) delete record.secret;
    }

    Object.assign(record, { name: name || host, host, port, user, auth });
    if (body.forgetHostKey) delete record.hostKey;
    return record;
  }

  function applySnippet(record, body) {
    const name = str(body.name, 100);
    const command = typeof body.command === 'string' ? body.command.replace(/\r\n?/g, '\n').slice(0, 10000) : '';
    if (!command.trim()) throw new HttpError(400, 'Command is required');
    // Named after its first line with something on it: a command pasted with
    // a blank line in front of it would otherwise be saved with no name.
    const firstLine = command.split('\n').find((line) => line.trim()) || command;
    return Object.assign(record, {
      name: name || firstLine.trim().slice(0, 40),
      command,
      sendEnter: body.sendEnter !== false,
    });
  }

  return {
    listServers: () => servers.servers.map(publicServer),
    getServer: (id) => findServer(id),

    createServer(body) {
      const record = applyServer({ id: newId(), favorites: [] }, body || {});
      record.createdAt = new Date().toISOString();
      saveServers([...servers.servers, record]);
      return publicServer(record);
    },
    updateServer(id, body) {
      const current = findServer(id);
      const record = applyServer({ ...current }, body || {});
      saveServers(replace(servers.servers, current, record));
      return publicServer(record);
    },
    // Folders pinned in the Files tab's Go to sheet, per saved server.
    setServerFavorites(id, list) {
      const current = findServer(id);
      if (!Array.isArray(list)) throw new HttpError(400, 'Favorites must be a list of paths');
      if (list.length > 50) throw new HttpError(400, 'At most 50 favorites');
      const favorites = [];
      for (const item of list) {
        const p = typeof item === 'string' ? item.trim() : '';
        if (!p.startsWith('/') || p.length > 4096 || CONTROL.test(p)) throw new HttpError(400, 'Each favorite must be an absolute path');
        if (!favorites.includes(p)) favorites.push(p);
      }
      const record = { ...current, favorites };
      saveServers(replace(servers.servers, current, record));
      return publicServer(record);
    },
    deleteServer(id) {
      const server = findServer(id);
      saveServers(servers.servers.filter((s) => s !== server));
    },
    // Trust on first use: the first key saved stays. Answers the key trusted
    // now (null for a server deleted meanwhile), which another connection
    // may have saved since this one checked its own.
    setHostKey(id, fingerprint) {
      const server = servers.servers.find((s) => s.id === id);
      if (!server) return null;
      if (server.hostKey) return server.hostKey;
      saveServers(replace(servers.servers, server, { ...server, hostKey: fingerprint }));
      return fingerprint;
    },
    // Plain credentials for connecting; only sessions.js calls this.
    credentials(server) {
      if (server.auth !== 'key') return { password: cipher.decrypt(server.secret) };
      const key = keys.keys.find((k) => k.id === server.keyId);
      if (!key) throw new HttpError(400, 'The SSH key for this server was deleted. Edit the server and choose another key.');
      if (key.type === ENCLAVE) return { enclaveKey: key };
      return { privateKey: cipher.decrypt(key.private), passphrase: cipher.decrypt(key.passphrase) };
    },

    listKeys: () => keys.keys.map(publicKey),
    async createKey(body = {}) {
      const type = body.type === undefined || body.type === '' ? 'ed25519' : body.type;
      if (!Object.hasOwn(KEY_TYPES, type)) throw new HttpError(400, 'Unknown key type');
      const sizes = KEY_TYPES[type];
      const bits = sizes.length ? (body.bits === undefined || body.bits === '' ? sizes[0] : Number(body.bits)) : undefined;
      if (sizes.length && !sizes.includes(bits)) throw new HttpError(400, `${KEY_LABELS[type]} keys can be ${sizes.join(', ')} bits`);
      if (typeof body.name === 'string' && body.name.trim().length > 100) throw new HttpError(400, 'Name must be at most 100 characters');
      const name = keyName(body.name) || `${KEY_LABELS[type]} key`;
      const passphrase = typeof body.passphrase === 'string' ? body.passphrase : '';
      if (passphrase.length > 1000) throw new HttpError(400, 'Passphrase must be at most 1000 characters');

      // The async variant keeps RSA 4096 generation off the event loop.
      const options = { comment: name, ...(bits && { bits }), ...(passphrase && { passphrase, cipher: 'aes256-ctr' }) };
      const generate = () => new Promise((resolve, reject) => {
        sshUtils.generateKeyPair(type, options, (err, result) => (err ? reject(err) : resolve(result)));
      });
      // ssh2 now and then writes an ed25519 key it cannot read back (about 1
      // in 250); such a key could never be used to connect, so make another.
      let pair = await generate();
      for (let tries = 1; sshUtils.parseKey(pair.private, passphrase || undefined) instanceof Error; tries++) {
        if (tries === 5) throw new Error('Could not create a usable key');
        pair = await generate();
      }
      const record = {
        id: newId(),
        name,
        type,
        ...(bits && { bits }),
        public: pair.public.trim(),
        fingerprint: fingerprintOf(pair.public),
        private: cipher.encrypt(pair.private),
        ...(passphrase && { passphrase: cipher.encrypt(passphrase) }),
        createdAt: new Date().toISOString(),
      };
      saveKeys([...keys.keys, record]);
      return publicKey(record);
    },
    // A key made from a browser credential: the public point and the
    // credential id the browser needs to find it again, and nothing else.
    addEnclaveKey({ name, credentialId, point, rpID, origin, transports }) {
      const record = {
        id: newId(),
        name: keyName(name) || 'Face ID key',
        type: ENCLAVE,
        credentialId,
        point: point.toString('base64url'),
        // The rp id is also the key's "application": the server hashes it when
        // it checks a signature, so the key only works on this hostname.
        rpID,
        origin,
        transports: transports || [],
        public: skKeys.publicLine({ point, application: rpID, name: keyName(name) || 'Face ID key' }),
        fingerprint: fingerprint(skKeys.publicKeyBlob({ point, application: rpID })),
        createdAt: new Date().toISOString(),
      };
      saveKeys([...keys.keys, record]);
      return publicKey(record);
    },
    // Enclave keys are used by id; this is what the browser signs with.
    enclaveKey(id) {
      const key = findKey(id);
      if (key.type !== ENCLAVE) throw new HttpError(400, 'This is not a Face ID key');
      return key;
    },
    renameKey(id, body = {}) {
      const current = findKey(id);
      const name = keyName(body.name);
      if (!name) throw new HttpError(400, 'Name is required');
      const key = { ...current, name, public: current.public.split(' ').slice(0, 2).concat(name).join(' ') }; // the comment is the name
      saveKeys(replace(keys.keys, current, key));
      return publicKey(key);
    },
    deleteKey(id) {
      const key = findKey(id);
      const users = servers.servers.filter((s) => s.auth === 'key' && s.keyId === id);
      if (users.length) {
        throw new HttpError(409, `This key is used by ${users.map((s) => s.name).join(', ')}. Choose another key for those servers first.`);
      }
      saveKeys(keys.keys.filter((k) => k !== key));
    },
    // A key as a download: the public line, or the OpenSSH private key file.
    keyFile(id, part) {
      const key = findKey(id);
      if (part !== 'public' && part !== 'private') throw new HttpError(400, 'part must be public or private');
      if (part === 'private' && key.type === ENCLAVE) {
        throw new HttpError(400, 'A Face ID key has no private key file: it never leaves the device that made it.');
      }
      const base = key.name.replace(/[^\w.-]+/g, '_') || `id_${key.type}`;
      return part === 'public'
        ? { name: `${base}.pub`, content: key.public + '\n' }
        : { name: base, content: cipher.decrypt(key.private) };
    },

    listSnippets: () => snippets.snippets,
    createSnippet(body) {
      const record = applySnippet({ id: newId() }, body || {});
      record.createdAt = new Date().toISOString();
      saveSnippets([...snippets.snippets, record]);
      return record;
    },
    updateSnippet(id, body) {
      const current = snippets.snippets.find((s) => s.id === id);
      if (!current) throw new HttpError(404, 'Snippet not found');
      const record = applySnippet({ ...current }, body || {});
      saveSnippets(replace(snippets.snippets, current, record));
      return record;
    },
    deleteSnippet(id) {
      if (!snippets.snippets.some((s) => s.id === id)) throw new HttpError(404, 'Snippet not found');
      saveSnippets(snippets.snippets.filter((s) => s.id !== id));
    },
    // The listed snippets first, in that order; anything the app did not name
    // (a snippet added from another device meanwhile) keeps its place after them.
    reorderSnippets(body) {
      const ids = (body || {}).ids;
      if (!Array.isArray(ids)) throw new HttpError(400, 'ids must be an array of snippet ids');
      const seen = new Set();
      const named = [];
      for (const id of ids) {
        if (typeof id !== 'string' || seen.has(id)) continue;
        const snippet = snippets.snippets.find((s) => s.id === id);
        if (!snippet) throw new HttpError(404, 'Snippet not found');
        seen.add(id);
        named.push(snippet);
      }
      saveSnippets([...named, ...snippets.snippets.filter((s) => !seen.has(s.id))]);
      return snippets.snippets;
    },
  };
}

module.exports = { createStore, loadSecret, HttpError, writeJsonAtomic, readJson, fingerprint, ENCLAVE };
