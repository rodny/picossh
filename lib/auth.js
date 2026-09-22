// Single app password. A successful login (password or passkey) sets a
// stateless cookie `sid=<expiry>.<hmac>`. The HMAC key mixes in the password,
// so changing APP_PASSWORD signs every device out.
//
// Apart from signing in, each browser gets a device cookie `did=<id>.<hmac>`:
// a random id the server signed, which names "this device" (one browser or
// Home Screen app profile, at this address) as the owner of the SSH
// connections it opens. Only that device can list, attach to or close them.
// It is kept on sign-out and renewed while in use, and a password change does
// not replace it; clearing the site's data makes a new device.
const crypto = require('crypto');
const net = require('net');
const { HttpError } = require('./store');

const COOKIE = 'sid';
const MAX_AGE_S = 90 * 24 * 3600;
const DEVICE_COOKIE = 'did';
const DEVICE_MAX_AGE_S = 365 * 24 * 3600;
// Unless the admin page chose otherwise (maxFailures() and blockMs()).
const MAX_FAILURES = 5;
// Per connecting address, however many clients it forwards for: X-Forwarded-For
// is only trustworthy from the proxy, and without one anyone can make it up.
const MAX_FAILURES_PER_PEER = 20;
const BLOCK_MS = 5 * 60 * 1000;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// Behind Caddy the peer is the proxy; it appends the real client to X-Forwarded-For.
function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return fwd.length ? fwd[fwd.length - 1] : req.socket.remoteAddress;
}

const isHttps = (req) => req.headers['x-forwarded-proto'] === 'https' || !!req.socket.encrypted;

// The WebAuthn relying party for a request: the hostname the browser used.
// Face ID credentials (sign-in passkeys and secure enclave SSH keys alike)
// belong to that hostname and to no other, so they only work on the HTTPS
// address they were made on.
function relyingParty(req, what = 'Face ID') {
  const host = String(req.headers.host || '');
  const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (!hostname || net.isIP(hostname)) {
    throw new HttpError(400, `${what} needs the app to be opened by hostname over HTTPS, not by IP address.`);
  }
  if (!isHttps(req) && hostname !== 'localhost') {
    throw new HttpError(400, `${what} needs HTTPS.`);
  }
  return { rpID: hostname, origin: `${isHttps(req) ? 'https' : 'http'}://${host}` };
}

function createAuth({ password, secret, maxFailures = () => MAX_FAILURES, blockMs = () => BLOCK_MS }) {
  const key = crypto.createHash('sha256').update(`${secret}\0${password}`).digest();
  const sign = (exp) => crypto.createHmac('sha256', key).update(String(exp)).digest('base64url');
  const deviceKey = crypto.createHash('sha256').update(`${secret}\0device`).digest();
  const signDevice = (id) => crypto.createHmac('sha256', deviceKey).update(id).digest('base64url');
  const failures = new Map(); // key -> { count, until }

  // [key, max] for the client and, when it came through a proxy (or claims
  // to), for the address that connected.
  function buckets(req) {
    const ip = clientIp(req);
    const peer = req.socket.remoteAddress;
    const max = maxFailures();
    return ip === peer ? [[ip, max]] : [[ip, max], [`via ${peer}`, Math.max(max, MAX_FAILURES_PER_PEER)]];
  }

  function cookie(req, value, maxAge, name = COOKIE) {
    return `${name}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax${isHttps(req) ? '; Secure' : ''}`;
  }

  // Adds a Set-Cookie header to any the response already has.
  function addCookie(res, value) {
    const had = res.getHeader('Set-Cookie');
    res.setHeader('Set-Cookie', [...(had ? [].concat(had) : []), value]);
  }

  // The device id from a genuine device cookie, or null.
  function deviceId(req) {
    const value = parseCookies(req.headers.cookie)[DEVICE_COOKIE];
    if (!value) return null;
    const [id, mac, ...rest] = value.split('.');
    if (rest.length || !/^[\w-]{22,64}$/.test(id) || !mac) return null;
    const expected = Buffer.from(signDevice(id));
    const given = Buffer.from(mac);
    return expected.length === given.length && crypto.timingSafeEqual(expected, given) ? id : null;
  }

  return {
    checkPassword(input) {
      return crypto.timingSafeEqual(sha256(input), sha256(password));
    },

    isAuthenticated(req) {
      const value = parseCookies(req.headers.cookie)[COOKIE];
      if (!value) return false;
      // Exactly the shape login() sets: anything else was not issued here.
      const [exp, mac, ...rest] = value.split('.');
      if (rest.length || !/^\d+$/.test(exp) || !mac || Number(exp) * 1000 < Date.now()) return false;
      const expected = Buffer.from(sign(exp));
      const given = Buffer.from(mac);
      return expected.length === given.length && crypto.timingSafeEqual(expected, given);
    },

    login(req, res) {
      const exp = Math.floor(Date.now() / 1000) + MAX_AGE_S;
      addCookie(res, cookie(req, `${exp}.${sign(exp)}`, MAX_AGE_S));
      this.device(req, res);
    },

    // Only the sign-in cookie: the device stays the same device.
    logout(req, res) {
      addCookie(res, cookie(req, '', 0));
    },

    deviceId,

    // This request's device id, making one (and setting its cookie) when the
    // browser has none. A known device gets its cookie again, which keeps a
    // device in use from ever reaching the end of its year.
    device(req, res) {
      const id = deviceId(req) || crypto.randomBytes(18).toString('base64url');
      addCookie(res, cookie(req, `${id}.${signDevice(id)}`, DEVICE_MAX_AGE_S, DEVICE_COOKIE));
      return id;
    },

    // Seconds the client must still wait, or 0.
    blockedFor(req) {
      let wait = 0;
      for (const [key] of buckets(req)) {
        const entry = failures.get(key);
        if (!entry || !entry.until) continue;
        const left = entry.until - Date.now();
        if (left <= 0) failures.delete(key);
        else wait = Math.max(wait, Math.ceil(left / 1000));
      }
      return wait;
    },

    recordFailure(req) {
      for (const [key, max] of buckets(req)) {
        const entry = failures.get(key) || { count: 0, until: 0 };
        entry.count += 1;
        if (entry.count >= max) {
          entry.count = 0;
          const wait = blockMs();
          entry.until = Date.now() + wait;
          console.log(`login: ${max} failures from ${key}, blocking for ${wait / 1000}s`);
        }
        // Bound memory against address churn, keeping blocks already in force.
        if (!failures.has(key) && failures.size >= 10000) {
          for (const [k, v] of failures) if (!v.until) failures.delete(k);
        }
        failures.set(key, entry);
      }
    },

    recordSuccess(req) {
      for (const [key] of buckets(req)) failures.delete(key);
    },
  };
}

module.exports = { createAuth, clientIp, isHttps, relyingParty };
