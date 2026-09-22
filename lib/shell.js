// Bridges a WebSocket to an SSH shell channel. Binary frames carry terminal
// bytes both ways; text frames are JSON control messages.
//
// iOS Safari drops sockets when the app is backgrounded, so a shell outlives
// its socket for the connection's background time (retention(): taken when
// the socket goes, and kept until the next time however the settings change;
// Forever sets no timer at all). A new socket for the same shell takes it
// over and first receives the last bufferBytes() of output (the admin page's
// setting, 256 KB by default) to repaint the screen.
//
// A socket has to say which shell it wants and hold its attachment lease: a
// secret the page chose when it created the shell (`create`), or one the
// server issued when the page attached to the shell explicitly (takeOver(),
// which the page asks for through POST /api/sessions/:id/attach). A new lease
// replaces the old, so a page holding an old one cannot come back: it is told
// `superseded`. Resuming a shell that is gone is refused (`gone`) instead of
// quietly opening a new one; only `create` opens a shell, and creating one
// that exists with the same lease resumes it, so a page may retry a create
// whose answer it never got.
// When that leaves out older output, the hello says so (`historyLost`, with
// `lostBytes` the page never got): a program that only redraws what changes
// cannot be rebuilt from a tail. `fullScreen` says whether one is on screen
// (the alternate screen is on); a plain shell only lost old scrollback.
//
// On a bad cell link the replay has to survive a slow, lossy pipe, so it goes
// out in REPLAY_CHUNK pieces: a WebSocket message only reaches the page once
// the whole frame has arrived, and a 64 KB frame cut short is thrown away.
//
// The page resets its terminal before a replay, so the replay starts with the
// modes (mouse reporting, alternate screen...) set by output it leaves out.
//
// Output and input are counted in bytes. A page that reconnects says how much
// output it has (`have`), and when the buffer still holds everything after
// that, gets only the missing part and keeps its screen: a blip on a slow link
// costs nothing instead of a full repaint. The hello and every pong carry how
// much input the shell has taken (`in`), so the page can resend keystrokes
// that went into a socket that died, and only those.
//
// Output waits for the page: the SSH channel is paused, and the remote program
// blocks as it would on a real terminal, while more than HIGH_WATER bytes wait
// for the socket or more than WINDOW bytes are unacknowledged. The page
// acknowledges output with {"t":"ack","pos":n} as it goes.
// The socket alone is not enough: compressed output fits megabytes into the
// operating system's socket buffers, out of sight. Reading on regardless
// would queue everything a runaway command prints for a phone that takes
// minutes to receive it, and Ctrl+C would only show after all of that. What
// still comes after Ctrl+C is bounded by SSH's own 2 MB channel window, as
// with any SSH client.
const crypto = require('crypto');
const WebSocket = require('ws');
const { TermModes } = require('./term-modes');
const { timerAt } = require('./deadline');

const BUFFER_BYTES = 1024 * 1024; // unless attach() is given bufferBytes
const REPLAY_CHUNK = 8 * 1024;
const MAX_SKIP = 256; // past the longest sequence TermModes follows
const HIGH_WATER = 64 * 1024;
const WINDOW = 256 * 1024;

// Only a number or a numeric string: Number() on an arbitrary JSON object can
// throw (a "toString" that is not a function).
const clampSize = (n, fallback) => {
  const v = typeof n === 'number' ? n : typeof n === 'string' ? Number(n) : NaN;
  return Number.isInteger(v) && v > 0 && v <= 1000 ? v : fallback;
};

