// A session is one ssh2 connection to a saved server. It owns a lazily opened
// SFTP channel and any number of shell channels (see shell.js), and belongs to
// the device that opened it (its device cookie, lib/auth.js): only that
// device finds it through owned().
const crypto = require('crypto');
const dns = require('dns');
const net = require('net');
const { Client } = require('ssh2');
const { HttpError, fingerprint } = require('./store');
const skKeys = require('./sk-keys');
const { timerAt } = require('./deadline');

// A server that drops the connection before login gets one more try: some
// (OpenSSH on Windows, for one) now and then reset a new connection outright.
const CONNECT_ATTEMPTS = 2;
const RETRY_DELAY_MS = 1000;
const HANDSHAKE_CLOSED = 'Connection closed during handshake';
// How long a half-made connection waits for the browser to answer a Face ID
// prompt. Below sshd's LoginGraceTime (two minutes by default), so a phone
// that never answers is dropped here rather than by the server.
const SIGN_WAIT_MS = 90 * 1000;

// Refused, unreachable, timed out and bad credentials fail the same way twice;
// a connection cut mid-handshake often doesn't.
function droppedDuringHandshake(err) {
  return err.code === 'ECONNRESET' || err.code === 'EPIPE' || err.message === HANDSHAKE_CLOSED;
}

// Looks the host up on the configured DNS servers. Returns an address, or null
// to let the connection fall back to the system resolver (hosts file etc.).
async function resolveWith(servers, host) {
  if (!servers.length || net.isIP(host)) return null;
  const resolver = new dns.promises.Resolver({ timeout: 3000, tries: 2 });
  resolver.setServers(servers);
  for (const method of ['resolve4', 'resolve6']) {
    try {
      const addresses = await resolver[method](host);
      if (addresses.length) return addresses[0];
    } catch {}
  }
  return null;
}

function notFound(server, dnsServers) {
  const message = dnsServers.length
    ? `Host not found: ${server.host}. Neither the DNS servers in Settings (${dnsServers.join(', ')}) nor the system DNS know this name.`
    : `Host not found: ${server.host}. If a local DNS server knows this name, add it under Settings → DNS servers, or use the IP address.`;
  return new HttpError(502, message, { code: 'unreachable' });
}

function connectError(err, server, hostKeyMismatch, dnsServers = []) {
  if (err instanceof HttpError) return err;
  if (hostKeyMismatch) {
    return new HttpError(409, `Host key for ${server.host} changed (now ${hostKeyMismatch}). If you expected this, use "Forget host key" in the server settings.`, { code: 'hostkey' });
  }
  const msg = err.message || String(err);
  if (/passphrase/i.test(msg)) {
    return new HttpError(400, /bad passphrase|decrypt/i.test(msg) ? 'Wrong key passphrase' : 'This private key needs a passphrase', { code: 'passphrase' });
  }
  // Not 401: the browser treats that as its own session expiring.
  if (err.level === 'client-authentication') return new HttpError(400, 'Authentication failed', { code: 'auth' });
  // A Face ID key whose assertion was refused, mistyped or too late: the
  // message already says which, so pass it on as it is.
  if (err.level === 'agent') return new HttpError(400, msg, { code: 'faceid' });
  if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') return notFound(server, dnsServers);
  if (err.code === 'ECONNREFUSED') return new HttpError(502, `Connection refused by ${server.host}:${server.port}`, { code: 'unreachable' });
  if (['ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'].includes(err.code) || /timed out/i.test(msg)) {
    return new HttpError(504, `Host unreachable: ${server.host}:${server.port}`, { code: 'unreachable' });
  }
  if (err.level === 'client-socket' || err.code === 'ECONNRESET') return new HttpError(502, `Connection failed: ${msg}`, { code: 'unreachable' });
  return new HttpError(502, msg, { code: 'ssh' });
}

