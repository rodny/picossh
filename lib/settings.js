// App-wide settings changed from the Settings screen, kept in data/settings.json.
//
// dnsServers: nameservers used to look up server hostnames before the system
// resolver. A container's DNS often cannot resolve local names like server.lan
// that only a LAN DNS server (or Tailscale split DNS) knows. DNS_SERVERS in the
// environment is the default while nothing is saved here.
//
// backgroundMinutes: how long the server keeps a shell, and then the SSH
// connection, with no app connected (in the background, offline or closed)
// before closing them: 15, 60 or 1440 minutes, or "forever" for no background
// expiry. One connection's Connection settings can choose its own. The time
// is taken when a shell loses its page (or the connection its last shell), so
// a change applies from the next disconnection on.
//
// The limits and timeouts in LIMITS are changed from the admin page. Each is
// one of its `options`, in its own unit (KB, seconds, minutes); `scale` turns
// that into bytes or milliseconds. Where `env` names a variable (in
// milliseconds, as the tests use to shorten a timeout), it is the default
// while nothing is saved.
const net = require('net');
const path = require('path');
const { HttpError, writeJsonAtomic, readJson } = require('./store');

const MAX_DNS_SERVERS = 4;
const FOREVER = 'forever';
const BACKGROUND_MINUTES = [15, 60, 24 * 60, FOREVER];
const DEFAULT_BACKGROUND_MINUTES = 60;

const LIMITS = {
  // Output each shell keeps for a page that comes back (lib/shell.js).
  replayKB: { label: 'output kept per shell', unit: 'KB', options: [64, 256, 512, 1024], default: 256, scale: 1024 },
  // How often each terminal socket is pinged; one that misses a round is dropped.
  heartbeatSeconds: { label: 'terminal heartbeat', unit: 's', options: [10, 15, 30, 60], default: 15, scale: 1000, env: 'HEARTBEAT_MS' },
  // A request that moves no bytes either way for this long is given up.
  transferIdleMinutes: { label: 'stalled transfer timeout', unit: 'min', options: [1, 2, 5, 10], default: 2, scale: 60 * 1000, env: 'TRANSFER_IDLE_MS' },
  // An SSH connection nothing uses for this long is listed as unused (a zombie).
  zombieMinutes: { label: 'unused connection after', unit: 'min', options: [1, 5, 15, 30], default: 1, scale: 60 * 1000, env: 'ZOMBIE_MS' },
  // Wrong passwords (or Face ID failures) from one address before it has to wait,
  loginAttempts: { label: 'failed sign-ins before a wait', unit: '', options: [3, 5, 10], default: 5, scale: 1 },
  // and how long.
  loginWaitSeconds: { label: 'wait after too many failures', unit: 's', options: [30, 60, 5 * 60, 15 * 60], default: 5 * 60, scale: 1000 },
};

function parseLimit(name, value) {
  const { options, label, unit } = LIMITS[name];
  const n = typeof value === 'number' || (typeof value === 'string' && value.trim()) ? Number(value) : NaN;
  if (!options.includes(n)) {
    const text = label[0].toUpperCase() + label.slice(1);
    throw new HttpError(400, `${text} must be one of ${options.join(', ')}${unit ? ` ${unit}` : ''}`);
  }
  return n;
}

// Exactly one of the options: a number of minutes, or "forever".
function parseBackgroundMinutes(value) {
  if (!BACKGROUND_MINUTES.includes(value)) {
    throw new HttpError(400, 'Background time must be 15 or 60 minutes, 24 hours (1440) or "forever"');
  }
  return value;
}
const validBackground = (value) => BACKGROUND_MINUTES.includes(value);

