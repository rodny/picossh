// What the admin page shows: the devices using the app, the SSH connections
// they have open and how those are doing, the server process, and a history
// of all of it for the activity charts. Everything is kept in memory; a
// restart starts over.
//
// A device is a browser: its address plus its user agent. It counts as online
// while it has a terminal socket open or for ONLINE_MS after its last request;
// a gap longer than AWAY_MS starts a new visit ("online for").
//
// A zombie is an SSH connection nothing is using: no page has a terminal on it,
// no transfer is running and nothing touched it for zombieMs() (a minute unless
// the admin page chose otherwise). Its shells wait for a page that may not come
// back until the background time they got runs out, if it does: with Forever,
// nothing closes it but the admin page (or its device signing out).
const crypto = require('crypto');
const os = require('os');
const { monitorEventLoopDelay } = require('perf_hooks');
const { clientIp } = require('./auth');

const ONLINE_MS = 2 * 60 * 1000;
const AWAY_MS = 10 * 60 * 1000;
const HISTORY_MS = 24 * 3600 * 1000;
const FORGET_MS = 24 * 3600 * 1000;
const MAX_DEVICES = 500;
const MAX_EVENTS = 200;
const MAX_CLOSED = 50;
const MAX_POINTS = 360; // per chart, whatever the range

// "::ffff:192.168.1.20" is an IPv4 client on a dual-stack socket.
const plainIp = (ip) => String(ip || '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');

// A short name for a user agent: "iPhone · Safari", "Windows · Edge".
function describeAgent(ua) {
  ua = String(ua || '');
  const system = /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
    : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows'
    : /CrOS/.test(ua) ? 'ChromeOS'
    : /Mac OS X|Macintosh/.test(ua) ? 'Mac'
    : /Linux/.test(ua) ? 'Linux'
    : '';
  const browser = /Edg(e|A|iOS)?\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
    : /Firefox\/|FxiOS\//.test(ua) ? 'Firefox'
    : /Chrome\/|CriOS\//.test(ua) ? 'Chrome'
    : /Version\/[\d.]+.*Safari\//.test(ua) ? 'Safari'
    // iOS gives a Home Screen app Safari's agent without "Version" or "Safari".
    : /(iPhone|iPad).*AppleWebKit/.test(ua) ? 'Home Screen app'
    : /^curl\//.test(ua) ? 'curl'
    : /^node$|undici/.test(ua) ? 'Node.js'
    : ua ? 'Other' : 'Unknown';
  return { system, browser, label: system ? `${system} · ${browser}` : browser };
}