// retention(session) is how long the connection is kept in the background:
// { minutes, ms }, with ms null for Forever (server.js: the connection's own
// setting, else the app's default). It is read at the moment the time starts:
// a shell losing its page (shell.js), or the connection being left with no
// shell and no transfer. What it was then holds until the next time, however
// the settings change in between: the deadline is fixed, and nothing that
// looks at the connection moves it.
// onClose(session) hears about every connection that ends.
function createSessions({ store, dnsServers = () => [], retention, onClose = () => {} }) {
  const sessions = new Map();
  // Handshakes stopped halfway, waiting for a Face ID signature from the
  // browser that asked for the connection: id -> what it takes to go on.
  const pending = new Map();
  // Every connection attempt still under way, so that signing out can stop
  // the ones its device started: { owner, cancelled, clients }.
  const attempts = new Set();

  const cancelledError = () => new HttpError(409, 'Connection cancelled: this device signed out', { code: 'cancelled' });

  function clearIdle(session) {
    if (session.idleTimer) session.idleTimer.clear();
    session.idleTimer = null;
    session.idle = null;
  }

  // Nothing uses the connection now (no shell, no transfer): its own
  // background time starts, as the settings are at this moment.
  function idleNow(session) {
    clearIdle(session);
    const { minutes, ms } = retention(session);
    const now = Date.now();
    session.idle = { since: now, retention: minutes, deadline: ms === null ? null : now + ms };
    if (ms !== null) session.idleTimer = timerAt(session.idle.deadline, () => destroy(session, 'idle'));
  }

  function destroy(session, reason) {
    if (!sessions.has(session.id)) return;
    sessions.delete(session.id);
    clearIdle(session);
    for (const shell of session.shells.values()) shell.end(reason);
    session.shells.clear();
    session.client.end();
    session.closedAt = Date.now();
    session.closeReason = reason;
    console.log(`session ${session.id} (${session.name}) closed: ${reason}`);
    onClose(session);
  }

  // What the connection is doing, and when it closes unless that changes:
  // 'attached' (a page has a shell), 'background' (shells waiting for their
  // page) or 'idle' (no shell). The deadline is when its last shell's
  // background time runs out, or its own while idle; null while a page or a
  // transfer uses it, and when nothing ends it (Forever).
  function status(session) {
    const shells = [...session.shells.values()];
    const attached = shells.some((sh) => sh.ws);
    const transferring = session.busy > 0;
    const state = attached ? 'attached' : shells.length ? 'background' : 'idle';
    let deadline = null;
    if (!attached && !transferring) {
      const deadlines = shells.length ? shells.map((sh) => sh.deadline) : [session.idle ? session.idle.deadline : null];
      if (deadlines.every((d) => d !== null && d !== undefined)) deadline = Math.max(...deadlines);
    }
    return { state, transferring, deadline };
  }

  // One connection attempt. Rejects with { raw, mismatch }: the ssh2 error and
  // the changed host key fingerprint, if that is why it failed.
  function connectOnce(server, cfg, password, prepare, job) {
    let seenKey = null;
    let mismatch = null;
    const verified = {
      ...cfg,
      hostVerifier: (key) => {
        seenKey = fingerprint(key);
        if (server.hostKey && server.hostKey !== seenKey) {
          mismatch = seenKey;
          return false;
        }
        return true;
      },
    };

    return new Promise((resolve, reject) => {
      const client = new Client();
      job.clients.add(client);
      let settled = false;
      let session = null;
      const fail = (raw) => {
        settled = true;
        reject({ raw, mismatch });
      };

      client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
        finish(prompts.map(() => password));
      });

      client.on('ready', () => {
        if (job.cancelled) {
          fail(cancelledError());
          client.end();
          return;
        }
        // Trust on first use. A key that cannot be saved fails the attempt:
        // otherwise the next connection would trust whatever key it sees.
        if (seenKey) {
          let trusted;
          try {
            trusted = store.setHostKey(server.id, seenKey);
          } catch (err) {
            fail(new HttpError(500, `Could not save the host key: ${err.message}`, { code: 'storage' }));
            client.end();
            return;
          }
          // Another connection to the server, checked as this one was while
          // no key was trusted, got here first with a different key (this
          // one waited for Face ID, say): this key is a changed one now.
          if (trusted && trusted !== seenKey) {
            mismatch = seenKey;
            fail(new Error('Host key changed'));
            client.end();
            return;
          }
        }
        settled = true;
        session = {
          id: crypto.randomBytes(18).toString('base64url'),
          serverId: server.id,
          // What it is called: the server's name when it connected, until
          // renamed (rename()). Like backgroundMinutes, never saved.
          name: server.name,
          defaultName: server.name,
          client,
          sftp: null,
          shells: new Map(),
          busy: 0,
          lastUsed: Date.now(),
          connectedAt: new Date().toISOString(),
          // The device that opened it, the only one that may use it.
          owner: job.owner,
          // How long this connection is kept in the background, from its
          // Connection settings; null follows the app's default. It is never
          // saved, so it ends with the connection.
          backgroundMinutes: null,
          // While nothing uses it: { since, retention, deadline }.
          idle: null,
          idleTimer: null,
          // Its last shell ran out of time during a transfer: it closes when
          // the transfer ends, rather than starting a background time again.
          closeWhenFree: false,
          // For the admin page: where it goes (as typed, not the resolved
          // address), the TCP socket whose byte counts are the SSH traffic,
          // and how the browser sockets on its shells have fared.
          user: server.user,
          host: server.host,
          port: server.port,
          sock: client._sock || null,
          stats: { attaches: 0, reconnects: 0, drops: 0, repaints: 0, lostBytes: 0, pauses: 0 },
        };
        sessions.set(session.id, session);
        idleNow(session);
        console.log(`session ${session.id} connected to ${server.user}@${server.host}:${server.port} (${server.name})`);
        resolve(session);
      });

      client.on('error', (err) => {
        if (!settled) fail(err);
        else console.log(`session ${session ? session.id : '?'} error: ${err.message}`);
      });

      client.on('close', () => {
        if (!settled) fail(new Error(HANDSHAKE_CLOSED));
        if (session) destroy(session, 'connection closed');
      });

      try {
        client.connect(verified);
        // Only now does the client have the protocol object a Face ID key
        // needs to patch (sk-keys.js).
        if (prepare) prepare(client);
      } catch (err) {
        fail(err);
      }
    });
  }

  return {
    // Any connection, whoever owns it: for the admin page.
    get(id) {
      return sessions.get(id);
    },

    // A connection of this device's, or undefined: another device's
    // connection is not there as far as this one can tell.
    owned(id, owner) {
      const session = sessions.get(id);
      return session && owner && session.owner === owner ? session : undefined;
    },

    all() {
      return [...sessions.values()];
    },

    // This device's connections, oldest first.
    ownedBy(owner) {
      return owner ? [...sessions.values()].filter((s) => s.owner === owner) : [];
    },

    retention,
    status,

    // What the device that owns it is told: where it goes (as it was when it
    // connected, which outlives the saved server being edited or deleted),
    // how long it is kept and until when, and its shells. Nothing secret:
    // no credentials, and no shell's attachment lease.
    info(session) {
      const { state, transferring, deadline } = status(session);
      return {
        id: session.id,
        serverId: session.serverId,
        name: session.name,
        defaultName: session.defaultName,
        user: session.user,
        host: session.host,
        port: session.port,
        connectedAt: session.connectedAt,
        backgroundMinutes: session.backgroundMinutes,
        retention: retention(session).minutes,
        state,
        transferring,
        deadline,
        shells: [...session.shells.values()].map((sh) => ({
          id: sh.id,
          attached: !!sh.ws,
          detachedAt: sh.detachedAt,
          deadline: sh.deadline,
          retention: sh.retention,
          revision: sh.revision,
        })),
      };
    },

    // A name of its own for the connection, or its default (the server's
    // name when it connected) for an empty one.
    rename(session, name) {
      if (typeof name !== 'string') throw new HttpError(400, 'Name must be text');
      const trimmed = name.trim();
      if (trimmed.length > 100) throw new HttpError(400, 'Name must be at most 100 characters');
      session.name = trimmed || session.defaultName;
    },

    // Only for the admin page's "last used": it never keeps a connection open longer.
    touch(session) {
      session.lastUsed = Date.now();
    },

    // A transfer on the connection starts and ends. The connection waits for
    // it, and starts its idle time (or closes) when the last one is done.
    begin(session) {
      session.busy++;
      session.lastUsed = Date.now();
      clearIdle(session);
    },

    finish(session) {
      session.busy--;
      session.lastUsed = Date.now();
      if (session.busy > 0 || session.shells.size || sessions.get(session.id) !== session) return;
      if (session.closeWhenFree) destroy(session, 'background time ran out');
      else idleNow(session);
    },

    // shell.js: a shell opened on the connection, and one that ended. When
    // the last shell ends because its background time ran out, the SSH
    // connection it leaves unused closes too, without a background time of
    // its own on top (after a transfer still running, if there is one).
    shellOpened(session) {
      clearIdle(session);
      session.closeWhenFree = false;
    },

    shellEnded(session, expired) {
      if (sessions.get(session.id) !== session || session.shells.size) return;
      if (expired) {
        if (session.busy) session.closeWhenFree = true;
        else destroy(session, 'background time ran out');
      } else if (!session.busy) {
        idleNow(session);
      }
    },

    // A new connection for the device `owner`, which owns it from the start
    // (a Face ID key's handshake that stops halfway too).
    async create(serverId, body = {}, owner) {
      const server = store.getServer(serverId);
      const job = { owner, cancelled: false, clients: new Set() };
      attempts.add(job);
      let handedOff = false;
      try {
        return await this.connect(server, body, job, () => { handedOff = true; });
      } finally {
        if (!handedOff) attempts.delete(job);
      }
    },

    // create() without the bookkeeping. handOff(): the attempt goes on after
    // this returns (waiting for Face ID), and forgets `job` itself.
    async connect(server, body, job, handOff) {
      const cfg = {
        host: server.host,
        port: server.port,
        username: server.user,
        readyTimeout: 15000,
        keepaliveInterval: 15000,
        keepaliveCountMax: 4,
      };

      const creds = store.credentials(server);
      const password = body.password || creds.password;
      const enclave = creds.enclaveKey;
      if (enclave) {
        // Nothing here can sign: the browser is asked for one signature in the
        // middle of the handshake, so the handshake has to outlast someone
        // picking up their phone.
        cfg.readyTimeout += SIGN_WAIT_MS;
      } else if (server.auth === 'key') {
        cfg.privateKey = creds.privateKey;
        const passphrase = body.passphrase || creds.passphrase;
        if (passphrase) cfg.passphrase = passphrase;
      } else {
        if (!password) throw new HttpError(400, 'Password required', { code: 'password' });
        cfg.password = password;
        cfg.tryKeyboard = true; // many servers only offer keyboard-interactive for passwords
      }

      const nameservers = dnsServers();
      const address = await resolveWith(nameservers, server.host);
      if (address) cfg.host = address;
      if (job.cancelled) throw cancelledError();

      // A Face ID key is used once per connection, so a dropped handshake
      // cannot be retried here: the browser would have to be asked again.
      const tries = enclave ? 1 : CONNECT_ATTEMPTS;
      let entry = null;
      let asked = null;
      let prepare;

      if (enclave) {
        entry = { id: crypto.randomBytes(18).toString('base64url'), owner: job.owner, credentialId: enclave.credentialId, client: null, answer: null, connect: null, timer: null };
        let deliver;
        asked = new Promise((resolve) => { deliver = resolve; });
        cfg.agent = new skKeys.EnclaveAgent({
          point: Buffer.from(enclave.point, 'base64url'),
          application: enclave.rpID,
          // Hands the browser what to sign and waits for it to come back
          // through signature() below.
          sign: (data) => new Promise((resolve, reject) => {
            entry.answer = { resolve, reject };
            deliver({
              id: entry.id,
              keyName: enclave.name,
              rpId: enclave.rpID,
              challenge: data.toString('base64url'),
              allowCredentials: [{ id: enclave.credentialId, type: 'public-key', transports: enclave.transports }],
              timeoutMs: SIGN_WAIT_MS,
            });
          }),
        });
        prepare = (client) => {
          entry.client = client;
          skKeys.useWebauthnAuth(client);
        };
      }

      const target = `${server.user}@${server.host}:${server.port} (${server.name})`;
      const run = async () => {
        for (let attempt = 1; ; attempt++) {
          let failure;
          try {
            const session = await connectOnce(server, cfg, password, prepare, job);
            // Signed out as it got through: closeOwned() has closed it.
            if (job.cancelled || !sessions.has(session.id)) throw { raw: cancelledError() };
            return session;
          } catch (e) {
            failure = e;
          }
          const { raw, mismatch } = failure;
          if (job.cancelled) throw cancelledError();
          const retry = attempt < tries && !mismatch && droppedDuringHandshake(raw);
          console.log(`connect to ${target} failed (attempt ${attempt})${retry ? ', retrying' : ''}: ${raw.code || raw.level || 'error'}: ${raw.message}`);
          if (!retry) throw connectError(raw, server, mismatch, nameservers);
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
          if (job.cancelled) throw cancelledError();
        }
      };

      if (!entry) return { session: await run() };

      // Either the handshake reaches the point of needing a signature, or it
      // fails first (refused, unreachable, wrong host key).
      entry.connect = run();
      handOff();
      const done = () => attempts.delete(job);
      entry.connect.then(done, done); // failures are answered for through signature()
      const outcome = await Promise.race([
        asked.then((signRequest) => ({ signRequest })),
        entry.connect.then((session) => ({ session }), (error) => ({ error })),
      ]);
      if (outcome.error) throw outcome.error;
      if (outcome.session) return { session: outcome.session };

      pending.set(entry.id, entry);
      entry.timer = setTimeout(() => {
        if (pending.get(entry.id) !== entry) return;
        pending.delete(entry.id);
        entry.answer.reject(new Error('Face ID was not used in time'));
        if (entry.client) entry.client.end();
      }, SIGN_WAIT_MS);
      entry.timer.unref();
      console.log(`connect to ${target} waiting for Face ID (${entry.id})`);
      return { signRequest: outcome.signRequest };
    },

    // What the browser signed, for the handshake that is waiting on it: only
    // from the device that asked for the connection.
    async signature(id, response, owner) {
      const entry = pending.get(String(id || ''));
      if (!entry || !owner || entry.owner !== owner) throw new HttpError(404, 'This connection is no longer waiting for Face ID. Connect again.', { code: 'gone' });
      // The browser may have offered a different credential; the handshake is
      // left waiting so that the right one can still be used.
      if (response && response.id !== entry.credentialId) {
        throw new HttpError(400, 'That is a different key from the one this server uses.', { code: 'faceid' });
      }
      pending.delete(entry.id);
      clearTimeout(entry.timer);
      entry.answer.resolve(response);
      return { session: await entry.connect };
    },

    destroy,

    // One SFTP channel per session, reopened if the server closes it. One
    // that could not be opened is not kept, so the next request tries again:
    // ssh2 may refuse before sftp() returns (a thrown "Not connected", or no
    // free channel), which is why this is not left to its callback.
    sftp(session) {
      if (!session.sftp) {
        const opening = new Promise((resolve, reject) => {
          const refused = (err) => reject(new HttpError(502, `SFTP is not available on this server: ${err.message}`));
          try {
            session.client.sftp((err, sftp) => {
              if (err) return refused(err);
              const reset = () => { if (session.sftp && session.sftpChannel === sftp) session.sftp = null; };
              session.sftpChannel = sftp;
              sftp.on('close', reset);
              sftp.on('end', reset);
              resolve(sftp);
            });
          } catch (err) {
            refused(err);
          }
        });
        session.sftp = opening;
        opening.catch(() => { if (session.sftp === opening) session.sftp = null; });
      }
      return session.sftp;
    },

    // Signing out: every connection the device owns, the handshakes it has
    // under way and the ones waiting for its Face ID all end.
    closeOwned(owner, reason) {
      if (!owner) return 0;
      for (const job of attempts) {
        if (job.owner !== owner) continue;
        job.cancelled = true;
        for (const client of job.clients) client.destroy();
      }
      for (const entry of [...pending.values()]) {
        if (entry.owner !== owner) continue;
        pending.delete(entry.id);
        clearTimeout(entry.timer);
        if (entry.answer) entry.answer.reject(new Error('Signed out'));
        if (entry.client) entry.client.destroy();
      }
      const doomed = this.ownedBy(owner);
      for (const session of doomed) destroy(session, reason);
      return doomed.length;
    },

    closeAll(reason) {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        if (entry.client) entry.client.end();
      }
      pending.clear();
      for (const session of [...sessions.values()]) destroy(session, reason);
    },
  };
}

module.exports = { createSessions };