function sendJson(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function frames(buf) {
  const out = [];
  for (let i = 0; i < buf.length; i += REPLAY_CHUNK) out.push(buf.subarray(i, i + REPLAY_CHUNK));
  return out;
}

// How much output the page says it has: a plain count, or null.
const position = (value) => (/^\d{1,15}$/.test(value || '') ? Number(value) : null);

const LEASE = /^[\w-]{16,128}$/;
const newLease = () => crypto.randomBytes(24).toString('base64url');

function sameLease(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function createShell(session, id, { sessions, lease, retention, bufferBytes = () => BUFFER_BYTES }) {
  const stats = session.stats;
  const shell = {
    id,
    bufferBytes,
    lease,
    // Counts the leases: one more each time an explicit attach replaces it.
    revision: 1,
    ws: null,
    stream: null,
    chunks: [], // { data, start, injected }: start is the output offset of data
    size: 0,
    outPos: 0, // output bytes so far (what the program printed)
    inPos: 0, // input bytes written to the shell
    paused: false,
    modes: new TermModes(), // as of the start of chunks[0]
    attaches: 0,
    detachTimer: null,
    detachedAt: null, // when its last socket went away, while it has none
    detachedOut: 0, // outPos then: what the page that left had, about
    // While it has no socket: the background time it got then, and when that
    // runs out (null for Forever).
    retention: null,
    deadline: null,
    ended: false,

    // Its socket went (or was taken away): the background time starts now.
    detach() {
      this.ws = null;
      this.detachedAt = Date.now();
      this.detachedOut = this.outPos;
      this.flow(); // with no page, output only goes to the replay buffer
      if (this.ended) return;
      const { minutes, ms } = retention();
      this.retention = minutes;
      this.deadline = ms === null ? null : this.detachedAt + ms;
      if (ms !== null) this.detachTimer = timerAt(this.deadline, () => this.end('detached too long'));
    },

    // A socket has it again.
    attached(ws) {
      if (this.detachTimer) this.detachTimer.clear();
      this.detachTimer = null;
      this.detachedAt = null;
      this.retention = null;
      this.deadline = null;
      this.ws = ws;
    },

    // An explicit attach: a new lease, which the socket on it now (if any)
    // does not have, so it is told it was replaced and let go.
    takeOver() {
      this.lease = newLease();
      this.revision++;
      const old = this.ws;
      if (old) {
        this.detach();
        sendJson(old, { t: 'replaced' });
        old.close(4000, 'replaced');
      }
      return this.lease;
    },

    // Injected bytes (the page turning mouse reporting off) are replayed but
    // are not program output, so they take no room in outPos.
    record(data, injected = false) {
      this.chunks.push({ data, start: this.outPos, injected });
      if (!injected) this.outPos += data.length;
      this.size += data.length;
      this.trim();
    },

    // Drops the oldest chunks the limit no longer needs; also when the limit
    // has just been lowered.
    trim() {
      const limit = this.bufferBytes();
      while (this.chunks.length > 1 && this.size - this.chunks[0].data.length >= limit) {
        const dropped = this.chunks.shift();
        this.size -= dropped.data.length;
        this.modes.feed(dropped.data);
      }
    },

    // How full the buffer is, for the admin page. `kept`: what a replay would
    // send; `sinceDetach`: output since the page left, and `lostOnReturn` the
    // part of it a page coming back now would not get.
    buffer() {
      const limit = this.bufferBytes();
      const kept = Math.min(this.size, limit);
      const detached = !this.ws && this.detachedAt !== null;
      const sinceDetach = detached ? this.outPos - this.detachedOut : 0;
      return {
        limit,
        kept,
        sinceDetach,
        lostOnReturn: detached ? Math.max(0, this.outPos - kept - this.detachedOut) : 0,
      };
    },

    // The output after the first `have` bytes, or null when the buffer no
    // longer reaches back that far (or `have` is not a position at all).
    since(have) {
      if (have === null || have > this.outPos) return null;
      if (this.chunks.length && have < this.chunks[0].start) return null;
      // Program output only, so the page can count it: the page that turned
      // mouse reporting off did so on its own screen already.
      const parts = [];
      for (const { data, start, injected } of this.chunks) {
        if (!injected && start + data.length > have) parts.push(data.subarray(Math.max(0, have - start)));
      }
      return frames(Buffer.concat(parts));
    },

    // Sends output to the page, pausing the program while the page is behind.
    send(chunk) {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(chunk, () => this.flow());
      if (!this.paused && this.stream && this.behind(ws, 1)) {
        this.paused = true;
        stats.pauses++;
        this.stream.pause();
      }
    },

    behind(ws, share) {
      return ws.bufferedAmount > HIGH_WATER * share || this.outPos - ws.acked > WINDOW * share;
    },

    // Output moves again once the page has caught up halfway, or has gone.
    flow() {
      if (!this.paused) return;
      const ws = this.ws;
      if (ws && ws.readyState === WebSocket.OPEN && this.behind(ws, 0.5)) return;
      this.paused = false;
      if (this.stream) this.stream.resume();
    },

    ack(ws, pos) {
      if (!Number.isSafeInteger(pos) || pos < 0 || pos > this.outPos) return;
      ws.acked = Math.max(ws.acked, pos);
      this.flow();
    },

    // The recent output, split so each frame lands on its own. It starts on
    // a character boundary outside any escape sequence: a cut sequence would
    // print its tail as text and lose the mode it sets.
    replay() {
      const all = Buffer.concat(this.chunks.map((c) => c.data));
      let cut = Math.max(0, all.length - this.bufferBytes());
      const modes = this.modes.clone();
      modes.feed(all.subarray(0, cut));
      const limit = Math.min(all.length, cut + MAX_SKIP);
      while (cut < limit && (modes.inSequence || (all[cut] & 0xc0) === 0x80)) {
        modes.feed(all.subarray(cut, cut + 1));
        cut++;
      }
      // Where the replay starts in the program's output: anything before that
      // is gone, and a screen rebuilt without it may be incomplete.
      let start = this.outPos;
      let at = 0;
      for (const { data, start: from, injected } of this.chunks) {
        if (at + data.length > cut) {
          start = injected ? from : from + Math.max(0, cut - at);
          break;
        }
        at += data.length;
      }
      // Only worth reading through the whole tail when something is missing.
      let fullScreen = false;
      if (start > 0) {
        const now = modes.clone();
        now.feed(all.subarray(cut));
        fullScreen = now.alternateScreen;
      }
      return { frames: frames(Buffer.concat([Buffer.from(modes.restore()), all.subarray(cut)])), start, fullScreen };
    },

    // Called when the channel closes or the session goes away.
    end(reason, code) {
      if (this.ended) return;
      this.ended = true;
      if (this.detachTimer) this.detachTimer.clear();
      session.shells.delete(id);
      if (this.ws) {
        sendJson(this.ws, { t: 'exit', reason, code });
        this.ws.close(1000, 'shell ended');
        this.ws = null;
      }
      if (this.stream) this.stream.close();
      sessions.shellEnded(session, reason === 'detached too long');
    },
  };
  session.shells.set(id, shell);
  sessions.shellOpened(session);
  return shell;
}

// Refuses a socket after the upgrade, so a browser (which cannot see why an
// upgrade failed) is told: `gone` or `superseded`.
function refuse(ws, t, code, message) {
  sendJson(ws, { t, message });
  ws.close(code, t);
}

function attach({ ws, session, sessions, shellId, lease, create, cols, rows, have, retention, bufferBytes }) {
  cols = clampSize(cols, 80);
  rows = clampSize(rows, 24);
  let shell = session.shells.get(shellId);
  if (!shell && !create) return refuse(ws, 'gone', 4404, 'This shell has ended.');
  if (shell && !sameLease(shell.lease, lease)) return refuse(ws, 'superseded', 4409, 'This shell was opened somewhere else.');
  const resumed = !!shell;
  const stats = session.stats;
  stats.attaches++;
  if (resumed) stats.reconnects++;
  // Counting from the start: the first ack is a round trip away, and a
  // runaway command fills megabytes of socket buffers in that time.
  ws.acked = shell ? shell.outPos : 0;

  if (shell) {
    shell.attaches++;
    // The same lease on another socket: the same page, back before its old
    // socket was noticed gone (or a copy of the page, which is told).
    if (shell.ws) {
      sendJson(shell.ws, { t: 'replaced' });
      shell.ws.close(4000, 'replaced');
    }
    shell.attached(ws);
    shell.flow(); // the old socket's backlog is not this one's
    if (shell.stream) {
      const had = position(have);
      const missing = shell.since(had);
      const full = missing ? null : shell.replay();
      const buffered = missing || full.frames;
      // The client holds its old screen until the first replay frame, so tell
      // it up front whether a repaint is on the way, or just what it missed.
      // A repaint that leaves out earlier output may not rebuild the screen
      // (htop only redraws what changes): the page tells its user so.
      const replay = buffered.reduce((n, b) => n + b.length, 0);
      const historyLost = !!full && full.start > 0;
      const lost = historyLost ? { lostBytes: full.start - (had !== null && had < full.start ? had : 0), fullScreen: full.fullScreen } : {};
      if (!missing) stats.repaints++;
      if (historyLost) stats.lostBytes += lost.lostBytes;
      sendJson(ws, { t: 'hello', resumed: true, reset: !missing, replay, pos: shell.outPos, in: shell.inPos, historyLost, ...lost });
      for (const chunk of buffered) shell.send(chunk);
      shell.stream.setWindow(rows, cols, 0, 0);
    }
  } else {
    shell = createShell(session, shellId, { sessions, lease, retention, bufferBytes });
    shell.attaches = 1;
    shell.attached(ws);
    session.client.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
      if (err) {
        sendJson(shell.ws, { t: 'error', message: `Could not open a shell: ${err.message}` });
        return shell.end('open failed');
      }
      if (shell.ended) return stream.close();
      shell.stream = stream;
      // ssh2 buffers 2 MB in the stream while paused, on top of the channel
      // window; a pty's worth is plenty to resume from.
      if (stream._readableState) stream._readableState.highWaterMark = HIGH_WATER;
      let exitCode;
      stream.on('exit', (code) => { exitCode = code; });
      stream.on('data', (chunk) => {
        shell.record(chunk);
        shell.send(chunk);
      });
      stream.on('close', () => shell.end('exited', exitCode));
      // A socket may have replaced this one while the shell was opening.
      sendJson(shell.ws, { t: 'hello', resumed: shell.attaches > 1, reset: false, replay: 0, pos: shell.outPos, in: shell.inPos, historyLost: false });
    });
  }

  ws.on('message', (data, isBinary) => {
    if (shell.ws !== ws) return;
    sessions.touch(session);
    if (isBinary) {
      if (shell.stream) {
        shell.stream.write(data);
        shell.inPos += data.length;
      }
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    // A phone cannot see a WebSocket ping, so it probes at the app level: a
    // dead cell link leaves the socket "open" in the browser for minutes.
    if (msg.t === 'ping') return sendJson(ws, { t: 'pong', in: shell.inPos });
    if (msg.t === 'ack') return shell.ack(ws, msg.pos);
    // The page found mouse reporting left on by a program that has ended and
    // turned it off; replays turn it off at the same point.
    if (msg.t === 'mouse-off') return shell.record(Buffer.from('\x1b[?1000l'), true);
    if (msg.t === 'resize' && shell.stream) {
      shell.stream.setWindow(clampSize(msg.rows, 24), clampSize(msg.cols, 80), 0, 0);
    }
  });

  ws.on('close', (code) => {
    // 1006: the socket died (a phone gone, a cut link, the heartbeat giving
    // up) rather than being closed by either end.
    if (code === 1006) stats.drops++;
    if (shell.ws !== ws) return;
    shell.detach();
    sessions.touch(session);
  });

  sessions.touch(session);
  return resumed;
}

module.exports = { attach, LEASE };
