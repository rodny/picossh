// picossh: browser SSH + SFTP client for phones. See README.md.
const fs = require('fs');
const http = require('http');
const path = require('path');
const zlib = require('zlib');
const { WebSocketServer } = require('ws');
const { createStore, loadSecret, HttpError } = require('./lib/store');
const { createAuth } = require('./lib/auth');
const { createPasskeys } = require('./lib/passkeys');
const { createEnrolment } = require('./lib/sk-enrol');
const { createSessions } = require('./lib/sessions');
const { createMonitor } = require('./lib/monitor');
const { createSettings, parseBackgroundMinutes, FOREVER } = require('./lib/settings');
const { serveStatic, acceptsGzip } = require('./lib/static');
const shell = require('./lib/shell');
const sftpOps = require('./lib/sftp');

const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const MAX_JSON_BYTES = 256 * 1024;
// A body over the limit is read to the end (and dropped) so the 413 reaches
// the browser; past this much the connection is cut instead.
const MAX_DISCARD_BYTES = 64 * 1024 * 1024;
// How long a request may move no bytes (transferIdleMinutes), how often
// terminal sockets are pinged (heartbeatSeconds), when an unused connection is
// a zombie (zombieMinutes), the sign-in lockout and the output each shell
// keeps (replayKB) are settings the admin page changes: lib/settings.js.
// How often the admin page's activity charts get a point. Tests shorten it.
const SAMPLE_MS = Number(process.env.MONITOR_SAMPLE_MS) || 10000;
// JSON answers bigger than this are gzipped for clients that take it: a
// folder listing or a file for the editor shrinks to a fraction on a slow link.
const COMPRESS_MIN_BYTES = 1024;

fs.mkdirSync(DATA_DIR, { recursive: true });
const secret = loadSecret(DATA_DIR, process.env.APP_SECRET);
const store = createStore({ dataDir: DATA_DIR, secret });
const settings = createSettings({ dataDir: DATA_DIR });
const auth = createAuth({
  password: APP_PASSWORD,
  secret,
  maxFailures: () => settings.limit('loginAttempts'),
  blockMs: () => settings.limit('loginWaitSeconds'),
});
const passkeys = createPasskeys({ dataDir: DATA_DIR });
// Face ID SSH keys: enrolling one is a WebAuthn registration (lib/sk-keys.js).
const enclave = createEnrolment({ store });

// How long the server keeps a shell with no app connected, and then its SSH
// connection: this connection's own setting (Connection settings, which last
// as long as the connection and are never saved), else the app's default.
// { minutes, ms }, ms null for Forever. Read when a shell loses its page, so
// a change applies from the next disconnection on (lib/sessions.js).
// Tests shorten a minute with BACKGROUND_MINUTE_MS.
const MINUTE_MS = Number(process.env.BACKGROUND_MINUTE_MS) || 60 * 1000;
function retention(session) {
  const minutes = session.backgroundMinutes ?? settings.backgroundMinutes();
  return { minutes, ms: minutes === FOREVER ? null : minutes * MINUTE_MS };
}

const sessions = createSessions({
  store,
  dnsServers: settings.dnsServers,
  retention,
  onClose: (session) => monitor.sessionClosed(session),
});
const monitor = createMonitor({ sessions, sampleMs: SAMPLE_MS, zombieMs: () => settings.limit('zombieMinutes') });

const setupPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>picossh setup</title>
<style>body{font:17px system-ui;background:#131313;color:#eaeaea;max-width:640px;margin:30px auto;padding:24px;line-height:1.6}code{color:#ffffff}pre{background:#1d1d1d;padding:14px;border-radius:10px;overflow:auto}</style></head>
<body><h1>picossh needs a password</h1><p>Set the <code>APP_PASSWORD</code> (and <code>APP_SECRET</code>) environment variables and restart the server.</p>
<pre>APP_PASSWORD='a long password' APP_SECRET='a long random string' npm start</pre></body></html>`;

function sendJson(res, status, body) {
  if (res.headersSent) return res.destroy();
  const json = Buffer.from(JSON.stringify(body));
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Accept-Encoding' };
  const send = (data, encoding) => {
    if (res.headersSent || res.destroyed) return;
    res.writeHead(status, { ...headers, ...(encoding && { 'Content-Encoding': encoding }), 'Content-Length': data.length });
    res.end(data);
  };
  if (json.length < COMPRESS_MIN_BYTES || !acceptsGzip(res.req)) return send(json);
  zlib.gzip(json, (err, gz) => (err ? send(json) : send(gz, 'gzip')));
}

// The editor gzips what it saves; anything that inflates past the limit is refused.
function decodeBody(buf, encoding, limit) {
  if (!encoding || encoding === 'identity') return Promise.resolve(buf);
  if (encoding !== 'gzip') return Promise.reject(new HttpError(415, `Unsupported Content-Encoding: ${encoding}`));
  return new Promise((resolve, reject) => {
    zlib.gunzip(buf, { maxOutputLength: limit }, (err, out) => {
      if (!err) return resolve(out);
      reject(err.code === 'ERR_BUFFER_TOO_LARGE' ? new HttpError(413, 'Request body too large') : new HttpError(400, 'Invalid compressed body'));
    });
  });
}

function readJson(req, limit = MAX_JSON_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_DISCARD_BYTES) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
      } else if (size <= limit) {
        chunks.push(chunk);
      }
    });
    req.on('end', async () => {
      if (size > limit) return reject(new HttpError(413, 'Request body too large'));
      if (!size) return resolve({});
      let text;
      try {
        text = (await decodeBody(Buffer.concat(chunks), (req.headers['content-encoding'] || '').trim().toLowerCase(), limit)).toString('utf8');
      } catch (err) {
        return reject(err);
      }
      try {
        const body = JSON.parse(text);
        resolve(body && typeof body === 'object' ? body : {});
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// "15 min", "1 hour", "24 hours", "forever".
const backgroundText = (m) => (m === FOREVER ? 'forever' : m >= 60 ? `${m / 60} hour${m === 60 ? '' : 's'}` : `${m} min`);

// A connect attempt either produced a connection or is waiting for a face.
function connected(req, result) {
  if (result.signRequest) return { signRequest: result.signRequest };
  monitor.sessionOpened(result.session, req);
  return { session: sessions.info(result.session) };
}

// A connection of the device making the request. Another device's is not
// found, exactly as if it had closed.
const gone = () => new HttpError(404, 'Session not found or already closed', { code: 'gone' });
function requireSession(id, req) {
  const session = sessions.owned(id, auth.deviceId(req));
  if (!session) throw gone();
  return session;
}

// Admin: any connection, whichever device owns it.
function anySession(id) {
  const session = sessions.get(id);
  if (!session) throw gone();
  return session;
}

async function loginWith(req, res, how, verify) {
  const wait = auth.blockedFor(req);
  if (wait) throw new HttpError(429, `Too many attempts. Try again in ${wait}s.`, { retryAfter: wait });
  let ok = false;
  try {
    ok = await verify();
  } finally {
    if (ok) auth.recordSuccess(req);
    else auth.recordFailure(req);
    monitor.signIn(req, ok, how);
  }
  if (!ok) throw new HttpError(401, 'Wrong password');
  auth.login(req, res);
  return { ok: true };
}

// Routes reachable without a session cookie.
const publicRoutes = [
  ['POST', /^\/login$/, async (req, res) => {
    const body = await readJson(req);
    return loginWith(req, res, 'password', async () => typeof body.password === 'string' && auth.checkPassword(body.password));
  }],
  // Signing out closes every SSH connection this device owns, and the ones
  // it is still opening, before the cookie goes: nothing this device started
  // is left running, whatever the page still knew about. The device cookie
  // stays, so this is still the same device afterwards.
  ['POST', /^\/logout$/, async (req, res) => {
    const closed = sessions.closeOwned(auth.deviceId(req), 'signed out');
    if (closed) monitor.note(req, 'kill', `Signed out: closed ${closed} SSH connection${closed === 1 ? '' : 's'}`);
    auth.logout(req, res);
    return { ok: true, closed };
  }],
  ['GET', /^\/api\/passkeys$/, async (req) =>
    auth.isAuthenticated(req) ? { count: passkeys.count(), credentials: passkeys.list() } : { count: passkeys.count() }],
  ['POST', /^\/api\/passkeys\/login\/options$/, async (req) => {
    const wait = auth.blockedFor(req);
    if (wait) throw new HttpError(429, `Too many attempts. Try again in ${wait}s.`, { retryAfter: wait });
    return passkeys.authenticationOptions(req);
  }],
  ['POST', /^\/api\/passkeys\/login\/verify$/, async (req, res) => {
    const body = await readJson(req);
    return loginWith(req, res, 'Face ID', () => passkeys.verifyAuthentication(req, body));
  }],
];

const routes = [
  ['GET', /^\/api\/servers$/, async () => ({ servers: store.listServers() })],
  ['POST', /^\/api\/servers$/, async (req) => ({ server: store.createServer(await readJson(req)) })],
  ['PUT', /^\/api\/servers\/([\w-]+)$/, async (req, res, [id]) => ({ server: store.updateServer(id, await readJson(req)) })],
  ['PUT', /^\/api\/servers\/([\w-]+)\/favorites$/, async (req, res, [id]) => {
    const body = await readJson(req);
    return { server: store.setServerFavorites(id, body && body.favorites) };
  }],
  // This device's connections to it close with it; other devices' stay, and
  // still know where they go (lib/sessions.js keeps that per connection).
  ['DELETE', /^\/api\/servers\/([\w-]+)$/, async (req, res, [id]) => {
    store.deleteServer(id);
    for (const s of sessions.ownedBy(auth.deviceId(req))) if (s.serverId === id) sessions.destroy(s, 'server deleted');
    return { ok: true };
  }],

  ['GET', /^\/api\/snippets$/, async () => ({ snippets: store.listSnippets() })],
  ['POST', /^\/api\/snippets$/, async (req) => ({ snippet: store.createSnippet(await readJson(req)) })],
  // Before the /:id routes, which would take "order" for an id.
  ['POST', /^\/api\/snippets\/order$/, async (req) => ({ snippets: store.reorderSnippets(await readJson(req)) })],
  ['PUT', /^\/api\/snippets\/([\w-]+)$/, async (req, res, [id]) => ({ snippet: store.updateSnippet(id, await readJson(req)) })],
  ['DELETE', /^\/api\/snippets\/([\w-]+)$/, async (req, res, [id]) => {
    store.deleteSnippet(id);
    return { ok: true };
  }],

  ['GET', /^\/api\/keys$/, async () => ({ keys: store.listKeys() })],
  ['POST', /^\/api\/keys$/, async (req) => ({ key: await store.createKey(await readJson(req)) })],
  ['PUT', /^\/api\/keys\/([\w-]+)$/, async (req, res, [id]) => ({ key: store.renameKey(id, await readJson(req)) })],
  ['DELETE', /^\/api\/keys\/([\w-]+)$/, async (req, res, [id]) => {
    store.deleteKey(id);
    return { ok: true };
  }],
  // A key that lives in this device's secure enclave: made in the browser,
  // stored here as a public key only.
  ['POST', /^\/api\/keys\/enclave\/options$/, async (req) => enclave.options(req)],
  ['POST', /^\/api\/keys\/enclave$/, async (req) => ({ key: await enclave.verify(req, await readJson(req)) })],
  ['GET', /^\/api\/keys\/([\w-]+)\/file$/, async (req, res, [id], url) => {
    const part = url.searchParams.get('part');
    const file = store.keyFile(id, part);
    res.writeHead(200, {
      'Content-Type': part === 'public' ? 'text/plain; charset=utf-8' : 'application/octet-stream',
      'Content-Length': Buffer.byteLength(file.content),
      'Content-Disposition': sftpOps.disposition(file.name),
      'Cache-Control': 'no-store',
    });
    res.end(file.content);
  }],

  ['GET', /^\/api\/settings$/, async () => ({ settings: settings.get() })],
  ['PUT', /^\/api\/settings$/, async (req) => ({ settings: settings.update(await readJson(req)) })],

  ['POST', /^\/api\/passkeys\/register\/options$/, async (req) => passkeys.registrationOptions(req)],
  ['POST', /^\/api\/passkeys\/register\/verify$/, async (req) => ({ credential: await passkeys.verifyRegistration(req, await readJson(req)) })],
  ['DELETE', /^\/api\/passkeys\/([\w-]+)$/, async (req, res, [id]) => {
    passkeys.remove(id);
    return { ok: true };
  }],

  // The connections this device has open, for the Connections tab. Also
  // where a signed-in browser without a device cookie gets one: the app asks
  // this first, before anything that needs the device.
  ['GET', /^\/api\/sessions$/, async (req, res) => {
    const owner = auth.device(req, res);
    return { now: Date.now(), sessions: sessions.ownedBy(owner).map((s) => sessions.info(s)) };
  }],
  // A new connection, owned from the start (before the handshake) by the
  // device asking for it.
  ['POST', /^\/api\/sessions$/, async (req, res) => {
    const owner = auth.device(req, res);
    const body = await readJson(req);
    return connected(req, await sessions.create(String(body.serverId || ''), body, owner));
  }],
  // A Face ID key signs halfway through the handshake: the browser sends the
  // assertion here, and gets back the connection that was waiting for it.
  ['POST', /^\/api\/sessions\/sign$/, async (req) => {
    const body = await readJson(req);
    return connected(req, await sessions.signature(body.id, body.response, auth.deviceId(req)));
  }],
  ['GET', /^\/api\/sessions\/([\w-]+)$/, async (req, res, [id]) => ({ now: Date.now(), session: sessions.info(requireSession(id, req)) })],
  // Connection settings: how long this one connection is kept in the
  // background, or null for the app's default. It lives with the connection
  // and is saved nowhere, so other devices and later connections are untouched.
  // A shell already in the background keeps the time it got.
  ['PUT', /^\/api\/sessions\/([\w-]+)\/background$/, async (req, res, [id]) => {
    const session = requireSession(id, req);
    const { backgroundMinutes } = await readJson(req);
    session.backgroundMinutes = backgroundMinutes === null ? null : parseBackgroundMinutes(backgroundMinutes);
    return { session: sessions.info(session) };
  }],
  // Its name, from Connection settings: kept like the background time, with
  // the connection only. An empty name goes back to the default.
  ['PUT', /^\/api\/sessions\/([\w-]+)\/name$/, async (req, res, [id]) => {
    const session = requireSession(id, req);
    sessions.rename(session, (await readJson(req)).name);
    return { session: sessions.info(session) };
  }],
  // Attaching to a shell that exists, from the Connections tab or a page that
  // lost it to another: gives a new attachment lease for its socket, which
  // makes any other lease (and the socket holding it) useless. A shell that
  // another socket has asks first: {"takeover": true} with the revision the
  // page saw confirms it, and a different revision means it changed hands
  // since, so the page looks again rather than take something else over.
  ['POST', /^\/api\/sessions\/([\w-]+)\/attach$/, async (req, res, [id]) => {
    const session = requireSession(id, req);
    const body = await readJson(req);
    const shell = session.shells.get(String(body.shellId || ''));
    if (!shell) throw new HttpError(404, 'This shell has ended.', { code: 'shell-gone' });
    const takeover = body.takeover === true;
    if (shell.ws && !takeover) {
      throw new HttpError(409, 'This shell is open in another window or on another device.', { code: 'attached', revision: shell.revision });
    }
    if (takeover && body.revision !== shell.revision) {
      throw new HttpError(409, 'This shell changed hands again since you looked.', { code: 'conflict', revision: shell.revision });
    }
    const lease = shell.takeOver();
    return { shellId: shell.id, lease, revision: shell.revision, session: sessions.info(session) };
  }],
  ['DELETE', /^\/api\/sessions\/([\w-]+)$/, async (req, res, [id]) => {
    const session = sessions.owned(id, auth.deviceId(req));
    if (session) sessions.destroy(session, 'closed by user');
    return { ok: true };
  }],
  [['GET', 'HEAD', 'POST'], /^\/api\/sessions\/([\w-]+)\/sftp$/, async (req, res, [id], url) => {
    const session = requireSession(id, req);
    sessions.begin(session);
    try {
      const sftp = await sessions.sftp(session);
      return await sftpOps.handle({ req, res, url, sftp, readBody: (limit) => readJson(req, limit) });
    } finally {
      sessions.finish(session);
    }
  }],

  // The admin page (public/admin.html): same sign-in as the app.
  ['GET', /^\/api\/admin\/overview$/, async () => monitor.overview()],
  ['GET', /^\/api\/admin\/history$/, async (req, res, params, url) => monitor.history(Number(url.searchParams.get('range')) * 1000)],
  ['GET', /^\/api\/admin\/settings$/, async () => ({ limits: settings.limits() })],
  ['PUT', /^\/api\/admin\/settings$/, async (req) => {
    const before = settings.limits();
    const body = await readJson(req);
    const allowed = Object.fromEntries(Object.keys(before).filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));
    settings.update(allowed);
    const after = settings.limits();
    const changed = Object.keys(after).filter((k) => after[k].value !== before[k].value);
    const described = (k) => (k === 'backgroundMinutes' ? backgroundText(after[k].value) : `${after[k].value}${after[k].unit ? ` ${after[k].unit}` : ''}`);
    if (changed.length) monitor.note(req, 'settings', `Changed ${changed.map((k) => `${after[k].label} to ${described(k)}`).join(', ')} from the admin page`);
    return { limits: after };
  }],
  ['POST', /^\/api\/admin\/sessions\/([\w-]+)\/close$/, async (req, res, [id]) => {
    const session = anySession(id);
    monitor.note(req, 'kill', `Closed ${session.user}@${session.host}:${session.port} (${session.name}) from the admin page`);
    sessions.destroy(session, 'closed from the admin page');
    return { closed: 1 };
  }],
  // {"which": "zombies"} closes the connections nothing is using, "all" every one.
  ['POST', /^\/api\/admin\/sessions\/close$/, async (req) => {
    const { which } = await readJson(req);
    if (which !== 'zombies' && which !== 'all') throw new HttpError(400, 'which must be "zombies" or "all"');
    const doomed = sessions.all().filter((s) => which === 'all' || monitor.isZombie(s));
    if (doomed.length) monitor.note(req, 'kill', `Closed ${doomed.length} ${which === 'all' ? '' : 'unused '}SSH connection${doomed.length === 1 ? '' : 's'} from the admin page`);
    for (const s of doomed) sessions.destroy(s, which === 'all' ? 'closed from the admin page' : 'unused, closed from the admin page');
    return { closed: doomed.length };
  }],
];

function match(table, method, pathname) {
  for (const [methods, pattern, handler] of table) {
    if (!(Array.isArray(methods) ? methods : [methods]).includes(method)) continue;
    const m = pathname.match(pattern);
    if (m) return { handler, params: m.slice(1) };
  }
  return null;
}

async function handleApi(req, res, url) {
  const method = req.method;
  let route = match(publicRoutes, method, url.pathname);
  const isPublic = !!route;
  if (!route) route = match(routes, method, url.pathname);
  if (!route) return url.pathname.startsWith('/api/') ? sendJson(res, 404, { error: 'Not found' }) : false;

  // SameSite=Lax already blocks cross-site POSTs; the custom header also
  // rules out plain form submissions and anything a CORS preflight would stop.
  if (!['GET', 'HEAD'].includes(method) && req.headers['x-requested-with'] !== 'fetch') {
    return sendJson(res, 403, { error: 'Missing X-Requested-With header' });
  }
  if (!isPublic && !auth.isAuthenticated(req)) return sendJson(res, 401, { error: 'Not signed in' });

  try {
    const result = await route.handler(req, res, route.params, url);
    if (result !== undefined) sendJson(res, 200, result);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error(`${method} ${url.pathname} failed:`, err.message);
    if (res.headersSent) return res.destroy();
    const body = { error: err.message || 'Internal error' };
    for (const key of ['code', 'retryAfter', 'size', 'offset', 'revision']) if (err[key] !== undefined) body[key] = err[key];
    sendJson(res, status, body);
  }
  return true;
}

// The request target as a URL, or null when it is not one (such as "//[").
function parseUrl(req) {
  try {
    return new URL(req.url, 'http://localhost');
  } catch {
    return null;
  }
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error(`${req.method} ${req.url} failed:`, err);
    if (res.headersSent) res.destroy();
    else sendJson(res, 500, { error: 'Internal error' });
  });
});
// A slow upload may take as long as it needs; only silence ends a request: a
// phone that went silent mid-transfer would otherwise hold the remote file
// (and keep its session from closing) forever. A new value applies to
// connections made after it.
server.requestTimeout = 0;
server.timeout = settings.limit('transferIdleMinutes');

async function handleRequest(req, res) {
  const url = parseUrl(req);
  if (!url) return sendJson(res, 400, { error: 'Bad request' });
  console.log(`${new Date().toISOString()} ${req.method} ${url.pathname}`);

  if (url.pathname === '/health') return sendJson(res, 200, { status: 'ok' });

  if (!APP_PASSWORD) {
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(setupPage);
  }
  monitor.request(req, auth.isAuthenticated(req));

  if (url.pathname === '/login' || url.pathname === '/logout' || url.pathname.startsWith('/api/')) {
    if ((await handleApi(req, res, url)) !== false) return;
  }
  if (serveStatic(req, res, url.pathname)) return;

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found\n');
}

// ------------------------------------------------------------------ websocket

// Terminal output is repetitive text: compressed, it takes a fraction of the link.
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 1024 * 1024,
  perMessageDeflate: { threshold: 256, zlibDeflateOptions: { level: 6 } },
});

function rejectUpgrade(socket, status, text) {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => {}); // a client gone mid-handshake
  socket.setTimeout(0); // the heartbeat below looks after terminal sockets
  const url = parseUrl(req);
  if (!url) return rejectUpgrade(socket, 400, 'Bad Request');
  console.log(`${new Date().toISOString()} WS ${url.pathname}`);
  const m = url.pathname.match(/^\/ws\/([\w-]+)$/);
  if (!m || !APP_PASSWORD) return rejectUpgrade(socket, 404, 'Not Found');

  let originHost = null;
  try {
    originHost = new URL(req.headers.origin).host;
  } catch {}
  if (!originHost || originHost !== req.headers.host) return rejectUpgrade(socket, 403, 'Forbidden');
  if (!auth.isAuthenticated(req)) return rejectUpgrade(socket, 401, 'Unauthorized');

  // Only this device's connection; another's is not there.
  const session = sessions.owned(m[1], auth.deviceId(req));
  if (!session) return rejectUpgrade(socket, 404, 'Not Found');
  // The shell, its attachment lease, and whether to create it (lib/shell.js).
  const shellId = url.searchParams.get('shell');
  const lease = url.searchParams.get('lease');
  if (!/^[\w-]{8,64}$/.test(shellId || '') || !shell.LEASE.test(lease || '')) return rejectUpgrade(socket, 400, 'Bad Request');
  const create = url.searchParams.get('create') === '1';

  wss.handleUpgrade(req, socket, head, (ws) => {
    monitor.socket(ws, req);
    ws.isAlive = true;
    // Anything from the page proves it is there. Its answer to a ping can be
    // held up behind output queued for a slow link; its own frames are not.
    const alive = () => { ws.isAlive = true; };
    ws.on('pong', alive);
    ws.on('message', alive);
    // A frame over maxPayload or text that is not UTF-8: ws closes the socket
    // (the shell waits for the page to come back), but without a listener the
    // error would end the whole process.
    ws.on('error', (err) => console.log(`ws ${url.pathname}: ${err.message}`));
    shell.attach({
      ws, session, sessions, shellId, lease, create, cols: url.searchParams.get('cols'), rows: url.searchParams.get('rows'),
      have: url.searchParams.get('have'),
      retention: () => retention(session),
      bufferBytes: () => settings.limit('replayKB'),
    });
  });
});

// Phones vanish without closing sockets; ping so detached shells start their
// grace period. The short interval also keeps carrier NAT mappings alive, which
// are often reaped after 30-60s of silence and are a common cause of a terminal
// that looks connected but is not.
let heartbeat = null;
function startHeartbeat() {
  clearInterval(heartbeat);
  heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.readyState !== ws.OPEN) continue;
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, settings.limit('heartbeatSeconds'));
  heartbeat.unref();
}
startHeartbeat();

// Settings from the admin page take effect without a restart. A smaller
// replay buffer lets go of the output it no longer keeps right away.
settings.onChange((changed) => {
  if (changed.includes('heartbeatSeconds')) startHeartbeat();
  if (changed.includes('transferIdleMinutes')) server.timeout = settings.limit('transferIdleMinutes');
  if (changed.includes('replayKB')) {
    for (const session of sessions.all()) for (const sh of session.shells.values()) sh.trim();
  }
});

server.listen(PORT, '0.0.0.0', () => {
  // The port it actually bound, which is the one that matters when PORT is 0.
  console.log(`picossh listening on 0.0.0.0:${server.address().port}`);
  if (!APP_PASSWORD) console.log('APP_PASSWORD is not set - serving only the setup page');
});

// Without this, `docker compose restart` waits the full 10s timeout every time.
const shutdown = (signal) => () => {
  console.log(`received ${signal}, closing server`);
  sessions.closeAll('server shutting down');
  for (const ws of wss.clients) ws.terminate();
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGTERM', shutdown('SIGTERM'));
process.on('SIGINT', shutdown('SIGINT'));
