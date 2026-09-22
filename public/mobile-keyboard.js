// The terminal owns its keyboard on phones and tablets (PhoneTerminal.media:
// touch screens and narrow windows); elsewhere xterm uses the system keyboard.
// Pages of letters, numbers, symbols and terminal keys, with Ctrl and Alt
// shared with the extra row through ExtraKeys.createInput. Character keys show
// what they type above the finger, and touch and hold offers accents (or, on
// the bottom-left key, every other page).
'use strict';
(() => {
  const media = window.PhoneTerminal.media;
  const active = () => media.matches;
  const { KEYS, NAMES, REPEAT_DELAY, REPEAT_EVERY, LOCK_DELAY } = window.ExtraKeys;

  // A page as the bottom-left key names it.
  const LABEL = { abc: 'ABC', 123: '123', symbols: '#+=', fn: 'Fn' };
  const PAGE_NAME = { abc: 'Letters', 123: 'Numbers and symbols', symbols: 'More symbols', fn: 'Terminal keys' };
  // Touch and hold choices, as on the iPhone keyboard.
  const ACCENTS = {
    a: 'àáâäæãåā', e: 'èéêëēėę', i: 'îïíīįì', o: 'ôöòóœøōõ', u: 'ûüùúū',
    n: 'ñń', c: 'çćč', y: 'ÿ', s: 'ßśš', z: 'žźż', l: 'ł',
    '?': '¿', '!': '¡', '-': '–—•', '$': '¢€£¥₩', '.': '…', '0': '°', '&': '§',
    "'": '‘’`', '"': '“”„«»',
  };
  const HOLD_DELAY = 450;
  // The extra row shows one set of keys per page; both symbol pages share one.
  const EXTRA_PAGE = { abc: 'letters', 123: 'numbers', symbols: 'numbers', fn: 'terminal' };

  // Popups sit above the keys, outside the keyboard, so none is clipped. A
  // stem joins each one to its key.
  function popup(button, className, width, height, left) {
    const r = button.getBoundingClientRect();
    left = Math.min(Math.max(4, left ?? r.left + r.width / 2 - width / 2), innerWidth - width - 4);
    const el = document.createElement('div');
    el.className = 'mobile-key-popup ' + className;
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText = `left:${left}px;top:${r.top - height - 2}px;width:${width}px;height:${height}px;` +
      `--stem-left:${r.left - left}px;--stem-width:${r.width}px;--stem-height:${r.height + 2}px`;
    document.body.append(el);
    return { el, left };
  }

  // The enlarged character above a pressed key.
  function preview(button) {
    const width = button.offsetWidth;
    const { el } = popup(button, 'preview', Math.max(width * 1.5, width + 16), button.offsetHeight * 1.15);
    el.textContent = button.textContent;
    return el;
  }

  // The touch and hold menu. The choice over the key starts selected; sliding
  // along selects another, and sliding well away selects none.
  function menu(button, choices) {
    const r = button.getBoundingClientRect();
    const words = choices.some((c) => c.label.length > 1);
    const size = Math.max(r.width, words ? 48 : 32);
    const pad = 4;
    const width = size * choices.length + pad * 2;
    // Open to the right of the key, or to its left near the right edge.
    const start = r.left + r.width / 2 - size / 2 - pad;
    const leftward = start + width > innerWidth - 4;
    const order = leftward ? [...choices].reverse() : choices;
    const { el, left } = popup(button, words ? 'menu words' : 'menu', width, button.offsetHeight * 1.15, leftward ? start + size + pad * 2 - width : start);
    const options = order.map((choice) => {
      const option = document.createElement('span');
      option.className = 'option';
      option.style.width = size + 'px';
      option.textContent = choice.label;
      return option;
    });
    el.append(...options);
    let selected = -1;
    const select = (x, y) => {
      const i = Math.floor((x - left - pad) / size);
      const away = y > r.bottom + r.height || y < r.top - r.height * 2.5 || i < -1 || i > order.length;
      selected = away ? -1 : Math.min(Math.max(i, 0), order.length - 1);
      options.forEach((option, n) => option.classList.toggle('selected', n === selected));
    };
    select(r.left + r.width / 2, r.top + r.height / 2);
    return { el, select, get choice() { return order[selected]; } };
  }

  function create(container, { input, onResize, onCollapse, onPage, onAction, slide }) {
    let page = 'abc';
    // The page Fn came from, which its bottom-left key returns to.
    let back = 'abc';
    let shift = false;
    let scrollLock = false;
    let collapsed = false;
    let collapseTransition = 0;
    const gestures = new Map();
    const usable = () => !document.hidden && container.getClientRects().length > 0 &&
      !document.querySelector('#sheet-root .sheet') &&
      !document.querySelector('#view-lock.active');

    function key(value, label = value, className = '') {
      const button = document.createElement('button');
      button.type = 'button';
      button.tabIndex = -1;
      button.className = 'mobile-key' + (className ? ' ' + className : '');
      button.dataset.mobileKey = value;
      button.textContent = label;
      const special = KEYS[value];
      const name = special ? special.name : value.length === 1 ? NAMES[value] : null;
      if (name && name !== label) button.setAttribute('aria-label', name);
      return button;
    }

    function row(keys, className = '') {
      const el = document.createElement('div');
      el.className = 'mobile-keyrow' + (className ? ' ' + className : '');
      el.append(...keys);
      container.append(el);
    }

    function render() {
      cancelAll();
      container.replaceChildren();
      container.dataset.page = page;
      container.hidden = collapsed || !active();
      if (container.hidden) return;
      const letters = (text) => Array.from(text, (ch) => key(ch, shift ? ch.toUpperCase() : ch));
      const symbols = (text) => Array.from(text, (ch) => key(ch));
      const special = (ids, className) => ids.map((id) => key(id, KEYS[id].label, className));
      const backspace = key('bksp', '⌫', 'action');
      if (page === 'abc') {
        const shiftKey = key('shift', '⇧', 'action');
        shiftKey.setAttribute('aria-label', 'Shift');
        shiftKey.setAttribute('aria-pressed', String(shift));
        row(letters('qwertyuiop'));
        row(letters('asdfghjkl'), 'inset');
        row([shiftKey, ...letters('zxcvbnm'), backspace]);
      } else if (page === 'fn') {
        row(special(['ctrlD', 'ctrlZ', 'ctrlL', 'ctrlR', 'ctrlA', 'ctrlE', 'ctrlU', 'ctrlK', 'ctrlW', 'ctrlY'], 'shortcut'));
        const [prtsc, scrlk, pause] = special(['prtsc', 'scrlk', 'pause'], 'nav');
        scrlk.setAttribute('aria-pressed', String(scrollLock));
        row([prtsc, scrlk, pause, ...special(['left', 'down', 'up', 'right'], 'arrow')]);
        row([...special(['home', 'end', 'pgup', 'pgdn', 'ins', 'del'], 'nav'), key('bksp', '⌫', 'nav')]);
      } else {
        const numbers = page === '123';
        row(symbols(numbers ? '1234567890' : '[]{}#%^*+='));
        row(symbols(numbers ? '-/:;()$&@"' : '_\\|~<>€£¥•'));
        const more = key('symbols', numbers ? '#+=' : '123', 'action');
        more.setAttribute('aria-label', numbers ? 'More symbols' : 'Numbers');
        row([more, ...symbols('.,?!\''), backspace]);
      }
      const next = modeChoices()[0];
      const mode = key('mode', LABEL[next], 'action mode');
      mode.setAttribute('aria-label', PAGE_NAME[next]);
      mode.setAttribute('aria-description', 'Touch and hold for more keyboards');
      const space = key('space', '', 'space');
      space.setAttribute('aria-label', 'Space');
      row([mode, key('alt', 'Alt', 'mod'), space, key('ctrl', 'Ctrl', 'mod'), key('enter', 'Enter', 'enter')], 'bottom');
      renderMods();
    }

    function renderMods(mods = input.modifiers()) {
      for (const name of ['ctrl', 'alt']) {
        const button = container.querySelector(`[data-mobile-key="${name}"]`);
        if (!button) continue;
        button.classList.toggle('on', mods[name] !== 'off');
        button.classList.toggle('locked', mods[name] === 'lock');
        button.setAttribute('aria-pressed', String(mods[name] !== 'off'));
        button.setAttribute('aria-label', KEYS[name].name + (mods[name] === 'lock' ? ', locked' : ''));
      }
    }
    input.onChange(renderMods);

    // Where the bottom-left key goes on a tap, then the rest of its choices:
    // letters and numbers take turns, and Fn returns to the page it came from.
    function modeChoices() {
      if (page === 'fn') return [back, back === 'abc' ? '123' : 'abc'];
      return [page === 'abc' ? '123' : 'abc', 'fn'];
    }

    function choicesFor(value) {
      if (value === 'mode') return modeChoices().map((target) => ({ label: LABEL[target], page: target }));
      const accents = ACCENTS[value];
      if (!accents) return null;
      return Array.from(accents, (ch) => {
        // ß has no single-letter capital.
        const upper = page === 'abc' && shift && ch.toUpperCase().length === 1 ? ch.toUpperCase() : ch;
        return { label: upper, text: upper };
      });
    }

    function setPage(value) {
      if (value === 'fn' && page !== 'fn') back = page;
      page = value;
      shift = false;
      render();
      onResize();
      onPage?.(EXTRA_PAGE[page]);
    }

    function press(value) {
      if (!usable()) return;
      if (value === 'shift') {
        shift = !shift;
        render();
      } else if (value === 'mode') {
        setPage(modeChoices()[0]);
      } else if (value === 'symbols') {
        setPage(page === '123' ? 'symbols' : '123');
      } else if (value === 'ctrl' || value === 'alt') {
        input.toggle(value);
      } else if (value === 'scrlk') {
        // XOFF holds the program's output, XON lets it continue.
        scrollLock = !scrollLock;
        input.press({ type: 'shortcut', send: scrollLock ? '\x13' : '\x11' });
        container.querySelector('[data-mobile-key="scrlk"]')?.setAttribute('aria-pressed', String(scrollLock));
      } else if (KEYS[value]?.type === 'action') {
        onAction?.(value);
      } else if (KEYS[value]) {
        input.press(KEYS[value]);
      } else {
        const text = { space: ' ', enter: '\r' }[value] ?? (page === 'abc' && shift ? value.toUpperCase() : value);
        type(text, value.length === 1);
      }
    }

    function type(text, character) {
      input.text(text);
      if (shift && character) {
        shift = false;
        render();
      }
    }

    // A choice from a touch and hold menu.
    function choose(choice) {
      if (!usable()) return;
      if (choice.page) setPage(choice.page);
      else type(choice.text, true);
    }

    // `slide(up)` animates the keys into place, or away before they go
    // (resolving when done): they come up, then slide in; they slide out,
    // then go, unless shown again meanwhile.
    function setCollapsed(value) {
      if (collapsed === value) return;
      collapsed = value;
      const transition = ++collapseTransition;
      const apply = () => {
        render();
        onResize();
        onCollapse?.(collapsed);
      };
      if (!slide) return apply();
      if (collapsed) slide(false).then(() => { if (transition === collapseTransition) apply(); });
      else {
        apply();
        slide(true);
      }
    }

    // Rotating, resizing the window or attaching a mouse can switch devices.
    media.addEventListener('change', () => {
      ++collapseTransition;
      collapsed = false;
      // Cancel a slide that belonged to the previous device layout.
      for (const a of container.getAnimations()) a.cancel();
      render();
      onResize();
      onCollapse?.(collapsed);
    });

    function cancel(id) {
      const g = gestures.get(id);
      if (!g) return;
      clearTimeout(g.timer);
      clearInterval(g.repeat);
      g.preview?.remove();
      g.menu?.el.remove();
      g.button.classList.remove('pressed');
      gestures.delete(id);
    }
    function cancelAll() { for (const id of gestures.keys()) cancel(id); }

    container.addEventListener('pointerdown', (e) => {
      const button = e.target.closest('button[data-mobile-key]');
      if (!button || e.button !== 0 || !usable()) return;
      e.preventDefault(); // Never focus a native text field to type a custom key.
      const value = button.dataset.mobileKey;
      const g = { button, x: e.clientX, y: e.clientY, held: false };
      gestures.set(e.pointerId, g);
      button.classList.add('pressed');
      button.setPointerCapture(e.pointerId);
      if (value.length === 1) g.preview = preview(button);
      const choices = choicesFor(value);
      if (choices) {
        g.timer = setTimeout(() => {
          if (!usable()) { cancel(e.pointerId); return; }
          g.held = true;
          g.preview?.remove();
          g.menu = menu(button, choices);
          if (navigator.vibrate) navigator.vibrate(10);
        }, HOLD_DELAY);
      } else if (KEYS[value]?.repeat) {
        g.timer = setTimeout(() => {
          if (!usable()) { cancel(e.pointerId); return; }
          g.held = true;
          press(value);
          g.repeat = setInterval(() => {
            if (!usable()) cancel(e.pointerId);
            else press(value);
          }, REPEAT_EVERY);
        }, REPEAT_DELAY);
      } else if (value === 'ctrl' || value === 'alt') {
        g.timer = setTimeout(() => {
          g.held = true;
          input.lock(value);
          if (navigator.vibrate) navigator.vibrate(20);
        }, LOCK_DELAY);
      }
    });
    container.addEventListener('pointermove', (e) => {
      const g = gestures.get(e.pointerId);
      if (g?.menu) g.menu.select(e.clientX, e.clientY);
      else if (g && Math.hypot(e.clientX - g.x, e.clientY - g.y) > 12) cancel(e.pointerId);
    });
    container.addEventListener('pointerup', (e) => {
      const g = gestures.get(e.pointerId);
      if (!g) return;
      e.preventDefault();
      cancel(e.pointerId);
      if (g.menu) {
        if (g.menu.choice) choose(g.menu.choice);
      } else if (!g.held) {
        press(g.button.dataset.mobileKey);
      }
    });
    for (const event of ['pointercancel', 'lostpointercapture']) {
      container.addEventListener(event, (e) => cancel(e.pointerId));
    }
    // Keyboard and assistive-technology activation have no pointer sequence.
    container.addEventListener('click', (e) => {
      const button = e.target.closest('button[data-mobile-key]');
      if (button && e.detail === 0) press(button.dataset.mobileKey);
    });
    container.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('blur', cancelAll);
    document.addEventListener('visibilitychange', cancelAll);
    render();
    onPage?.(EXTRA_PAGE[page]);
    return {
      toggle: () => setCollapsed(!collapsed),
      // A tap on the terminal: the only way back once the keys are down.
      show: () => setCollapsed(false),
      get collapsed() { return collapsed; },
      cancel: cancelAll,
      get page() { return EXTRA_PAGE[page]; },
    };
  }

  window.MobileKeyboard = { active, create };
})();