// Accepts "10.0.0.1", "10.0.0.1:5353", "fd00::53" and "[fd00::53]:5353".
function parseDnsServers(input) {
  const items = (Array.isArray(input) ? input : String(input || '').split(/[\s,]+/))
    .map((s) => String(s).trim())
    .filter(Boolean);
  if (items.length > MAX_DNS_SERVERS) throw new HttpError(400, `At most ${MAX_DNS_SERVERS} DNS servers`);
  return items.map((item) => {
    const bracketed = item.match(/^\[([^\]]+)\](?::(\d{1,5}))?$/);
    const v4port = item.match(/^([\d.]+):(\d{1,5})$/);
    const [ip, port] = bracketed ? [bracketed[1], bracketed[2]] : v4port ? [v4port[1], v4port[2]] : [item, undefined];
    if (!net.isIP(ip) || (port !== undefined && (Number(port) < 1 || Number(port) > 65535))) {
      throw new HttpError(400, `Not a DNS server IP address: ${item}`);
    }
    if (port === undefined) return ip;
    return net.isIPv6(ip) ? `[${ip}]:${port}` : `${ip}:${port}`;
  });
}

function createSettings({ dataDir, env = process.env }) {
  const file = path.join(dataDir, 'settings.json');
  const data = readJson(file, {});
  let envDns = [];
  try {
    envDns = parseDnsServers(env.DNS_SERVERS);
  } catch (err) {
    console.log(`ignoring DNS_SERVERS: ${err.message}`);
  }
  const envMs = (name) => {
    const ms = LIMITS[name].env ? Number(env[LIMITS[name].env]) : NaN;
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  };
  const listeners = [];

  return {
    // Saved servers win; an empty saved list falls back to the environment.
    dnsServers: () => (data.dnsServers && data.dnsServers.length ? data.dnsServers : envDns),

    // A saved value that is no longer an option counts as the default.
    backgroundMinutes: () => (validBackground(data.backgroundMinutes) ? data.backgroundMinutes : DEFAULT_BACKGROUND_MINUTES),

    get() {
      return { dnsServers: data.dnsServers || [], envDnsServers: envDns, backgroundMinutes: this.backgroundMinutes() };
    },

    // A limit in bytes, milliseconds or a count: saved, else the environment,
    // else the default.
    limit(name) {
      const saved = data[name];
      if (saved !== undefined) return saved * LIMITS[name].scale;
      return envMs(name) ?? LIMITS[name].default * LIMITS[name].scale;
    },

    // For the admin page: each limit in its own unit, where it comes from and
    // what it can be; with the background time, which the app sets as well.
    limits() {
      const out = {};
      for (const [name, def] of Object.entries(LIMITS)) {
        const source = data[name] !== undefined ? 'saved' : envMs(name) !== null ? 'environment' : 'default';
        out[name] = { value: this.limit(name) / def.scale, default: def.default, options: def.options, source, label: def.label, unit: def.unit };
      }
      out.backgroundMinutes = {
        value: this.backgroundMinutes(),
        default: DEFAULT_BACKGROUND_MINUTES,
        options: BACKGROUND_MINUTES,
        source: validBackground(data.backgroundMinutes) ? 'saved' : 'default',
        label: 'default background time',
        unit: 'min',
      };
      return out;
    },

    // fn(names) after an update, with the names of the values it changed.
    onChange(fn) {
      listeners.push(fn);
    },

    // All or nothing: every value is checked before any is applied.
    update(body) {
      const changes = {};
      if (body && body.dnsServers !== undefined) changes.dnsServers = parseDnsServers(body.dnsServers);
      if (body && body.backgroundMinutes !== undefined) changes.backgroundMinutes = parseBackgroundMinutes(body.backgroundMinutes);
      for (const name of Object.keys(LIMITS)) {
        if (body && body[name] !== undefined) changes[name] = parseLimit(name, body[name]);
      }
      // Saved first, so a failed write does not leave unsaved values in use.
      writeJsonAtomic(file, { ...data, ...changes });
      const changed = Object.keys(changes).filter((k) => JSON.stringify(data[k]) !== JSON.stringify(changes[k]));
      Object.assign(data, changes);
      if (changed.length) for (const fn of listeners) fn(changed);
      return this.get();
    },
  };
}

module.exports = { createSettings, parseDnsServers, parseBackgroundMinutes, LIMITS, BACKGROUND_MINUTES, DEFAULT_BACKGROUND_MINUTES, FOREVER };
