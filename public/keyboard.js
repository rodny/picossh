// Extra key row above the terminal keyboard: key definitions, the shared
// Ctrl/Alt modifiers and key encoding used by every keyboard surface, key
// repeat, and the saved layouts. Exposes window.ExtraKeys.
'use strict';
(() => {
  // Versioned storage: layouts saved by earlier versions are ignored.
  const LAYOUT_KEYS = { phone: 'picossh.keyboard.v2.phone', desktop: 'picossh.keyboard.v2.desktop' };

  // Special keys: [final byte, style]. 'cursor' keys use SS3 in application
  // cursor mode; 'tilde' keys are CSI <n> ~; 'ss3' are F1-F4.
  const SPECIAL = {
    up: ['A', 'cursor'], down: ['B', 'cursor'], right: ['C', 'cursor'], left: ['D', 'cursor'],
    home: ['H', 'cursor'], end: ['F', 'cursor'],
    ins: ['2', 'tilde'], del: ['3', 'tilde'], pgup: ['5', 'tilde'], pgdn: ['6', 'tilde'],
    f1: ['P', 'ss3'], f2: ['Q', 'ss3'], f3: ['R', 'ss3'], f4: ['S', 'ss3'],
    f5: ['15', 'tilde'], f6: ['17', 'tilde'], f7: ['18', 'tilde'], f8: ['19', 'tilde'],
    f9: ['20', 'tilde'], f10: ['21', 'tilde'], f11: ['23', 'tilde'], f12: ['24', 'tilde'],
  };

  // Spoken names for keys whose label is a symbol.
  const NAMES = {
    '-': 'Minus', '_': 'Underscore', '/': 'Slash', '\\': 'Backslash', '|': 'Pipe', '~': 'Tilde',
    ':': 'Colon', ';': 'Semicolon', "'": 'Apostrophe', '"': 'Quote', '`': 'Backtick',
    '[': 'Left bracket', ']': 'Right bracket', '{': 'Left brace', '}': 'Right brace',
    '(': 'Left parenthesis', ')': 'Right parenthesis', '<': 'Less than', '>': 'Greater than',
    '&': 'Ampersand', '$': 'Dollar', '!': 'Exclamation mark', '*': 'Asterisk', '^': 'Caret',
    '.': 'Period', ',': 'Comma', '?': 'Question mark', '@': 'At', '#': 'Hash', '%': 'Percent',
    '+': 'Plus', '=': 'Equals', '€': 'Euro', '£': 'Pound', '¥': 'Yen', '•': 'Bullet',
  };
  const nameFor = (ch) => NAMES[ch] || ch;

  const KEYS = {};
  const def = (id, label, props) => { KEYS[id] = { id, label, name: label, ...props }; };
  const charId = (ch) => `ch${ch.charCodeAt(0)}`;

  def('esc', 'Esc', { type: 'send', send: '\x1b', name: 'Escape' });
  def('tab', 'Tab', { type: 'send', send: '\t' });
  def('ctrl', 'Ctrl', { type: 'mod', name: 'Control' });
  def('alt', 'Alt', { type: 'mod' });
  def('up', '↑', { type: 'special', repeat: true, name: 'Up arrow' });
  def('down', '↓', { type: 'special', repeat: true, name: 'Down arrow' });
  def('left', '←', { type: 'special', repeat: true, name: 'Left arrow' });
  def('right', '→', { type: 'special', repeat: true, name: 'Right arrow' });
  def('home', 'Home', { type: 'special' });
  def('end', 'End', { type: 'special' });
  def('pgup', 'PgUp', { type: 'special', repeat: true, name: 'Page up' });
  def('pgdn', 'PgDn', { type: 'special', repeat: true, name: 'Page down' });
  def('ins', 'Ins', { type: 'special', name: 'Insert' });
  def('del', 'Del', { type: 'special', repeat: true, name: 'Delete' });
  def('bksp', '⌫', { type: 'bksp', repeat: true, name: 'Backspace' });
  // No terminal sequence exists for these three. Print Screen copies the
  // screen's text; Scroll Lock holds output (XOFF/XON) like the Linux console;
  // Pause/Break sends the interrupt, as Ctrl+Break does.
  def('prtsc', 'PrtSc', { type: 'action', name: 'Print Screen' });
  def('scrlk', 'ScrLk', { type: 'toggle', name: 'Scroll Lock' });
  def('pause', 'Pause', { type: 'shortcut', send: '\x03', name: 'Pause/Break' });
  def('snippets', 'Snippets', { type: 'action', icon: 'code' });
  // Paste reads the clipboard, which needs the tap's user activation.
  def('paste', 'Paste', { type: 'action', icon: 'paste', activation: true });
  // Takes the built-in keyboard down, and this row with it. There is no Show
  // counterpart: a tap on the terminal brings both back.
  def('hide', 'Hide keyboard', { type: 'action', icon: 'keyboard-hide' });
  for (const ch of ['-', '_', '/', '.', '*', '|', '~', ':', ';', "'", '"', '`', '[', ']', '{', '}', '<', '>', '&', '$', '!', '^', '\\']) {
    def(charId(ch), ch, { type: 'char', send: ch, name: nameFor(ch) });
  }
  for (let i = 1; i <= 12; i++) def(`f${i}`, `F${i}`, { type: 'special' });
  // Dedicated shortcuts always send their own control character.
  for (const ch of ['C', 'D', 'Z', 'L', 'R', 'A', 'E', 'U', 'K', 'W', 'Y']) {
    def(`ctrl${ch}`, `^${ch}`, { type: 'shortcut', send: String.fromCharCode(ch.charCodeAt(0) & 0x1f), chip: true, name: `Control ${ch}` });
  }

  // ------------------------------------------------------------- layouts

  const PAGES = ['letters', 'numbers', 'terminal'];
  // Letters: Tab, shell symbols and ^C. Numbers: Esc, the arrows, Home and End. Each page
  // can add the other's keys (and more) back in the layout editor.
  const LETTERS_ROW = ['tab', ...['-', '~', '/', '\\', '.', '*', '|', '<', '>'].map(charId), 'ctrlC'];
  const NUMBERS_ROW = ['esc', 'left', 'up', 'down', 'right', 'home', 'end'];
  const SHELL_EXTRAS = [...['_', ':', ';', '"', "'", '`', '&', '$', '!', '^', '[', ']', '{', '}'].map(charId),
    'ctrlD', 'ctrlZ', 'ctrlL', 'ctrlR'];
  const FKEYS = Array.from({ length: 12 }, (_, i) => `f${i + 1}`);
  // Built-in keys each row can show; the ones after the defaults start hidden.
  const POOLS = {
    letters: { order: [...LETTERS_ROW, ...NUMBERS_ROW, ...SHELL_EXTRAS], hidden: [...NUMBERS_ROW, ...SHELL_EXTRAS] },
    numbers: { order: [...NUMBERS_ROW, ...LETTERS_ROW, ...SHELL_EXTRAS], hidden: [...LETTERS_ROW, ...SHELL_EXTRAS] },
    terminal: { order: [...FKEYS, 'esc', 'tab', 'ctrlC'], hidden: ['esc', 'tab', 'ctrlC'] },
    commands: { order: [], hidden: [] },
    main: { order: ['paste', 'snippets'], hidden: [] },
  };
  // Built-ins added after layouts were first saved that start shown in them.
  const SHOWN_WHEN_ADDED = ['paste'];
  // Phones keep these at the right end of the row on every page.
  const FIXED = ['paste', 'snippets', 'hide'];
  const ROWS = { phone: [...PAGES, 'commands'], desktop: ['main'] };
  // Rows that list the custom commands after their built-in keys.
  const CUSTOM_ROWS = ['commands', 'main'];

  const clone = (v) => JSON.parse(JSON.stringify(v));
  const platform = (phone) => (phone ? 'phone' : 'desktop');
  const defaultLayout = (phone) => ({
    version: 2,
    rows: Object.fromEntries(ROWS[platform(phone)].map((name) => [name, clone(POOLS[name])])),
    custom: [],
  });
  const DEFAULT_LAYOUTS = { phone: defaultLayout(true), desktop: defaultLayout(false) };

  const storage = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch {} },
    remove(key) { try { localStorage.removeItem(key); } catch {} },
  };

  // Letters and numbers used to share this row; a page saved unchanged from it
  // takes the new default for that page.
  const OLD_SHELL_ROW = ['esc', 'tab', ...['-', '~', '/', '.', '*', '|', '<', '>'].map(charId), 'ctrlC', 'left', 'up', 'down', 'right'];
  const isOldDefault = (row) => Array.isArray(row?.order) && Array.isArray(row.hidden) &&
    row.order.filter((id) => !row.hidden.includes(id)).join() === OLD_SHELL_ROW.join();

  // Reads the saved layout for one platform, dropping unknown ids and adding
  // keys the saved layout does not know about (built-ins hidden, at the end).
  function loadLayout(phone = false) {
    let saved;
    try { saved = JSON.parse(storage.get(LAYOUT_KEYS[platform(phone)])); } catch {}
    const layout = defaultLayout(phone);
    if (!saved || saved.version !== 2 || typeof saved.rows !== 'object' || !saved.rows) return layout;
    const ids = new Set();
    layout.custom = (Array.isArray(saved.custom) ? saved.custom : [])
      .filter((c) => c && typeof c.id === 'string' && c.id.startsWith('custom-') && !ids.has(c.id) &&
        typeof c.label === 'string' && c.label && typeof c.send === 'string' && ids.add(c.id))
      .map(({ id, label, send }) => ({ id, label, send }));
    for (const name of ROWS[platform(phone)]) {
      const pool = [...POOLS[name].order, ...(CUSTOM_ROWS.includes(name) ? layout.custom.map((c) => c.id) : [])];
      let row = saved.rows[name] || POOLS[name];
      if (isOldDefault(row)) row = POOLS[name];
      const seen = new Set();
      const order = (Array.isArray(row.order) ? row.order : []).filter((id) => pool.includes(id) && !seen.has(id) && seen.add(id));
      const hidden = (Array.isArray(row.hidden) ? row.hidden : []).filter((id) => seen.has(id));
      for (const id of pool) {
        if (seen.has(id)) continue;
        order.push(id);
        if (!id.startsWith('custom-') && !SHOWN_WHEN_ADDED.includes(id)) hidden.push(id);
      }
      layout.rows[name] = { order, hidden: [...new Set(hidden)] };
    }
    return layout;
  }

  const saveLayout = (layout, phone = false) => storage.set(LAYOUT_KEYS[platform(phone)], JSON.stringify(layout));
  const resetLayout = (phone = false) => storage.remove(LAYOUT_KEYS[platform(phone)]);

  function keyFor(id, layout) {
    if (KEYS[id]) return KEYS[id];
    const c = layout.custom.find((k) => k.id === id);
    return c ? { id: c.id, label: c.label, name: c.label, type: 'send', send: c.send, custom: true } : null;
  }

  // Visible keys of a row, in order.
  const visibleKeys = (layout, name) => {
    const row = layout.rows[name];
    return row ? row.order.filter((id) => !row.hidden.includes(id)).map((id) => keyFor(id, layout)).filter(Boolean) : [];
  };

  function addCustom(layout, { label, send }) {
    const id = `custom-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    layout.custom.push({ id, label, send });
    for (const name of CUSTOM_ROWS) if (layout.rows[name]) layout.rows[name].order.push(id);
    return id;
  }

  function removeCustom(layout, id) {
    layout.custom = layout.custom.filter((c) => c.id !== id);
    for (const row of Object.values(layout.rows)) {
      row.order = row.order.filter((x) => x !== id);
      row.hidden = row.hidden.filter((x) => x !== id);
    }
  }

  // "\e[A", "\x03", "\n" etc. typed into the custom command editor.
  function parseEscapes(text) {
    return text.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|[nrte0\\])/g, (_, seq) => {
      switch (seq[0]) {
        case 'x': case 'u': return String.fromCharCode(parseInt(seq.slice(1), 16));
        case 'n': return '\n';
        case 'r': return '\r';
        case 't': return '\t';
        case 'e': return '\x1b';
        case '0': return '\0';
        default: return '\\';
      }
    });
  }

  // The inverse, to show a saved command in the editor again.
  function formatEscapes(text) {
    return text.replace(/[\\\x00-\x1f\x7f]/g, (ch) => {
      const named = { '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\x1b': '\\e', '\0': '\\0' }[ch];
      return named || `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`;
    });
  }

  // --------------------------------------------------------------- encoding

  function ctrlChar(ch) {
    const code = ch.charCodeAt(0);
    if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) return String.fromCharCode(code & 0x1f);
    const map = {
      ' ': '\x00', '@': '\x00', '2': '\x00', '[': '\x1b', '3': '\x1b', '\\': '\x1c', '4': '\x1c',
      ']': '\x1d', '5': '\x1d', '^': '\x1e', '6': '\x1e', '_': '\x1f', '-': '\x1f', '/': '\x1f', '7': '\x1f',
      '?': '\x7f', '8': '\x7f',
    };
    return map[ch] !== undefined ? map[ch] : ch;
  }

  function specialSequence(id, mods, appCursor) {
    const [final, style] = SPECIAL[id];
    const m = 1 + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0);
    if (style === 'tilde') return m > 1 ? `\x1b[${final};${m}~` : `\x1b[${final}~`;
    if (m > 1) return `\x1b[1;${m}${final}`;
    if (style === 'ss3') return `\x1bO${final}`;
    return appCursor ? `\x1bO${final}` : `\x1b[${final}`;
  }

  // Applies Ctrl/Alt to typed text or a character key.
  function withModifiers(data, mods) {
    let out = data;
    if (mods.ctrl && out.length === 1) out = ctrlChar(out);
    if (mods.alt && out.length >= 1) out = '\x1b' + out;
    return out;
  }

  // Bytes a key sends with the given modifiers.
  function encode(key, mods, appCursor) {
    switch (key.type) {
      case 'special': return specialSequence(key.id, mods, appCursor);
      case 'char': return withModifiers(key.send, mods);
      case 'bksp': return (mods.alt ? '\x1b' : '') + (mods.ctrl ? '\x08' : '\x7f');
      case 'shortcut': return (mods.alt ? '\x1b' : '') + key.send;
      case 'send': return mods.alt && key.send.length === 1 ? '\x1b' + key.send : key.send;
      default: return '';
    }
  }

  /**
   * Shared terminal input for every keyboard surface: one set of Ctrl/Alt
   * modifiers ('off' | 'once' | 'lock') and one encoder.
   * options: { write(data), appCursor() -> bool }. write must deliver data to
   * the terminal's onData synchronously; data written here is already final
   * and passes filter() unchanged, so each input is modified exactly once.
   */
  function createInput({ write, appCursor }) {
    const mods = { ctrl: 'off', alt: 'off' };
    const listeners = new Set();
    let passing = 0;
    const notify = () => { for (const fn of listeners) fn({ ...mods }); };
    const active = () => ({ ctrl: mods.ctrl !== 'off', alt: mods.alt !== 'off' });
    const consume = () => {
      let changed = false;
      for (const k of ['ctrl', 'alt']) if (mods[k] === 'once') { mods[k] = 'off'; changed = true; }
      if (changed) notify();
    };
    const passthrough = (fn) => {
      passing++;
      try { return fn(); } finally { passing--; }
    };
    const emit = (data) => {
      consume();
      if (data) passthrough(() => write(data));
    };
    return {
      modifiers: () => ({ ...mods }),
      onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      // Tap: arm for the next input, or cancel (including a lock).
      toggle(name) { mods[name] = mods[name] === 'off' ? 'once' : 'off'; notify(); },
      lock(name) { mods[name] = 'lock'; notify(); },
      clear() {
        if (mods.ctrl === 'off' && mods.alt === 'off') return;
        mods.ctrl = mods.alt = 'off';
        notify();
      },
      // A key definition (arrows, shortcuts, custom commands...).
      press(key) {
        if (key.type === 'mod') return this.toggle(key.id);
        emit(encode(key, active(), appCursor()));
      },
      // Text from an on-screen letter, digit, space or Enter.
      text(data) { emit(withModifiers(data, active())); },
      // Input arriving from the terminal itself (system or physical keyboard).
      filter(data) {
        if (passing) return data;
        const m = active();
        if (!m.ctrl && !m.alt) return data;
        const out = withModifiers(data, m);
        consume();
        return out;
      },
      // Runs fn (e.g. a paste) with modifiers left alone.
      passthrough,
    };
  }

  // Tap vs hold for one button: taps fire on release unless the finger moved
  // (the row was scrolled); repeating keys repeat while held; modifiers lock.
  const REPEAT_DELAY = 400;
  const REPEAT_EVERY = 70;
  const LOCK_DELAY = 500;

  // ------------------------------------------------------------- extra row

  function iconFor(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.appendChild(use);
    return svg;
  }

  /**
   * options: { input (createInput), onAction(name), isFocused() -> bool,
   * refocus(), onResize() }. Phones and tablets (PhoneTerminal.media) get
   * the built-in keyboard, and this row follows its page.
   */
  function createKeybar(container, options) {
    const { input } = options;
    const media = window.PhoneTerminal.media;
    let phone = media.matches;
    let layout = loadLayout(phone);
    let page = 'letters';
    let keyboardHidden = false;

    function renderMods(mods = input.modifiers()) {
      for (const k of ['ctrl', 'alt']) {
        for (const el of container.querySelectorAll(`[data-key="${k}"]`)) {
          el.classList.toggle('on', mods[k] !== 'off');
          el.classList.toggle('locked', mods[k] === 'lock');
          el.setAttribute('aria-pressed', String(mods[k] !== 'off'));
        }
      }
    }
    input.onChange(renderMods);

    function button(key, extraClass = '') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.tabIndex = -1;
      btn.className = `key${key.chip ? ' chip' : ''}${key.type === 'mod' ? ' mod' : ''}${key.type === 'action' ? ' action-key' : ''}${key.label.length > 2 && !key.icon ? ' wide' : ''}${extraClass}`;
      btn.dataset.key = key.id;
      if (key.activation) btn.dataset.activation = '';
      if (key.name !== key.label) btn.setAttribute('aria-label', key.name);
      if (key.icon) {
        btn.classList.add('icon-key');
        btn.setAttribute('aria-label', key.label);
        btn.appendChild(iconFor(key.icon));
        if (!phone) btn.append(key.label);
      } else {
        btn.textContent = key.label;
      }
      return btn;
    }

    function render() {
      endGesture();
      container.textContent = '';
      container.classList.toggle('phone-keybar', phone);
      // The row belongs to the built-in keyboard and goes down with it, Paste
      // and Snippets included, leaving the whole screen to the terminal. A tap
      // on the terminal brings both back. Desktops, which have no built-in
      // keyboard, always keep the row.
      if (phone && keyboardHidden) {
        container.hidden = true;
        return;
      }
      const rowEl = document.createElement('div');
      rowEl.className = 'keyrow';
      const keys = document.createElement('div');
      keys.className = 'keys';
      const shown = phone
        ? [...visibleKeys(layout, page), ...visibleKeys(layout, 'commands')]
        : visibleKeys(layout, 'main');
      for (const key of shown) keys.appendChild(button(key));
      rowEl.appendChild(keys);
      if (phone) {
        const fixed = document.createElement('div');
        fixed.className = 'keys-fixed';
        fixed.append(...FIXED.map((id) => button(KEYS[id])));
        rowEl.appendChild(fixed);
      }
      container.appendChild(rowEl);
      container.hidden = !phone && !shown.length;
      renderMods();
    }

    function setPage(value) {
      if (value === page) return;
      page = value;
      if (phone) render();
    }

    // Desktop: a vertical wheel scrolls the row sideways.
    container.addEventListener('wheel', (e) => {
      const keys = e.target.closest('.keys');
      if (!keys || keys.scrollWidth <= keys.clientWidth || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
      keys.scrollLeft += e.deltaY;
      e.preventDefault();
    }, { passive: false });

    let gesture = null;
    function endGesture() {
      if (!gesture) return;
      gesture.btn.classList.remove('pressed');
      clearTimeout(gesture.timer);
      clearInterval(gesture.interval);
      gesture = null;
    }

    function activate(key) {
      if (navigator.vibrate) navigator.vibrate(8);
      if (key.type === 'action') options.onAction(key.id);
      else input.press(key);
    }

    container.addEventListener('pointerdown', (e) => {
      const btn = e.target.closest('button[data-key]');
      if (!btn || e.button > 0) return;
      endGesture();
      const key = keyFor(btn.dataset.key, layout);
      if (!key) return;
      gesture = { key, btn, x: e.clientX, y: e.clientY, fired: false, focused: options.isFocused() };
      btn.classList.add('pressed');
      const g = gesture;
      if (key.repeat) {
        g.timer = setTimeout(() => {
          g.fired = true;
          activate(key);
          g.interval = setInterval(() => (document.hidden ? endGesture() : activate(key)), REPEAT_EVERY);
        }, REPEAT_DELAY);
      } else if (key.type === 'mod') {
        g.timer = setTimeout(() => {
          g.fired = true;
          input.lock(key.id);
          if (navigator.vibrate) navigator.vibrate(20);
        }, LOCK_DELAY);
      }
    });

    container.addEventListener('pointermove', (e) => {
      if (gesture && Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y) > 10) endGesture();
    });

    // Hide keyboard takes this row down with it, so its button leaves the page
    // before the touch is over: the touchend below no longer passes through
    // the container, and the browser sends its click to whatever is under the
    // finger now (the terminal, which would bring the keyboard straight back).
    function swallowClick() {
      let timer = 0;
      const done = () => {
        clearTimeout(timer);
        document.removeEventListener('click', stop, true);
      };
      const stop = (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
        done();
      };
      document.addEventListener('click', stop, true);
      timer = setTimeout(done, 400); // no click came: the tap was not a touch
    }

    const release = (cancelled) => {
      if (!gesture) return;
      const g = gesture;
      endGesture();
      if (cancelled || g.fired) return;
      const wasShown = !container.hidden;
      activate(g.key);
      if (wasShown && (container.hidden || g.key.id === 'hide')) swallowClick();
      // Hide keyboard must not bring the system keyboard straight back, and
      // the sheets Snippets and Copy open keep the focus.
      if (g.focused && g.key.type !== 'action') options.refocus();
    };
    container.addEventListener('pointerup', () => release(false));
    container.addEventListener('pointercancel', () => release(true));
    container.addEventListener('pointerleave', endGesture);
    // Keys act on pointerup. The click a touch sends afterwards would land on
    // whatever just opened under the finger (a snippet in the Snippets sheet).
    container.addEventListener('touchend', (e) => {
      if (e.cancelable) e.preventDefault();
    }, { passive: false });
    // Keyboard and assistive-technology activation have no pointer sequence.
    container.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-key]');
      const key = btn && e.detail === 0 && keyFor(btn.dataset.key, layout);
      if (key) activate(key);
    });
    // Keep focus (and any system keyboard) on the terminal.
    container.addEventListener('mousedown', (e) => e.preventDefault());
    container.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('blur', endGesture);
    document.addEventListener('visibilitychange', endGesture);

    media.addEventListener('change', () => {
      phone = media.matches;
      layout = loadLayout(phone);
      render();
      options.onResize && options.onResize();
    });
    render();

    return {
      render,
      setPage,
      cancel: endGesture,
      setKeyboardHidden(value) {
        if (keyboardHidden === value) return;
        keyboardHidden = value;
        if (phone) render();
      },
      reload() {
        layout = loadLayout(phone);
        render();
        options.onResize && options.onResize();
      },
    };
  }

  window.ExtraKeys = {
    KEYS, NAMES, PAGES, POOLS, DEFAULT_LAYOUTS, REPEAT_DELAY, REPEAT_EVERY, LOCK_DELAY,
    loadLayout, saveLayout, resetLayout, keyFor, visibleKeys, addCustom, removeCustom,
    parseEscapes, formatEscapes, specialSequence, ctrlChar, withModifiers, encode,
    createInput, createKeybar,
  };
})();
