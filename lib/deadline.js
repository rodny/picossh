// A timer for a moment in time rather than a delay. setTimeout takes at most
// 2^31-1 ms (about 24.8 days) and fires at once for anything longer, so a
// far deadline is reached in steps. Unreferenced: a pending expiry never keeps
// the process alive.
const MAX_TIMER_MS = 2 ** 31 - 1;

function timerAt(deadline, fn) {
  const handle = { timer: null, clear() { clearTimeout(this.timer); } };
  const arm = () => {
    const left = deadline - Date.now();
    if (left <= 0) return fn();
    handle.timer = setTimeout(arm, Math.min(left, MAX_TIMER_MS));
    handle.timer.unref();
  };
  handle.timer = setTimeout(arm, Math.min(Math.max(0, deadline - Date.now()), MAX_TIMER_MS));
  handle.timer.unref();
  return handle;
}

module.exports = { timerAt, MAX_TIMER_MS };