function createMonitor({ sessions, sampleMs = 10000, zombieMs = () => 60 * 1000, now = Date.now }) {
  const startedAt = now();
  const devices = new Map(); // id -> device
  const events = []; // newest last
  const closed = []; // recently closed connections, newest last
  // Bytes of connections and sockets already closed; live ones are added on top.
  const retired = { sshIn: 0, sshOut: 0, wsIn: 0, wsOut: 0 };
  let requests = 0;
  const samples = [];
  let last = null; // the previous sample's running totals
  let cpu = { usage: process.cpuUsage(), at: now(), percent: 0 };
  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();

  function deviceFor(req) {
    const ip = plainIp(clientIp(req));
    const ua = String(req.headers['user-agent'] || '').slice(0, 300);
    const id = crypto.createHash('sha256').update(`${ip}\0${ua}`).digest('base64url').slice(0, 12);
    let device = devices.get(id);
    if (!device) {
      if (devices.size >= MAX_DEVICES) forget(true);
      const t = now();
      device = {
        id, ip, ua, ...describeAgent(ua),
        firstSeen: t, since: t, lastSeen: t,
        requests: 0, signIns: 0, failures: 0, signedIn: false,
        sockets: new Set(), wsIn: 0, wsOut: 0,
      };
      devices.set(id, device);
    }
    return device;
  }

  function touch(device) {
    const t = now();
    if (!device.sockets.size && t - device.lastSeen > AWAY_MS) device.since = t;
    device.lastSeen = t;
  }

  const online = (device, t = now()) => device.sockets.size > 0 || t - device.lastSeen < ONLINE_MS;

  // Drops devices gone for a day; with `crowded`, every offline one but the
  // most recent half, so a flood of made-up user agents cannot grow the map.
  function forget(crowded = false) {
    const t = now();
    const offline = [...devices.values()].filter((d) => !online(d, t)).sort((a, b) => a.lastSeen - b.lastSeen);
    const keep = crowded ? Math.floor(offline.length / 2) : offline.length;
    offline.forEach((d, i) => {
      if (i < offline.length - keep || t - d.lastSeen > FORGET_MS) devices.delete(d.id);
    });
    // Still full: a flood faster than devices go offline (a request needs no
    // sign-in to be counted). The longest unseen go, down to half, but never
    // one with a terminal socket open, which signed in to have it.
    if (crowded && devices.size >= MAX_DEVICES) {
      const idle = [...devices.values()].filter((d) => !d.sockets.size).sort((a, b) => a.lastSeen - b.lastSeen);
      for (const d of idle.slice(0, devices.size - Math.floor(MAX_DEVICES / 2))) devices.delete(d.id);
    }
  }

  function event(device, kind, text) {
    events.push({ at: now(), kind, text, device: device ? { id: device.id, label: device.label, ip: device.ip } : null });
    if (events.length > MAX_EVENTS) events.shift();
  }

  const socketBytes = (sock) => ({ in: (sock && sock.bytesRead) || 0, out: (sock && sock.bytesWritten) || 0 });

  function totals() {
    const t = { ...retired, requests };
    for (const s of sessions.all()) {
      const b = socketBytes(s.sock);
      t.sshIn += b.in;
      t.sshOut += b.out;
    }
    for (const d of devices.values()) {
      for (const ws of d.sockets) {
        const b = socketBytes(ws.rawSocket);
        t.wsIn += b.in;
        t.wsOut += b.out;
      }
    }
    return t;
  }

  // What a connection is doing: 'active' (a page on it, or a transfer), else
  // 'detached' (shells waiting for their page) or 'idle' (no shells).
  function stateOf(session, t = now()) {
    const shells = [...session.shells.values()];
    const attached = shells.some((sh) => sh.ws);
    const active = attached || session.busy > 0;
    const kind = active ? 'active' : shells.length ? 'detached' : 'idle';
    const quietSince = Math.max(session.lastUsed, ...shells.map((sh) => sh.detachedAt || 0));
    const zombie = !active && t - quietSince >= zombieMs();
    // The deadlines fixed when its shells lost their pages (or it its last
    // shell), which are when it closes; none while in use, and none at all
    // for Forever (noExpiry).
    const closesAt = active ? null : sessions.status(session).deadline;
    return { kind, zombie, closesAt, noExpiry: !active && closesAt === null };
  }

  function deviceRef(id) {
    const d = id && devices.get(id);
    return d ? { id: d.id, label: d.label, ip: d.ip } : null;
  }

  function sessionInfo(session, t = now()) {
    const bytes = socketBytes(session.sock);
    const state = stateOf(session, t);
    const shells = [...session.shells.values()].map((sh) => ({
      id: sh.id.slice(0, 8),
      attached: !!sh.ws,
      device: sh.ws ? deviceRef(sh.ws.deviceId) : null,
      outBytes: sh.outPos,
      inBytes: sh.inPos,
      paused: !!sh.paused,
      detachedAt: sh.detachedAt,
      // The replay buffer (see lib/shell.js) and the output rate over the
      // last sample, which is how fast a detached shell fills it.
      buffer: sh.buffer ? sh.buffer() : null,
      outRate: sh.outRate || 0,
    }));
    const deviceIds = new Set([session.deviceId, ...shells.filter((sh) => sh.device).map((sh) => sh.device.id)].filter(Boolean));
    return {
      id: session.id,
      name: session.name,
      target: `${session.user}@${session.host}:${session.port}`,
      connectedAt: Date.parse(session.connectedAt),
      lastUsed: session.lastUsed,
      state: state.kind,
      zombie: state.zombie,
      closesAt: state.closesAt,
      noExpiry: state.noExpiry,
      retention: sessions.retention ? sessions.retention(session).minutes : null,
      busy: session.busy,
      openedBy: deviceRef(session.deviceId),
      devices: [...deviceIds].map(deviceRef).filter(Boolean),
      bytesIn: bytes.in,
      bytesOut: bytes.out,
      rateIn: session.rate ? session.rate.in : 0,
      rateOut: session.rate ? session.rate.out : 0,
      termOut: shells.reduce((n, sh) => n + sh.outBytes, 0),
      termIn: shells.reduce((n, sh) => n + sh.inBytes, 0),
      stats: { ...session.stats },
      shells,
    };
  }

  function sample() {
    const t = now();
    const tot = totals();
    const elapsed = last ? (t - last.t) / 1000 : 0;
    const usage = process.cpuUsage(cpu.usage);
    const wall = (t - cpu.at) * 1000;
    cpu = { usage: process.cpuUsage(), at: t, percent: wall > 0 ? Math.min(100 * os.cpus().length, ((usage.user + usage.system) / wall) * 100) : 0 };
    for (const s of sessions.all()) {
      const b = socketBytes(s.sock);
      const prev = s.lastBytes;
      s.rate = prev && elapsed > 0 ? { in: (b.in - prev.in) / elapsed, out: (b.out - prev.out) / elapsed } : { in: 0, out: 0 };
      s.lastBytes = b;
      for (const sh of s.shells.values()) {
        sh.outRate = sh.lastOut !== undefined && elapsed > 0 ? Math.max(0, sh.outPos - sh.lastOut) / elapsed : 0;
        sh.lastOut = sh.outPos;
      }
    }
    const live = sessions.all();
    const mem = process.memoryUsage();
    const delta = (k) => (last ? Math.max(0, tot[k] - last[k]) : 0);
    samples.push({
      t,
      devices: [...devices.values()].filter((d) => online(d, t)).length,
      sessions: live.length,
      shells: live.reduce((n, s) => n + s.shells.size, 0),
      zombies: live.filter((s) => stateOf(s, t).zombie).length,
      sshIn: delta('sshIn'),
      sshOut: delta('sshOut'),
      wsIn: delta('wsIn'),
      wsOut: delta('wsOut'),
      requests: delta('requests'),
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      cpu: Math.round(cpu.percent * 10) / 10,
    });
    last = { t, ...tot };
    while (samples.length && samples[0].t < t - HISTORY_MS) samples.shift();
    forget();
  }

  sample();
  const timer = setInterval(sample, sampleMs);
  timer.unref();

  return {
    // Every request but /health (a container health check is not a device).
    request(req, signedIn) {
      const device = deviceFor(req);
      touch(device);
      device.requests++;
      device.signedIn = signedIn;
      requests++;
      return device;
    },

    signIn(req, ok, how) {
      const device = deviceFor(req);
      touch(device);
      if (ok) device.signIns++;
      else device.failures++;
      event(device, ok ? 'signin' : 'failure', ok ? `Signed in with ${how}` : `Wrong ${how}`);
    },

    // A terminal socket: the device is online while it is open.
    socket(ws, req) {
      const device = deviceFor(req);
      touch(device);
      device.signedIn = true; // the upgrade checked its cookie
      ws.deviceId = device.id;
      ws.rawSocket = req.socket;
      device.sockets.add(ws);
      ws.on('close', () => {
        if (!device.sockets.delete(ws)) return;
        const b = socketBytes(req.socket);
        device.wsIn += b.in;
        device.wsOut += b.out;
        retired.wsIn += b.in;
        retired.wsOut += b.out;
        device.lastSeen = now();
      });
    },

    sessionOpened(session, req) {
      const device = deviceFor(req);
      session.deviceId = device.id;
      event(device, 'open', `Connected to ${session.user}@${session.host}:${session.port} (${session.name})`);
    },

    sessionClosed(session) {
      const b = socketBytes(session.sock);
      retired.sshIn += b.in;
      retired.sshOut += b.out;
      const info = sessionInfo(session);
      closed.push({ ...info, closedAt: session.closedAt || now(), reason: session.closeReason || '' });
      if (closed.length > MAX_CLOSED) closed.shift();
      event(devices.get(session.deviceId), 'close', `Closed ${info.target} (${session.name}): ${session.closeReason || 'closed'}`);
    },

    note(req, kind, text) {
      event(req ? deviceFor(req) : null, kind, text);
    },

    isZombie: (session) => stateOf(session).zombie,

    overview() {
      const t = now();
      const live = sessions.all().map((s) => sessionInfo(s, t)).sort((a, b) => a.connectedAt - b.connectedAt);
      const tot = totals();
      const deviceList = [...devices.values()].map((d) => {
        let wsIn = d.wsIn;
        let wsOut = d.wsOut;
        for (const ws of d.sockets) {
          const b = socketBytes(ws.rawSocket);
          wsIn += b.in;
          wsOut += b.out;
        }
        return {
          id: d.id, ip: d.ip, ua: d.ua, label: d.label, system: d.system, browser: d.browser,
          online: online(d, t), firstSeen: d.firstSeen, since: d.since, lastSeen: d.lastSeen,
          sockets: d.sockets.size, requests: d.requests, signIns: d.signIns, failures: d.failures, signedIn: d.signedIn,
          bytesIn: wsIn, bytesOut: wsOut,
          sessions: live.filter((s) => s.devices.some((x) => x.id === d.id)).map((s) => s.id),
        };
      }).sort((a, b) => (b.online - a.online) || (b.lastSeen - a.lastSeen));
      const mem = process.memoryUsage();
      const shells = live.reduce((n, s) => n + s.shells.length, 0);
      return {
        now: t,
        server: {
          startedAt,
          uptime: Math.round(process.uptime()),
          pid: process.pid,
          node: process.version,
          platform: `${os.type()} ${os.release()} (${process.arch})`,
          hostname: os.hostname(),
          memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, external: mem.external, arrayBuffers: mem.arrayBuffers },
          system: { total: os.totalmem(), free: os.freemem(), cpus: os.cpus().length, load: os.loadavg() },
          cpu: Math.round(cpu.percent * 10) / 10,
          eventLoop: {
            mean: Math.round(loopDelay.mean / 1e4) / 100,
            p99: Math.round(loopDelay.percentile(99) / 1e4) / 100,
            max: Math.round(loopDelay.max / 1e4) / 100,
          },
        },
        counts: {
          devicesOnline: deviceList.filter((d) => d.online).length,
          devices: deviceList.length,
          sessions: live.length,
          shells,
          attached: live.reduce((n, s) => n + s.shells.filter((sh) => sh.attached).length, 0),
          // Memory the replay buffers hold, and output a page coming back would miss.
          buffered: live.reduce((n, s) => n + s.shells.reduce((m, sh) => m + (sh.buffer ? sh.buffer.kept : 0), 0), 0),
          overflowing: live.reduce((n, s) => n + s.shells.filter((sh) => sh.buffer && sh.buffer.lostOnReturn > 0).length, 0),
          zombies: live.filter((s) => s.zombie).length,
        },
        totals: tot,
        devices: deviceList,
        sessions: live,
        closed: [...closed].reverse(),
        events: [...events].reverse(),
        sampleMs,
      };
    },

    // The samples for the last `rangeMs`, merged into at most MAX_POINTS
    // buckets: counts keep their peak, byte and request counts add up, memory
    // and CPU keep their peak.
    history(rangeMs) {
      const t = now();
      const range = Math.min(HISTORY_MS, Math.max(sampleMs, rangeMs || 3600 * 1000));
      const from = t - range;
      const bucketMs = Math.max(sampleMs, Math.ceil(range / MAX_POINTS / sampleMs) * sampleMs);
      const buckets = new Map();
      for (const s of samples) {
        if (s.t < from) continue;
        const key = Math.floor(s.t / bucketMs) * bucketMs;
        const b = buckets.get(key);
        if (!b) {
          buckets.set(key, { ...s, t: key });
          continue;
        }
        for (const k of ['devices', 'sessions', 'shells', 'zombies', 'rss', 'heapUsed', 'cpu']) b[k] = Math.max(b[k], s[k]);
        for (const k of ['sshIn', 'sshOut', 'wsIn', 'wsOut', 'requests']) b[k] += s[k];
      }
      return { now: t, from, range, bucketMs, sampleMs, points: [...buckets.values()] };
    },

    stop() {
      clearInterval(timer);
      loopDelay.disable();
    },
  };
}

module.exports = { createMonitor, describeAgent, plainIp };
