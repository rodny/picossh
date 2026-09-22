// picossh client: views, API calls, terminals, file manager, snippets, passkeys.
// Plain browser JS, no build step. xterm.js and the fit addon are loaded as
// globals; keyboard.js provides window.ExtraKeys, mobile-keyboard.js
// window.MobileKeyboard.
'use strict';
(() => {
  // ================================================================ helpers

  const $ = (id) => document.getElementById(id);

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    let value;
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'value') value = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (typeof v === 'boolean' && k in el) el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat(Infinity)) {
      if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
    }
    if (value !== undefined) el.value = value; // after children, so <select> has its options
    return el;
  }

  // A Material icon from the sprite in index.html (<symbol id="i-name">).
  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  }

  // Motion on the curve iOS uses for sheets and its keyboard. With Reduce
  // Motion on, things appear and go at once.
  const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

  const makeStorage = (area) => ({
    get(key, fallback = null) {
      try {
        const raw = window[area].getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try { window[area].setItem(key, JSON.stringify(value)); } catch {}
    },
    remove(key) {
      try { window[area].removeItem(key); } catch {}
    },
  });
  const local = makeStorage('localStorage');
  const session = makeStorage('sessionStorage');

  const KEYS = {
    // sessionStorage, per tab: { [connectionId]: { serverId, meta, shellId, lease, creating, superseded, panel } },
    // what it takes to resume each terminal this tab has open, and the panel it was left on.
    sessions: 'picossh.terminals',
    active: 'picossh.active', // the connection id of the terminal on screen
    lock: 'picossh.lock',
    fullscreen: 'picossh.fullscreen',
    noWebgl: 'picossh.terminal.noWebgl', // Settings: always use the DOM renderer
    installHintDismissed: 'picossh.installHint.dismissed',
    hiddenAt: 'picossh.hiddenAt',
    showHidden: 'picossh.files.hidden',
    editorWrap: 'picossh.editor.wrap',
    editorLineNumbers: 'picossh.editor.lineNumbers',
    editorIndent: 'picossh.editor.indent', // 'tab-4', 'space-2', ...
    editorDraft: 'picossh.editor.draft', // sessionStorage: unsaved text survives a reload
    editorFind: 'picossh.editor.find', // find toggles: case, whole word, regex, preserve case
  };
  const LOCK_AFTER_MS = 5 * 60 * 1000;

  const debounce = (fn, ms) => {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  };

  const randomId = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  };

  function formatSize(n) {
    if (n === undefined || n === null) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024;
      i++;
    }
    return `${i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
  }

  // "About 3.2 MB", or "Some" when the server did not say.
  function lostAmount(bytes) {
    return typeof bytes === 'number' && bytes > 0 ? `About ${formatSize(bytes)}` : 'Some';
  }

  function formatDate(value) {
    const d = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
    if (isNaN(d)) return '';
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleString(undefined, sameYear
      ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
      : { year: 'numeric', month: 'short', day: 'numeric' });
  }

  // Every notice: at the top of the screen, clear of the keys and sheets.
  // Longer by default for errors; `ms` for a notice that needs reading.
  let toastTimer;
  function toast(message, isError, ms) {
    const el = $('toast');
    el.textContent = '';
    el.append(icon(isError ? 'warning' : 'check'), h('span', { text: message }));
    el.classList.toggle('error', !!isError);
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms || (isError ? 4500 : 2500));
  }

  function field(label, input, hint) {
    return h('label', { class: 'field' }, h('span', { class: 'label', text: label }), input, hint && h('span', { class: 'hint', text: hint }));
  }

  // Puts an eye button inside a password field that shows what is typed until
  // pressed again. Wraps the input where it stands; returns the wrapper, whose
  // hide() puts the dots back.
  function revealable(input) {
    const button = h('button', { type: 'button', class: 'reveal-btn', 'aria-pressed': 'false' }, icon('eye'));
    const wrap = h('div', { class: 'reveal' });
    if (input.parentNode) input.replaceWith(wrap);
    wrap.append(input, button);
    const show = (shown) => {
      input.type = shown ? 'text' : 'password';
      const label = shown ? 'Hide password' : 'Show password';
      button.setAttribute('aria-pressed', String(shown));
      button.setAttribute('aria-label', label);
      button.title = label;
      button.querySelector('use').setAttribute('href', shown ? '#i-eye-off' : '#i-eye');
    };
    show(false);
    // The button must not take focus, or the iOS keyboard closes mid-password.
    button.addEventListener('mousedown', (e) => e.preventDefault());
    button.addEventListener('click', () => show(input.type === 'password'));
    wrap.hide = () => show(false);
    return wrap;
  }

  const noAutoText = { autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', autocomplete: 'off' };

  // Tap and long-press on the same element.
  function onPress(el, { tap, long }) {
    let timer;
    let fired = false;
    let x = 0;
    let y = 0;
    const cancel = () => clearTimeout(timer);
    el.addEventListener('pointerdown', (e) => {
      fired = false;
      x = e.clientX;
      y = e.clientY;
      cancel();
      timer = setTimeout(() => {
        fired = true;
        if (navigator.vibrate) navigator.vibrate(15);
        long();
      }, 550);
    });
    el.addEventListener('pointermove', (e) => { if (Math.hypot(e.clientX - x, e.clientY - y) > 10) cancel(); });
    el.addEventListener('pointerup', cancel);
    el.addEventListener('pointercancel', cancel);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('click', (e) => {
      if (fired) {
        fired = false;
        e.preventDefault();
        return;
      }
      tap(e);
    });
  }

  // ==================================================================== api

  // Counts sign-ins. A 401 for a request sent before the latest one (the
  // page's first load, answered late) must not sign the new session out.
  let signIns = 0;

  const networkError = () => Object.assign(new Error('Network error. Is the server reachable?'), { status: 0 });
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Gzipped text, for request bodies worth shrinking before a slow uplink.
  async function gzipped(text) {
    if (!window.CompressionStream) return null;
    try {
      return await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
    } catch {
      return null;
    }
  }

  // One HTTP request over XMLHttpRequest, for its progress events: on a
  // stalled link a request can hang for minutes, so one whose bytes stop
  // moving either way for `stall` ms is given up, however long it has been
  // going. `timeout` caps the whole request; `signal` aborts it. Resolves
  // { status, text } (or { status, bytes } for `binary`) and header(name).
  function request(method, url, { headers = {}, body, timeout, stall, signal, onUpload, binary = false } = {}) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, url);
      if (signal) signal.addEventListener('abort', () => xhr.abort());
      if (binary) xhr.responseType = 'arraybuffer';
      xhr.setRequestHeader('X-Requested-With', 'fetch');
      for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
      if (timeout) xhr.timeout = timeout;
      let timer = null;
      const watch = () => {
        clearTimeout(timer);
        if (stall) timer = setTimeout(() => xhr.abort(), stall);
      };
      const fail = () => {
        clearTimeout(timer);
        reject(networkError());
      };
      xhr.onprogress = watch;
      xhr.upload.onprogress = (e) => {
        watch();
        if (onUpload) onUpload(e.loaded);
      };
      xhr.onload = () => {
        clearTimeout(timer);
        const header = (name) => xhr.getResponseHeader(name);
        if (binary) resolve({ status: xhr.status, bytes: new Uint8Array(xhr.response || new ArrayBuffer(0)), header });
        else resolve({ status: xhr.status, text: xhr.responseText, header });
      };
      xhr.onerror = xhr.onabort = xhr.ontimeout = fail;
      watch();
      xhr.send(body === undefined ? null : body);
    });
  }

  // `retries` sends a request that failed on the network again: only for ones
  // that are safe to repeat. `compress` gzips a large JSON body.
  async function api(method, url, body, { timeout, stall, retries = 0, compress = false } = {}) {
    const sentAt = signIns;
    const headers = {};
    let payload;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
      const gz = compress && payload.length > 4096 ? await gzipped(payload) : null;
      if (gz) {
        headers['Content-Encoding'] = 'gzip';
        payload = gz;
      }
    }
    let res;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await request(method, url, { headers, body: payload, timeout, stall });
        if (res.status) break;
      } catch {}
      if (attempt >= retries) throw networkError();
      await delay(1000 * 2 ** attempt);
    }
    const text = res.text;
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { error: text.slice(0, 200) };
    }
    const signingIn = url === '/login' || url.startsWith('/api/passkeys/login');
    if (res.status === 401 && !signingIn && sentAt === signIns) onUnauthorized();
    if (res.status < 200 || res.status >= 300) throw Object.assign(new Error((data && data.error) || `HTTP ${res.status}`), { status: res.status, data: data || {} });
    return data;
  }

  // Reordering a list by dragging one item's handle. The list itself holds
  // still: the item stays where it was, faded, a copy of it rides under the
  // finger, and a line is drawn in the gap the item would drop into. Letting go
  // moves it there and hands back the new order of the children's data-id; a
  // cancelled gesture puts everything back untouched. Scrolls the list when the
  // finger reaches its top or bottom edge. The listeners are on the window
  // because the finger leaves the handle as soon as it moves; touch-action:
  // none on the handle is what keeps the page from scrolling with the drag.
  function startReorder(e, done) {
    if (e.button) return;
    e.preventDefault();
    const item = e.currentTarget.closest('[data-id]');
    const list = item.parentElement;
    const pointer = e.pointerId;
    const startY = e.clientY;
    const scroller = list.closest('.sheet-body') || list.closest('.scroll');
    const order = () => Array.from(list.children, (c) => c.dataset.id).filter(Boolean);
    const was = order().join();

    const box = item.getBoundingClientRect();
    const ghost = item.cloneNode(true);
    ghost.classList.add('drag-ghost');
    ghost.style.cssText = `left:${box.left}px;top:${box.top}px;width:${box.width}px;height:${box.height}px`;
    const line = h('div', { class: 'drop-line' });
    item.classList.add('drag-source');
    document.body.append(ghost);
    list.append(line); // absolutely positioned, so it costs the list no room

    // The gap the item would drop into: before `next`, after the item above it.
    let next = null;
    const aim = (y) => {
      const items = Array.from(list.children).filter((el) => el.dataset.id);
      let at = items.findIndex((other) => {
        const r = other.getBoundingClientRect();
        return y < r.top + r.height / 2;
      });
      if (at < 0) at = items.length;
      next = items[at] || null;
      const above = items[at - 1];
      let edge;
      if (above && next) edge = (above.getBoundingClientRect().bottom + next.getBoundingClientRect().top) / 2;
      else if (next) edge = next.getBoundingClientRect().top;
      else edge = above.getBoundingClientRect().bottom;
      const rect = list.getBoundingClientRect();
      line.style.top = `${Math.max(0, Math.min(rect.height - 2, edge - rect.top - 1))}px`;
    };
    aim(startY);

    const stop = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', drop);
      removeEventListener('pointercancel', stop);
      ghost.remove();
      line.remove();
      item.classList.remove('drag-source');
    };
    const move = (ev) => {
      if (ev.pointerId !== pointer) return;
      const view = scroller ? scroller.getBoundingClientRect() : null;
      if (view && ev.clientY < view.top + 40) scroller.scrollTop -= 12;
      else if (view && ev.clientY > view.bottom - 40) scroller.scrollTop += 12;
      ghost.style.transform = `translateY(${ev.clientY - startY}px)`;
      aim(ev.clientY);
    };
    const drop = (ev) => {
      if (ev.pointerId !== pointer) return;
      stop();
      list.insertBefore(item, next); // next === item, or null, both land right
      const ids = order();
      if (ids.join() !== was) done(ids);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', drop);
    addEventListener('pointercancel', stop);
  }

  // The handle that reorders one row of a list: drag it, or focus it and press
  // Up or Down. Either way `apply` is handed the new order of the rows' data-id.
  // `ids` is the order the list was drawn from and `index` this row's place in
  // it; `name` is what the row is called, for a screen reader.
  let handleToFocus = null;

  function dragHandle({ name, ids, index, apply }) {
    const nudge = (to) => {
      if (to < 0 || to >= ids.length) return;
      const moved = [...ids];
      [moved[index], moved[to]] = [moved[to], moved[index]];
      handleToFocus = ids[index];
      apply(moved);
    };
    return h('button', {
      type: 'button', class: 'drag-handle', 'aria-label': `Move ${name}`, title: 'Drag to reorder',
      onpointerdown: (e) => startReorder(e, apply),
      onkeydown: (e) => {
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        e.preventDefault();
        nudge(e.key === 'ArrowUp' ? index - 1 : index + 1);
      },
    }, icon('drag'));
  }

  // Applying an order redraws the list, so the handle that moved by keyboard
  // asks for focus back once it is on the page again. Every redraw of a
  // reorderable list ends here; only the list holding that row answers.
  function restoreHandle(list) {
    if (!handleToFocus) return;
    const handle = list.querySelector(`[data-id="${CSS.escape(handleToFocus)}"] .drag-handle`);
    if (!handle) return;
    handle.focus();
    handleToFocus = null;
  }

  // ================================================================== state

  const state = {
    authed: false,
    view: 'loading',
    homeTab: 'servers',
    panel: 'terminal', // the panel on screen: the active connection's own (TermSession.panel)
    servers: [],
    snippets: [],
    keys: [],
    passkeys: { count: 0, credentials: [] },
    settings: { dnsServers: [], envDnsServers: [], backgroundMinutes: 60 },
    sessions: new Map(), // connection id -> TermSession
    activeId: null, // connection id
    connecting: new Set(), // server ids with a connection attempt under way
    // The Connections tab: this device's connections as the server last
    // listed them (null until the first answer), the server's clock minus
    // ours, and whether the latest refresh failed.
    connections: { list: null, skew: 0, fetchedAt: 0, error: null, loading: false, request: 0, inFlight: null, again: false },
    cardErrors: new Map(),
    locked: false,
  };

  const activeSession = () => (state.activeId && state.sessions.get(state.activeId)) || null;

  // A field in a view being hidden keeps focus on iOS. On phones the terminal's
  // has inputmode=none (it has its own keyboard), and while it holds focus iOS
  // does not open the system keyboard for the editor or other fields.
  function blurHidden(container) {
    const el = document.activeElement;
    if (el && el !== document.body && container.contains(el) && el.blur) el.blur();
  }

  // Deeper in, left to right: a view further along pushes in from the right,
  // and going back slides the earlier one in from the left. Others fade in.
  const VIEWS = ['home', 'session', 'editor'];

  function showView(name) {
    if (state.view === 'session' && name !== 'session') resetTerminalInput();
    slideDirection($('app'), VIEWS, state.view, name);
    for (const v of document.querySelectorAll('.view:not(#view-lock)')) {
      const active = v.id === `view-${name}`;
      if (!active) blurHidden(v);
      v.classList.toggle('active', active);
    }
    state.view = name;
    syncConnectionsPolling();
  }

  // =============================================================== viewport

  // iOS keeps the layout viewport full height when the keyboard opens; size
  // the app to the visual viewport so the terminal and key bar stay visible.
  // Scrolls the focused sheet field into the visible part of its sheet.
  function revealFocused() {
    const el = document.activeElement;
    const body = el && el.closest && el.closest('.sheet-body');
    if (!body) return;
    const box = body.getBoundingClientRect();
    const target = (el.closest('.field') || el).getBoundingClientRect();
    const margin = 12;
    if (target.bottom > box.bottom - margin) body.scrollTop += target.bottom - box.bottom + margin;
    else if (target.top < box.top + margin) body.scrollTop -= box.top + margin - target.top;
  }
  const revealFocusedLater = debounce(revealFocused, 60);

  function setupViewport() {
    // The keyboard animates in after focus; resize events cover most of it,
    // this catches focus moving between fields while it is already open.
    document.addEventListener('focusin', (e) => {
      if (e.target.closest && e.target.closest('.sheet')) setTimeout(revealFocused, 350);
    });
    // Before a tap moves focus: iOS keeps focus on a field that is no longer on
    // screen (a hidden view, a closed find bar), and while it has it, tapping
    // another field may not bring up the keyboard.
    document.addEventListener('touchstart', () => {
      const el = document.activeElement;
      if (el && el !== document.body && el.blur && !el.getClientRects().length) el.blur();
    }, { capture: true, passive: true });

    const vv = window.visualViewport;
    const app = $('app');
    const fitLater = debounce(() => {
      const s = activeSession();
      if (s) s.fit();
    }, 100);
    const root = document.documentElement;
    const apply = () => {
      // The app is pinned to the layout viewport's edges (CSS top/bottom) and
      // shrinks to the visible part only while the keyboard takes space.
      const layoutHeight = Math.max(window.innerHeight, root.clientHeight);
      const keyboard = !!vv && layoutHeight - vv.height > 120;
      const top = keyboard ? vv.offsetTop : 0;
      const gap = keyboard ? Math.max(0, layoutHeight - vv.offsetTop - vv.height) : 0;
      root.style.setProperty('--vvtop', `${top}px`);
      root.style.setProperty('--vvgap', `${gap}px`);
      document.body.classList.toggle('kb-open', keyboard);
      if (window.scrollY) window.scrollTo(0, 0);
      fitLater();
      revealFocusedLater();
    };
    if (vv) {
      vv.addEventListener('resize', apply);
      vv.addEventListener('scroll', apply);
    }
    window.addEventListener('resize', apply);
    window.addEventListener('orientationchange', apply);
    PhoneTerminal.media.addEventListener('change', apply);
    apply();
  }

  // ================================================================= sheets

  let currentSheet = null;

  // A sheet's header buttons, iOS style: a round × (or ‹ for `back`, when
  // closing returns to the sheet this one came from) on the left, and a round ✓
  // on the right that submits the form in its body.
  const roundBtn = (name, label, props) =>
    h('button', { type: 'button', class: 'round-btn', 'aria-label': label, title: label, ...props }, icon(name));
  const saveBtn = (label) => roundBtn('check', label, { type: 'submit', form: 'sheet-form', class: 'round-btn primary' });

  // `tall`: a long form, given the whole height like an iOS page sheet;
  // anything else is only as tall as what it holds.
  function openSheet(title, body, { onClose, save, back = false, tall = false } = {}) {
    closeSheet();
    const closeBtn = back ? roundBtn('back', 'Back') : roundBtn('close', 'Close');
    if (save) body.id = 'sheet-form';
    const sheet = h('div', { class: `sheet${tall ? ' tall' : ''}`, role: 'dialog', 'aria-label': title },
      h('div', { class: 'sheet-head' }, closeBtn, h('h2', { text: title }), save || h('span', { class: 'round-btn-space' })),
      h('div', { class: 'sheet-body' }, body));
    const backdrop = h('div', { class: 'sheet-backdrop' }, sheet);
    const entry = {
      close() {
        if (currentSheet !== entry) return;
        currentSheet = null;
        backdrop.remove();
        if (onClose) onClose();
        focusTerminal();
      },
    };
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) entry.close(); });
    closeBtn.addEventListener('click', () => entry.close());
    $('sheet-root').append(backdrop);
    currentSheet = entry;
    return () => entry.close();
  }

  function closeSheet() {
    if (currentSheet) currentSheet.close();
  }

  // Resolves with { name: value } or null when dismissed.
  function formSheet({ title, message, fields, submit = 'OK', back = false }) {
    return new Promise((resolve) => {
      let submitted = false;
      const inputs = {};
      const form = h('form', { novalidate: true },
        message && h('p', { class: 'muted mono', text: typeof message === 'string' ? message : null, style: 'white-space:pre-wrap;overflow-wrap:anywhere' }, typeof message === 'string' ? null : message),
        fields.map((f) => {
          const input = f.multiline
            ? h('textarea', { class: 'textarea', placeholder: f.placeholder, value: f.value || '', ...noAutoText })
            : h('input', { class: 'input', type: f.type || 'text', placeholder: f.placeholder, value: f.value || '', ...noAutoText, autocomplete: f.autocomplete || 'off' });
          inputs[f.name] = input;
          return field(f.label, f.type === 'password' ? revealable(input) : input, f.hint);
        }));
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        submitted = true;
        const values = {};
        for (const [name, input] of Object.entries(inputs)) values[name] = input.value;
        close();
        resolve(values);
      });
      const close = openSheet(title, form, { save: saveBtn(submit), back, onClose: () => { if (!submitted) resolve(null); } });
      const first = Object.values(inputs)[0];
      if (first) {
        first.focus();
        if (fields[0].select) first.select();
      }
    });
  }

  // Resolves true/false. Stacks above an open sheet instead of replacing it, and
  // unlike confirm() does not make the browser leave full screen.
  function confirmSheet(message, { confirm = 'OK', danger = false } = {}) {
    return new Promise((resolve) => {
      const done = (value) => {
        backdrop.remove();
        resolve(value);
      };
      const backdrop = h('div', { class: 'sheet-backdrop confirm-backdrop' },
        h('div', { class: 'sheet confirm-sheet', role: 'alertdialog', 'aria-label': message },
          h('div', { class: 'sheet-body' },
            h('p', { class: 'confirm-message', text: message }),
            h('div', { class: 'sheet-actions' },
              h('button', { type: 'button', class: `btn block ${danger ? 'danger' : 'primary'}`, 'data-confirm': 'yes', text: confirm, onclick: () => done(true) }),
              h('button', { type: 'button', class: 'btn block', 'data-confirm': 'no', text: 'Cancel', onclick: () => done(false) })))));
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) done(false); });
      $('sheet-root').append(backdrop);
    });
  }

  function actionSheet(title, actions) {
    const close = openSheet(title, h('div', { class: 'action-list' },
      actions.filter(Boolean).map((a) => h('button', {
        type: 'button',
        class: `btn block${a.danger ? ' danger' : ''}`,
        text: a.label,
        onclick: () => {
          close();
          a.run();
        },
      }))));
  }

  // ============================================================== terminals

  const encoder = new TextEncoder();
  const INPUT_FRAME_BYTES = 64 * 1024;

  const TERM_THEME = {
    background: '#0e0e0e', foreground: '#eaeaea', cursor: '#eaeaea', cursorAccent: '#0e0e0e',
    selectionBackground: 'rgba(255, 255, 255, 0.25)',
    black: '#212121', red: '#ff7b72', green: '#a5d66f', yellow: '#f0c35b', blue: '#79b8ff', magenta: '#d2a8ff', cyan: '#76e3ea', white: '#d4d4d4',
    brightBlack: '#666666', brightRed: '#ffa198', brightGreen: '#c9f477', brightYellow: '#f8d98b', brightBlue: '#a5d6ff', brightMagenta: '#e2c5ff', brightCyan: '#b3f0f5', brightWhite: '#ffffff',
  };

  // A phone on a bad cell link keeps a dead socket in CONNECTING or OPEN for
  // minutes: no FIN ever arrives, so the browser never fires onclose. Nothing
  // below waits on the browser to notice. Tests shorten these through
  // window.PicoSSH.timings.
  const timings = {
    hello: 10000,   // socket opened but the server never said hello
    ping: 20000,    // app-level liveness probe, also keeps NAT mappings warm
    pong: 10000,    // no answer to a probe: the socket is dead
    check: 8000,    // give up on the "is the session still there" request
    stall: 20000,   // a file transfer or request whose bytes stopped moving
    quiet: 5000,    // typing on a link silent this long checks it is alive
    redraw: 300,    // Force redraw: how long the terminal stays a row smaller
    connections: 10000, // the Connections tab refreshes this often while on screen
  };

  // Output is acknowledged every ACK_EVERY bytes, so the server never has more
  // than a little in flight (see lib/shell.js). Keystrokes the server has not
  // confirmed are kept, up to MAX_UNACKED, to send again after a reconnect.
  const ACK_EVERY = 32 * 1024;
  const MAX_UNACKED = 1024 * 1024;

  const savedSessions = () => session.get(KEYS.sessions, {});
  function forgetSaved(connectionId) {
    const all = savedSessions();
    delete all[connectionId];
    session.set(KEYS.sessions, all);
  }

  // An attachment lease: the secret a socket shows to have its shell. The page
  // picks one when it creates a shell; attaching to one gets a new one from
  // the server (lib/shell.js).
  const newLease = () => randomId() + randomId();

  // Where a connection goes, as it was when it connected: it outlives the
  // saved server being edited or deleted. `id` is the saved server's id.
  const connectionMeta = (info) => ({ id: info.serverId, name: info.name, user: info.user, host: info.host, port: info.port });

  // Chrome's device emulation (DevTools' phone sizes) reports the real screen's
  // pixels to ResizeObserver's device-pixel box but the emulated
  // devicePixelRatio everywhere else. The WebGL renderer sizes its canvas from
  // the first and draws from the second, so after a resize the screen comes out
  // magnified and cut off. Real devices agree; when they do not, the terminal
  // keeps the DOM renderer.
  function devicePixelsAgree() {
    if (!window.ResizeObserverEntry || !('devicePixelContentBoxSize' in ResizeObserverEntry.prototype)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const probe = h('div', { style: 'position:fixed;left:0;top:0;width:100px;height:100px;visibility:hidden;pointer-events:none' });
      const observer = new ResizeObserver(([entry]) => {
        observer.disconnect();
        probe.remove();
        const pixels = entry.devicePixelContentBoxSize?.[0]?.inlineSize;
        resolve(!pixels || Math.abs(pixels - entry.contentRect.width * devicePixelRatio) <= 1);
      });
      document.body.append(probe);
      try {
        observer.observe(probe, { box: 'device-pixel-content-box' });
      } catch {
        observer.disconnect();
        probe.remove();
        resolve(true);
      }
    });
  }

  // One terminal: a shell on one SSH connection (this.id, the connection id),
  // with the lease its socket shows. `server` is where the connection goes,
  // as it was when it connected (connectionMeta). `creating`: the shell is
  // this page's to open, and the server has not said hello on it yet.
  class TermSession {
    constructor(server, info) {
      this.server = server;
      this.id = info.sessionId;
      this.shellId = info.shellId || randomId();
      this.lease = info.lease || newLease();
      this.creating = !!info.creating;
      // The panel it was left on, which it opens on again: a new connection
      // starts on its terminal.
      this.panel = info.panel === 'files' ? 'files' : 'terminal';
      this.status = 'closed';
      this.ws = null;
      this.term = null;
      this.webgl = null;
      this.retries = 0;
      this.retryTimer = null;
      this.everOpened = false;
      this.ended = false; // SSH connection is gone
      this.shellExited = false;
      this.replaced = false;
      this.lastSize = '';
      this.pendingInput = '';
      this.helloTimer = null;
      this.pingTimer = null;
      this.pongTimer = null;
      this.pendingReset = false;
      // Output bytes of this shell on screen, once known (null while a full
      // repaint is still arriving); a reconnect asks only for what follows.
      this.outPos = null;
      this.ackedOut = 0;
      this.replayLeft = 0;
      this.replayPos = 0;
      // A repaint that left out older output may have left gaps on screen: the
      // user is told once the replay is drawn (historyWs, the socket it came
      // on), and the notice stays until they choose what to do about it.
      this.historyNotice = false;
      this.historyWs = null;
      this.historyLoss = null; // what the replay under way on historyWs left out
      this.historyLostBytes = 0; // left out in total, unanswered (null: unknown)
      // Input the server confirmed (a position), and what was sent after it.
      this.inAck = null;
      this.unacked = [];
      this.unackedBytes = 0;
      this.lastFrameAt = 0;
      // back: the folders shown before this one, for the Files topbar's ‹.
      // recent: folders left, newest first, for Go to. This page only.
      this.files = { path: null, items: [], loading: false, error: null, request: 0, back: [], recent: [], listed: new Map() };
      this.el = h('div', { class: 'term' });
      $('terminals').append(this.el);
      this.persist();
    }

    persist() {
      if (this.ended) return;
      const all = savedSessions();
      all[this.id] = {
        serverId: this.server.id, meta: this.server, shellId: this.shellId, lease: this.lease,
        creating: this.creating, superseded: this.replaced, panel: this.panel,
      };
      session.set(KEYS.sessions, all);
    }

    ensureTerminal() {
      if (this.term) return;
      // The keyboard is shared by the views, but a new terminal must not
      // inherit Hide from the connection that was open before it.
      mobileKeyboard.show();
      const term = new Terminal({
        fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
        fontSize: 14,
        scrollback: 2000,
        cursorBlink: true,
        macOptionIsMeta: true,
        theme: TERM_THEME,
      });
      this.fitAddon = new FitAddon.FitAddon();
      term.loadAddon(this.fitAddon);
      term.open(this.el);
      this.term = term;
      this.watchContextLoss();
      this.useWebgl();
      const ta = term.textarea;
      if (ta) {
        for (const [k, v] of Object.entries(noAutoText)) ta.setAttribute(k, v);
        ta.setAttribute('enterkeyhint', 'send');
        setTerminalInputMode(ta);
      }
      // Only an attached keyboard sends key events to the terminal on a phone
      // or tablet; our keys write through term.input. Make room for typing.
      // Captured here: xterm stops the event on its own field.
      this.el.addEventListener('keydown', (e) => {
        if (e.target === term.textarea && MobileKeyboard.active() && !mobileKeyboard.collapsed) mobileKeyboard.toggle();
      }, true);
      // A mouse report is not typing: an armed Ctrl or Alt waits for a key.
      this.staleMouse = TerminalMouse.watchStaleReports(() => this.releaseMouse());
      term.onData((data) => {
        this.staleMouse.sent(data);
        this.sendInput(/^\x1b\[[<M]/.test(data) ? data : keyInput.filter(data));
      });
      term.onBinary((data) => this.sendBytes(Uint8Array.from(data, (c) => c.charCodeAt(0) & 0xff)));
      // A tap or click on the terminal takes it back: the focus, and with it
      // the built-in keyboard and the key row that went down together. A
      // banner's buttons sit over the terminal but are not part of it.
      this.el.addEventListener('click', (e) => {
        this.keepBlurred = false;
        if (term.element.contains(e.target)) mobileKeyboard.show();
        term.focus();
      });
      // A tap on the title bar or other bare page moves focus to <body>; give
      // it back. Focus moving to a field (a sheet, the editor) is left alone.
      term.textarea?.addEventListener('blur', () => setTimeout(() => {
        const el = document.activeElement;
        if (this === activeSession() && (!el || el === document.body)) focusTerminal();
      }));
      // Like a Linux terminal, finishing a selection copies it: lifting the
      // finger after a long press, or the mouse after a drag or double-click.
      this.disposeTouch = PhoneTerminal.bindTouch(term, { onSelect: () => copySelection(this) });
      this.disposeCursorClick = TerminalMouse.bindCursorClick(term, (data) => this.sendInput(data));
      this.el.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        // xterm follows the drag on the document, so the button may come up
        // outside the terminal; it settles the selection in its own handler.
        const up = () => setTimeout(() => { if (term.hasSelection()) copySelection(this); });
        window.addEventListener('mouseup', up, { once: true, capture: true });
      }, true);
      // Copy the selection like Windows Terminal: Ctrl+Shift+C, Ctrl+Insert,
      // or Ctrl+C while there is one (it still sends ^C without). Cmd+C on a Mac
      // is the browser's own copy.
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== 'keydown' || !e.ctrlKey || e.altKey || e.metaKey) return true;
        const key = e.key.toLowerCase();
        const copy = (key === 'c' && (e.shiftKey || term.hasSelection())) || (key === 'insert' && !e.shiftKey);
        if (!copy) return true;
        e.preventDefault();
        // Cleared, so the next Ctrl+C interrupts again.
        copySelection(this);
        term.clearSelection();
        return false;
      });
      this.resizeObserver = new ResizeObserver(() => {
        // slideKeyboard has already fitted this temporary full-height screen.
        if (keyboardSlide?.terminal !== this.el) this.fitSoon();
      });
      this.resizeObserver.observe(this.el);
    }

    // Draws on the GPU. The DOM renderer rebuilds every row on each scrolled
    // line, which takes several frames for a screen of colored text on a phone;
    // WebGL keeps it to one. Without WebGL, or after its context is lost (iOS
    // drops it in the background), the DOM renderer takes over until the page
    // is shown again. Emulated pixel ratios also get the DOM renderer (see
    // devicePixelsAgree), as does everything once Settings turns WebGL off.
    async useWebgl() {
      if (this.webgl || this.webglPending || !this.term || !window.WebglAddon || local.get(KEYS.noWebgl, false)) return;
      this.webglPending = true;
      const agree = await devicePixelsAgree();
      this.webglPending = false;
      if (!agree || this.webgl || !this.term || local.get(KEYS.noWebgl, false)) return;
      try {
        const addon = new WebglAddon.WebglAddon();
        addon.onContextLoss(() => this.lostWebgl(addon));
        this.term.loadAddon(addon);
        this.webgl = addon;
      } catch (err) {
        this.webgl = null;
        this.webglOff(`WebGL could not start (${err.message || err})`);
      }
    }

    // The addon only reports a lost context after waiting 3 s for the browser
    // to restore it. Coming back from the background on iOS, that is after
    // visibilitychange has already found WebGL "on", so the DOM renderer would
    // stay until the next time the app is hidden. The loss event itself does
    // not bubble but can be caught on the way down; drop the dead context
    // then, and start a fresh one right away if the page is on screen.
    watchContextLoss() {
      this.el.addEventListener('webglcontextlost', () => {
        const addon = this.webgl;
        if (addon) setTimeout(() => this.lostWebgl(addon));
      }, true);
    }

    lostWebgl(addon) {
      if (this.webgl !== addon) return;
      this.dropWebgl(addon);
      if (document.hidden) return; // visibilitychange brings it back
      // A context lost again soon after a fresh one is not coming back.
      const now = Date.now();
      const again = now - (this.webglLostAt || 0) < 30000;
      this.webglLostAt = now;
      if (again) return this.webglOff('the GPU context was lost');
      this.useWebgl();
    }

    // Leaving WebGL for the slower DOM renderer is worth knowing about, unless
    // Settings asked for it.
    webglOff(reason) {
      if (local.get(KEYS.noWebgl, false) || document.hidden) return;
      toast(`Terminal switched off WebGL: ${reason}. Scrolling may be slower.`, false, 4500);
    }

    dropWebgl(addon = this.webgl) {
      if (!addon) return;
      if (this.webgl === addon) this.webgl = null;
      addon.dispose();
    }

    fit() {
      if (!this.term || !this.el.clientWidth || !this.el.clientHeight) return;
      try {
        PhoneTerminal.fit(this.term, this.fitAddon);
      } catch {}
      this.sendResize(false);
      // Device emulation can be switched on while WebGL is drawing.
      const addon = this.webgl;
      if (addon) devicePixelsAgree().then((agree) => {
        if (agree || this.webgl !== addon) return;
        this.dropWebgl(addon);
        this.webglOff('the pixel ratios disagree (device emulation?)');
      });
    }

    fitSoon() {
      clearTimeout(this.fitTimer);
      this.fitTimer = setTimeout(() => this.fit(), 100);
    }

    isOpen() {
      return !!this.ws && this.ws.readyState === WebSocket.OPEN;
    }

    // In frames well under the server's 1 MB limit, so a big paste gets through.
    sendBytes(bytes) {
      if (!this.isOpen()) return false;
      for (let i = 0; i < bytes.length; i += INPUT_FRAME_BYTES) this.ws.send(bytes.subarray(i, i + INPUT_FRAME_BYTES));
      if (this.inAck !== null) {
        this.unacked.push(bytes);
        this.unackedBytes += bytes.length;
        if (this.unackedBytes > MAX_UNACKED) this.forgetUnacked(null);
      }
      return true;
    }

    forgetUnacked(pos) {
      this.inAck = pos;
      this.unacked = [];
      this.unackedBytes = 0;
    }

    // The server has the first `pos` input bytes: drop what it confirmed.
    inputAcked(pos) {
      let drop = this.inAck === null ? -1 : pos - this.inAck;
      if (drop < 0 || drop > this.unackedBytes) return this.forgetUnacked(pos);
      this.unackedBytes -= drop;
      while (drop > 0) {
        const first = this.unacked[0];
        if (first.length <= drop) {
          this.unacked.shift();
          drop -= first.length;
        } else {
          this.unacked[0] = first.subarray(drop);
          drop = 0;
        }
      }
      this.inAck = pos;
    }

    // Keystrokes that went into a socket that died before they reached the
    // shell. The hello says how much arrived; the rest is sent again, once.
    unconfirmedAfter(pos) {
      if (this.inAck === null || pos < this.inAck || pos - this.inAck > this.unackedBytes) return null;
      const all = new Uint8Array(this.unackedBytes);
      let at = 0;
      for (const b of this.unacked) {
        all.set(b, at);
        at += b.length;
      }
      return all.subarray(pos - this.inAck);
    }

    sendInput(text) {
      if (!text) return;
      if (this.status === 'open' && this.sendBytes(encoder.encode(text))) {
        this.term.scrollToBottom();
        // Typing into a link that has been silent a while: make sure it is
        // there, rather than find out at the next scheduled ping.
        if (performance.now() - this.lastFrameAt > timings.quiet) this.probe();
        return;
      }
      if (this.ended || this.shellExited || this.replaced) {
        toast('Not connected', true);
        return;
      }
      // Still (re)connecting, e.g. just back from the background: send it
      // once the shell is attached instead of losing it.
      this.pendingInput += text;
      if (this.pendingInput.length > 16 * 1024) {
        this.pendingInput = '';
        toast('Not connected', true);
      }
      if (!this.ws) this.reconnect(true);
      else if (this.status === 'open') this.probe(); // looked open, swallowed it
    }

    sendResize(force) {
      if (!this.term || !this.isOpen()) return;
      const size = `${this.term.cols}x${this.term.rows}`;
      if (!force && size === this.lastSize) return;
      this.lastSize = size;
      this.ws.send(JSON.stringify({ t: 'resize', cols: this.term.cols, rows: this.term.rows }));
    }

    setStatus(status) {
      this.status = status;
      if (this === activeSession()) updateStatusDot();
    }

    // Drops the socket now instead of waiting for the browser to admit it is
    // gone, and forgets anything that only made sense for that socket.
    closeSocket() {
      clearTimeout(this.helloTimer);
      clearTimeout(this.pongTimer);
      clearInterval(this.pingTimer);
      this.helloTimer = this.pongTimer = this.pingTimer = null;
      this.pendingReset = false;
      this.historyWs = null;
      this.lastSize = '';
      // A repaint cut short leaves the screen incomplete: ask for all of it next time.
      if (this.replayLeft > 0) this.outPos = null;
      this.replayLeft = 0;
      const ws = this.ws;
      if (!ws) return;
      this.ws = null;
      ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {}
    }

    connect() {
      if (this.ended || this.shellExited || this.replaced) return;
      clearTimeout(this.retryTimer);
      // Keep a socket that is healthy, or one whose handshake is still under
      // the hello watchdog. Anything else is in the way and gets dropped.
      if (this.ws && (this.helloTimer || (this.status === 'open' && this.isOpen()))) return;
      this.closeSocket();
      this.ensureTerminal();
      this.fit();
      this.setStatus('connecting');
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const query = new URLSearchParams({ shell: this.shellId, lease: this.lease, cols: this.term.cols, rows: this.term.rows });
      // Only a shell this page is opening is created; any other is resumed
      // or refused, never replaced by a new one behind the user's back.
      if (this.creating) query.set('create', '1');
      if (this.outPos !== null) query.set('have', this.outPos);
      const ws = new WebSocket(`${proto}://${location.host}/ws/${this.id}?${query}`);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      // A stalled upgrade never reaches onclose; stop waiting and try again.
      this.helloTimer = setTimeout(() => this.dropSocket(), timings.hello);
      ws.onmessage = (e) => {
        if (this.ws !== ws) return;
        // Any frame at all is proof the link is alive.
        clearTimeout(this.pongTimer);
        this.pongTimer = null;
        this.lastFrameAt = performance.now();
        if (typeof e.data !== 'string') {
          const replayed = this.replayLeft > 0 && this.replayLeft <= e.data.byteLength;
          this.countOutput(e.data.byteLength);
          // The screen is only wiped once the repaint actually starts, so a
          // replay that never arrives leaves the old output on screen.
          if (this.pendingReset) {
            this.pendingReset = false;
            this.term.reset();
          }
          const bytes = new Uint8Array(e.data);
          if (this.staleMouse?.watching) this.staleMouse.received(new TextDecoder().decode(bytes));
          this.term.write(bytes, replayed && this.historyWs === ws ? () => this.replayDrawn(ws) : undefined);
          return;
        }
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        this.onControl(msg);
      };
      ws.onerror = () => {
        if (this.ws === ws) this.dropSocket();
      };
      ws.onclose = () => {
        if (this.ws !== ws) return;
        this.closeSocket();
        if (this.ended || this.shellExited || this.replaced) return;
        this.setStatus('closed');
        if (!document.hidden) this.reconnect(false);
      };
    }

    // Gives up on the current socket and starts the retry backoff.
    dropSocket() {
      this.closeSocket();
      if (this.ended || this.shellExited || this.replaced) return;
      this.setStatus('closed');
      this.reconnect(false);
    }

    // Asks the server for a pong. Runs on a timer, after typing that went
    // nowhere, and when the app comes back to the foreground - every case where
    // the socket can look open but be dead.
    probe() {
      if (!this.isOpen() || this.pongTimer) return;
      this.ws.send(JSON.stringify({ t: 'ping' }));
      this.pongTimer = setTimeout(() => {
        this.pongTimer = null;
        this.dropSocket();
      }, timings.pong);
    }

    // Keeps count of the output on screen, and tells the server as it goes.
    countOutput(length) {
      if (this.replayLeft > 0) {
        this.replayLeft -= length;
        if (this.replayLeft <= 0) this.outPos = this.replayPos;
        return;
      }
      if (this.outPos === null) return;
      this.outPos += length;
      if (this.outPos - this.ackedOut >= ACK_EVERY && this.isOpen()) {
        this.ackedOut = this.outPos;
        this.ws.send(JSON.stringify({ t: 'ack', pos: this.outPos }));
      }
    }

    onControl(msg) {
      if (msg.t === 'pong') return this.inputAcked(msg.in); // the socket is alive; onmessage noted it
      if (msg.t === 'hello') {
        if (this.creating) {
          this.creating = false;
          this.persist();
        }
        this.retries = 0;
        clearTimeout(this.helloTimer);
        this.helloTimer = null;
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => this.probe(), timings.ping);
        this.setStatus('open');
        this.hideBanner();
        // The server replays recent output next, either all of it (the reset
        // waits for it) or only what this screen missed.
        const repaint = msg.resumed && msg.reset && msg.replay > 0;
        if (msg.resumed) this.pendingReset = repaint;
        else if (this.everOpened) this.term.write(this.programModesOff() + '\r\n\x1b[2m[new shell]\x1b[0m\r\n');
        this.everOpened = true;
        this.replayLeft = repaint ? msg.replay : 0;
        this.replayPos = msg.pos;
        this.outPos = repaint ? null : msg.pos - msg.replay;
        this.ackedOut = msg.pos;
        // A notice still unanswered comes back: newer output fills no old gaps.
        if (!msg.resumed) this.dismissHistory(); // a new shell: nothing of the old one is missing
        if (msg.historyLost) {
          const loss = { fullScreen: msg.fullScreen, bytes: msg.lostBytes };
          if (repaint) {
            this.historyWs = this.ws;
            this.historyLoss = loss;
          } else this.noteLoss(loss);
        }
        if (this.historyNotice) this.showHistoryNotice();
        // Keystrokes lost with the old socket, then any typed while away.
        const lost = msg.resumed ? this.unconfirmedAfter(msg.in) : null;
        this.forgetUnacked(msg.in);
        this.sendResize(true);
        if (lost && lost.length) this.sendBytes(lost);
        if (this.pendingInput) {
          this.sendBytes(encoder.encode(this.pendingInput));
          this.pendingInput = '';
        }
      } else if (msg.t === 'exit') {
        this.shellExited = true;
        this.pendingInput = '';
        this.dismissHistory();
        this.setStatus('closed');
        this.banner(`Shell exited${msg.code !== undefined && msg.code !== null ? ` (code ${msg.code})` : ''}.`, [
          { label: 'New shell', primary: true, run: () => this.newShell() },
          { label: 'Disconnect', run: () => disconnectSession(this, false) },
        ]);
      } else if (msg.t === 'replaced' || msg.t === 'superseded') {
        // Another window (or this one, reloaded elsewhere) has the shell now,
        // or holds its newer lease: this one stops for good, reload included,
        // until the user takes it back.
        this.supersede();
      } else if (msg.t === 'gone') {
        this.shellGone();
      } else if (msg.t === 'error') {
        this.banner(msg.message, [{ label: 'Dismiss', run: () => this.hideBanner() }]);
      }
    }

    supersede() {
      this.replaced = true;
      this.pendingInput = '';
      this.forgetUnacked(null);
      clearTimeout(this.retryTimer);
      this.closeSocket();
      this.dismissHistory();
      this.setStatus('closed');
      this.persist();
      this.supersededBanner();
    }

    supersededBanner() {
      this.banner('This shell is open in another window or on another device.', [
        { label: 'Use it here', primary: true, run: () => takeOverShell(this) },
      ]);
    }

    // The shell this terminal resumes is not on the connection any more (it
    // exited, or its background time ran out): nothing new is opened in its
    // place unless the user asks.
    shellGone() {
      this.shellExited = true;
      this.pendingInput = '';
      clearTimeout(this.retryTimer);
      this.closeSocket();
      this.dismissHistory();
      this.setStatus('closed');
      this.banner('This shell has ended: it exited, or it was in the background too long. The SSH connection is still open.', [
        { label: 'New shell', primary: true, run: () => this.newShell() },
        { label: 'Disconnect', run: () => disconnectSession(this, false) },
      ]);
    }

    // Attached again (the Connections tab, or taking it back): the shell and
    // the lease the server gave for it. Another shell starts on a clean screen.
    useShell(shellId, lease) {
      clearTimeout(this.retryTimer);
      this.closeSocket();
      if (shellId !== this.shellId) {
        this.shellId = shellId;
        this.outPos = null;
        this.everOpened = false;
        if (this.term) this.term.reset();
      }
      this.forgetUnacked(null);
      this.lease = lease;
      this.creating = false;
      this.replaced = false;
      this.shellExited = false;
      this.retries = 0;
      this.dismissHistory();
      this.hideBanner();
      this.persist();
    }

    // The last frame of a repaint that left out older output is on screen.
    replayDrawn(ws) {
      if (this.ws !== ws || this.historyWs !== ws) return;
      this.historyWs = null;
      if (this.ended || this.shellExited || this.replaced) return;
      this.noteLoss(this.historyLoss);
    }

    // Only a full-screen program (htop, vim) can be left with holes: it
    // redraws just what changes. At a shell prompt the lost part is old
    // scrollback, worth a mention and no more. A notice still unanswered
    // takes in the new loss rather than stacking a second one.
    noteLoss(loss) {
      if (loss.fullScreen || this.historyNotice) {
        if (!this.historyNotice) this.historyLostBytes = 0;
        this.historyNotice = true;
        this.historyLostBytes = loss.bytes === null || this.historyLostBytes === null ? null : this.historyLostBytes + loss.bytes;
        this.showHistoryNotice();
      } else if (this === activeSession()) {
        toast(`${lostAmount(loss.bytes)} of earlier output was not kept, so scrollback starts later.`);
      }
    }

    // Nothing here can tell which cells are wrong, so this only says what
    // happened and offers what may help; nothing is sent until the user picks.
    showHistoryNotice() {
      const message = `${lostAmount(this.historyLostBytes)} of output was not kept while you were away, so the screen may be incomplete.`;
      if (this.bannerEl && this.bannerEl.dataset.kind === 'history') {
        this.bannerEl.querySelector('.msg').textContent = message;
        return;
      }
      this.banner(message, [
        { label: 'Redraw (^L)', primary: true, title: 'Sends Ctrl+L, which most full-screen programs repaint for', run: () => this.historyAction('redraw') },
        { label: 'Force redraw', title: 'Makes the terminal a row smaller and back, so the program repaints for the new size', run: () => this.historyAction('force') },
        { label: 'Send ^C', title: 'Sends Ctrl+C, which may interrupt the program', run: () => this.historyAction('ctrl-c') },
        { label: 'Ignore', run: () => this.dismissHistory() },
      ]);
      this.bannerEl.dataset.kind = 'history';
    }

    // Sent only on a live connection: a request queued for later could reach
    // a program the user never saw.
    historyAction(action) {
      if (this.status !== 'open' || !this.isOpen()) {
        toast('Not connected: try again once the shell is back', true);
        return;
      }
      if (action === 'redraw') {
        this.sendInput('\x0c');
        toast('^L sent');
      } else if (action === 'force') {
        this.forceRedraw();
        toast('Force redraw sent');
      } else {
        this.sendInput('\x03');
        toast('^C sent');
      }
      this.dismissHistory();
    }

    // One row less, then the real size again: a real change of size, which
    // full-screen programs repaint for, where the same size may be ignored.
    // The pause lets the program see the smaller size before it goes back.
    forceRedraw() {
      const { cols, rows } = this.term;
      const ws = this.ws;
      ws.send(JSON.stringify({ t: 'resize', cols, rows: rows > 1 ? rows - 1 : rows + 1 }));
      this.lastSize = '';
      setTimeout(() => {
        if (this.ws === ws) this.sendResize(true); // a new socket sends the size itself
      }, timings.redraw);
    }

    dismissHistory() {
      this.historyNotice = false;
      this.historyWs = null;
      if (this.bannerEl && this.bannerEl.dataset.kind === 'history') this.hideBanner();
    }

    // A new shell replacing one the server let go of (after GRACE_MS away)
    // keeps the old screen, but not what the old program switched on: its
    // mouse reporting would turn taps into text at the new prompt.
    programModesOff() {
      const alternate = this.term.buffer.active.type === 'alternate';
      return (alternate ? '\x1b[?1049l' : '') + TerminalMouse.MOUSE_OFF +
        '\x1b[?1l\x1b[?1004l\x1b[?2004l\x1b[?25h\x1b>';
    }

    // Mouse reporting a program left on when it ended: off here, and in the
    // server's replay so a resume does not turn it back on.
    releaseMouse() {
      if (this.term.modes.mouseTrackingMode === 'none') return;
      this.term.write(TerminalMouse.MOUSE_OFF);
      if (this.isOpen()) this.ws.send(JSON.stringify({ t: 'mouse-off' }));
      toast('Mouse reporting turned off: the program that asked for it has ended');
    }

    // Checks the SSH session still exists before reopening the socket.
    reconnect(immediate) {
      if (this.ended || this.shellExited || this.replaced) return;
      clearTimeout(this.retryTimer);
      const delay = immediate ? 0 : Math.min(15000, 1000 * 2 ** this.retries);
      this.retries++;
      this.setStatus('connecting');
      // Retrying silently behind a blank screen is what makes this look broken.
      if (this.retries > 1) this.reconnectBanner();
      this.retryTimer = setTimeout(async () => {
        try {
          await api('GET', `/api/sessions/${this.id}`, undefined, { timeout: timings.check });
        } catch (err) {
          if (err.status === 404) return this.markEnded('The SSH connection was closed.');
          if (err.status === 401) return this.setStatus('closed');
          return this.reconnect(false);
        }
        this.connect();
      }, delay);
    }

    reconnectBanner() {
      if (this.bannerEl && this.bannerEl.dataset.kind === 'reconnecting') return;
      this.banner('Reconnecting\u2026 the shell is still open on the server.', [
        { label: 'Try now', primary: true, run: () => { this.retries = 0; this.closeSocket(); this.reconnect(true); } },
      ]);
      this.bannerEl.dataset.kind = 'reconnecting';
    }

    markEnded(message) {
      if (this.ended) return;
      this.ended = true;
      this.pendingInput = '';
      this.dismissHistory();
      clearTimeout(this.retryTimer);
      this.closeSocket();
      forgetSaved(this.id);
      this.setStatus('closed');
      this.banner(message, [
        { label: 'Reconnect', primary: true, run: () => reconnectServer(this) },
        { label: 'Close', run: () => disconnectSession(this, false) },
      ]);
      renderServers();
      refreshConnections();
    }

    // A new shell on the same connection, which this page creates.
    newShell() {
      this.shellExited = false;
      this.replaced = false;
      this.shellId = randomId();
      this.lease = newLease();
      this.creating = true;
      this.outPos = null;
      this.forgetUnacked(null);
      this.persist();
      this.dismissHistory();
      this.hideBanner();
      this.term.reset();
      mobileKeyboard.show();
      this.connect();
    }

    banner(message, actions) {
      this.hideBanner();
      this.bannerEl = h('div', { class: 'term-banner' },
        h('div', { class: 'msg', text: message }),
        h('div', { class: 'actions' },
          actions.map((a) => h('button', { type: 'button', class: `btn small${a.primary ? ' primary' : ''}`, text: a.label, title: a.title, onclick: a.run }))));
      this.el.append(this.bannerEl);
    }

    hideBanner() {
      if (this.bannerEl) this.bannerEl.remove();
      this.bannerEl = null;
    }

    dispose() {
      this.ended = true;
      clearTimeout(this.retryTimer);
      clearTimeout(this.fitTimer);
      this.closeSocket();
      if (this.resizeObserver) this.resizeObserver.disconnect();
      this.disposeTouch?.();
      this.disposeCursorClick?.();
      if (this.term) this.term.dispose();
      this.el.remove();
      forgetSaved(this.id);
      if (state.sessions.get(this.id) === this) state.sessions.delete(this.id);
    }
  }

  // One set of Ctrl/Alt modifiers for every keyboard. Keys write their final
  // bytes through xterm (term.input), which passes them to onData unmodified.
  const keyInput = ExtraKeys.createInput({
    write: (data) => activeSession()?.term?.input(data, true),
    appCursor: () => !!activeSession()?.term?.modes.applicationCursorKeysMode,
  });

  const keybar = ExtraKeys.createKeybar($('keybar'), {
    input: keyInput,
    onAction: (name) => {
      if (name === 'hide') hideKeyboard();
      else if (name === 'paste') pasteIntoTerminal(activeSession());
      else openSnippetPicker();
    },
    isFocused: () => {
      const s = activeSession();
      return !!(s && s.term && document.activeElement === s.term.textarea);
    },
    refocus: () => {
      const s = activeSession();
      if (s && s.term) s.term.focus();
    },
    onResize: () => {
      const s = activeSession();
      if (s) s.fitSoon();
    },
  });

  // The built-in keyboard and its key row rise into place together and drop
  // away together, like the iOS keyboard. Going down resolves when they are
  // out of sight; coming back up starts from wherever they are.
  let keyboardSlide = null;
  function slideKeyboard(up) {
    const els = [$('keybar'), $('mobile-keyboard')].filter((el) => !el.hidden);
    const height = els.reduce((sum, el) => sum + el.offsetHeight, 0);
    const keyboard = $('mobile-keyboard');
    const animations = keyboard.getAnimations();
    const from = animations.length ? getComputedStyle(keyboard).marginBottom : up ? `${-height}px` : '0px';
    for (const a of animations) a.cancel();
    if (keyboardSlide) {
      keyboardSlide.terminal.style.height = '';
      keyboardSlide = null;
    }
    if (!height || reducedMotion.matches || state.view !== 'session') return Promise.resolve();
    const s = activeSession();
    const terminal = s?.el;
    const fit = () => {
      if (!s?.term) return;
      clearTimeout(s.fitTimer);
      // Only height changes: preserve the font and glyph atlas while moving.
      try { s.fitAddon.fit(); } catch {}
      s.sendResize(false);
    };
    if (terminal) {
      // Prepare the entire screen before revealing it. #terminals clips this
      // full-height terminal as the keys move; resizing xterm after motion (or
      // on every frame) exposes rows its renderer has not painted yet.
      terminal.style.height = $('panel-terminal').clientHeight + 'px';
      fit();
    }
    // Release the keys' flex space as they move, so the terminal follows their
    // top edge throughout the animation instead of leaving a dark empty band.
    const a = keyboard.animate([{ marginBottom: from }, { marginBottom: up ? '0px' : `${-height}px` }],
      { duration: 300, easing: EASE, fill: up ? 'none' : 'forwards' });
    if (terminal) keyboardSlide = { animation: a, terminal };
    const settle = () => {
      if (keyboardSlide?.animation !== a) return;
      keyboardSlide = null;
      terminal.style.height = '';
      fit();
    };
    return a.finished.then(() => {
      settle();
      if (!up) requestAnimationFrame(() => a.cancel());
    }, settle);
  }

  const mobileKeyboard = MobileKeyboard.create($('mobile-keyboard'), {
    input: keyInput,
    slide: slideKeyboard,
    onResize: () => activeSession()?.fitSoon(),
    onCollapse: (collapsed) => keybar.setKeyboardHidden(collapsed),
    onPage: (page) => keybar.setPage(page),
    onAction: (name) => { if (name === 'prtsc') copyScreen(activeSession()); },
  });

  // The built-in keyboard replaces the system one on phones and tablets.
  function setTerminalInputMode(ta) {
    if (MobileKeyboard.active()) ta.setAttribute('inputmode', 'none');
    else ta.removeAttribute('inputmode');
  }
  PhoneTerminal.media.addEventListener('change', () => {
    for (const s of state.sessions.values()) if (s.term?.textarea) setTerminalInputMode(s.term.textarea);
  });

  // Phones and tablets: take the built-in keyboard down, and the key row with
  // it; a tap on the terminal brings both back. Elsewhere the system keyboard
  // follows terminal focus.
  function hideKeyboard() {
    if (MobileKeyboard.active()) return mobileKeyboard.toggle();
    const s = activeSession();
    if (!s?.term) return;
    s.keepBlurred = true;
    s.term.blur();
  }

  // The terminal on screen holds focus, so keys reach it without a tap first
  // and its cursor blinks. Sheets, the lock screen and the Files panel take
  // it while they are up. (On a phone the textarea has inputmode=none, so
  // this does not bring up the system keyboard; iOS may ignore a focus call
  // outside a tap, and the built-in keys write to the terminal regardless.)
  function focusTerminal() {
    const s = activeSession();
    if (!s?.term || s.keepBlurred || state.view !== 'session' || state.panel !== 'terminal' || currentSheet || state.locked || document.hidden) return;
    if (document.activeElement !== s.term.textarea) s.term.focus();
  }

  // Leaving the terminal (or switching sessions) ends held keys and armed
  // modifiers.
  function resetTerminalInput() {
    keybar.cancel();
    mobileKeyboard.cancel();
    keyInput.clear();
  }

  function updateStatusDot() {
    const s = activeSession();
    $('session-status').className = `dot ${s ? s.status : ''}`;
  }

  // Pastes into the session the Paste key was used in, even if another one is
  // on screen by the time the clipboard (or the fallback sheet) answers.
  //
  // Reading the clipboard can be refused (a browser asks for permission first,
  // plain HTTP has no clipboard). Then a box opens to paste into, filled in
  // with the text last copied in the app, so Copy then Paste still works.
  async function pasteIntoTerminal(s) {
    if (!s || !s.term) return;
    let text = null;
    let refused = false;
    if (copiedInAppOnly) text = lastCopied;
    else if (window.isSecureContext && navigator.clipboard && navigator.clipboard.readText) {
      try {
        text = await navigator.clipboard.readText();
      } catch {
        refused = true;
      }
    }
    if (text === null) {
      const v = await formSheet({
        title: 'Paste',
        message: refused
          ? 'The browser did not let the app read the clipboard. Allow clipboard access for this site in the browser, or paste the text here.'
          : 'The clipboard cannot be read here. Paste the text here.',
        fields: [{
          name: 'text', label: 'Text to send', multiline: true, value: lastCopied, select: !!lastCopied,
          hint: lastCopied ? 'Filled in with the text last copied in the app.' : undefined,
        }],
        submit: 'Send',
      });
      text = v && v.text;
      if (s.term && s === activeSession()) s.term.focus();
    }
    // term.paste keeps bracketed paste; the text is not a key for Ctrl/Alt.
    if (text && s.term && !s.ended) keyInput.passthrough(() => s.term.paste(text));
  }

  // Copies a finished selection and keeps it on screen. Paste falls back to
  // it when the clipboard is out of reach (see pasteIntoTerminal).
  async function copySelection(s) {
    copyTerminalText(s.term?.hasSelection() ? s.term.getSelection() : '');
  }

  // Print Screen: the text on screen, without trailing blank lines.
  function copyScreen(s) {
    const buffer = s?.term?.buffer.active;
    if (!buffer) return;
    const lines = [];
    for (let y = buffer.viewportY; y < buffer.viewportY + s.term.rows; y++) {
      lines.push(buffer.getLine(y)?.translateToString(true) ?? '');
    }
    copyTerminalText(lines.join('\n').replace(/\s+$/, ''));
  }

  async function copyTerminalText(text) {
    if (!text) return;
    if (await writeClipboard(text)) return toast('Copied');
    // Kept in the app instead: Paste here still sends it.
    lastCopied = text;
    copiedInAppOnly = true;
    toast('Copied (app only)');
  }

  // Starting a connection is one call, unless the server's key lives in this
  // device's secure enclave: then the app answers with the handshake to sign,
  // Face ID signs it, and the answer finishes the connection.
  async function startSession(body) {
    const started = await api('POST', '/api/sessions', body);
    if (!started.signRequest) return started.session;
    const response = await faceIdFor(started.signRequest);
    return (await api('POST', '/api/sessions/sign', { id: started.signRequest.id, response })).session;
  }

  async function faceIdFor(request) {
    if (!passkeySupported()) {
      throw new Error(`This server uses a Face ID key. Open picossh at https://${request.rpId} to connect.`);
    }
    const ask = () => navigator.credentials.get({
      publicKey: {
        challenge: b64url.toBuffer(request.challenge),
        rpId: request.rpId,
        allowCredentials: (request.allowCredentials || []).map((c) => ({ ...c, id: b64url.toBuffer(c.id) })),
        userVerification: 'required',
        timeout: request.timeoutMs,
      },
    });
    try {
      const cred = await ask();
      if (!cred) throw new Error('Face ID returned nothing');
      return credentialToJSON(cred);
    } catch (err) {
      // A key made on another hostname can never be used from this one.
      if (err.name === 'SecurityError') throw new Error(`This key belongs to ${request.rpId}. Open picossh there to use it.`);
      // Safari only shows the prompt close to the tap that asked for it, and
      // reaching the server took a moment; a fresh tap gets one more try.
      if (!(await confirmSheet(`Confirm this connection with "${request.keyName}".`, { confirm: 'Use Face ID' }))) {
        throw err.name === 'NotAllowedError' ? new Error('Face ID was cancelled') : err;
      }
      const cred = await ask();
      if (!cred) throw new Error('Face ID was cancelled');
      return credentialToJSON(cred);
    }
  }

  // A tap on a server: a new connection, unless this device has some open to
  // it already, when the user picks one of those to attach to or asks for a
  // new one anyway.
  function tapServer(server) {
    const open = (state.connections.list || []).filter((c) => c.serverId === server.id);
    if (!open.length) return connectServer(server);
    const close = openSheet(server.name, h('div', { class: 'action-list' },
      h('p', { class: 'note', text: open.length === 1 ? 'This device has a connection open to this server.' : `This device has ${open.length} connections open to this server.` }),
      open.map((conn) => h('button', {
        type: 'button',
        class: 'btn block',
        'data-connection': conn.id,
        text: `Attach: ${conn.name} (#${conn.id.slice(-6)}) · ${connectionState(conn).label}`,
        onclick: () => {
          close();
          openConnection(conn);
        },
      })),
      h('button', {
        type: 'button',
        class: 'btn block primary',
        'data-connection': 'new',
        text: 'New connection',
        onclick: () => {
          close();
          connectServer(server);
        },
      })));
  }

  // Always a new SSH connection: tapServer() offers the existing ones first.
  // While one is on its way the server's row is disabled, so
  // a second tap cannot start another. `replacing`: a terminal whose
  // connection closed, which the new one takes the place of.
  async function connectServer(server, { replacing = null } = {}) {
    if (state.connecting.has(server.id)) return;

    const body = { serverId: server.id };
    const target = `${server.user}@${server.host}`;
    const askPassword = async (title, submit) => {
      const v = await formSheet({ title, message: target, fields: [{ name: 'password', label: 'Password', type: 'password', autocomplete: 'current-password' }], submit });
      if (v) body.password = v.password;
      return !!v;
    };

    state.connecting.add(server.id);
    state.cardErrors.delete(server.id);
    renderServers();
    try {
      for (;;) {
        try {
          const info = await startSession(body);
          if (replacing) replacing.dispose();
          const s = new TermSession(connectionMeta(info), { sessionId: info.id, creating: true });
          state.sessions.set(s.id, s);
          openSession(s);
          refreshConnections();
          return;
        } catch (err) {
          const code = err.data && err.data.code;
          if (code === 'passphrase') {
            const v = await formSheet({ title: 'Key passphrase', message: err.message, fields: [{ name: 'passphrase', label: 'Passphrase', type: 'password' }], submit: 'Connect' });
            if (!v) return;
            body.passphrase = v.passphrase;
          } else if (code === 'password') {
            // No saved password: ask for one for this connection only.
            if (!(await askPassword('Connect', 'Connect'))) return;
          } else if (code === 'auth' && body.password !== undefined) {
            if (!(await askPassword('Wrong password', 'Try again'))) return;
          } else {
            throw err;
          }
        }
      }
    } catch (err) {
      if (err.status !== 401) {
        state.cardErrors.set(server.id, err.message);
        if (state.view !== 'home') toast(err.message, true);
      }
    } finally {
      state.connecting.delete(server.id);
      renderServers();
    }
  }

  // "Reconnect" on a terminal whose connection closed: a new connection to
  // the same saved server, if it still exists.
  function reconnectServer(s) {
    const server = state.servers.find((x) => x.id === s.server.id);
    if (!server) return toast(`"${s.server.name}" is no longer a saved server.`, true);
    connectServer(server, { replacing: s });
  }

  function openSession(s) {
    if (state.activeId !== s.id) resetTerminalInput();
    state.activeId = s.id;
    session.set(KEYS.active, s.id);
    for (const other of state.sessions.values()) other.el.classList.toggle('active', other === s);
    $('session-title').textContent = s.server.name;
    updateStatusDot();
    showView('session');
    showPanel(s.panel);
    s.ensureTerminal();
    requestAnimationFrame(() => {
      s.fit();
      if (!s.isOpen()) s.connect();
      focusTerminal();
    });
  }

  // Home again, with the connection left open: the Connections tab, where
  // it (and any other) can be opened again.
  function leaveSession() {
    state.activeId = null;
    session.remove(KEYS.active);
    state.homeTab = 'connections';
    showHome();
  }

  async function disconnectSession(s, ask) {
    if (ask && !(await confirmSheet(`Disconnect from ${s.server.name}?`, { confirm: 'Disconnect', danger: true }))) return;
    const wasActive = s === activeSession();
    s.dispose();
    await closeConnection(s.id);
    if (wasActive) leaveSession();
    else renderServers();
  }

  // Closes a connection on the server, with its shells, whether or not this
  // page has a terminal on it. Best effort: a connection this device cannot
  // reach now is refreshed out of the list later, or closes on its own.
  async function closeConnection(id) {
    const c = state.connections;
    if (c.list) c.list = c.list.filter((x) => x.id !== id);
    renderConnections();
    try {
      await api('DELETE', `/api/sessions/${id}`, undefined, { timeout: timings.check });
    } catch {}
    refreshConnections();
  }

  // "Use it here" on a terminal another window took: attaches again (asking
  // first while the other window has it), as the Connections tab would.
  function takeOverShell(s) {
    return attachShell({ id: s.id, serverId: s.server.id, name: s.server.name, user: s.server.user, host: s.server.host, port: s.server.port }, { id: s.shellId }, s);
  }

  // ============================================================ connections

  // This device's connections, as the server lists them. One request at a
  // time; an answer to a request older than the latest one is dropped (a
  // sign-out in between makes every earlier one old). A refresh that fails
  // keeps the list it had and says so: it does not mean the connections ended.
  function refreshConnections() {
    const c = state.connections;
    if (!state.authed) return Promise.resolve();
    if (c.inFlight) {
      c.again = true;
      return c.inFlight;
    }
    const request = ++c.request;
    c.loading = true;
    if (!c.list) renderConnections();
    c.inFlight = (async () => {
      try {
        const data = await api('GET', '/api/sessions', undefined, { timeout: timings.check });
        if (request === c.request) takeConnections(data);
      } catch (err) {
        if (request === c.request && err.status !== 401) c.error = err.message;
      } finally {
        if (request === c.request) {
          c.loading = false;
          c.inFlight = null;
          renderConnections();
          renderServers();
          if (c.again) {
            c.again = false;
            refreshConnections();
          }
        }
      }
    })();
    return c.inFlight;
  }

  function takeConnections(data) {
    const c = state.connections;
    c.list = data.sessions;
    c.skew = data.now - Date.now();
    c.fetchedAt = Date.now();
    c.error = null;
    // A connection renamed in another window is called that here too.
    for (const conn of c.list) nameTerminal(conn.id, conn.name);
  }

  // A connection's name on this page's terminal for it, if there is one.
  function nameTerminal(id, name) {
    const s = state.sessions.get(id);
    if (!s || s.server.name === name) return;
    s.server = { ...s.server, name };
    s.persist();
    if (s === activeSession()) $('session-title').textContent = name;
  }

  // Renames a connection on the server (an empty name goes back to the
  // default), then everywhere this page shows it. Throws what the server says.
  async function renameConnection(id, name) {
    const { session: info } = await api('PUT', `/api/sessions/${id}/name`, { name }, { timeout: timings.check });
    const listed = (state.connections.list || []).find((x) => x.id === id);
    if (listed) listed.name = info.name;
    nameTerminal(id, info.name);
    renderConnections();
    return info.name;
  }

  async function askRename(conn) {
    const v = await formSheet({
      title: 'Rename connection',
      message: `${conn.user}@${conn.host}${conn.port === 22 ? '' : `:${conn.port}`} · #${conn.id.slice(-6)}`,
      fields: [{ name: 'name', label: 'Name', value: conn.name, select: true, hint: `Only this connection, until it closes. Leave empty for "${conn.defaultName || conn.name}".` }],
      submit: 'Save',
    });
    if (!v) return;
    try {
      await renameConnection(conn.id, v.name);
      toast('Renamed');
    } catch (err) {
      toast(err.message, true);
    }
  }

  // Forgets the list and anything on its way (signing out).
  function resetConnections() {
    const c = state.connections;
    c.request++;
    Object.assign(c, { list: null, skew: 0, fetchedAt: 0, error: null, loading: false, inFlight: null, again: false });
  }

  // Refreshing on a timer only while the tab is on screen and signed in.
  let connectionsTimer = null;
  function syncConnectionsPolling() {
    const want = state.authed && !state.locked && !document.hidden && state.view === 'home' && state.homeTab === 'connections';
    if (want && !connectionsTimer) connectionsTimer = setInterval(refreshConnections, timings.connections);
    if (!want && connectionsTimer) {
      clearInterval(connectionsTimer);
      connectionsTimer = null;
    }
  }

  // "in 42 min", "in 3 h 5 min"; the server's clock decides.
  function timeLeft(deadline) {
    const ms = deadline - (Date.now() + state.connections.skew);
    if (ms < 60000) return 'in less than a minute';
    const minutes = Math.round(ms / 60000);
    if (minutes < 60) return `in ${minutes} min`;
    const hours = Math.floor(minutes / 60);
    return `in ${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
  }

  function clockTime(ms) {
    const d = new Date(ms - state.connections.skew);
    const today = d.toDateString() === new Date().toDateString();
    return d.toLocaleString(undefined, today ? { hour: '2-digit', minute: '2-digit' } : { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  }

  // The terminal this page has on a connection's shell, if it is live here.
  function localTerminal(conn) {
    const s = state.sessions.get(conn.id);
    return s && !s.ended && !s.shellExited && !s.replaced && conn.shells.some((sh) => sh.id === s.shellId) ? s : null;
  }

  // What a connection is doing, in words, and when it closes on its own.
  function connectionState(conn) {
    const here = localTerminal(conn);
    if (here && here.status !== 'closed') return { label: 'Active', detail: 'This window has its terminal.' };
    if (conn.transferring) return { label: 'Transfer', detail: 'A file transfer is running.' };
    if (conn.state === 'attached') return { label: 'Active elsewhere', detail: 'Attached in another window.' };
    const expiry = conn.deadline ? `Closes ${timeLeft(conn.deadline)}, at ${clockTime(conn.deadline)}` : 'No background expiry';
    if (conn.state === 'background') return { label: 'Background', detail: expiry };
    return { label: 'Idle', detail: `No shell · ${expiry}` };
  }

  // The saved server's name (the monogram's letter), else the connection's own.
  const serverName = (conn) => (state.servers.find((x) => x.id === conn.serverId) || conn).name;

  function renderConnections() {
    const root = $('tab-connections');
    if (!root) return;
    const c = state.connections;
    root.textContent = '';
    if (!c.list) {
      if (c.error) {
        root.append(h('div', { class: 'empty' }, icon('lan'),
          h('p', { class: 'error', text: `Could not load your connections: ${c.error}` }),
          h('button', { type: 'button', class: 'btn', text: 'Retry', onclick: () => refreshConnections() })));
      } else {
        root.append(h('div', { class: 'loading' }, h('div', { class: 'spinner' })));
      }
      return;
    }
    if (c.error) {
      const when = new Date(c.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      root.append(h('div', { class: 'notice warn stale', role: 'status' }, icon('warning'),
        h('span', { class: 'grow', text: `Offline or unreachable: showing the list from ${when}. ${c.error}` }),
        h('button', { type: 'button', class: 'btn small', text: 'Retry', onclick: () => refreshConnections() })));
    }
    if (!c.list.length) {
      root.append(h('div', { class: 'empty' }, icon('lan'),
        h('p', { text: 'No open connections from this device.' }),
        h('button', { type: 'button', class: 'btn primary', text: 'Connect to a server', onclick: () => setHomeTab('servers') })));
      return;
    }
    for (const conn of c.list) {
      const st = connectionState(conn);
      const started = new Date(conn.connectedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const shells = conn.shells.length;
      root.append(h('div', { class: 'card connection', 'data-id': conn.id },
        h('button', { type: 'button', class: 'card-main has-monogram', 'aria-label': `Open ${conn.name}, ${st.label}`, onclick: () => openConnection(conn) },
          monogram(conn.serverId, serverName(conn)),
          h('div', { class: 'card-body' },
            h('div', { class: 'card-title' },
              h('span', { class: 'name', text: conn.name }),
              h('span', { class: `badge state-${conn.state}`, text: st.label })),
            h('div', { class: 'card-sub', text: `${conn.user}@${conn.host}:${conn.port}` }),
            h('div', { class: 'card-meta', text: `Started ${started} · #${conn.id.slice(-6)}${shells > 1 ? ` · ${shells} shells` : ''}` }),
            h('div', { class: 'card-meta expiry', text: st.detail }))),
        h('button', { type: 'button', class: 'card-side', 'aria-label': `Actions for ${conn.name}`, onclick: () => connectionActions(conn) }, icon('more'))));
    }
  }

  function connectionActions(conn) {
    actionSheet(`${conn.name} · #${conn.id.slice(-6)}`, [
      { label: localTerminal(conn) ? 'Open' : 'Attach', run: () => openConnection(conn) },
      { label: 'Rename', run: () => askRename(conn) },
      { label: 'Connection settings', run: () => connectionSettings(conn.id, connectionMeta(conn)) },
      { label: 'Disconnect', danger: true, run: () => disconnectConnection(conn) },
    ]);
  }

  async function disconnectConnection(conn) {
    if (!(await confirmSheet(`Disconnect from ${conn.name} (#${conn.id.slice(-6)})? Its shells and anything running in them end.`, { confirm: 'Disconnect', danger: true }))) return;
    const s = state.sessions.get(conn.id);
    if (s) {
      if (s === activeSession()) state.activeId = null;
      s.dispose();
    }
    await closeConnection(conn.id);
    toast(`Disconnected from ${conn.name}`);
  }

  // Opens a connection from the list: its terminal if this page has it live
  // (just shown), else one of its shells attached here (the user picks when
  // there are several), else, when it has none, a new shell if the user wants.
  async function openConnection(conn) {
    const here = localTerminal(conn);
    if (here) return openSession(here);
    const local = state.sessions.get(conn.id);
    if (!conn.shells.length) {
      const ok = await confirmSheet(`The shell on this connection to ${conn.name} is gone: it exited, or it was in the background too long. The SSH connection is still open.`, { confirm: 'New shell' });
      if (!ok) return;
      let s = local && !local.ended ? local : null;
      if (s) s.newShell();
      else {
        s = new TermSession(connectionMeta(conn), { sessionId: conn.id, creating: true });
        state.sessions.set(conn.id, s);
      }
      openSession(s);
      refreshConnections();
      return;
    }
    const shell = conn.shells.length === 1 ? conn.shells[0] : await chooseShell(conn);
    if (shell) await attachShell(conn, shell, local && !local.ended ? local : null);
  }

  // Resolves with the shell picked, or null.
  function chooseShell(conn) {
    return new Promise((resolve) => {
      let picked = null;
      const describe = (sh) => (sh.attached ? 'active elsewhere' : sh.deadline ? `background, closes ${timeLeft(sh.deadline)}` : 'background, no expiry');
      const close = openSheet('Choose a shell', h('div', { class: 'action-list' },
        h('p', { class: 'note', text: `${conn.name} has ${conn.shells.length} shells open.` }),
        conn.shells.map((sh, i) => h('button', {
          type: 'button',
          class: 'btn block',
          text: `Shell ${i + 1} (#${sh.id.slice(-6)}): ${describe(sh)}`,
          onclick: () => {
            picked = sh;
            close();
          },
        }))), { onClose: () => resolve(picked) });
    });
  }

  // Attaches this page to a shell on a connection, asking first when another
  // window has it. The confirmation carries the attachment revision the user
  // saw: if it changed hands again meanwhile, nothing is taken over and the
  // list is shown afresh. A shell or connection that has gone is said so,
  // and nothing is created in its place.
  async function attachShell(conn, shell, local) {
    let body = { shellId: shell.id };
    if (shell.attached) {
      if (!(await confirmTakeover(conn))) return false;
      body = { shellId: shell.id, takeover: true, revision: shell.revision };
    }
    for (;;) {
      try {
        const r = await api('POST', `/api/sessions/${conn.id}/attach`, body, { timeout: timings.check });
        let s = local;
        if (s) s.useShell(r.shellId, r.lease);
        else {
          s = new TermSession(connectionMeta(r.session), { sessionId: conn.id, shellId: r.shellId, lease: r.lease });
          state.sessions.set(conn.id, s);
        }
        openSession(s);
        refreshConnections();
        return true;
      } catch (err) {
        const code = err.data && err.data.code;
        if (code === 'attached' && !body.takeover) {
          if (!(await confirmTakeover(conn))) return false;
          body = { shellId: shell.id, takeover: true, revision: err.data.revision };
          continue;
        }
        if (err.status === 401) return false;
        if (code === 'conflict') toast('That shell changed hands again meanwhile. Here is the list as it is now.', true);
        else if (code === 'shell-gone') toast('That shell has ended.', true);
        else if (code === 'gone') {
          toast(`The connection to ${conn.name} has ended.`, true);
          if (local) local.markEnded('The SSH connection was closed.');
        } else toast(err.message, true);
        refreshConnections();
        if (code === 'conflict' || code === 'shell-gone' || code === 'gone') {
          if (state.view !== 'home') leaveSession();
          else setHomeTab('connections');
        }
        return false;
      }
    }
  }

  const confirmTakeover = (conn) =>
    confirmSheet(`This shell on ${conn.name} is open in another window or on another device. Use it here instead? It stops there.`, { confirm: 'Use it here' });

  // The view, tab or panel being shown slides in from the side it sits on in
  // `order` (style.css .tab.active); shown again in place, or when either is
  // not in `order`, it only fades in.
  function slideDirection(container, order, from, to) {
    const a = order.indexOf(from);
    const b = order.indexOf(to);
    const d = a < 0 || b < 0 ? 0 : Math.sign(b - a);
    container.style.setProperty('--slide', `${d * 32}px`);
  }

  function showPanel(name) {
    const panel = name === 'files' ? 'files' : 'terminal';
    slideDirection($('view-session').querySelector('.session-main'), ['terminal', 'files'], state.panel, panel);
    state.panel = panel;
    const active = activeSession();
    if (active && active.panel !== state.panel) {
      active.panel = state.panel;
      active.persist();
    }
    if (state.panel !== 'terminal') {
      blurHidden($('panel-terminal'));
      resetTerminalInput();
    }
    for (const p of document.querySelectorAll('#view-session .panel')) {
      const on = p.id === `panel-${state.panel}`;
      p.classList.toggle('active', on);
      if (!on) p.style.animation = ''; // swiped in without the slide; slides in next time
    }
    for (const b of document.querySelectorAll('#session-tabs button')) b.classList.toggle('active', b.dataset.panel === state.panel);
    // Files has its own topbar: its ‹ stays in Files, and Disconnect is the Terminal's.
    $('session-topbar').hidden = state.panel === 'files';
    $('files-topbar').hidden = state.panel !== 'files';
    renderFilesBar();
    const s = activeSession();
    if (!s) return;
    if (state.panel === 'files') {
      if (s.files.path === null && !s.files.loading) loadFiles(s, '.');
      else renderFiles();
    } else {
      s.fitSoon();
      focusTerminal();
    }
  }

  // ================================================================== files

  const joinPath = (dir, name) => (dir === '/' ? '' : dir) + '/' + name;
  const parentPath = (p) => p.replace(/\/[^/]+\/?$/, '') || '/';
  const sftpUrl = (s, params) => `/api/sessions/${s.id}/sftp?${new URLSearchParams(params)}`;

  const MAX_BACK = 50;
  const MAX_RECENT = 8;

  // Opening a folder pushes its list in from the right, and going up or back
  // slides the one before in from the left, the way iOS Files does. The
  // folder left is remembered for ‹ (not when going `back`) and for Go to's
  // Recent. With `keep`, a folder that cannot be listed is only told about:
  // the listing on screen stays. Resolves true once the folder is listed.
  async function loadFiles(s, path, { back = false, keep = false, quiet = false } = {}) {
    const request = ++s.files.request;
    const before = s.files.path;
    const files = s.files;
    let slide = null;
    let listed = false;
    files.loading = true;
    if (s === activeSession()) renderFiles();
    try {
      const r = await api('GET', sftpUrl(s, { op: 'list', path }), undefined, { stall: timings.stall, retries: 2 });
      if (request !== files.request) return false;
      if (before !== null && r.path !== before) {
        const inside = (a, b) => a.startsWith(b === '/' ? '/' : `${b}/`);
        slide = back ? -1 : inside(before, r.path) ? -1 : 1;
        if (!back) {
          files.back.push(before);
          if (files.back.length > MAX_BACK) files.back.shift();
        }
        files.recent = [before, ...files.recent.filter((p) => p !== before && p !== r.path)].slice(0, MAX_RECENT);
      }
      files.path = r.path;
      files.items = r.items;
      files.error = null;
      // Kept for a swipe back to show while the folder is listed again.
      files.listed.delete(r.path);
      files.listed.set(r.path, r.items);
      if (files.listed.size > MAX_BACK) files.listed.delete(files.listed.keys().next().value);
      listed = true;
    } catch (err) {
      if (request !== files.request) return false;
      if (err.data && err.data.code === 'gone') s.markEnded('The SSH connection was closed.');
      if (keep && before !== null) toast(err.message, true);
      else files.error = err.message;
    } finally {
      if (request === s.files.request) {
        s.files.loading = false;
        if (s === activeSession()) {
          renderFiles();
          if (slide !== null && !quiet && state.panel === 'files') {
            $('files-list').animate([{ opacity: 0, transform: `translateX(${reducedMotion.matches ? 0 : slide * 32}px)` }, {}],
              { duration: 280, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
          }
        }
      }
    }
    return listed;
  }

  // The Files topbar's ‹: the folder shown before this one, then the Terminal.
  // `quiet` (a swipe that has the folder on screen already) skips the slide.
  function filesBack(s, { quiet = false } = {}) {
    if (!s.files.back.length) return showPanel('terminal');
    return loadFiles(s, s.files.back.pop(), { back: true, quiet });
  }

  const folderName = (p) => (p === '/' ? '/' : p.replace(/\/+$/, '').split('/').pop() || p);
  // The saved server a session was opened from: null once it is deleted.
  const savedServer = (s) => state.servers.find((x) => x.id === s.server.id) || null;
  const favoritesOf = (server) => (server && server.favorites) || [];

  function renderFilesBar() {
    const s = activeSession();
    if (!s) return;
    const { path, back } = s.files;
    const label = back.length ? folderName(back[back.length - 1]) : 'Terminal';
    $('files-back-label').textContent = label;
    $('files-back').setAttribute('aria-label', `Back to ${label}`);
    $('files-folder').textContent = path === null ? s.server.name : folderName(path);
    const server = savedServer(s);
    const star = $('files-star');
    star.hidden = !server || path === null;
    const on = favoritesOf(server).includes(path);
    star.setAttribute('aria-pressed', String(on));
    const label2 = on ? 'Remove from favorites' : 'Add to favorites';
    star.setAttribute('aria-label', label2);
    star.title = label2;
    star.querySelector('use').setAttribute('href', on ? '#i-star' : '#i-star-outline');
  }

  async function saveFavorites(s, favorites) {
    const server = savedServer(s);
    if (!server) return false;
    try {
      const r = await api('PUT', `/api/servers/${server.id}/favorites`, { favorites });
      state.servers = state.servers.map((x) => (x.id === r.server.id ? r.server : x));
      if (s === activeSession()) renderFilesBar();
      return true;
    } catch (err) {
      toast(err.message, true);
      return false;
    }
  }

  async function toggleFavorite(s) {
    const path = s.files.path;
    const server = savedServer(s);
    if (!server || path === null) return;
    const list = favoritesOf(server);
    const on = list.includes(path);
    if (await saveFavorites(s, on ? list.filter((p) => p !== path) : [...list, path])) {
      toast(on ? 'Removed from favorites' : 'Added to favorites');
    }
  }

  // What was typed in Go to, as a path to list: ~ and ~/x as they are (the
  // server expands them), C:\x as SFTP writes it (/C:/x), and anything
  // relative from the folder on screen.
  function goToPath(typed, current) {
    const v = typed.trim();
    if (v === '~' || v.startsWith('~/')) return v;
    if (/^[A-Za-z]:([\\/]|$)/.test(v)) return '/' + v.replace(/\\/g, '/').replace(/\/$/, '');
    if (v.startsWith('/')) return v;
    return joinPath(current || '/', v);
  }

  function goToSheet(s) {
    const server = savedServer(s);
    const input = h('input', { class: 'input mono', value: s.files.path || '', ...noAutoText, enterkeyhint: 'go', 'aria-label': 'Folder' });
    const place = (glyph, text, target, sub) => h('button', {
      type: 'button', class: 'list-item button', 'data-path': target,
      onclick: async () => {
        close();
        await loadFiles(s, target, { keep: true });
      },
    }, icon(glyph), h('span', { class: 'grow' }, h('div', { text }), sub && sub !== text && h('div', { class: 'sub mono', text: sub })));
    const copyBtn = h('button', {
      type: 'button', class: 'reveal-btn goto-copy', 'aria-label': 'Copy path', title: 'Copy path',
      onclick: () => { if (input.value) copyText(input.value, input); },
    }, icon('copy'));
    // Like the eye button: it must not take focus, or the iOS keyboard closes.
    copyBtn.addEventListener('mousedown', (e) => e.preventDefault());
    const pathBox = h('div', { class: 'reveal' }, input, copyBtn);
    const form = h('form', { novalidate: true, class: 'goto' }, field('Path', pathBox, 'A folder on the server: /absolute, relative to this one, or ~ for home.'));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!input.value.trim()) return;
      if (await loadFiles(s, goToPath(input.value, s.files.path), { keep: true })) close();
    });
    const section = (title, rows, className) => h('div', { class: `section ${className}` }, h('h2', { text: title }), h('div', { class: 'list' }, rows));
    form.append(section('Places', [place('folder', 'Home', '~'), place('folder', 'Root', '/')], 'goto-places'));
    if (server) {
      const favorites = favoritesOf(server);
      const rows = favorites.map((p) => h('div', { class: 'goto-row' },
        place('star', folderName(p), p, p),
        h('button', {
          type: 'button', class: 'icon-btn small', 'aria-label': `Remove ${p} from favorites`, title: 'Remove from favorites',
          onclick: async (e) => {
            const row = e.currentTarget.closest('.goto-row');
            if (await saveFavorites(s, favoritesOf(savedServer(s)).filter((x) => x !== p))) row.remove();
          },
        }, icon('close'))));
      form.append(favorites.length
        ? section('Favorites', rows, 'goto-favorites')
        : h('div', { class: 'section goto-favorites' }, h('h2', { text: 'Favorites' }), h('p', { class: 'note', text: 'Tap the star in a folder to add it here.' })));
    }
    if (s.files.recent.length) {
      form.append(section('Recent', s.files.recent.map((p) => place('folder', folderName(p), p, p)), 'goto-recent'));
    }
    const close = openSheet('Go to', form, { save: saveBtn('Go') });
    if (server) $('sheet-root').querySelector('.sheet-head h2').prepend(monogram(server.id, server.name, true));
    // No focus on open: on a phone the keyboard would cover the sheet. Tap the
    // path to edit it.
  }

  const CODE_EXT = /\.(c|cc|cpp|cs|css|go|h|hpp|html?|ini|java|jsx?|json|kt|lua|mjs|cjs|php|pl|py|rb|rs|scss|sh|bash|zsh|fish|ps1|sql|swift|toml|tsx?|vue|xml|ya?ml|conf|cfg|env|dockerfile|makefile)$/i;
  const ARCHIVE_EXT = /\.(zip|tar|gz|tgz|bz2|xz|zst|7z|rar)$/i;
  const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|heic|heif|bmp|ico|avif)$/i;
  // A file's icon, by its extension.
  function fileGlyph(name) {
    if (CODE_EXT.test(name) || /^(Dockerfile|Makefile)$/.test(name)) return 'code';
    if (ARCHIVE_EXT.test(name)) return 'file-zip';
    if (IMAGE_EXT.test(name)) return 'image';
    return 'file';
  }

  function renderFiles() {
    renderFilesBar();
    const s = activeSession();
    const crumbs = $('files-crumbs');
    const list = $('files-list');
    crumbs.textContent = '';
    // The pull-to-refresh spacer stays: it may be spinning for this render.
    for (const c of Array.from(list.children)) if (!c.classList.contains('ptr')) c.remove();
    if (!s) return;
    const { path, items, loading, error } = s.files;
    const showHidden = !!local.get(KEYS.showHidden, false);
    const hiddenBtn = document.querySelector('[data-files="hidden"]');
    hiddenBtn.setAttribute('aria-pressed', String(showHidden));
    hiddenBtn.querySelector('use').setAttribute('href', showHidden ? '#i-visibility' : '#i-visibility-off');

    if (path) {
      crumbs.append(h('button', { type: 'button', text: '/', onclick: () => loadFiles(s, '/') }));
      let acc = '';
      const parts = path.split('/').filter(Boolean);
      parts.forEach((part, i) => {
        acc += '/' + part;
        const target = acc;
        if (i > 0) crumbs.append(h('span', { class: 'sep', text: '/' }));
        crumbs.append(h('button', { type: 'button', text: part, onclick: () => loadFiles(s, target) }));
      });
      requestAnimationFrame(() => { crumbs.scrollLeft = crumbs.scrollWidth; });
    }

    if (error) {
      list.append(h('div', { class: 'empty' }, icon('folder'),
        h('p', { class: 'error', text: error }),
        h('button', { type: 'button', class: 'btn', text: 'Retry', onclick: () => loadFiles(s, path || '.') })));
      return;
    }
    if (loading && !items.length) {
      list.append(h('div', { class: 'loading' }, h('div', { class: 'spinner' })));
      return;
    }
    list.append(...fileEntries(s, path, items));
  }

  // The rows of a folder's listing: .. above its entries (hidden ones when
  // asked), or a word when there is nothing to show.
  function fileEntries(s, path, items) {
    const showHidden = !!local.get(KEYS.showHidden, false);
    const list = [];
    if (path && path !== '/') {
      list.push(h('div', { class: 'file' },
        h('button', { type: 'button', class: 'file-main', onclick: () => loadFiles(s, parentPath(path)) },
          h('span', { class: 'file-icon' }, icon('folder-up')),
          h('span', { class: 'file-text' }, h('div', { class: 'file-name', text: '..' })))));
    }

    const visible = items.filter((it) => showHidden || !it.name.startsWith('.'));
    for (const item of visible) {
      const isDir = item.type === 'dir' || item.target === 'dir';
      const glyph = item.type === 'symlink' ? (item.target === 'broken' ? 'warning' : isDir ? 'folder' : 'link') : isDir ? 'folder' : fileGlyph(item.name);
      const meta = [
        item.type === 'symlink' ? 'link' : null,
        !isDir ? formatSize(item.size) : null,
        formatDate(item.mtime),
      ].filter(Boolean).join(' · ');
      list.push(h('div', { class: 'file' },
        h('button', {
          type: 'button',
          class: 'file-main',
          onclick: () => (isDir ? loadFiles(s, joinPath(path, item.name)) : openFile(s, item)),
        },
        h('span', { class: `file-icon kind-${glyph}${item.type === 'symlink' ? ' kind-link' : ''}` }, icon(glyph)),
        h('span', { class: 'file-text' }, h('div', { class: 'file-name', text: item.name }), h('div', { class: 'file-meta', text: meta }))),
        h('button', { type: 'button', class: 'file-more', 'aria-label': `Actions for ${item.name}`, onclick: () => fileActions(s, item) }, icon('more'))));
    }
    if (!visible.length) {
      list.push(h('div', { class: 'empty' }, icon('folder'), h('p', { text: items.length ? 'Only hidden files here.' : 'This folder is empty.' })));
    }
    return list;
  }

  function triggerDownload(url, name) {
    const a = h('a', { href: url, download: name, style: 'display:none' });
    document.body.append(a);
    a.click();
    a.remove();
  }

  function fileActions(s, item) {
    const dir = s.files.path;
    const full = joinPath(dir, item.name);
    const isDir = item.type === 'dir' || item.target === 'dir';
    actionSheet(item.name, [
      isDir && { label: 'Open', run: () => loadFiles(s, full) },
      !isDir && { label: 'Open in editor', run: () => openEditor(s, full) },
      !isDir && { label: 'Download', run: () => triggerDownload(sftpUrl(s, { op: 'download', path: full }), item.name) },
      isDir && { label: 'Download as zip', run: () => triggerDownload(sftpUrl(s, { op: 'zip', path: full }), `${item.name}.zip`) },
      { label: 'Copy path', run: () => copyPath(full) },
      { label: 'Rename / move', run: () => renameEntry(s, dir, item) },
      { label: 'Delete', danger: true, run: () => deleteEntry(s, dir, item, isDir && item.type === 'dir') },
    ]);
  }

  // The path as the server's own shell writes it. Windows OpenSSH's SFTP shows
  // drives as /C:/Users/..., which cmd and PowerShell do not accept: C:\Users\...
  const nativePath = (p) => (/^\/[A-Za-z]:(\/|$)/.test(p) ? p.slice(1).replace(/\//g, '\\').replace(/^([A-Za-z]:)$/, '$1\\') : p);

  // Without clipboard access (plain HTTP) the path is shown selected, to copy by hand.
  async function copyPath(sftpPath) {
    const path = nativePath(sftpPath);
    if (await writeClipboard(path)) return toast('Copied');
    const box = h('div', { class: 'key-public', text: path });
    openSheet('Copy path', box);
    copyText(path, box);
  }

  async function fileOp(s, op, body, success) {
    try {
      await api('POST', sftpUrl(s, { op }), body);
      if (success) toast(success);
    } catch (err) {
      toast(err.message, true);
    }
    loadFiles(s, s.files.path);
  }

  async function renameEntry(s, dir, item) {
    const v = await formSheet({
      title: 'Rename / move',
      fields: [{ name: 'to', label: 'New name or path', value: item.name, select: true, hint: 'A name renames in place. A relative or absolute path moves it.' }],
      submit: 'Rename',
    });
    if (!v || !v.to.trim() || v.to.trim() === item.name) return;
    const to = v.to.trim();
    fileOp(s, 'rename', { from: joinPath(dir, item.name), to: to.startsWith('/') ? to : joinPath(dir, to) }, 'Renamed');
  }

  async function deleteEntry(s, dir, item, isRealDir) {
    const question = isRealDir
      ? `Delete the folder "${item.name}" and everything inside it? This cannot be undone.`
      : `Delete "${item.name}"? This cannot be undone.`;
    if (!(await confirmSheet(question, { confirm: 'Delete', danger: true }))) return;
    fileOp(s, 'delete', { path: joinPath(dir, item.name) }, 'Deleted');
  }

  async function newFolder(s) {
    const v = await formSheet({ title: 'New folder', fields: [{ name: 'name', label: 'Folder name' }], submit: 'Create' });
    if (!v || !v.name.trim()) return;
    fileOp(s, 'mkdir', { path: joinPath(s.files.path, v.name.trim()) }, 'Folder created');
  }

  // Consecutive failed attempts, without any progress between them, before an
  // upload is given up (about a minute and a half of backing off).
  const UPLOAD_ATTEMPTS = 8;

  // Uploads one file, however many requests the link needs: after a drop or a
  // stall it asks the server how much arrived and sends only the rest. The
  // server keeps the file aside until it is whole, so a failed upload never
  // replaces anything.
  async function uploadOne(s, dir, file, onProgress) {
    const id = randomId();
    const arrived = async () => (await api('GET', sftpUrl(s, { op: 'upload-offset', dir, id }), undefined, { timeout: timings.check })).offset;
    let offset = 0;
    let failures = 0;
    for (;;) {
      let res = null;
      const stop = new AbortController();
      const watchdog = watchUpload(stop, arrived);
      try {
        res = await request('POST', sftpUrl(s, { op: 'upload', dir, name: file.name, id, offset }), {
          headers: { 'Content-Type': 'application/octet-stream' },
          body: file.slice(offset),
          signal: stop.signal,
          onUpload: (loaded) => {
            watchdog.moved();
            onProgress(offset + loaded);
          },
        });
      } catch {} // the network: find out how far it got
      watchdog.done();
      if (res && res.status >= 200 && res.status < 300) return;
      let data = {};
      try { data = JSON.parse(res.text); } catch {}
      if (res && res.status === 401) onUnauthorized();
      if (data.code === 'gone') s.markEnded('The SSH connection was closed.');
      if (res && !(res.status === 409 && data.code === 'offset')) {
        cancelUpload(s, dir, id);
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      if (++failures >= UPLOAD_ATTEMPTS) {
        cancelUpload(s, dir, id);
        throw networkError();
      }
      await delay(Math.min(15000, 500 * 2 ** failures));
      try {
        const at = await arrived();
        if (at > offset) failures = 0;
        offset = at;
        onProgress(offset);
      } catch (err) {
        if (err.data && err.data.code === 'gone') {
          s.markEnded('The SSH connection was closed.');
          throw err;
        }
      }
    }
  }

  // Gives up on an upload request whose bytes stopped moving. The browser's
  // progress runs ahead of the link by what the system buffers (and says
  // nothing while it resends a request by itself), so before giving up it
  // asks the server whether the file is still growing.
  function watchUpload(stop, arrived) {
    let last = performance.now();
    let seen = -1;
    let checking = false;
    const timer = setInterval(async () => {
      if (checking || performance.now() - last < timings.stall) return;
      checking = true;
      try {
        const at = await arrived();
        if (at > seen) {
          seen = at;
          last = performance.now();
          return;
        }
      } catch {} finally {
        checking = false;
      }
      if (performance.now() - last >= timings.stall) stop.abort();
    }, Math.max(250, timings.stall / 4));
    return {
      moved: () => { last = performance.now(); },
      done: () => clearInterval(timer),
    };
  }

  // What arrived of an upload that is given up; best effort.
  function cancelUpload(s, dir, id) {
    api('POST', sftpUrl(s, { op: 'upload-cancel' }), { dir, id }, { timeout: timings.check }).catch(() => {});
  }

  let uploading = false;
  async function uploadFiles(s, list) {
    if (!list.length || !s.files.path) return;
    if (uploading) return toast('An upload is already running', true);
    const dir = s.files.path;
    const existing = new Set(s.files.items.map((i) => i.name));
    const clashes = list.filter((f) => existing.has(f.name));
    const replaceQuestion = clashes.length === 1 ? `Replace "${clashes[0].name}"?` : `Replace ${clashes.length} existing files?`;
    if (clashes.length && !(await confirmSheet(replaceQuestion, { confirm: 'Replace', danger: true }))) return;

    const progress = $('files-progress');
    const bar = progress.querySelector('.progress-bar');
    const text = progress.querySelector('.progress-text');
    const total = list.reduce((n, f) => n + f.size, 0) || 1;
    let sent = 0;
    uploading = true;
    progress.hidden = false;
    try {
      for (const [i, file] of list.entries()) {
        await uploadOne(s, dir, file, (loaded) => {
          const pct = Math.min(100, Math.round(((sent + loaded) / total) * 100));
          bar.style.width = `${pct}%`;
          text.textContent = `${pct}% · ${list.length > 1 ? `${i + 1}/${list.length} · ` : ''}${file.name}`;
        });
        sent += file.size;
      }
      toast(list.length === 1 ? `Uploaded ${list[0].name}` : `Uploaded ${list.length} files`);
    } catch (err) {
      toast(`Upload failed: ${err.message}`, true);
    } finally {
      uploading = false;
      progress.hidden = true;
      bar.style.width = '0';
      if (s.files.path === dir) loadFiles(s, dir);
    }
  }

  // ================================================================= editor

  const editorEls = {
    view: $('view-editor'),
    main: $('editor-main'),
    name: $('editor-name'),
    dirty: $('editor-dirty'),
    back: $('editor-back'),
    discard: $('editor-discard'),
    edit: $('editor-edit'),
    save: $('editor-save'),
    status: $('editor-status'),
    language: $('editor-language'),
    indent: $('editor-indent'),
    find: $('editor-find'),
    findButton: document.querySelector('[data-editor="find"]'),
    findInput: $('editor-find-input'),
    findOptionsToggle: document.querySelector('[data-editor="find-options"]'),
    findCount: $('editor-find-count'),
    replaceRow: $('editor-replace-row'),
    replaceInput: $('editor-replace-input'),
  };
  // { sessionId, path, name, original, bom, eol, mixedEol, encoding, mtime, size, editing, saving, saveDone, locked, large }:
  // sessionId is the connection it was opened through, the only one it is saved through.
  // saveDone settles when the last save does.
  let openedFile = null;
  let codeEditor = null;
  let largeView = null; // LargeFile viewer while a file too big for the editor is open
  let largeLanguage = 'plaintext';
  let cursorPos = { line: 1, col: 1 };
  let topOffset = 0; // large files: byte offset of the first line on screen
  let topLine = null; // and its line number, once known
  let lineIndexRequest = null;
  let languagesListed = false;

  const editorDirty = () => !!openedFile && !openedFile.large && !!codeEditor && codeEditor.getValue() !== openedFile.original;
  const baseName = (p) => p.split('/').pop() || p;
  const dirName = (p) => parentPath(p);
  const keyboardOpen = () => document.body.classList.contains('kb-open');
  const EOL_NAMES = { lf: 'LF', crlf: 'CRLF', cr: 'CR' };
  const ENCODING_NAMES = { 'utf-16le': 'UTF-16 LE', 'utf-16be': 'UTF-16 BE', 'windows-1252': 'Windows-1252' };

  // Indentation for typing (tabs or spaces) and the width of a tab; tabs, 4 wide by default.
  const INDENTS = ['tab-2', 'tab-4', 'tab-8', 'space-2', 'space-4', 'space-8'];
  function indentSetting() {
    const value = INDENTS.includes(local.get(KEYS.editorIndent)) ? local.get(KEYS.editorIndent) : 'tab-4';
    const [kind, size] = value.split('-');
    return { value, tabs: kind === 'tab', size: Number(size) };
  }

  function getEditor() {
    if (!codeEditor) {
      codeEditor = CodeEditor.create(editorEls.main, {
        onChange: () => {
          updateEditorChrome();
          saveDraftSoon();
          if (!editorEls.find.hidden) showFindState(codeEditor.searchState());
        },
        onSave: () => saveEditor(),
        onReadOnlyTap: (offset) => followMarkdownLink(offset),
        onCursor: (pos) => {
          cursorPos = pos;
          updateEditorStatus();
        },
        keyboardOpen,
      });
      codeEditor.setWrap(!!local.get(KEYS.editorWrap, true));
      codeEditor.setLineNumbers(!!local.get(KEYS.editorLineNumbers, true));
      codeEditor.setIndent(indentSetting());
    }
    return codeEditor;
  }

  function closeLargeView() {
    stopLargeSearch();
    if (lineIndexRequest) lineIndexRequest.abort();
    lineIndexRequest = null;
    topLine = null;
    if (largeView) largeView.destroy();
    largeView = null;
    editorEls.main.classList.remove('large');
  }

  function updateEditorStatus() {
    if (!openedFile) return;
    const e = getEditor();
    const language = openedFile.large ? largeLanguage : e.language;
    const chosen = openedFile.large ? openedFile.chosenLanguage : e.chosenLanguage;
    const langOption = Array.from(editorEls.language.options).find((o) => o.value === language);
    const percent = `${openedFile.size ? Math.floor((topOffset / openedFile.size) * 1000) / 10 : 0}%`;
    const position = openedFile.large
      ? (topLine ? `Ln ${topLine.toLocaleString()} · ${percent}` : `${percent} · byte ${topOffset.toLocaleString()}`)
      : `Ln ${cursorPos.line}, Col ${cursorPos.col}`;
    const parts = [
      h('span', { text: position }),
      h('span', { text: EOL_NAMES[openedFile.eol] }),
      ENCODING_NAMES[openedFile.encoding] && h('span', { text: ENCODING_NAMES[openedFile.encoding] }),
      openedFile.bom && h('span', { text: 'BOM' }),
      h('span', { text: formatSize(openedFile.size) }),
      openedFile.large ? h('span', { class: 'ro', text: 'large file, read-only' }) : !openedFile.editing && h('span', { class: 'ro', text: 'read-only' }),
    ];
    editorEls.status.textContent = '';
    editorEls.status.append(...parts.filter(Boolean));
    const auto = editorEls.language.options[0];
    if (auto) auto.textContent = chosen === 'auto' ? (langOption && language !== 'plaintext' ? langOption.textContent : 'Plain text') : 'Auto-detect';
  }

  function updateEditorChrome() {
    if (!openedFile) return;
    const dirty = editorDirty();
    editorEls.dirty.hidden = !dirty;
    editorEls.name.textContent = openedFile.name;
    // While editing, the way out is saving or discarding.
    editorEls.back.hidden = openedFile.editing;
    editorEls.discard.hidden = !openedFile.editing;
    editorEls.discard.disabled = !!openedFile.saving;
    editorEls.edit.hidden = openedFile.editing || openedFile.locked;
    editorEls.save.hidden = !openedFile.editing;
    editorEls.save.disabled = !!openedFile.saving;
    editorEls.save.classList.toggle('dirty', dirty);
    for (const b of document.querySelectorAll('[data-editor="indent"], [data-editor="outdent"]')) b.hidden = !openedFile.editing;
    document.querySelector('[data-editor="wrap"]').setAttribute('aria-pressed', String(!!local.get(KEYS.editorWrap, true)));
    document.querySelector('[data-editor="lines"]').setAttribute('aria-pressed', String(!!local.get(KEYS.editorLineNumbers, true)));
    updateFindToggles();
    updateEditorStatus();
  }

  // focus only from a tap handler: iOS opens the keyboard for focus() inside a
  // user gesture. Focusing outside one leaves the field focused without a
  // keyboard, and later taps on it do not bring one up.
  function setEditing(on, { focus = false } = {}) {
    openedFile.editing = on;
    getEditor().setReadOnly(!on);
    updateEditorChrome();
    if (on && focus) getEditor().focus();
    if (on && openedFile.mixedEol && !openedFile.mixedWarned) {
      openedFile.mixedWarned = true;
      toast(`This file mixes line endings. Saving it uses ${EOL_NAMES[openedFile.eol]} on every line.`, false, 4500);
    }
  }

  // Leaves edit mode, putting back the text as it was last opened or saved.
  async function discardEdits() {
    const file = openedFile;
    if (!file || !file.editing || file.saving) return;
    if (editorDirty() && !(await confirmSheet(`Discard unsaved changes to "${file.name}"?`, { confirm: 'Discard', danger: true }))) return;
    if (openedFile !== file || !file.editing || file.saving) return;
    const e = getEditor();
    if (e.getValue() !== file.original) {
      const scroller = editorEls.main.querySelector('.code-scroll');
      const top = scroller.scrollTop;
      e.setValue(file.original, { path: file.path, language: e.chosenLanguage });
      scroller.scrollTop = top;
      cursorPos = { line: 1, col: 1 };
      if (!editorEls.find.hidden) runFind();
    }
    session.remove(KEYS.editorDraft);
    if (document.activeElement === e.input) e.input.blur();
    setEditing(false);
  }

  const saveDraftSoon = debounce(() => {
    if (!openedFile || openedFile.large) return;
    const value = getEditor().getValue();
    if (!editorDirty() || value.length > 1024 * 1024) return session.remove(KEYS.editorDraft);
    const { sessionId, path, mtime, size } = openedFile;
    session.set(KEYS.editorDraft, { sessionId, path, mtime, size, value, at: Date.now() });
  }, 600);

  async function populateLanguages() {
    if (languagesListed) return;
    languagesListed = true;
    try {
      for (const lang of await CodeEditor.listLanguages()) {
        editorEls.language.append(h('option', { value: lang.id, text: lang.name }));
      }
    } catch {
      languagesListed = false;
    }
    updateEditorStatus();
  }

  // Opens a file from the list; binary files show the actions instead.
  async function openFile(s, item) {
    const opened = await openEditor(s, joinPath(s.files.path, item.name), { quietRefusal: true });
    if (opened === 'refused') fileActions(s, item);
  }

  async function confirmLeaveEditor() {
    // A save under way may leave nothing unsaved: wait for it before asking.
    if (openedFile && openedFile.saveDone) await openedFile.saveDone;
    return !(openedFile && editorDirty()) || confirmSheet(`Discard unsaved changes to "${openedFile.name}"?`, { confirm: 'Discard', danger: true });
  }

  // Returns true when the editor opened, 'refused' for binary files, false otherwise.
  // With openFolders, a folder shows in the file list instead (returns 'folder').
  async function openEditor(s, path, { edit = false, quietRefusal = false, openFolders = false } = {}) {
    if (!(await confirmLeaveEditor())) {
      showView('editor');
      return false;
    }
    let data;
    editorEls.main.classList.add('loading');
    try {
      data = await api('GET', sftpUrl(s, { op: 'read', path }), undefined, { stall: timings.stall, retries: 2 });
    } catch (err) {
      const code = err.data && err.data.code;
      if (code === 'too-large') return openLargeFile(s, path, { quietRefusal });
      if (code === 'folder' && openFolders) {
        leaveEditor(s, path);
        return 'folder';
      }
      if (code === 'gone') s.markEnded('The SSH connection was closed.');
      toast(err.message, true);
      return code === 'binary' ? (quietRefusal ? 'refused' : false) : false;
    } finally {
      editorEls.main.classList.remove('loading');
    }

    let text = data.content;
    const bom = text.startsWith('﻿');
    if (bom) text = text.slice(1);
    const lines = CodeEditor.splitLineEndings(text);
    text = lines.text;

    closeLargeView();
    openedFile = {
      sessionId: s.id,
      path: data.path,
      name: baseName(data.path),
      original: text,
      bom,
      eol: lines.eol,
      mixedEol: lines.mixed,
      encoding: data.encoding || 'utf-8',
      mtime: data.mtime,
      size: data.size,
      editing: false,
      saving: false,
      locked: false,
    };
    cursorPos = { line: 1, col: 1 };
    closeFind();
    editorEls.language.value = 'auto';
    showView('editor');
    const e = getEditor();
    e.setReadOnly(true);
    const loading = e.setValue(text, { path: data.path }); // text is in place now, colours follow
    updateEditorChrome();
    populateLanguages();
    await loading;
    updateEditorStatus();

    const draft = session.get(KEYS.editorDraft, null);
    if (draft && draft.sessionId === openedFile.sessionId && draft.path === openedFile.path && draft.value !== text) {
      const when = new Date(draft.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const stale = draft.mtime !== data.mtime || draft.size !== data.size;
      const question = stale
        ? `You have unsaved changes from ${when}, but the file changed on the server since. Restore your version anyway?`
        : `Restore your unsaved changes from ${when}?`;
      if (await confirmSheet(question, { confirm: 'Restore' })) {
        await e.setValue(draft.value, { path: data.path });
        setEditing(edit); // mark the restored text unsaved; Edit enables typing
        return true;
      }
      session.remove(KEYS.editorDraft);
    }
    if (edit) setEditing(true);
    return true;
  }

  // Byte range fetch for the large-file viewer.
  // A stalled or dropped range is asked for again, a couple of times.
  async function fetchRange(s, path, start, length) {
    const url = sftpUrl(s, { op: 'range', path, start, length });
    let res;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await request('GET', url, { stall: timings.stall, binary: true });
        break;
      } catch (err) {
        if (attempt >= 2) throw err;
        await delay(1000 * 2 ** attempt);
      }
    }
    if (res.status < 200 || res.status >= 300) {
      let data = {};
      try { data = JSON.parse(new TextDecoder().decode(res.bytes)); } catch {}
      if (res.status === 401) onUnauthorized();
      if (data.code === 'gone') s.markEnded('The SSH connection was closed.');
      throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
    }
    return { bytes: res.bytes, size: Number(res.header('X-File-Size')), mtime: Number(res.header('X-File-Mtime')) };
  }

  // Files over the editor's limit open read-only in the paged viewer.
  async function openLargeFile(s, path, { quietRefusal = false } = {}) {
    let head;
    try {
      head = await fetchRange(s, path, 0, LargeFile.CHUNK);
    } catch (err) {
      toast(err.message, true);
      return false;
    }
    if (head.bytes.subarray(0, 8000).includes(0)) {
      toast('This looks like a binary file.', true);
      return quietRefusal ? 'refused' : false;
    }
    const sample = new TextDecoder().decode(head.bytes.subarray(0, 64 * 1024));
    closeLargeView();
    openedFile = {
      sessionId: s.id,
      path,
      name: baseName(path),
      bom: sample.startsWith('﻿'),
      eol: CodeEditor.splitLineEndings(sample).eol,
      mtime: head.mtime,
      size: head.size,
      editing: false,
      saving: false,
      locked: true,
      large: true,
      chosenLanguage: 'auto',
      sample,
    };
    const file = openedFile;
    topOffset = 0;
    closeFind();
    editorEls.language.value = 'auto';
    showView('editor');
    let changedWarned = false;
    editorEls.main.classList.add('large');
    largeView = LargeFile.create(editorEls.main, {
      size: head.size,
      load: async (start, length) => {
        if (start === 0 && length <= head.bytes.length) return head.bytes.subarray(0, length);
        const r = await fetchRange(s, path, start, length);
        if ((r.size !== file.size || r.mtime !== file.mtime) && !changedWarned && openedFile === file) {
          changedWarned = true;
          toast('This file changed on the server since you opened it. Reopen it to see the current version.', true);
        }
        return r.bytes;
      },
      onPosition: ({ offset, line }) => {
        topOffset = offset;
        topLine = line;
        updateEditorStatus();
      },
      onError: (err) => { if (openedFile === file) toast(err.message, true); },
    });
    largeView.setWrap(!!local.get(KEYS.editorWrap, true));
    largeView.setLineNumbers(!!local.get(KEYS.editorLineNumbers, true));
    largeView.setTabSize(indentSetting().size);
    loadLineIndex(s, file);
    updateEditorChrome();
    populateLanguages();
    await setLargeLanguage('auto');
    return true;
  }

  // Line numbers for a large file: the server counts its lines once (a few
  // seconds per GB) and sends where every 1000th line starts.
  async function loadLineIndex(s, file) {
    const controller = new AbortController();
    lineIndexRequest = controller;
    try {
      const res = await fetch(sftpUrl(s, { op: 'lines', path: file.path }), { headers: { 'X-Requested-With': 'fetch' }, credentials: 'same-origin', signal: controller.signal });
      if (!res.ok) return;
      const text = await res.text();
      const done = text.trim().split('\n').map((l) => JSON.parse(l)).find((m) => m.t === 'done');
      if (done && openedFile === file && largeView) largeView.setLineIndex(done);
    } catch {
      // Aborted or failed: the viewer works without line numbers.
    } finally {
      if (lineIndexRequest === controller) lineIndexRequest = null;
    }
  }

  async function setLargeLanguage(choice) {
    const file = openedFile;
    file.chosenLanguage = choice;
    const language = await CodeEditor.detectLanguage(file.path, file.sample, choice);
    if (openedFile !== file || !largeView) return;
    largeLanguage = language;
    largeView.setHighlighter((text) => CodeEditor.highlight(text, language));
    updateEditorStatus();
  }

  async function closeEditor() {
    if (!(await confirmLeaveEditor())) return;
    const sessionId = openedFile && openedFile.sessionId;
    const dir = openedFile && dirName(openedFile.path);
    const s = sessionId && state.sessions.get(sessionId);
    leaveEditor(s && !s.ended ? s : null, dir, { reloadOnly: true });
  }

  // Closes the file (unsaved changes already confirmed) and shows the folder
  // `dir` of session s, or the server list without one. With reloadOnly, the
  // file list moves only if it already shows `dir`.
  function leaveEditor(s, dir, { reloadOnly = false } = {}) {
    openedFile = null;
    session.remove(KEYS.editorDraft);
    closeFind();
    closeLargeView();
    if (document.activeElement) document.activeElement.blur();
    if (!s) return showHome();
    openSession(s);
    showPanel('files');
    if (!reloadOnly || s.files.path === dir) loadFiles(s, dir);
  }

  // A tap on a link in a read-only Markdown file follows it: #anchors scroll to
  // their heading, paths open that file (or folder) on the server, and web
  // addresses open in a new tab.
  async function followMarkdownLink(offset) {
    const file = openedFile;
    const e = getEditor();
    if (!file || file.large || file.editing || e.language !== 'markdown') return;
    const target = MarkdownLinks.resolve(MarkdownLinks.linkAt(e.getValue(), offset), file.path);
    if (!target) return;
    if (target.kind === 'url') {
      window.open(target.url, '_blank', 'noopener');
      return;
    }
    if (target.kind === 'anchor' || target.path === file.path) {
      if (target.anchor) goToAnchor(target.anchor);
      return;
    }
    const s = state.sessions.get(file.sessionId);
    if (!s || s.ended) return toast('Not connected. Reconnect to the server to follow links.', true);
    if (target.dir) {
      if (await confirmLeaveEditor()) leaveEditor(s, target.path);
      return;
    }
    if ((await openEditor(s, target.path, { openFolders: true })) === true && target.anchor && openedFile && !openedFile.large) goToAnchor(target.anchor);
  }

  // Scrolls to a heading's anchor, or to a line for #L12-style anchors.
  function goToAnchor(anchor) {
    const e = getEditor();
    const text = e.getValue();
    let offset = e.language === 'markdown' ? MarkdownLinks.anchorOffset(text, anchor) : -1;
    const line = anchor.match(/^L(\d+)(?:-L?\d+)?$/);
    if (offset === -1 && line) {
      const starts = text.split('\n').slice(0, Number(line[1]) - 1);
      offset = Math.min(text.length, starts.reduce((sum, l) => sum + l.length + 1, 0));
    }
    if (offset === -1) return toast(`No heading for #${anchor} in this file`, true);
    e.scrollToOffset(offset);
  }

  async function saveEditor(force = false) {
    if (!openedFile || !openedFile.editing || openedFile.saving) return;
    const file = openedFile;
    const s = state.sessions.get(file.sessionId);
    if (!s || s.ended) {
      toast('Not connected. Reconnect to the server from the server list, then save again.', true);
      return;
    }
    const value = getEditor().getValue();
    let content = CodeEditor.joinLineEndings(value, file.eol);
    if (file.bom) content = '﻿' + content;

    file.saving = true;
    let settled;
    file.saveDone = new Promise((resolve) => { settled = resolve; });
    updateEditorChrome();
    try {
      const r = await api('POST', sftpUrl(s, { op: 'write' }), {
        path: file.path,
        content,
        encoding: file.encoding,
        expected: { mtime: file.mtime, size: file.size },
        force,
      }, { stall: timings.stall, retries: 2, compress: true });
      file.mtime = r.mtime;
      file.size = r.size;
      file.original = value;
      file.mixedEol = false;
      // Back to read-only, unless typing went on during the save.
      if (openedFile === file && getEditor().getValue() === value) {
        session.remove(KEYS.editorDraft);
        setEditing(false);
      }
      toast(`Saved ${file.name}`);
      if (s.files.path === dirName(file.path)) loadFiles(s, s.files.path);
    } catch (err) {
      const code = err.data && err.data.code;
      if (code === 'changed' || code === 'deleted') {
        file.saving = false;
        if (await confirmSheet(`${err.message} Overwrite it with your version?`, { confirm: 'Overwrite', danger: true })) return await saveEditor(true);
      } else {
        if (code === 'gone') s.markEnded('The SSH connection was closed.');
        toast(`Not saved: ${err.message}`, true);
      }
    } finally {
      file.saving = false;
      settled();
      if (openedFile === file) updateEditorChrome();
    }
  }

  // Reads the file from the server again, keeping the scroll position and edit mode.
  async function reloadEditor() {
    if (!openedFile) return;
    const file = openedFile;
    const s = state.sessions.get(file.sessionId);
    if (!s || s.ended) return toast('Not connected. Reconnect to the server from the server list, then reload.', true);
    if (editorDirty()) {
      if (!(await confirmSheet(`Discard unsaved changes to "${file.name}" and reload it from the server?`, { confirm: 'Reload', danger: true }))) return;
      file.original = getEditor().getValue(); // already confirmed: openEditor need not ask again
      session.remove(KEYS.editorDraft);
    }
    const scroller = editorEls.main.querySelector(file.large ? '.big-scroll' : '.code-scroll');
    const top = scroller ? scroller.scrollTop : 0;
    const opened = await openEditor(s, file.path, { edit: file.editing });
    if (opened !== true || !openedFile) return;
    if (!openedFile.large) editorEls.main.querySelector('.code-scroll').scrollTop = top;
    toast(`Reloaded ${openedFile.name}`);
  }

  async function newFile(s) {
    const v = await formSheet({ title: 'New file', fields: [{ name: 'name', label: 'File name', placeholder: 'notes.txt' }], submit: 'Create' });
    const name = v && v.name.trim();
    if (!name) return;
    if (name.includes('/')) return toast('Use a name without "/"', true);
    const path = joinPath(s.files.path, name);
    try {
      await api('POST', sftpUrl(s, { op: 'write' }), { path, content: '', create: true }, { stall: timings.stall });
    } catch (err) {
      return toast(err.message, true);
    }
    loadFiles(s, s.files.path);
    openEditor(s, path);
  }

  // ------------------------------------------------------------ find/replace
  // Like VS Code: match case, whole word, regular expression and find in
  // selection toggles, replace (one or all) with $1-style groups and preserve
  // case. The toggles are remembered on this device.

  const FIND_OPTIONS = { case: 'caseSensitive', word: 'wholeWord', regex: 'regex', preserve: 'preserveCase' };
  const findOptions = { caseSensitive: false, wholeWord: false, regex: false, preserveCase: false };
  for (const key of Object.keys(findOptions)) findOptions[key] = !!local.get(KEYS.editorFind, {})[key];
  let replaceOpen = false;

  const findQuery = () => ({ query: editorEls.findInput.value, ...findOptions });

  function updateFindToggles() {
    for (const [name, key] of Object.entries(FIND_OPTIONS)) {
      const btn = document.querySelector(`[data-editor="opt-${name}"]`);
      if (btn) btn.setAttribute('aria-pressed', String(!!findOptions[key]));
    }
    editorEls.findOptionsToggle.dataset.active = String(findOptions.caseSensitive || findOptions.wholeWord || findOptions.regex);
    const expand = document.querySelector('[data-editor="toggle-replace"]');
    expand.hidden = !canReplace();
    if (!canReplace()) {
      replaceOpen = false;
      if (editorEls.replaceRow.contains(document.activeElement)) {
        if (!editorEls.find.hidden) editorEls.findInput.focus();
        else document.activeElement.blur();
      }
    }
    expand.setAttribute('aria-expanded', String(replaceOpen));
    editorEls.replaceRow.hidden = !replaceOpen;
    updateReplaceButtons();
  }

  let findCount = 0;
  const canReplace = () => !!(openedFile && openedFile.editing && !openedFile.large && !openedFile.locked);

  function updateReplaceButtons() {
    for (const b of document.querySelectorAll('[data-editor="replace-one"], [data-editor="replace-all"]')) b.disabled = !canReplace() || !findCount;
    editorEls.replaceInput.placeholder = !openedFile || canReplace() ? 'Replace' : openedFile.large ? 'Large files are read-only' : 'This file is read-only';
  }

  function openFind({ replace = false } = {}) {
    if (!openedFile) return;
    replace = replace && canReplace();
    const seed = !openedFile.large && getEditor().selectedText();
    if (seed) editorEls.findInput.value = seed;
    if (replace) replaceOpen = true;
    editorEls.find.hidden = false;
    editorEls.findButton.setAttribute('aria-pressed', 'true');
    updateFindToggles();
    const field = replace && editorEls.findInput.value ? editorEls.replaceInput : editorEls.findInput;
    field.focus();
    field.select();
    if (editorEls.findInput.value) runFind();
  }

  // On phones the match case, whole word and regex toggles live in a menu
  // under the options button, so Find fits on one row. It stays open while
  // they are toggled, and closes on a tap elsewhere.
  const findOptionsOpen = () => editorEls.findOptionsToggle.getAttribute('aria-expanded') === 'true';
  function setFindOptionsMenu(open) {
    editorEls.findOptionsToggle.setAttribute('aria-expanded', String(open));
  }

  function closeFind() {
    setFindOptionsMenu(false);
    editorEls.find.hidden = true;
    editorEls.findButton.setAttribute('aria-pressed', 'false');
    editorEls.findCount.textContent = '';
    editorEls.findInput.classList.remove('invalid');
    if (codeEditor) codeEditor.clearFind();
    stopLargeSearch();
    if (largeView) largeView.setMatches([]);
  }

  // From a tap or key: a find field loses focus with the bar. On iOS a hidden
  // field would keep it, and the keyboard would not open for the text after.
  function closeFindToEditor() {
    const hadFocus = editorEls.find.contains(document.activeElement);
    closeFind();
    if (!hadFocus) return;
    if (openedFile && openedFile.editing && !openedFile.large) getEditor().focus();
    else document.activeElement.blur();
  }

  // st: { count, index, error, truncated, searching, scanned }
  function showFindState(st) {
    const query = editorEls.findInput.value;
    editorEls.findInput.classList.toggle('invalid', !!(st && st.error));
    editorEls.findInput.title = (st && st.error) || '';
    let text = '';
    if (!st || !query) text = '';
    else if (st.error) text = 'Invalid';
    else if (st.count && st.index >= 0) text = `${st.index + 1} of ${st.count}${st.truncated ? '+' : ''}`;
    else if (st.count) text = `${st.count}${st.truncated ? '+' : ''} result${st.count === 1 ? '' : 's'}`;
    else if (!st.searching) text = 'No results';
    if (st && st.searching) text = `${text ? `${text} · ` : ''}${Math.floor((st.scanned / Math.max(1, openedFile.size)) * 100)}%`;
    editorEls.findCount.textContent = text;
    findCount = st && !st.error ? st.count || 0 : 0;
    updateReplaceButtons();
  }

  function runFind() {
    if (!openedFile) return;
    if (openedFile.large) return runLargeSearchSoon();
    if (!editorEls.findInput.value) {
      getEditor().clearFind();
      return showFindState(null);
    }
    showFindState(getEditor().setSearch(findQuery()));
  }

  function stepFind(dir) {
    if (!openedFile || !editorEls.findInput.value) return;
    if (openedFile.large) return stepLargeSearch(dir);
    showFindState(getEditor().findNext(dir));
  }

  function replaceOne() {
    if (!canReplace()) return;
    showFindState(getEditor().replaceOne(editorEls.replaceInput.value, { preserveCase: findOptions.preserveCase }));
  }

  function replaceAll() {
    if (!canReplace()) return;
    const n = getEditor().replaceAll(editorEls.replaceInput.value, { preserveCase: findOptions.preserveCase });
    showFindState(getEditor().searchState());
    toast(n ? `Replaced ${n} occurrence${n === 1 ? '' : 's'}` : 'Nothing to replace');
  }

  function toggleFindOption(name) {
    const key = FIND_OPTIONS[name];
    findOptions[key] = !findOptions[key];
    local.set(KEYS.editorFind, findOptions);
    updateFindToggles();
    if (key !== 'preserveCase') runFind();
  }

  // Large files: the server streams matches (byte offsets) for the whole file.
  let largeSearch = null; // { controller, matches, index, truncated, searching, scanned, error }

  const largeState = (search) => ({ ...search, count: search.matches.length });

  function stopLargeSearch() {
    if (largeSearch && largeSearch.controller) largeSearch.controller.abort();
    largeSearch = null;
  }

  const runLargeSearchSoon = debounce(() => runLargeSearch(), 300);

  async function runLargeSearch() {
    stopLargeSearch();
    const file = openedFile;
    if (!file || !file.large || !largeView || editorEls.find.hidden) return;
    const { query, regex, caseSensitive, wholeWord } = findQuery();
    largeView.setMatches([]);
    if (!query) return showFindState(null);
    const { error } = TextSearch.compile({ query, regex, caseSensitive, wholeWord });
    if (error) return showFindState({ error });

    const s = state.sessions.get(file.sessionId);
    if (!s || s.ended) return toast('Not connected. Reconnect to search this file.', true);
    const search = { controller: new AbortController(), matches: [], index: -1, truncated: false, searching: true, scanned: 0, error: null };
    largeSearch = search;
    const from = largeView.topOffset();
    const params = { op: 'search', path: file.path, query, regex: regex ? 1 : 0, case: caseSensitive ? 1 : 0, word: wholeWord ? 1 : 0 };
    const live = () => largeSearch === search && openedFile === file;
    showFindState(largeState(search));
    try {
      const res = await fetch(sftpUrl(s, params), { headers: { 'X-Requested-With': 'fetch' }, credentials: 'same-origin', signal: search.controller.signal });
      if (!res.ok) {
        let data = {};
        try { data = await res.json(); } catch {}
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffered = '';
      const redraw = debounce(() => { if (live()) largeView.setMatches(search.matches, search.index); }, 150);
      for (;;) {
        const { value, done } = await reader.read();
        if (done || !live()) break;
        buffered += decoder.decode(value, { stream: true });
        const lines = buffered.split('\n');
        buffered = lines.pop();
        for (const line of lines) {
          if (!line) continue;
          const msg = JSON.parse(line);
          if (msg.t === 'matches') {
            search.matches.push(...msg.m);
            // Jump to the first match at or below the top of the screen once one arrives.
            if (search.index === -1) {
              const i = search.matches.findIndex(([start]) => start >= from);
              if (i !== -1) {
                search.index = i;
                largeView.setMatches(search.matches, i);
                largeView.reveal(search.matches[i][0]);
              }
            }
            redraw();
          } else if (msg.t === 'progress') {
            search.scanned = msg.scanned;
          } else if (msg.t === 'done') {
            search.searching = false;
            search.truncated = msg.truncated;
            search.scanned = msg.scanned;
          } else if (msg.t === 'error') {
            throw new Error(msg.message);
          }
        }
        showFindState(largeState(search));
      }
      search.searching = false;
      if (!live()) return;
      if (search.index === -1 && search.matches.length) {
        search.index = 0; // nothing below the screen: wrap to the first
        largeView.reveal(search.matches[0][0]);
      }
      largeView.setMatches(search.matches, search.index);
      showFindState(largeState(search));
    } catch (err) {
      if (err.name === 'AbortError' || !live()) return;
      search.searching = false;
      showFindState(largeState(search));
      toast(`Search failed: ${err.message}`, true);
    }
  }

  function stepLargeSearch(dir) {
    const search = largeSearch;
    if (!search || !search.matches.length) {
      if (!search) runLargeSearch();
      return;
    }
    const n = search.matches.length;
    search.index = search.index === -1 ? (dir > 0 ? 0 : n - 1) : (search.index + dir + n) % n;
    largeView.setMatches(search.matches, search.index);
    largeView.reveal(search.matches[search.index][0]);
    showFindState(largeState(search));
  }

  function bindEditor() {
    editorEls.edit.addEventListener('click', () => {
      if (openedFile && !openedFile.locked) setEditing(true, { focus: true });
    });
    editorEls.save.addEventListener('click', () => saveEditor());
    editorEls.back.addEventListener('click', closeEditor);
    editorEls.discard.addEventListener('click', discardEdits);
    editorEls.indent.value = indentSetting().value;
    editorEls.indent.addEventListener('change', () => {
      local.set(KEYS.editorIndent, editorEls.indent.value);
      const setting = indentSetting();
      getEditor().setIndent(setting);
      if (largeView) largeView.setTabSize(setting.size);
    });
    editorEls.language.addEventListener('change', async () => {
      if (openedFile && openedFile.large) return setLargeLanguage(editorEls.language.value);
      await getEditor().setLanguage(editorEls.language.value);
      updateEditorStatus();
    });
    const toolbar = document.querySelector('.editor-toolbar');
    // Indent buttons must not take focus, or the iOS keyboard closes; find
    // buttons must not take it from the find field.
    for (const el of [toolbar, editorEls.find]) {
      el.addEventListener('mousedown', (e) => {
        if (e.target.closest('[data-editor="indent"], [data-editor="outdent"], .find-bar button')) e.preventDefault();
      });
      el.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-editor]');
        if (!btn || !openedFile) return;
        const action = btn.dataset.editor;
        const ed = getEditor();
        // A toggle, like Wrap and Line numbers beside it.
        if (action === 'find') {
          if (editorEls.find.hidden) openFind();
          else closeFindToEditor();
        }
        else if (action === 'close-find') closeFindToEditor();
        else if (action === 'reload') reloadEditor();
        else if (action === 'next') stepFind(1);
        else if (action === 'prev') stepFind(-1);
        else if (action === 'find-options') setFindOptionsMenu(!findOptionsOpen());
        else if (action === 'toggle-replace') {
          replaceOpen = !replaceOpen;
          updateFindToggles();
        } else if (action.startsWith('opt-')) toggleFindOption(action.slice(4));
        else if (action === 'replace-one') replaceOne();
        else if (action === 'replace-all') replaceAll();
        else if (action === 'indent') ed.insertIndent();
        else if (action === 'outdent') ed.outdent();
        else if (action === 'wrap') {
          const on = !local.get(KEYS.editorWrap, true);
          local.set(KEYS.editorWrap, on);
          ed.setWrap(on);
          if (largeView) largeView.setWrap(on);
          updateEditorChrome();
        } else if (action === 'lines') {
          const on = !local.get(KEYS.editorLineNumbers, true);
          local.set(KEYS.editorLineNumbers, on);
          ed.setLineNumbers(on);
          if (largeView) largeView.setLineNumbers(on);
          updateEditorChrome();
        }
      });
    }
    document.addEventListener('pointerdown', (e) => {
      if (findOptionsOpen() && !e.target.closest('.find-options-wrap')) setFindOptionsMenu(false);
    });
    editorEls.findInput.addEventListener('input', () => runFind());
    editorEls.findInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        stepFind(e.shiftKey ? -1 : 1);
      }
    });
    editorEls.replaceInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if ((e.ctrlKey || e.metaKey) && e.altKey) replaceAll();
      else replaceOne();
    });
    // Shortcuts while the editor is open, as in VS Code.
    document.addEventListener('keydown', (e) => {
      if (state.view !== 'editor' || !openedFile || document.querySelector('#sheet-root .sheet')) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      const inFind = editorEls.find.contains(document.activeElement);
      let handled = true;
      if (mod && !e.altKey && !e.shiftKey && key === 'f') openFind();
      else if ((e.ctrlKey && !e.metaKey && !e.altKey && key === 'h') || (e.metaKey && e.altKey && e.code === 'KeyF')) openFind({ replace: true });
      else if (key === 'f3' || (mod && !e.altKey && key === 'g')) stepFind(e.shiftKey ? -1 : 1);
      else if (key === 'escape' && findOptionsOpen()) setFindOptionsMenu(false);
      else if (key === 'escape' && !editorEls.find.hidden) closeFindToEditor();
      else if (e.altKey && !mod && !editorEls.find.hidden && { KeyC: 1, KeyW: 1, KeyR: 1, KeyP: 1 }[e.code]) {
        toggleFindOption({ KeyC: 'case', KeyW: 'word', KeyR: 'regex', KeyP: 'preserve' }[e.code]);
      } else if (inFind && mod && e.shiftKey && e.code === 'Digit1') replaceOne();
      else if (inFind && mod && e.altKey && key === 'enter') replaceAll();
      else handled = false;
      if (handled) e.preventDefault();
    });
    window.addEventListener('beforeunload', (e) => {
      if (editorDirty()) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  // =============================================================== snippets

  const PLACEHOLDER = /\$\{([A-Za-z_][\w.-]{0,39})\}/g;

  // A command with its words coloured by what they are (see shell-highlight.js).
  function shellCode(command, className = 'snippet-cmd') {
    return h('span', { class: `${className} shell-code` },
      ShellHighlight.tokenize(command).map(([type, text]) => (type === 'plain' ? text : h('span', { class: `sh-${type}`, text }))));
  }

  // confirm: show the command (and any placeholder fields) with a Run button
  // first, even when there is nothing to fill in.
  async function runSnippet(s, snippet, { confirm = false } = {}) {
    let command = snippet.command;
    const names = [...new Set(Array.from(command.matchAll(PLACEHOLDER), (m) => m[1]))];
    if (names.length || confirm) {
      const values = await formSheet({ title: snippet.name, message: shellCode(command, 'snippet-run'), fields: names.map((name) => ({ name, label: name })), submit: 'Run' });
      if (!values) return;
      command = command.replace(PLACEHOLDER, (match, name) => (name in values ? values[name] : match));
    }
    if (s.ended || !s.term) return;
    let data = command.replace(/\n/g, '\r');
    if (snippet.sendEnter) data += '\r';
    s.sendInput(data);
  }

  function openSnippetPicker() {
    const s = activeSession();
    if (!s) return;
    const body = h('div');
    let search = null;
    if (state.snippets.length) {
      search = h('input', { class: 'input snippet-search', type: 'search', placeholder: 'Search snippets', 'aria-label': 'Search snippets', ...noAutoText, autocomplete: 'off' });
      const list = h('div', { class: 'list' });
      const none = h('p', { class: 'muted', hidden: true, text: 'No matching snippets.' });
      const items = state.snippets.map((snippet) => {
        const btn = h('button', { type: 'button', class: 'list-item button' },
          h('div', { class: 'grow' }, h('div', { text: snippet.name }), shellCode(snippet.command)));
        onPress(btn, {
          tap: () => runSnippet(s, snippet, { confirm: true }),
          long: () => editSnippet(snippet),
        });
        list.append(btn);
        return { btn, text: `${snippet.name}\n${snippet.command}`.toLowerCase() };
      });
      // Every word has to appear in the name or the command.
      search.addEventListener('input', () => {
        const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
        let shown = 0;
        for (const { btn, text } of items) {
          btn.hidden = !words.every((w) => text.includes(w));
          if (!btn.hidden) shown++;
        }
        none.hidden = shown > 0;
      });
      body.append(search, list, none, h('p', { class: 'muted', style: 'font-size:13px;margin:10px 4px', text: 'Long-press to edit.' }));
    } else {
      body.append(h('p', { class: 'muted', text: 'No snippets yet. Save commands you run often, then send them from here.' }));
    }
    body.append(h('div', { class: 'sheet-actions' }, h('button', { type: 'button', class: 'btn block', onclick: () => editSnippet() }, icon('add'), 'New snippet')));
    openSheet('Snippets', body);
    // A touch screen would bring up the system keyboard over the list.
    if (search && !MobileKeyboard.active()) search.focus();
  }

  // The order here is the order of the Snippets picker, so it is worth
  // arranging: drag ☰, or move the focused handle with the arrow keys.
  async function saveSnippetOrder(ids) {
    try {
      state.snippets = (await api('POST', '/api/snippets/order', { ids })).snippets;
    } catch (err) {
      toast(err.message, true);
    }
    renderSnippets();
  }

  function renderSnippets() {
    const root = $('tab-snippets');
    root.textContent = '';
    if (!state.snippets.length) {
      root.append(h('div', { class: 'empty' }, icon('code'),
        h('p', { text: 'Snippets are saved commands you send from the Snippets key above the keyboard.' }),
        h('p', { text: 'Write ${name} in a command to be asked for a value when it runs.' }),
        h('button', { type: 'button', class: 'btn primary', text: 'Add a snippet', onclick: () => editSnippet() })));
      return;
    }
    const list = h('div', { class: 'cards' });
    const ids = state.snippets.map((x) => x.id);
    state.snippets.forEach((snippet, index) => {
      list.append(h('div', { class: 'card', 'data-id': snippet.id },
        dragHandle({ name: snippet.name, ids, index, apply: saveSnippetOrder }),
        h('button', { type: 'button', class: 'card-main', onclick: () => editSnippet(snippet) },
          h('div', { class: 'card-title' }, h('span', { class: 'name', text: snippet.name })),
          shellCode(snippet.command)),
        h('button', {
          type: 'button', class: 'card-side danger', 'aria-label': `Delete ${snippet.name}`, title: 'Delete',
          onclick: () => deleteSnippet(snippet),
        }, icon('close'))));
    });
    root.append(h('div', { class: 'section' }, list,
      h('p', { class: 'note', text: 'Tap a snippet to edit it, × to delete it. Drag ☰ to change the order they are listed in.' })));
    restoreHandle(list);
  }

  // From the × on a card and from the Edit sheet, so both ask the same way.
  async function deleteSnippet(snippet) {
    if (!(await confirmSheet(`Delete snippet "${snippet.name}"?`, { confirm: 'Delete', danger: true }))) return false;
    try {
      await api('DELETE', `/api/snippets/${snippet.id}`);
    } catch (err) {
      toast(err.message, true);
      return false;
    }
    await refreshSnippets();
    return true;
  }

  function editSnippet(snippet) {
    const isNew = !snippet;
    const v = snippet || { name: '', command: '', sendEnter: true };
    const name = h('input', { class: 'input', value: v.name, placeholder: 'Disk usage', ...noAutoText });
    const command = h('textarea', { class: 'textarea', value: v.command, placeholder: 'df -h ${path}', ...noAutoText });
    const sendEnter = h('input', { type: 'checkbox', checked: v.sendEnter !== false });
    const error = h('p', { class: 'error' });
    const save = saveBtn(isNew ? 'Add snippet' : 'Save');

    const form = h('form', {},
      field('Name', name),
      field('Command', command, 'Use ${name} for a value asked each time it runs.'),
      h('label', { class: 'check' }, sendEnter, h('span', { text: 'Press Enter after sending' })),
      error,
      !isNew && h('div', { class: 'sheet-actions' },
        h('button', {
          type: 'button',
          class: 'btn block danger',
          text: 'Delete snippet',
          onclick: async () => {
            if (await deleteSnippet(snippet)) close();
          },
        })));

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      save.disabled = true;
      error.textContent = '';
      const body = { name: name.value, command: command.value, sendEnter: sendEnter.checked };
      try {
        await api(isNew ? 'POST' : 'PUT', isNew ? '/api/snippets' : `/api/snippets/${snippet.id}`, body);
        close();
        await refreshSnippets();
      } catch (err) {
        error.textContent = err.message;
        save.disabled = false;
      }
    });
    const close = openSheet(isNew ? 'New snippet' : 'Edit snippet', form, { save, tall: true });
  }

  // ================================================================ servers

  function renderServers() {
    const root = $('tab-servers');
    root.textContent = '';
    const hint = installHint();
    if (hint) root.append(hint);
    if (!state.servers.length) {
      root.append(h('div', { class: 'empty' }, icon('dns'),
        h('p', { text: 'No servers yet.' }),
        h('button', { type: 'button', class: 'btn primary', text: 'Add a server', onclick: () => editServer() })));
      return;
    }
    for (const server of state.servers) {
      const open = openConnections(server.id);
      const connecting = state.connecting.has(server.id);
      const error = state.cardErrors.get(server.id);
      root.append(h('div', { class: 'card' },
        h('button', { type: 'button', class: 'card-main has-monogram', disabled: connecting, onclick: () => tapServer(server) },
          monogram(server.id, server.name),
          h('div', { class: 'card-body' },
            h('div', { class: 'card-title' },
              h('span', { class: 'name', text: server.name }),
              open > 0 && h('span', { class: 'badge open', text: `${open} open` }),
              connecting && h('span', { class: 'spinner' })),
            h('div', { class: 'card-sub', text: `${server.user}@${server.host}:${server.port}` }))),
        h('button', { type: 'button', class: 'card-side', 'aria-label': `Edit ${server.name}`, onclick: () => editServer(server) }, icon('more')),
        error && cardError(error)));
    }
  }

  // Each saved server's own hue (theme.css --hue-N), from a hash of its id so
  // a rename keeps it. Servers are taken in the order they were added, and
  // one whose hue is taken moves on to the next free one: up to eight never
  // share. A connection whose server was deleted keeps the hash's hue.
  const HUES = 8;
  function serverHue(id) {
    const hash = (x) => Array.from(String(x)).reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
    const used = new Set();
    for (const server of state.servers) {
      let hue = hash(server.id) % HUES;
      if (used.size < HUES) while (used.has(hue)) hue = (hue + 1) % HUES;
      if (server.id === id) return hue;
      used.add(hue);
    }
    return hash(id) % HUES;
  }

  // The server's first letter on its hue: on server and connection cards.
  const monogram = (serverId, name, small) => h('span', {
    class: `monogram hue-${serverHue(serverId)}${small ? ' small' : ''}`,
    'data-letter': (Array.from(String(name || '').trim())[0] || '?').toUpperCase(),
    'aria-hidden': 'true',
  });

  // How many connections this device has open to a saved server: the ones
  // the server listed, and any terminal here it has not listed yet.
  function openConnections(serverId) {
    const ids = new Set((state.connections.list || []).filter((c) => c.serverId === serverId).map((c) => c.id));
    for (const s of state.sessions.values()) if (!s.ended && s.server.id === serverId) ids.add(s.id);
    return ids.size;
  }

  // Below the card, not in its button: a button can't hold the Copy button.
  function cardError(message) {
    const text = h('span', { class: 'grow', text: message });
    return h('div', { class: 'card-error' }, icon('warning'), text,
      h('button', { type: 'button', class: 'icon-btn small', 'aria-label': 'Copy error', title: 'Copy error', onclick: () => copyText(message, text) }, icon('copy')));
  }

  function editServer(server) {
    const isNew = !server;
    const v = server || { name: '', host: '', port: 22, user: '', auth: 'password' };
    let auth = v.auth;
    let forgetPassword = false;

    const name = h('input', { class: 'input', value: v.name, placeholder: 'My NAS' });
    const host = h('input', { class: 'input', value: v.host, placeholder: '192.168.1.10 or nas.lan', inputmode: 'url', ...noAutoText });
    const port = h('input', { class: 'input', value: String(v.port), inputmode: 'numeric', pattern: '[0-9]*' });
    const user = h('input', { class: 'input', value: v.user, placeholder: 'admin', ...noAutoText });
    const password = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: v.auth === 'password' && v.hasSecret ? '••••••••' : 'Optional' });
    const keySelect = h('select', { class: 'select', value: v.keyId || '' },
      h('option', { value: '', text: 'Choose a key…' }),
      state.keys.map((k) => h('option', { value: k.id, text: k.name })));

    const savedPassword = v.auth === 'password' && v.hasSecret;
    const passwordHint = h('span', { class: 'hint' });
    const forgetButton = savedPassword && h('button', {
      type: 'button',
      class: 'btn small',
      style: 'margin-top:8px',
      text: 'Forget saved password',
      onclick: () => {
        forgetPassword = true;
        password.value = '';
        password.placeholder = 'Optional';
        forgetButton.hidden = true;
        syncPasswordHint();
      },
    });
    const syncPasswordHint = () => {
      passwordHint.textContent = savedPassword && !forgetPassword
        ? 'Saved. Leave empty to keep it.'
        : 'Leave empty to be asked each time you connect.';
    };
    syncPasswordHint();
    const passwordField = h('label', { class: 'field' }, h('span', { class: 'label', text: 'Password' }), revealable(password), passwordHint, forgetButton);
    const keyField = state.keys.length
      ? field('SSH key', keySelect, 'Managed in the SSH Keys tab.')
      : h('div', { class: 'field' },
        h('span', { class: 'label', text: 'SSH key' }),
        h('span', { class: 'hint', style: 'margin-top:0', text: 'No keys yet.' }),
        h('button', {
          type: 'button',
          class: 'btn small',
          style: 'margin-top:8px',
          text: 'Create a key',
          onclick: () => {
            close();
            setHomeTab('keys');
            newKey();
          },
        }));
    const segButtons = [['password', 'Password'], ['key', 'SSH key']].map(([value, label]) => {
      const b = h('button', { type: 'button', text: label, onclick: () => { auth = value; syncAuth(); } });
      b.dataset.value = value;
      return b;
    });
    function syncAuth() {
      for (const b of segButtons) b.classList.toggle('active', b.dataset.value === auth);
      passwordField.hidden = auth !== 'password';
      keyField.hidden = auth !== 'key';
    }

    const error = h('p', { class: 'error' });
    const save = saveBtn(isNew ? 'Add server' : 'Save');

    const baseBody = () => ({ name: name.value, host: host.value, port: port.value, user: user.value, auth });

    const hostKeySection = !isNew && server.hostKey && h('div', { class: 'field' },
      h('span', { class: 'label', text: 'Host key (trusted on first connect)' }),
      h('div', { class: 'mono muted', style: 'font-size:12px;overflow-wrap:anywhere;margin:0 2px 8px', text: server.hostKey }),
      h('button', {
        type: 'button',
        class: 'btn small',
        text: 'Forget host key',
        onclick: async () => {
          if (!(await confirmSheet('Forget the saved host key? The next connection will trust whatever key the server presents.', { confirm: 'Forget host key', danger: true }))) return;
          try {
            await api('PUT', `/api/servers/${server.id}`, { ...serverBody(server), forgetHostKey: true });
            close();
            await refreshServers();
            toast('Host key forgotten');
          } catch (err) {
            error.textContent = err.message;
          }
        },
      }));

    const form = h('form', { novalidate: true },
      field('Name', name),
      field('Host', host),
      h('div', { class: 'row' }, field('User', user), h('div', { class: 'narrow' }, field('Port', port))),
      h('div', { class: 'field' }, h('span', { class: 'label', text: 'Authentication' }), h('div', { class: 'segmented' }, segButtons)),
      passwordField, keyField,
      hostKeySection,
      error,
      !isNew && h('div', { class: 'sheet-actions' },
        h('button', {
          type: 'button',
          class: 'btn block danger',
          text: 'Delete server',
          onclick: async () => {
            const open = openConnections(server.id);
            const question = `Delete "${server.name}" and its saved credentials?${open ? ` Its ${open === 1 ? 'open connection' : `${open} open connections`} from this device close too.` : ''}`;
            if (!(await confirmSheet(question, { confirm: 'Delete', danger: true }))) return;
            try {
              // The server closes this device's connections to it, whether
              // this page has a terminal on them or not.
              await api('DELETE', `/api/servers/${server.id}`);
              for (const s of [...state.sessions.values()]) {
                if (s.server.id !== server.id) continue;
                if (s === activeSession()) state.activeId = null;
                s.dispose();
              }
              close();
              await refreshServers();
              refreshConnections();
            } catch (err) {
              error.textContent = err.message;
            }
          },
        })));

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      error.textContent = '';
      const body = baseBody();
      if (auth === 'password' && password.value) body.secret = password.value;
      else if (auth === 'password' && forgetPassword) body.clearSecret = true;
      if (auth === 'key') body.keyId = keySelect.value;
      save.disabled = true;
      try {
        await api(isNew ? 'POST' : 'PUT', isNew ? '/api/servers' : `/api/servers/${server.id}`, body);
        close();
        state.cardErrors.delete(v.id);
        await refreshServers();
      } catch (err) {
        error.textContent = err.message;
        save.disabled = false;
      }
    });

    syncAuth();
    const close = openSheet(isNew ? 'New server' : 'Edit server', form, { save, tall: true });
  }

  const serverBody = (s) => ({ name: s.name, host: s.host, port: s.port, user: s.user, auth: s.auth, keyId: s.keyId || '' });

  // =============================================================== SSH keys

  const KEY_CHOICES = [
    ['enclave:', 'Face ID (this device)'],
    ['ed25519:', 'Ed25519 (recommended)'],
    ['rsa:4096', 'RSA 4096'],
    ['rsa:3072', 'RSA 3072'],
    ['rsa:2048', 'RSA 2048'],
    ['ecdsa:256', 'ECDSA 256'],
    ['ecdsa:384', 'ECDSA 384'],
    ['ecdsa:521', 'ECDSA 521'],
  ];
  const keyTypeLabel = (key) => (key.type === 'enclave'
    ? 'Face ID'
    : ({ ed25519: 'Ed25519', rsa: 'RSA', ecdsa: 'ECDSA' }[key.type] || key.type) + (key.bits ? ` ${key.bits}` : ''));
  const keyUsers = (key) => state.servers.filter((s) => s.auth === 'key' && s.keyId === key.id);

  function renderKeys() {
    const root = $('tab-keys');
    root.textContent = '';
    if (!state.keys.length) {
      root.append(h('div', { class: 'empty' }, icon('key'),
        h('p', { text: 'No SSH keys yet.' }),
        h('p', { text: 'Create a key here, add its public key to the server, then choose the key in the server settings.' }),
        h('button', { type: 'button', class: 'btn primary', text: 'Create a key', onclick: () => newKey() })));
      return;
    }
    for (const key of state.keys) {
      const used = keyUsers(key).length;
      root.append(h('div', { class: 'card' },
        h('button', { type: 'button', class: 'card-main', onclick: () => keyDetails(key) },
          h('div', { class: 'card-title' },
            h('span', { class: 'name', text: key.name }),
            used > 0 && h('span', { class: 'badge', text: used === 1 ? '1 server' : `${used} servers` })),
          h('div', { class: 'card-sub', text: `${keyTypeLabel(key)} · ${key.fingerprint}` })),
        h('button', { type: 'button', class: 'card-side', 'aria-label': `Details for ${key.name}`, onclick: () => keyDetails(key) }, icon('more'))));
    }
  }

  // What the app last put on the clipboard (see pasteIntoTerminal).
  let lastCopied = '';
  // True while lastCopied is newer than the system clipboard: the browser
  // refused the copy, so Paste in the app sends lastCopied instead.
  let copiedInAppOnly = false;
  // Leaving the page may copy something else there, which Paste should get.
  addEventListener('blur', () => { copiedInAppOnly = false; });

  async function writeClipboard(text) {
    let ok = false;
    if (window.isSecureContext && navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch {}
    }
    // The async API can refuse (page not focused, no recent tap); the older
    // copy command still works in many of those cases, and on plain HTTP.
    if (!ok) ok = execCopy(text);
    if (ok) {
      lastCopied = text;
      copiedInAppOnly = false;
    }
    return ok;
  }

  function execCopy(text) {
    const onCopy = (e) => {
      e.clipboardData.setData('text/plain', text);
      e.preventDefault();
    };
    document.addEventListener('copy', onCopy, true);
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      document.removeEventListener('copy', onCopy, true);
    }
  }

  async function copyText(text, box) {
    if (await writeClipboard(text)) {
      toast('Copied');
      return;
    }
    // No clipboard access (plain HTTP): select the text so the user can copy it.
    if (box instanceof HTMLTextAreaElement || box instanceof HTMLInputElement) {
      box.focus();
      box.setSelectionRange(0, box.value.length);
      toast('Select and copy the text');
      return;
    }
    const range = document.createRange();
    range.selectNodeContents(box);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    toast('Select and copy the text');
  }

  // Quotes a string for a single-quoted shell argument: a key named
  // "Alex's iPhone" would otherwise end the quoting halfway.
  const shellQuote = (text) => `'${String(text).replace(/'/g, "'\\''")}'`;

  // What a server needs before it takes a Face ID key. The sshd setting some
  // versions need is one line, easy to get wrong from memory and invisible
  // when it is missing (the server just says authentication failed), so the
  // steps sit on the key itself, ready to copy into a terminal.
  function serverSteps(key) {
    const setting = 'PubkeyAcceptedAlgorithms +webauthn-sk-ecdsa-sha2-nistp256@openssh.com';
    const command = (text) => {
      const box = h('div', { class: 'key-public', text });
      return h('div', { class: 'cmd' }, box,
        h('button', { type: 'button', class: 'btn small', onclick: () => copyText(text, box) }, icon('copy'), 'Copy'));
    };
    const step = (title, ...rest) => h('li', {}, h('p', { class: 'step-title', text: title }), ...rest);
    const note = (text) => h('p', { class: 'step-note', text });

    return h('details', { class: 'steps' },
      h('summary', { text: 'Set up the server, step by step' }),
      h('ol', {},
        step('Add the key, as the user you log in as',
          command(`mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo ${shellQuote(`verify-required ${key.public}`)} >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`),
          note('verify-required tells the server to take the signature only when Face ID (or a PIN) checked it was you. Leave it out if the device may be unlocked some other way.')),

        step('Check the server’s OpenSSH version',
          command('ssh -V'),
          note('sshd comes from the same package, and this works on every version (sshd -V only exists from 9.2). 10.3 or newer: you are done. 8.4 to 10.2: step 3. Older than 8.4: that server cannot take a Face ID key — use an Ed25519 key there.')),

        step('Only on 8.4 to 10.2: let sshd accept webauthn signatures',
          note('Those versions can check the signature but do not accept the algorithm by default. If /etc/ssh/sshd_config starts with an Include line (Debian, Ubuntu, Fedora, RHEL 9), drop it in beside it:'),
          command(`echo ${shellQuote(setting)} | sudo tee /etc/ssh/sshd_config.d/10-picossh-faceid.conf`),
          note('Otherwise open the file with sudo nano /etc/ssh/sshd_config and add the line near the top, above any Match block: sshd keeps the first value it finds for a setting, so a line at the end can be ignored, or apply to that Match block alone.'),
          command(setting),
          note('On OpenSSH 8.4 the setting is called PubkeyAcceptedKeyTypes instead (it was renamed in 8.5). If something already sets it, add +webauthn-sk-ecdsa-sha2-nistp256@openssh.com to that line rather than adding a second one:'),
          command('sudo grep -ri pubkeyaccepted /etc/ssh/sshd_config /etc/ssh/sshd_config.d/')),

        step('Check the file and reload sshd',
          command('sudo sshd -t && sudo systemctl reload sshd'),
          note('The service is called ssh on Debian and Ubuntu. A reload keeps open connections, including the one you are typing in.')),

        step('If connecting still fails, the server says why',
          command('sudo journalctl -u ssh -n 30 --no-pager'),
          note('“not in PubkeyAcceptedAlgorithms” means step 3 did not take effect; on a server without journalctl look in /var/log/auth.log.'))));
  }

  function keyDetails(key) {
    const error = h('p', { class: 'error' });
    const publicBox = h('div', { class: 'key-public', text: key.public });
    const detail = (label, value, mono) => h('div', { class: 'field' },
      h('span', { class: 'label', text: label }),
      h('div', { class: mono ? 'mono' : '', style: `overflow-wrap:anywhere;margin:0 2px${mono ? ';font-size:12px' : ''}`, text: value }));
    const users = keyUsers(key);
    const fileUrl = (part) => `/api/keys/${encodeURIComponent(key.id)}/file?part=${part}`;

    const enclave = key.type === 'enclave';
    const body = h('div', {},
      h('div', { class: 'row' },
        detail('Type', keyTypeLabel(key) + (key.hasPassphrase ? ' · passphrase' : '')),
        detail('Created', formatDate(key.createdAt))),
      enclave && detail('Works only on', `${key.rpID}, on the device that made it`),
      // "SHA256:" in the label keeps the 43-character hash on one line on a phone.
      detail('Fingerprint (SHA256)', key.fingerprint.replace(/^SHA256:/, ''), true),
      users.length > 0 && detail('Used by', users.map((s) => s.name).join(', ')),
      h('div', { class: 'field' },
        h('span', { class: 'label', text: 'Public key' }),
        publicBox,
        h('span', { class: 'hint', text: enclave
          ? 'Add this line to ~/.ssh/authorized_keys on the server, which needs OpenSSH 8.4 or newer. The steps below do it.'
          : 'Add this line to ~/.ssh/authorized_keys on the server.' }),
        h('button', { type: 'button', class: 'btn small', style: 'margin-top:8px', onclick: () => copyText(key.public, publicBox) }, icon('copy'), 'Copy')),
      enclave && serverSteps(key),
      error,
      h('div', { class: 'sheet-actions' },
        h('button', { type: 'button', class: 'btn block', onclick: () => triggerDownload(fileUrl('public'), `${key.name}.pub`) }, icon('download'), 'Download public key'),
        !enclave && h('button', {
          type: 'button',
          class: 'btn block',
          onclick: async () => {
            if (!(await confirmSheet('The private key file gives access to every server that trusts this key. Download it?', { confirm: 'Download' }))) return;
            triggerDownload(fileUrl('private'), key.name);
          },
        }, icon('download'), 'Download private key'),
        h('button', {
          type: 'button',
          class: 'btn block',
          text: 'Rename',
          onclick: async () => {
            const values = await formSheet({ title: 'Rename key', fields: [{ name: 'name', label: 'Name', value: key.name, select: true }], submit: 'Rename' });
            if (!values) return;
            try {
              const { key: renamed } = await api('PUT', `/api/keys/${key.id}`, { name: values.name });
              await refreshKeys();
              keyDetails(renamed);
            } catch (err) {
              toast(err.message, true);
            }
          },
        }),
        h('button', {
          type: 'button',
          class: 'btn block danger',
          text: 'Delete key',
          onclick: async () => {
            if (!(await confirmSheet(`Delete key "${key.name}"? This cannot be undone.`, { confirm: 'Delete', danger: true }))) return;
            try {
              await api('DELETE', `/api/keys/${key.id}`);
              close();
              await refreshKeys();
            } catch (err) {
              error.textContent = err.message;
            }
          },
        })));
    const close = openSheet(key.name, body);
  }

  function newKey() {
    const name = h('input', { class: 'input', placeholder: 'iPhone', ...noAutoText });
    // A Face ID key is made by this device and stays on it, so it is only
    // offered where the browser can make one.
    const choices = KEY_CHOICES.filter(([value]) => value !== 'enclave:' || passkeySupported());
    const type = h('select', { class: 'select', value: 'ed25519:' }, choices.map(([value, label]) => h('option', { value, text: label })));
    const passphrase = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'Optional' });
    const error = h('p', { class: 'error' });
    const create = saveBtn('Create key');

    const passphraseField = field('Passphrase', revealable(passphrase),'Optional. Stored here so connecting never asks; downloaded private keys stay encrypted with it.');
    const enclaveNote = h('p', { class: 'note', hidden: true, text: 'The key is made by Face ID in this device’s secure enclave: it cannot be copied off it, downloaded or used from another device, and every connection asks for your face. The server needs OpenSSH 8.4 or newer.' });
    const isEnclave = () => type.value === 'enclave:';
    type.addEventListener('change', () => {
      passphraseField.hidden = isEnclave();
      enclaveNote.hidden = !isEnclave();
    });

    const form = h('form', { novalidate: true },
      field('Name', name),
      field('Type', type),
      enclaveNote,
      passphraseField,
      error);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      error.textContent = '';
      const [keyType, bits] = type.value.split(':');
      create.disabled = true;
      create.replaceChildren(h('span', { class: 'spinner' })); // RSA can take a few seconds
      try {
        const key = keyType === 'enclave'
          ? await enrolEnclaveKey(name.value)
          : (await api('POST', '/api/keys', { name: name.value, type: keyType, ...(bits && { bits: Number(bits) }), passphrase: passphrase.value })).key;
        close();
        await refreshKeys();
        toast('Key created');
        keyDetails(key);
      } catch (err) {
        error.textContent = err.message;
        create.disabled = false;
        create.replaceChildren(icon('check'));
      }
    });
    const close = openSheet('New SSH key', form, { save: create, tall: true });
    name.focus();
  }

  // =============================================================== passkeys

  const passkeySupported = () => window.isSecureContext && !!window.PublicKeyCredential && !!navigator.credentials;

  const b64url = {
    toBuffer(s) {
      const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
      return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
    },
    fromBuffer(buf) {
      let bin = '';
      for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b);
      return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    },
  };

  function credentialToJSON(cred) {
    const r = cred.response;
    const response = { clientDataJSON: b64url.fromBuffer(r.clientDataJSON) };
    if (r.attestationObject) {
      response.attestationObject = b64url.fromBuffer(r.attestationObject);
      response.transports = r.getTransports ? r.getTransports() : [];
    }
    if (r.authenticatorData) {
      response.authenticatorData = b64url.fromBuffer(r.authenticatorData);
      response.signature = b64url.fromBuffer(r.signature);
      if (r.userHandle) response.userHandle = b64url.fromBuffer(r.userHandle);
    }
    return {
      id: cred.id,
      rawId: b64url.fromBuffer(cred.rawId),
      type: cred.type,
      response,
      authenticatorAttachment: cred.authenticatorAttachment || undefined,
      clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
    };
  }

  // Safari only allows the Face ID prompt close to the tap that asked for it,
  // so login options are fetched ahead of time and reused while fresh.
  let loginOptions = null;
  async function prefetchLoginOptions() {
    loginOptions = null;
    if (!passkeySupported() || !state.passkeys.count) return;
    try {
      loginOptions = { at: Date.now(), options: await api('POST', '/api/passkeys/login/options') };
    } catch {}
  }

  async function takeLoginOptions() {
    const cached = loginOptions;
    loginOptions = null;
    if (cached && Date.now() - cached.at < 90 * 1000) return cached.options;
    return api('POST', '/api/passkeys/login/options');
  }

  async function passkeySignIn(errorEl) {
    errorEl.textContent = '';
    try {
      const options = await takeLoginOptions();
      const cred = await navigator.credentials.get({
        publicKey: {
          ...options,
          challenge: b64url.toBuffer(options.challenge),
          allowCredentials: (options.allowCredentials || []).map((c) => ({ ...c, id: b64url.toBuffer(c.id) })),
        },
      });
      if (!cred) throw new Error('No passkey returned');
      await api('POST', '/api/passkeys/login/verify', { response: credentialToJSON(cred) });
      return true;
    } catch (err) {
      errorEl.textContent = err.name === 'NotAllowedError' ? 'Face ID was cancelled or timed out.' : err.message;
      prefetchLoginOptions();
      return false;
    }
  }

  function deviceName() {
    const ua = navigator.userAgent;
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
    if (/Macintosh/.test(ua)) return 'Mac';
    if (/Android/.test(ua)) return 'Android';
    if (/Windows/.test(ua)) return 'Windows';
    return 'Browser';
  }

  async function enrolPasskey() {
    try {
      const options = await api('POST', '/api/passkeys/register/options');
      const cred = await navigator.credentials.create({
        publicKey: {
          ...options,
          challenge: b64url.toBuffer(options.challenge),
          user: { ...options.user, id: b64url.toBuffer(options.user.id) },
          excludeCredentials: (options.excludeCredentials || []).map((c) => ({ ...c, id: b64url.toBuffer(c.id) })),
        },
      });
      if (!cred) return;
      const name = `${deviceName()} · ${new Date().toLocaleDateString()}`;
      await api('POST', '/api/passkeys/register/verify', { name, response: credentialToJSON(cred) });
      await refreshPasskeys();
      toast('Face ID is on for this device');
    } catch (err) {
      if (err.name === 'NotAllowedError') toast('Face ID setup was cancelled', true);
      else if (err.name === 'InvalidStateError') toast('This device already has a passkey for picossh', true);
      else toast(err.message, true);
    }
  }

  // An SSH key whose private half is made and kept by this device's secure
  // enclave (Face ID). The server only ever sees the public key.
  async function enrolEnclaveKey(name) {
    const options = await api('POST', '/api/keys/enclave/options');
    let cred;
    try {
      cred = await navigator.credentials.create({
        publicKey: {
          ...options,
          challenge: b64url.toBuffer(options.challenge),
          user: { ...options.user, id: b64url.toBuffer(options.user.id) },
          excludeCredentials: (options.excludeCredentials || []).map((c) => ({ ...c, id: b64url.toBuffer(c.id) })),
        },
      });
    } catch (err) {
      throw err.name === 'NotAllowedError' ? new Error('Face ID was cancelled') : err;
    }
    if (!cred) throw new Error('No key was made');
    return (await api('POST', '/api/keys/enclave', { name, response: credentialToJSON(cred) })).key;
  }

  async function removePasskey(cred) {
    if (!(await confirmSheet(`Remove "${cred.name}"? That device will need the app password to sign in.`, { confirm: 'Remove', danger: true }))) return;
    try {
      await api('DELETE', `/api/passkeys/${encodeURIComponent(cred.id)}`);
      await refreshPasskeys();
    } catch (err) {
      toast(err.message, true);
    }
  }

  // =================================================================== lock

  const lockEnabled = () => !!local.get(KEYS.lock, false);

  function shouldLock() {
    const hiddenAt = Number(local.get(KEYS.hiddenAt, 0));
    return state.authed && lockEnabled() && state.passkeys.count > 0 && passkeySupported() && hiddenAt > 0 && Date.now() - hiddenAt >= LOCK_AFTER_MS;
  }

  function showLock() {
    state.locked = true;
    syncConnectionsPolling();
    closeSheet();
    if (document.activeElement) document.activeElement.blur();
    $('lock-error').textContent = '';
    $('view-lock').classList.add('active');
    prefetchLoginOptions();
  }

  function hideLock() {
    state.locked = false;
    syncConnectionsPolling();
    $('view-lock').classList.remove('active');
    focusTerminal();
  }

  // ============================================================== settings

  // ============================================================ full screen

  // Launched from the Home Screen / as an installed app: no browser UI at all.
  // (display-mode: fullscreen) also matches a browser tab using the Fullscreen API.
  const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;
  const isInstalled = () =>
    navigator.standalone === true ||
    ['standalone', 'minimal-ui'].some((m) => matchMedia(`(display-mode: ${m})`).matches) ||
    (matchMedia('(display-mode: fullscreen)').matches && !fullscreenElement());
  const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  const fullscreenSupported = () => {
    const el = document.documentElement;
    return !!(el.requestFullscreen || el.webkitRequestFullscreen) && (document.fullscreenEnabled || document.webkitFullscreenEnabled) !== false;
  };
  // Off unless switched on. Kept in this browser's storage only: each device
  // (and each browser on it) chooses for itself, and the server never sees it.
  const fullscreenWanted = () => !!local.get(KEYS.fullscreen, false);

  let fullscreenPending = null;

  function enterFullscreen() {
    if (fullscreenPending || isInstalled() || fullscreenElement() || !fullscreenSupported()) return;
    const el = document.documentElement;
    try {
      const result = el.requestFullscreen ? el.requestFullscreen({ navigationUI: 'hide' }) : el.webkitRequestFullscreen();
      if (result && result.then) {
        fullscreenPending = result
          .then(() => {
            fullscreenPending = null;
            if (!fullscreenWanted()) exitFullscreen(); // switched off while the request was pending
          }, () => {
            fullscreenPending = null;
          });
      }
    } catch {}
  }

  function exitFullscreen() {
    if (!fullscreenElement()) return;
    try {
      const result = document.exitFullscreen ? document.exitFullscreen() : document.webkitExitFullscreen();
      if (result && result.catch) result.catch(() => {});
    } catch {}
  }

  let installPrompt = null;

  function setupFullscreen() {
    // Browsers only allow full screen from a user gesture, so every tap is a
    // chance to (re-)enter it: after a reload, or after Back left full screen.
    // Entering full screen uses up the tap's user activation, so taps that need
    // it themselves (file picker, Face ID, install, clipboard) are left alone.
    const needsActivation = '[data-activation], input[type=file], [data-files="upload"], #login-passkey, #lock-unlock';
    for (const type of ['pointerup', 'click']) {
      document.addEventListener(type, (e) => {
        if (!fullscreenWanted() || (e.target.closest && e.target.closest(needsActivation))) return;
        enterFullscreen();
      }, { capture: true, passive: true });
    }
    for (const type of ['fullscreenchange', 'webkitfullscreenchange']) {
      document.addEventListener(type, () => {
        if (state.view === 'home' && state.homeTab === 'settings') renderSettings();
      });
    }
    // Chromium offers installing as an app, which opens full screen without the tap.
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      installPrompt = e;
      if (state.authed) {
        renderSettings();
        renderServers();
      }
    });
    window.addEventListener('appinstalled', () => {
      installPrompt = null;
      toast('Installed. Open picossh from your home screen for full screen.');
      renderSettings();
      renderServers();
    });
  }

  async function installApp() {
    if (!installPrompt) return;
    const prompt = installPrompt;
    installPrompt = null;
    prompt.prompt();
    try {
      await prompt.userChoice;
    } catch {}
    renderSettings();
    renderServers();
  }

  // iPhone browsers cannot hide their toolbars from a page; only a Home Screen launch does.
  function installHint() {
    if (isInstalled() || local.get(KEYS.installHintDismissed, false)) return null;
    let text;
    if (isIos() && !fullscreenSupported()) {
      text = 'For full screen, tap Share, then Add to Home Screen, and open picossh from there.';
    } else if (installPrompt) {
      text = 'Install picossh to open it full screen without browser bars.';
    } else {
      return null;
    }
    const card = h('div', { class: 'notice' }, icon('info'),
      h('div', { class: 'grow', text }),
      installPrompt && h('button', { type: 'button', class: 'btn small primary', text: 'Install', 'data-activation': true, onclick: installApp }),
      h('button', {
        type: 'button',
        class: 'icon-btn small',
        'aria-label': 'Dismiss',
        onclick: () => {
          local.set(KEYS.installHintDismissed, true);
          card.remove();
        },
      }, icon('close')));
    return card;
  }

  function fullscreenSection() {
    const list = h('div', { class: 'list' });
    if (isInstalled()) {
      list.append(h('div', { class: 'list-item' }, h('div', { class: 'grow sub', text: 'Running as an app: full screen, no browser bars.' })));
    } else if (fullscreenSupported()) {
      list.append(h('label', { class: 'list-item' },
        h('div', { class: 'grow' },
          h('div', { text: 'Full screen' }),
          h('div', { class: 'sub', text: 'Hide the browser bars and system navigation. After leaving full screen, the next tap turns it back on. Saved on this device.' })),
        h('input', {
          type: 'checkbox',
          class: 'switch',
          checked: fullscreenWanted(),
          onchange: (e) => {
            local.set(KEYS.fullscreen, e.target.checked);
            if (e.target.checked) enterFullscreen();
            else exitFullscreen();
          },
        })));
    } else if (isIos()) {
      list.append(h('div', { class: 'list-item' }, h('div', { class: 'grow sub', text: 'iPhone browsers always show their bars on web pages. For full screen, tap Share, then Add to Home Screen, and open picossh from the Home Screen.' })));
    }
    if (installPrompt) {
      list.append(h('button', { type: 'button', class: 'list-item button', style: 'color:var(--accent-text)', 'data-activation': true, onclick: installApp }, icon('add'), 'Install as an app'));
    }
    return h('div', { class: 'section' }, h('h2', { text: 'Display' }), list);
  }

  function renderSettings() {
    const root = $('tab-settings');
    root.textContent = '';

    const face = h('div', { class: 'section' }, h('h2', { text: 'Face ID' }));
    if (!passkeySupported()) {
      face.append(h('div', { class: 'list' }, h('div', { class: 'list-item' }, h('div', { class: 'grow sub', text: 'Face ID needs this page opened over HTTPS by its hostname, for example https://picossh.lan.' }))));
    } else {
      const list = h('div', { class: 'list' });
      for (const cred of state.passkeys.credentials) {
        list.append(h('div', { class: 'list-item' },
          h('div', { class: 'grow' },
            h('div', { text: cred.name }),
            h('div', { class: 'sub', text: `Added ${formatDate(cred.createdAt)}${cred.lastUsedAt ? ` · last used ${formatDate(cred.lastUsedAt)}` : ''}` })),
          h('button', { type: 'button', class: 'btn small danger', text: 'Remove', onclick: () => removePasskey(cred) })));
      }
      list.append(h('button', { type: 'button', class: 'list-item button', style: 'color:var(--accent-text)', 'data-activation': true, onclick: enrolPasskey }, icon('add'), 'Enable Face ID on this device'));
      list.append(h('label', { class: 'list-item' },
        h('div', { class: 'grow' },
          h('div', { text: 'Lock when reopened' }),
          h('div', { class: 'sub', text: 'Ask for Face ID after 5 minutes in the background.' })),
        h('input', {
          type: 'checkbox',
          class: 'switch',
          checked: lockEnabled(),
          disabled: !state.passkeys.count,
          onchange: (e) => local.set(KEYS.lock, e.target.checked),
        })));
      face.append(list);
      if (!state.passkeys.count) face.append(h('p', { class: 'note', text: 'After enabling Face ID, the sign-in page offers it before the password.' }));
    }

    const { dnsServers, envDnsServers } = state.settings;
    const dnsSummary = dnsServers.length
      ? dnsServers.join(', ')
      : envDnsServers.length ? `${envDnsServers.join(', ')} (from DNS_SERVERS)` : 'System default';
    const network = h('div', { class: 'section' }, h('h2', { text: 'Network' }),
      h('div', { class: 'list' },
        h('button', { type: 'button', class: 'list-item button', onclick: editDnsServers },
          h('div', { class: 'grow' }, h('div', { text: 'DNS servers' }), h('div', { class: 'sub mono', text: dnsSummary })),
          h('span', { class: 'muted' }, icon('chevron-right')))),
      h('p', { class: 'note', text: 'Used to look up server names such as nas.lan before the system DNS.' }));

    const background = backgroundSelect('default-background', String(state.settings.backgroundMinutes), false, (el) => saveBackground(el, async (value) => {
      state.settings = (await api('PUT', '/api/settings', { backgroundMinutes: backgroundValue(value) })).settings;
    }));
    const connections = h('div', { class: 'section' }, h('h2', { text: 'Connections' }),
      field('Keep in the background', background, `${BACKGROUND_HINT} One connection can change it for itself under Connection settings: tap the server's name above the terminal, or use the Connections tab.`));

    const terminal = h('div', { class: 'section' }, h('h2', { text: 'Terminal' }),
      field('Phone columns', h('select', {
        id: 'phone-columns', class: 'select', value: PhoneTerminal.getColumns(),
        onchange: (e) => {
          PhoneTerminal.setColumns(Number(e.target.value));
          for (const s of state.sessions.values()) s.fit();
        },
      }, PhoneTerminal.COLUMN_OPTIONS.map((n) => h('option', {
        value: String(n), text: n ? 'At least ' + n + ' columns' + (n === PhoneTerminal.DEFAULT_COLUMNS ? ' (default)' : '') : 'Automatic (14px font)',
      }))), 'Smaller text fits more columns on phones. Saved on this device; desktop text stays the same.'),
      h('div', { class: 'list' },
        h('label', { class: 'list-item' },
          h('div', { class: 'grow' },
            h('div', { text: 'Disable WebGL canvas' }),
            h('div', { class: 'sub', text: 'Draw the terminal as page text instead of on the GPU. Slower to scroll colored output; use it if the terminal looks wrong. Saved on this device.' })),
          h('input', {
            id: 'no-webgl',
            type: 'checkbox',
            class: 'switch',
            checked: !!local.get(KEYS.noWebgl, false),
            onchange: (e) => {
              local.set(KEYS.noWebgl, e.target.checked);
              for (const s of state.sessions.values()) {
                if (e.target.checked) s.dropWebgl();
                else s.useWebgl();
              }
            },
          }))));

    const keyboard = h('div', { class: 'section' }, h('h2', { text: 'Extra keyboard' }),
      h('p', { class: 'note', text: phoneKeyboardLayout()
        ? 'The swipeable row above the keyboard changes with its page: letters, numbers and symbols, or terminal keys. Touch and hold a letter for its accents, or 123/ABC for the terminal keys (Fn). Copy, Paste, Snippets and Hide keyboard stay at its right end. Tap the line you are typing to move the cursor there. Long-press the terminal and drag to select, then press Copy; without a selection Copy shows the terminal text to copy from. Paste sends the clipboard.'
        : 'One row of Copy, Paste, Snippets and your own commands. Select text with the mouse, then press Copy (or Ctrl+Shift+C). Phones have their own layout.' }),
      h('div', { class: 'list' },
        h('button', { type: 'button', class: 'list-item button', text: 'Edit layout', onclick: openLayoutEditor }),
        h('button', {
          type: 'button',
          class: 'list-item button',
          text: 'Reset to default',
          onclick: async () => {
            if (!(await confirmSheet('Reset the extra keyboard to the default layout?', { confirm: 'Reset' }))) return;
            ExtraKeys.resetLayout(phoneKeyboardLayout());
            keybar.reload();
            toast('Keyboard reset');
          },
        })));

    const count = state.snippets.length;
    const snippets = h('div', { class: 'section' }, h('h2', { text: 'Snippets' }),
      h('div', { class: 'list' },
        h('button', { type: 'button', class: 'list-item button', onclick: () => setHomeTab('snippets') },
          h('div', { class: 'grow' },
            h('div', { text: 'Edit snippets' }),
            h('div', { class: 'sub', text: count ? `${count} saved command${count === 1 ? '' : 's'}` : 'None yet' })),
          h('span', { class: 'muted' }, icon('chevron-right')))),
      h('p', { class: 'note', text: 'Commands you send with one tap from the Snippets key above the keyboard. ${name} in one is asked for when it runs.' }));

    const account = h('div', { class: 'section' }, h('h2', { text: 'Account' }),
      h('div', { class: 'list' },
        h('button', { type: 'button', class: 'list-item button', onclick: () => { location.href = '/admin'; } },
          h('div', { class: 'grow' }, h('div', { text: 'Admin dashboard' }), h('div', { class: 'sub', text: 'Devices, SSH connections, zombies, memory and activity.' })),
          h('span', { class: 'muted' }, icon('chevron-right'))),
        h('button', { type: 'button', class: 'list-item button danger', text: 'Sign out', onclick: signOut })));

    root.append(...[fullscreenSection(), terminal, keyboard, snippets, connections, face, network, account].filter(Boolean));
  }

  async function editDnsServers() {
    const env = state.settings.envDnsServers;
    const v = await formSheet({
      title: 'DNS servers',
      fields: [{
        name: 'dns',
        label: 'Nameserver IP addresses',
        value: state.settings.dnsServers.join(', '),
        placeholder: env.length ? env.join(', ') : '192.168.1.1',
        hint: `Comma separated, optional :port. Leave empty to use ${env.length ? 'the DNS_SERVERS environment variable' : 'the system DNS'}. Names these servers do not know still go to the system DNS.`,
      }],
      submit: 'Save',
    });
    if (!v) return;
    try {
      const { settings } = await api('PUT', '/api/settings', { dnsServers: v.dns });
      state.settings = settings;
      renderSettings();
      toast('DNS servers saved');
    } catch (err) {
      toast(err.message, true);
      if (err.status === 400) editDnsServers();
    }
  }

  // How long the server keeps a shell, then its SSH connection, while no app
  // is connected: minutes, or "forever".
  const BACKGROUND_MINUTES = [15, 60, 24 * 60, 'forever'];
  const backgroundLabel = (m) => (m === 'forever' ? 'Forever' : m >= 60 ? `${m / 60} hour${m > 60 ? 's' : ''}` : `${m} minutes`);
  const backgroundValue = (text) => (text === 'forever' ? text : Number(text));
  const BACKGROUND_HINT = 'How long the server keeps the shell, what runs in it, and the SSH connection once picossh notices the app has gone (in the background, offline or closed). Then it closes them. The time is taken at that moment, so a change applies from the next time. Forever turns the expiry off, but a connection still ends when picossh restarts, the SSH server drops it, or you disconnect.';

  function backgroundSelect(id, value, withDefault, onchange) {
    return h('select', { id, class: 'select', value, 'data-saved': value, onchange: (e) => onchange(e.target) },
      withDefault && h('option', { value: '', text: `Default (${backgroundLabel(state.settings.backgroundMinutes).toLowerCase()})` }),
      BACKGROUND_MINUTES.map((m) => h('option', { value: String(m), text: backgroundLabel(m) })));
  }

  // Saves one select's value, putting the old one back if the server refuses.
  async function saveBackground(select, save) {
    const before = select.dataset.saved;
    select.disabled = true;
    try {
      await save(select.value);
      select.dataset.saved = select.value;
      toast('Saved');
    } catch (err) {
      select.value = before;
      toast(err.message, true);
    } finally {
      select.disabled = false;
    }
  }

  // Opened by tapping the server's name above its terminal, or from the
  // Connections tab. These settings belong to this SSH connection alone: the
  // server keeps them until the connection closes and saves them nowhere, so
  // other devices connected to the same server, and the next connection from
  // this one, are unaffected. `meta`: where it goes (connectionMeta).
  async function connectionSettings(id, meta) {
    let own = null;
    let live = true;
    let info = null;
    try {
      info = (await api('GET', `/api/sessions/${id}`, undefined, { timeout: timings.check })).session;
      own = info.backgroundMinutes ?? null;
    } catch {
      live = false;
    }
    // Saved when it changes (Enter or leaving the field); empty is the default.
    const nameInput = h('input', {
      id: 'connection-name', class: 'input', value: info ? info.name : meta.name, 'data-saved': info ? info.name : meta.name,
      placeholder: info ? info.defaultName : meta.name, disabled: !live, ...noAutoText,
      onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } },
      onchange: async (e) => {
        const el = e.target;
        try {
          el.value = el.dataset.saved = await renameConnection(id, el.value);
          toast('Renamed');
        } catch (err) {
          el.value = el.dataset.saved;
          toast(err.message, true);
        }
      },
    });
    const select = backgroundSelect('connection-background', own === null ? '' : String(own), true, (el) => saveBackground(el, async (value) => {
      await api('PUT', `/api/sessions/${id}/background`, { backgroundMinutes: value === '' ? null : backgroundValue(value) });
      refreshConnections();
    }));
    select.disabled = !live;
    openSheet('Connection settings', h('div', {},
      h('p', { class: 'muted mono', text: `${meta.user}@${meta.host}${meta.port === 22 ? '' : `:${meta.port}`} · #${id.slice(-6)}` }),
      field('Name', nameInput, live ? `Leave empty for "${info.defaultName}".` : undefined),
      field('Keep in the background', select, live
        ? `${BACKGROUND_HINT} For this connection only, until it closes.`
        : 'Reconnect to change this: the setting belongs to the SSH connection, which is not open.')));
  }

  // Phones and tablets keep a layout separate from desktops'.
  function phoneKeyboardLayout() {
    return PhoneTerminal.media.matches;
  }

  function openLayoutEditor() {
    const phone = phoneKeyboardLayout();
    const body = h('div');
    const sections = phone
      ? [['letters', 'Letters page'], ['numbers', 'Numbers and symbols page'], ['terminal', 'Terminal keys page'], ['commands', 'Custom commands (on every page)']]
      : [['main', 'Key row']];

    function change(mutate) {
      const layout = ExtraKeys.loadLayout(phone);
      mutate(layout);
      ExtraKeys.saveLayout(layout, phone);
      keybar.reload();
      render();
    }

    // The row's keys in this order, the ones not on it after them.
    const reorder = (name, ids) => change((l) => {
      const r = l.rows[name];
      r.order = [...ids, ...r.order.filter((x) => !ids.includes(x))];
    });

    // Which section's Add key list is open.
    let adding = null;

    function render() {
      const layout = ExtraKeys.loadLayout(phone);
      body.textContent = '';
      body.append(h('div', { class: 'section' },
        h('button', { type: 'button', class: 'btn block primary', onclick: () => editCommand() }, icon('add'), 'Add custom command'),
        h('p', { class: 'note', text: phone
          ? 'Changes save automatically. Drag ☰ to change key order. Custom commands follow the built-in keys on every page.'
          : 'Changes save automatically. Drag ☰ to change the order.' })));
      for (const [name, title] of sections) {
        const row = layout.rows[name];
        const shown = row.order.filter((id) => !row.hidden.includes(id));
        const available = row.order.filter((id) => row.hidden.includes(id));
        const list = h('div', { class: 'list' });
        shown.forEach((id, index) => {
          const key = ExtraKeys.keyFor(id, layout);
          list.append(h('div', { class: 'list-item', 'data-id': id },
            dragHandle({ name: key.name, ids: shown, index, apply: (ids) => reorder(name, ids) }),
            h('span', { class: 'grow editor-key', text: key.custom ? `${key.label} ✦` : key.label, title: key.name }),
            key.custom && h('button', { type: 'button', class: 'editor-btn', text: 'Edit', onclick: () => editCommand(id) }),
            h('button', {
              type: 'button', class: 'editor-btn danger', 'aria-label': key.custom ? 'Delete command' : `Delete ${key.name}`,
              onclick: () => change((l) => {
                if (key.custom) ExtraKeys.removeCustom(l, id);
                else l.rows[name].hidden.push(id);
              }),
            }, icon('close'))));
        });
        if (!shown.length) list.append(h('div', { class: 'list-item muted', text: name === 'commands' ? 'No custom commands yet.' : 'No keys.' }));
        const open = adding === name && available.length > 0;
        const toggle = () => { adding = open ? null : name; render(); };
        body.append(h('div', { class: 'section', 'data-row': name },
          h('h2', { text: title }), list,
          available.length > 0 && h('button', { type: 'button', class: 'btn block add-key', onclick: toggle },
            open ? 'Done adding' : [icon('add'), 'Add key']),
          open && h('div', { class: 'key-choices' }, available.map((id) => {
            const key = ExtraKeys.keyFor(id, layout);
            return h('button', {
              type: 'button', class: 'key-choice', text: key.label, title: key.name, 'aria-label': `Add ${key.name}`,
              onclick: () => change((l) => {
                const r = l.rows[name];
                r.hidden = r.hidden.filter((x) => x !== id);
                const visible = r.order.filter((x) => x !== id && !r.hidden.includes(x));
                r.order = [...visible, id, ...r.hidden];
              }),
            });
          }))));
      }
      restoreHandle(body);
    }

    async function editCommand(id) {
      const existing = id && ExtraKeys.loadLayout(phone).custom.find((c) => c.id === id);
      const v = await formSheet({
        title: existing ? 'Edit custom command' : 'Custom command',
        fields: [
          { name: 'label', label: 'Label', placeholder: 'll', value: existing ? existing.label : '' },
          { name: 'send', label: 'Text to send', placeholder: 'ls -la\\r', value: existing ? ExtraKeys.formatEscapes(existing.send) : '', hint: 'Escapes: \\r Enter, \\t Tab, \\e Esc, \\x03 Ctrl-C' },
        ],
        submit: existing ? 'Save' : 'Add command',
        back: true,
      });
      if (v && v.label.trim() && v.send) {
        const command = { label: v.label.trim().slice(0, 12), send: ExtraKeys.parseEscapes(v.send) };
        const layout = ExtraKeys.loadLayout(phone);
        const current = existing && layout.custom.find((c) => c.id === id);
        if (current) Object.assign(current, command);
        else ExtraKeys.addCustom(layout, command);
        ExtraKeys.saveLayout(layout, phone);
        keybar.reload();
      }
      openLayoutEditor();
    }

    render();
    openSheet('Extra keyboard', body, { tall: true });
  }

  // ============================================================ data + auth

  async function refreshServers() {
    const { servers } = await api('GET', '/api/servers');
    state.servers = servers;
    renderServers();
    renderKeys(); // the "N servers" badges
  }

  async function refreshKeys() {
    state.keys = (await api('GET', '/api/keys')).keys;
    renderKeys();
  }

  async function refreshSnippets() {
    const { snippets } = await api('GET', '/api/snippets');
    state.snippets = snippets;
    renderSnippets();
    renderSettings();
  }

  async function refreshPasskeys() {
    const data = await api('GET', '/api/passkeys');
    state.passkeys = { count: data.count, credentials: data.credentials || [] };
    renderSettings();
  }

  async function refreshSettings() {
    state.settings = (await api('GET', '/api/settings')).settings;
    renderSettings();
  }

  const loadAll = () => Promise.all([refreshServers(), refreshSnippets(), refreshKeys(), refreshPasskeys(), refreshSettings()]);

  // The terminals this tab had, from sessionStorage, for the connections the
  // server still lists: each resumes its own shell with its lease (the one on
  // screen is opened again). The app starts on the Connections tab whenever
  // this device has connections to go back to (under the terminal, when one
  // is reopened); nothing else attaches by itself.
  function restoreSessions() {
    const list = state.connections.list;
    if (!list) return;
    for (const [id, rec] of Object.entries(savedSessions())) {
      const conn = list.find((c) => c.id === id);
      if (!conn || !rec || !rec.shellId || !rec.lease) {
        forgetSaved(id);
        continue;
      }
      if (state.sessions.has(id)) continue;
      // Named as the server lists it: it may have been renamed meanwhile.
      const s = new TermSession({ ...(rec.meta || connectionMeta(conn)), name: conn.name }, { sessionId: id, shellId: rec.shellId, lease: rec.lease, creating: rec.creating, panel: rec.panel });
      state.sessions.set(id, s);
      if (rec.superseded) {
        s.replaced = true;
        s.persist();
        s.supersededBanner();
      }
    }
    renderServers();
    renderConnections();
    if (state.view !== 'home') return;
    if (list.length) setHomeTab('connections');
    const active = state.sessions.get(session.get(KEYS.active, null));
    if (active) openSession(active);
  }

  function showHome() {
    showView('home');
    setHomeTab(state.homeTab);
  }

  // Left to right as in the tab bar; Snippets last, so it pushes in from
  // Settings and Back slides Settings in from the left.
  const HOME_TABS = ['servers', 'connections', 'keys', 'settings', 'snippets'];

  // Snippets has no tab bar button: Settings opens it, so it leaves Settings lit
  // and shows a back button to it.
  function setHomeTab(tab) {
    slideDirection($('view-home').querySelector('main'), HOME_TABS, state.homeTab, tab);
    state.homeTab = tab;
    for (const t of document.querySelectorAll('#view-home .tab')) {
      const on = t.id === `tab-${tab}`;
      t.classList.toggle('active', on);
      if (!on) t.style.animation = ''; // swiped in without the slide; slides in next time
    }
    const lit = tab === 'snippets' ? 'settings' : tab;
    for (const b of document.querySelectorAll('#home-tabs button')) b.classList.toggle('active', b.dataset.tab === lit);
    $('home-title').textContent = { servers: 'Servers', connections: 'Connections', snippets: 'Snippets', keys: 'SSH Keys', settings: 'Settings' }[tab];
    $('home-back').hidden = tab !== 'snippets';
    $('home-add').hidden = tab === 'settings' || tab === 'connections';
    $('home-refresh').hidden = !PULL_TABS.includes(tab);
    syncConnectionsPolling();
    renderHomeTab(tab);
    if (tab === 'connections') refreshConnections();
  }

  function renderHomeTab(tab) {
    if (tab === 'servers') renderServers();
    if (tab === 'connections') renderConnections();
    if (tab === 'snippets') renderSnippets();
    if (tab === 'keys') renderKeys();
    if (tab === 'settings') renderSettings();
  }

  // The tabs that pull to refresh (and show the refresh button).
  const PULL_TABS = ['servers', 'connections'];

  // Servers and connections loaded afresh, with the errors left on server
  // cards cleared: a failed connect stays on its card until then.
  async function refreshHome() {
    state.cardErrors.clear();
    renderServers();
    const [servers] = await Promise.allSettled([refreshServers(), refreshConnections()]);
    if (servers.status === 'rejected' && servers.reason.status !== 401) toast(servers.reason.message, true);
  }

  // Pull to refresh: a touch that starts on `el` with scroller() at its top
  // and drags down brings a refresh icon down; let go far enough down and
  // refresh() runs, the icon spinning until it is done. With `push` the icon
  // opens above the scroller's content, which comes down with the finger and
  // settles back (a list); without it the icon floats fixed over the top of
  // the scroller, so nothing under it moves or reflows (a file). A mostly
  // sideways drag (a wide line of code) is left alone.
  function pullToRefresh(el, { scroller, enabled, refresh, push = false }) {
    const indicator = h('div', { class: `ptr ${push ? 'push' : 'float'}`, 'aria-hidden': 'true', 'data-for': el.id || el.tagName.toLowerCase() }, icon('refresh-filled'));
    if (!push) document.body.append(indicator);
    const READY = 64;
    const MAX = 96;
    let start = null;
    let pulled = 0;
    let busy = false;
    const show = (px, settle) => {
      indicator.classList.toggle('settle', settle);
      indicator.classList.toggle('shown', px > 0 || busy);
      indicator.classList.toggle('ready', px >= READY);
      indicator.style.setProperty('--pull', `${px}px`);
      indicator.firstChild.style.transform = busy ? '' : `rotate(${Math.round((px / READY) * 270)}deg)`;
    };
    el.addEventListener('touchstart', (e) => {
      const sc = scroller();
      const ok = !busy && !currentSheet && e.touches.length === 1 && sc && sc.scrollTop <= 0 && enabled();
      start = ok ? { x: e.touches[0].clientX, y: e.touches[0].clientY, sc, decided: false } : null;
      pulled = 0;
      if (!ok) return;
      if (push) {
        // Rendering may have emptied the scroller since the last pull.
        if (indicator.parentNode !== sc) sc.prepend(indicator);
        return;
      }
      const r = sc.getBoundingClientRect();
      indicator.style.left = `${r.left + r.width / 2}px`;
      indicator.style.top = `${r.top}px`;
    }, { passive: true });
    el.addEventListener('touchmove', (e) => {
      if (!start) return;
      const dx = e.touches[0].clientX - start.x;
      const dy = e.touches[0].clientY - start.y;
      if (!start.decided && Math.abs(dx) + Math.abs(dy) > 8) {
        start.decided = true;
        if (Math.abs(dx) > dy) {
          start = null;
          return;
        }
      }
      if (dy <= 0 || start.sc.scrollTop > 0) {
        if (pulled) show(0, false);
        pulled = 0;
        return;
      }
      // Nothing scrolls or bounces under the icon while it is pulled.
      if (e.cancelable) e.preventDefault();
      pulled = Math.min(MAX, dy * 0.5);
      show(pulled, false);
    }, { passive: false });
    el.addEventListener('touchend', async () => {
      if (!start) return;
      start = null;
      if (pulled < READY) return show(0, true);
      busy = true;
      indicator.classList.add('spinning');
      show(READY, true);
      try {
        await refresh();
      } finally {
        busy = false;
        indicator.classList.remove('spinning');
        show(0, true);
      }
    });
    el.addEventListener('touchcancel', () => {
      start = null;
      if (!busy) show(0, true);
    });
  }

  function setupPullToRefresh() {
    const main = $('view-home').querySelector('main');
    pullToRefresh(main, {
      scroller: () => main,
      enabled: () => state.view === 'home' && PULL_TABS.includes(state.homeTab),
      refresh: refreshHome,
      push: true,
    });
    // The folder on screen, listed again.
    pullToRefresh($('files-list'), {
      scroller: () => $('files-list'),
      push: true,
      enabled: () => {
        const s = activeSession();
        return state.view === 'session' && state.panel === 'files' && !!s && !s.files.loading;
      },
      refresh: () => {
        const s = activeSession();
        return s && loadFiles(s, s.files.path || '.');
      },
    });
    // The file read from the server again, as Reload does. Not while
    // editing: a drag down there is selecting text.
    pullToRefresh(editorEls.main, {
      scroller: () => openedFile && editorEls.main.querySelector(openedFile.large ? '.big-scroll' : '.code-scroll'),
      enabled: () => state.view === 'editor' && !!openedFile && !openedFile.editing,
      refresh: reloadEditor,
    });
  }

  // A sideways drag on `el` brings in what lies beside what is on screen,
  // which moves along with the finger; let go far enough, or with a flick,
  // and it settles in and takes over, else both slide back. may() says
  // whether a touch can start one (not with a sheet open, say). pick(side)
  // gives, for a drag towards `side` (1: from the left, -1: from the right),
  // `cur`, the element on screen, `peek`, the one coming in, or null when
  // there is nothing that side (cur only gives a little), and land(), run
  // once the peek has settled in, which may take its time. The container,
  // where both sit, clips them and does not scroll under a swipe. A mostly
  // vertical drag is scrolling or a pull to refresh, and a touch on
  // something that scrolls sideways itself, or on a slider, is left to it.
  function sideSwipe(el, container, { may, pick }) {
    let start = null;
    let settle = null; // finishes the slide under way, now
    const ownsSideways = (target) => {
      for (let n = target; n && n !== el; n = n.parentElement) {
        if (n.matches('input[type="range"]')) return true;
        if (n.scrollWidth > n.clientWidth && ['auto', 'scroll'].includes(getComputedStyle(n).overflowX)) return true;
      }
      return false;
    };
    const clear = (node) => {
      if (!node) return;
      node.classList.remove('peek');
      for (const k of ['top', 'height', 'transform', 'transition']) node.style[k] = '';
    };
    const place = (s, dx, ms) => {
      const w = container.clientWidth;
      s.cur.style.transition = ms ? `transform ${ms}ms ease` : '';
      s.cur.style.transform = `translateX(${s.peek ? dx : dx * 0.3}px)`;
      if (!s.peek) return;
      s.peek.style.transition = s.cur.style.transition;
      s.peek.style.transform = `translateX(${dx - s.side * w}px)`;
    };
    const turn = (s, side) => {
      if (s.side === side) return;
      clear(s.cur);
      clear(s.peek);
      s.side = side;
      Object.assign(s, pick(side));
      if (s.peek) s.peek.classList.add('peek');
    };
    el.addEventListener('touchstart', (e) => {
      if (settle) settle();
      const ok = !currentSheet && e.touches.length === 1 && may() && !ownsSideways(e.target);
      start = ok ? { x: e.touches[0].clientX, y: e.touches[0].clientY, at: Date.now(), decided: false, side: 0, cur: null, peek: null, land: null } : null;
    }, { passive: true });
    el.addEventListener('touchmove', (e) => {
      if (!start) return;
      const dx = e.touches[0].clientX - start.x;
      const dy = e.touches[0].clientY - start.y;
      if (!start.decided) {
        if (Math.abs(dx) + Math.abs(dy) <= 8) return;
        start.decided = true;
        if (Math.abs(dx) <= Math.abs(dy)) {
          start = null;
          return;
        }
        container.classList.add('swiping');
      }
      // Nothing scrolls under a swipe.
      if (e.cancelable) e.preventDefault();
      if (dx) turn(start, Math.sign(dx));
      if (start.side) place(start, dx, 0);
    }, { passive: false });
    const release = (dx) => {
      const s = start;
      start = null;
      if (!s.decided) return;
      const w = container.clientWidth;
      const flick = Date.now() - s.at < 300 && Math.abs(dx) > 40;
      const go = !!s.peek && Math.sign(dx) === s.side && (flick || Math.abs(dx) >= Math.min(120, w / 4));
      const ms = reducedMotion.matches ? 0 : 200;
      if (s.side) place(s, go ? s.side * w : 0, ms);
      const timer = setTimeout(() => settle(), ms);
      settle = async () => {
        clearTimeout(timer);
        settle = null;
        if (go) await s.land();
        clear(s.cur);
        clear(s.peek);
        container.classList.remove('swiping');
      };
    };
    el.addEventListener('touchend', (e) => {
      if (start) release(e.changedTouches[0].clientX - start.x);
    });
    el.addEventListener('touchcancel', () => {
      if (start) release(0);
    });
  }

  // Home: a swipe goes to the tab beside the current one in the bar (Snippets
  // counts as Settings), the neighbour peeking in over the scroller's viewport.
  function setupHomeSwipe() {
    const main = $('view-home').querySelector('main');
    const tabs = Array.from(document.querySelectorAll('#home-tabs button'), (b) => b.dataset.tab);
    sideSwipe(main, main, {
      may: () => state.view === 'home',
      pick: (side) => {
        const cur = $(`tab-${state.homeTab}`);
        const next = tabs[tabs.indexOf(state.homeTab === 'snippets' ? 'settings' : state.homeTab) - side];
        if (!next) return { cur, peek: null };
        renderHomeTab(next);
        const peek = $(`tab-${next}`);
        peek.style.top = `${main.scrollTop}px`;
        peek.style.height = `${main.clientHeight}px`;
        return {
          cur,
          peek,
          land: () => {
            main.scrollTop = 0;
            peek.style.animation = 'none'; // in place already
            setHomeTab(next);
          },
        };
      },
    });
  }

  // Files: a swipe from the left does what ‹ does. The folder before this
  // one comes in as it was last listed, and is listed again once it has
  // settled in; with no folder before, the Terminal comes in. Nothing lies
  // to the right.
  function setupFilesSwipe() {
    const main = $('view-session').querySelector('main');
    const list = $('files-list');
    const peekList = h('div', { class: 'file-list peek-list', 'aria-hidden': 'true' });
    $('panel-files').append(peekList);
    sideSwipe(list, main, {
      may: () => {
        const s = activeSession();
        return state.view === 'session' && state.panel === 'files' && !!s && !s.files.loading;
      },
      pick: (side) => {
        const s = activeSession();
        if (side < 0) return { cur: list, peek: null };
        if (!s.files.back.length) {
          const peek = $('panel-terminal');
          return {
            cur: $('panel-files'),
            peek,
            land: () => {
              peek.style.animation = 'none'; // in place already
              showPanel('terminal');
            },
          };
        }
        const before = s.files.back[s.files.back.length - 1];
        const items = s.files.listed.get(before);
        peekList.replaceChildren(...(items ? fileEntries(s, before, items) : [h('div', { class: 'loading' }, h('div', { class: 'spinner' }))]));
        peekList.scrollTop = 0;
        peekList.style.top = `${list.offsetTop}px`;
        peekList.style.height = `${list.clientHeight}px`;
        return { cur: list, peek: peekList, land: () => filesBack(s, { quiet: true }) };
      },
    });
  }

  async function showLogin(message) {
    hideLock();
    closeSheet();
    $('login-passkey').hidden = true; // until we know a passkey is enrolled
    $('login-or').hidden = true;
    showView('login');
    $('login-error').textContent = message || '';
    try {
      const { count } = await api('GET', '/api/passkeys');
      state.passkeys.count = count;
    } catch {}
    const offerPasskey = passkeySupported() && state.passkeys.count > 0;
    $('login-passkey').hidden = !offerPasskey;
    $('login-or').hidden = !offerPasskey;
    if (offerPasskey) prefetchLoginOptions();
    else if (!matchMedia('(pointer: coarse)').matches) $('login-password').focus();
  }

  async function afterSignIn() {
    signIns++;
    state.authed = true;
    hideLock();
    local.remove(KEYS.hiddenAt);
    try {
      // Signing in set the device cookie; the list and the rest can go together.
      const [data] = await Promise.all([api('GET', '/api/sessions'), loadAll()]);
      takeConnections(data);
    } catch (err) {
      return showLogin(err.message);
    }
    showHome();
    restoreSessions();
    // Sockets closed while signed out come back now.
    const s = activeSession();
    if (s && state.view === 'session' && !s.isOpen()) s.connect();
  }

  function onUnauthorized() {
    if (!state.authed) return;
    state.authed = false;
    syncConnectionsPolling();
    for (const s of state.sessions.values()) {
      clearTimeout(s.retryTimer);
      s.closeSocket();
      s.setStatus('closed');
    }
    showLogin('Signed out. Sign in again to continue.');
  }

  // The server closes every connection this device owns, the ones in the
  // background and the ones still being opened, whatever this page knew of;
  // then the page forgets its terminals. The device stays the same device.
  async function signOut() {
    if (!(await confirmSheet('Sign out? Every SSH connection from this device is disconnected, including ones in the background.', { confirm: 'Sign out', danger: true }))) return;
    try {
      await api('POST', '/logout', undefined, { timeout: timings.check });
    } catch (err) {
      return toast(`Not signed out: ${err.message}`, true);
    }
    forgetTerminals();
    state.authed = false;
    syncConnectionsPolling();
    showLogin();
  }

  function forgetTerminals() {
    for (const s of [...state.sessions.values()]) s.dispose();
    state.activeId = null;
    session.remove(KEYS.sessions);
    session.remove(KEYS.active);
    session.remove(KEYS.editorDraft);
    resetConnections();
    renderConnections();
  }

  // ================================================================ wiring

  function bindUi() {
    bindEditor();
    const loginReveal = revealable($('login-password'));
    $('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = $('login-password');
      const button = $('login-submit');
      $('login-error').textContent = '';
      button.disabled = true;
      try {
        await api('POST', '/login', { password: input.value });
        input.value = '';
        loginReveal.hide();
        input.blur();
        await afterSignIn();
      } catch (err) {
        $('login-error').textContent = err.message;
      } finally {
        button.disabled = false;
      }
    });

    $('login-passkey').addEventListener('click', async () => {
      if (await passkeySignIn($('login-error'))) afterSignIn();
    });

    $('lock-unlock').addEventListener('click', async () => {
      if (await passkeySignIn($('lock-error'))) {
        local.remove(KEYS.hiddenAt);
        hideLock();
      }
    });
    $('lock-signout').addEventListener('click', async () => {
      try {
        await api('POST', '/logout');
      } catch {}
      state.authed = false;
      session.remove(KEYS.sessions);
      session.remove(KEYS.active);
      location.reload();
    });

    for (const b of document.querySelectorAll('#home-tabs button')) b.addEventListener('click', () => setHomeTab(b.dataset.tab));
    $('home-back').addEventListener('click', () => setHomeTab('settings'));
    $('home-refresh').addEventListener('click', () => refreshHome());
    setupPullToRefresh();
    setupHomeSwipe();
    setupFilesSwipe();
    $('home-add').addEventListener('click', () => ({ snippets: editSnippet, keys: newKey }[state.homeTab] || editServer)());

    $('session-back').addEventListener('click', leaveSession);
    $('session-settings').addEventListener('click', () => {
      const s = activeSession();
      if (s) connectionSettings(s.id, s.server);
    });
    $('session-close').addEventListener('click', () => {
      const s = activeSession();
      if (s) disconnectSession(s, true);
    });
    for (const b of document.querySelectorAll('#session-tabs button')) b.addEventListener('click', () => showPanel(b.dataset.panel));
    $('files-back').addEventListener('click', () => {
      const s = activeSession();
      if (s) filesBack(s);
    });
    $('files-title').addEventListener('click', () => {
      const s = activeSession();
      if (s) goToSheet(s);
    });
    $('files-star').addEventListener('click', () => {
      const s = activeSession();
      if (s) toggleFavorite(s);
    });

    const fileInput = $('files-input');
    fileInput.addEventListener('change', () => {
      const s = activeSession();
      const list = Array.from(fileInput.files || []);
      fileInput.value = '';
      if (s) uploadFiles(s, list);
    });
    document.querySelector('.files-toolbar').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-files]');
      const s = activeSession();
      if (!btn || !s) return;
      const action = btn.dataset.files;
      if (action === 'hidden') {
        local.set(KEYS.showHidden, !local.get(KEYS.showHidden, false));
        return renderFiles();
      }
      if (action === 'refresh') return loadFiles(s, s.files.path || '.');
      if (!s.files.path) return;
      if (action === 'upload') fileInput.click();
      if (action === 'mkdir') newFolder(s);
      if (action === 'newfile') newFile(s);
      if (action === 'zip') {
        const base = s.files.path === '/' ? 'root' : s.files.path.split('/').pop();
        triggerDownload(sftpUrl(s, { op: 'zip', path: s.files.path }), `${base}.zip`);
      }
    });

    document.addEventListener('visibilitychange', () => {
      syncConnectionsPolling();
      if (document.hidden) {
        if (state.authed) local.set(KEYS.hiddenAt, Date.now());
        // A loss on the way back is iOS's doing, not a failing GPU.
        for (const s of state.sessions.values()) s.webglLostAt = 0;
        return;
      }
      if (shouldLock()) showLock();
      local.remove(KEYS.hiddenAt);
      if (!state.authed) return;
      refreshConnections();
      focusTerminal();
      for (const s of state.sessions.values()) {
        s.useWebgl();
        if (!s.term || s.ended || s.shellExited || s.replaced) continue;
        // A socket that survived the background can still be dead, so probe it
        // instead of trusting readyState.
        if (s.isOpen()) s.probe();
        else s.reconnect(true);
      }
    });

    // Back on the network: the list, and any terminal waiting to reconnect.
    window.addEventListener('online', () => {
      if (!state.authed) return;
      refreshConnections();
      for (const s of state.sessions.values()) {
        if (s.term && !s.ended && !s.shellExited && !s.replaced && !s.isOpen()) s.reconnect(true);
      }
    });
  }

  async function boot() {
    setupViewport();
    setupFullscreen();
    bindUi();
    try {
      // First on its own: a signed-in browser without a device cookie gets
      // it here, before requests that need it go out side by side.
      takeConnections(await api('GET', '/api/sessions'));
      await loadAll();
    } catch (err) {
      // (Unless a sign-in already happened while this was on its way.)
      if (err.status === 401) return signIns ? undefined : showLogin();
      const root = $('view-loading');
      root.textContent = '';
      root.append(h('div', { class: 'empty' },
        h('p', { class: 'error', text: err.message }),
        h('button', { type: 'button', class: 'btn', text: 'Retry', onclick: () => location.reload() })));
      return;
    }
    state.authed = true;
    if (shouldLock()) showLock();
    local.remove(KEYS.hiddenAt);
    showHome();
    restoreSessions();
  }

  // A test seam for the reconnect watchdogs, which are otherwise only
  // reachable by waiting out a real stalled link.
  window.PicoSSH = { timings, session: activeSession, terminals: () => [...state.sessions.values()], connections: () => state.connections };

  boot();
})();
