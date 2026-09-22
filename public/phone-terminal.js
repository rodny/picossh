// Phone and tablet terminal sizing and touch scrollback. Desktop keeps xterm's defaults.
'use strict';
(() => {
  // Touch screens of any size, and any window narrow enough to be a phone
  // (so a desktop browser at phone size behaves like one). Keep in step with
  // the matching rule at the end of style.css.
  const media = matchMedia('(pointer: coarse), (max-width: 700px)');
  const STORAGE_KEY = 'picossh.terminal.phoneColumns';
  const COLUMN_OPTIONS = [0, 48, 64, 80, 100];
  const DEFAULT_COLUMNS = 64;
  function getColumns() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const value = raw === null ? DEFAULT_COLUMNS : Number(raw);
      return COLUMN_OPTIONS.includes(value) ? value : DEFAULT_COLUMNS;
    } catch { return DEFAULT_COLUMNS; }
  }
  function setColumns(value) {
    if (!COLUMN_OPTIONS.includes(value)) return;
    try { localStorage.setItem(STORAGE_KEY, String(value)); } catch {}
  }

  // Measure through FitAddon so font fallback, device scale and the scrollbar
  // are accounted for. Only resize the PTY once, after choosing the font.
  function fit(term, addon) {
    const target = media.matches ? getColumns() : 0;
    term.options.fontSize = 14;
    if (target) {
      let dims = addon.proposeDimensions();
      if (dims && dims.cols < target) {
        let size = Math.max(2, Math.floor(14 * dims.cols / target * 4) / 4);
        term.options.fontSize = size;
        dims = addon.proposeDimensions();
        while (dims && dims.cols < target && size > 2) {
          size -= 0.25;
          term.options.fontSize = size;
          dims = addon.proposeDimensions();
        }
      }
    }
    addon.fit();
  }

  const SELECT_DELAY = 450;

  // xterm's 256-colour palette entry n (0-15 come from the theme).
  const THEME_COLORS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
  function paletteColor(theme, n) {
    if (n < 8) return theme[THEME_COLORS[n]];
    if (n < 16) {
      const name = THEME_COLORS[n - 8];
      return theme[`bright${name[0].toUpperCase()}${name.slice(1)}`];
    }
    if (n >= 232) {
      const v = 8 + (n - 232) * 10;
      return `rgb(${v},${v},${v})`;
    }
    const i = n - 16;
    const level = (c) => (c ? 55 + c * 40 : 0);
    return `rgb(${level(Math.floor(i / 36))},${level(Math.floor(i / 6) % 6)},${level(i % 6)})`;
  }
  function cellColor(theme, cell, fg) {
    if (fg ? cell.isFgDefault() : cell.isBgDefault()) return null;
    const value = fg ? cell.getFgColor() : cell.getBgColor();
    if (fg ? cell.isFgRGB() : cell.isBgRGB()) return `#${value.toString(16).padStart(6, '0')}`;
    return paletteColor(theme, value) || null;
  }

  // The magnifier shown above the finger while selecting: the rows around the
  // touched cell drawn larger from the buffer (so it works with any renderer),
  // the selection shaded and the cell under the finger outlined.
  const LOUPE_COLS = 13;
  const LOUPE_ROWS = 3;
  function createLoupe(term) {
    let el = null;
    let canvas = null;
    function show(x, y, cell, range) {
      const theme = term.options.theme || {};
      const screenRect = term.element.querySelector('.xterm-screen').getBoundingClientRect();
      const cellW = screenRect.width / term.cols;
      const cellH = screenRect.height / term.rows;
      const scale = Math.min(3, Math.max(2, 22 / cellH));
      const cw = cellW * scale;
      const ch = cellH * scale;
      const w = Math.round(cw * LOUPE_COLS);
      const h = Math.round(ch * LOUPE_ROWS);
      if (!el) {
        el = document.createElement('div');
        el.className = 'term-loupe';
        el.setAttribute('aria-hidden', 'true');
        canvas = document.createElement('canvas');
        el.append(canvas);
        document.body.append(el);
      }
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
      }
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const background = theme.background || '#000';
      const foreground = theme.foreground || '#fff';
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, w, h);
      const buffer = term.buffer.active;
      // Keep the window inside the line, with the touched cell as central as it can be.
      const left = Math.min(Math.max(cell.col - (LOUPE_COLS >> 1), 0), Math.max(term.cols - LOUPE_COLS, 0));
      const top = cell.row - (LOUPE_ROWS >> 1);
      const size = term.options.fontSize * scale;
      const family = term.options.fontFamily || 'monospace';
      const selected = (col, row) => (row > range.from.row || (row === range.from.row && col >= range.from.col)) &&
        (row < range.to.row || (row === range.to.row && col <= range.to.col));
      const reuse = buffer.getNullCell();
      ctx.textBaseline = 'middle';
      for (let r = 0; r < LOUPE_ROWS; r++) {
        const line = buffer.getLine(top + r);
        if (!line) continue;
        for (let c = 0; c < LOUPE_COLS && left + c < term.cols; c++) {
          const data = line.getCell(left + c, reuse);
          if (!data) continue;
          let fg = cellColor(theme, data, true) || foreground;
          let bg = cellColor(theme, data, false);
          if (data.isInverse()) [fg, bg] = [bg || background, fg];
          const px = c * cw;
          const py = r * ch;
          if (bg) {
            ctx.fillStyle = bg;
            ctx.fillRect(px, py, cw * Math.max(1, data.getWidth()), ch);
          }
          if (selected(left + c, top + r)) {
            ctx.fillStyle = theme.selectionBackground || 'rgba(128, 128, 128, 0.4)';
            ctx.fillRect(px, py, cw, ch);
          }
          const chars = data.getChars();
          if (chars && chars !== ' ') {
            ctx.font = `${data.isItalic() ? 'italic ' : ''}${data.isBold() ? 'bold ' : ''}${size}px ${family}`;
            ctx.fillStyle = fg;
            ctx.fillText(chars, px, py + ch / 2);
          }
        }
      }
      // The cell under the finger.
      ctx.strokeStyle = theme.cursor || foreground;
      ctx.lineWidth = 2;
      ctx.strokeRect((cell.col - left) * cw + 1, (cell.row - top) * ch + 1, cw - 2, ch - 2);
      el.dataset.cell = buffer.getLine(cell.row)?.getCell(cell.col)?.getChars() || ' ';

      // Centred above the finger (below it near the top edge), inside the
      // visible viewport.
      const vv = window.visualViewport;
      const vLeft = vv ? vv.offsetLeft : 0;
      const vTop = vv ? vv.offsetTop : 0;
      const vWidth = vv ? vv.width : innerWidth;
      const margin = 6;
      const gap = 56;
      const boxLeft = Math.min(Math.max(x - w / 2, vLeft + margin), vLeft + vWidth - w - margin);
      const boxTop = y - h - gap >= vTop + margin ? y - h - gap : y + gap;
      el.style.left = `${Math.round(boxLeft)}px`;
      el.style.top = `${Math.round(boxTop)}px`;
    }
    function hide() {
      if (el) el.remove();
      el = canvas = null;
    }
    return { show, hide };
  }

  // xterm 6 uses a synthetic scrollbar, not a natively scrollable viewport.
  // Convert one-finger vertical movement to buffer lines, preserving taps and
  // gestures in programs using the alternate screen.
  //
  // xterm only selects with a mouse, so a long press selects instead: it marks
  // the character under the finger, dragging extends the selection (scrolling
  // at the top and bottom edges), and lifting keeps it and calls onSelect.
  // Any selection, by touch or mouse, then gets a handle at each end: drag one
  // to move that end, and onSelect is called again.
  function bindTouch(term, { onSelect } = {}) {
    const el = term.element;
    let gesture = null;
    let frame = 0;
    let suppressClickUntil = 0;
    let press = null; // { id, x, y, timer } until the long press fires
    let selecting = null; // { id, anchor: { col, row }, edge, x, y }
    const loupe = createLoupe(term);
    const stop = () => { cancelAnimationFrame(frame); frame = 0; };
    const screen = () => el.querySelector('.xterm-screen').getBoundingClientRect();
    const lineHeight = () => screen().height / term.rows;
    const cancelPress = () => {
      if (press) clearTimeout(press.timer);
      press = null;
    };
    // The buffer cell under a point, clamped to the screen.
    const cellAt = (x, y) => {
      const r = screen();
      const clamp = (v, max) => Math.min(Math.max(v, 0), max);
      return {
        col: clamp(Math.floor((x - r.left) / (r.width / term.cols)), term.cols - 1),
        row: clamp(Math.floor((y - r.top) / (r.height / term.rows)), term.rows - 1) + term.buffer.active.viewportY,
      };
    };
    // Selects from the anchor to the cell under the finger, and magnifies it.
    const selectAt = (x, y) => {
      const cell = cellAt(x, y);
      const a = selecting.anchor;
      const [from, to] = a.row < cell.row || (a.row === cell.row && a.col <= cell.col) ? [a, cell] : [cell, a];
      term.select(from.col, from.row, (to.row - from.row) * term.cols + to.col - from.col + 1);
      loupe.show(x, y, cell, { from, to });
    };
    const stopEdge = () => {
      if (selecting) clearInterval(selecting.edge);
      if (selecting) selecting.edge = 0;
    };
    const endSelection = () => {
      stopEdge();
      selecting = null;
      loupe.hide();
      placeHandles();
    };

    // The handles sit beside the xterm element, so its touch handling (and
    // xterm's own mouse selection) never sees them.
    const handles = ['start', 'end'].map((which) => {
      const handle = document.createElement('div');
      handle.className = `term-handle ${which}`;
      handle.hidden = true;
      handle.innerHTML = '<span class="stem"></span><span class="knob"></span>';
      handle.addEventListener('pointerdown', (e) => grabHandle(e, which));
      el.parentElement.append(handle);
      return handle;
    });
    // The selection as inclusive cells, first to last.
    const selectedCells = () => {
      const pos = term.getSelectionPosition();
      if (!pos) return null;
      const last = pos.end.x > 0 ? { col: pos.end.x - 1, row: pos.end.y } : { col: term.cols - 1, row: pos.end.y - 1 };
      return { first: { col: pos.start.x, row: pos.start.y }, last };
    };
    // Each handle stands on the outer edge of its end cell: the start one
    // with its knob above the row, the end one with its knob below, unless
    // that would put the knob off the screen.
    function placeHandles() {
      // Hidden under a long press (the magnifier shows the ends); a handle
      // being dragged follows its end.
      const cells = (!selecting || selecting.handle) && selectedCells();
      const box = el.parentElement.getBoundingClientRect();
      const r = screen();
      const w = r.width / term.cols, h = r.height / term.rows;
      handles.forEach((handle, i) => {
        const cell = cells && (i ? cells.last : cells.first);
        const row = cell && cell.row - term.buffer.active.viewportY;
        handle.hidden = !cell || row < 0 || row >= term.rows;
        if (handle.hidden) return;
        const below = i ? row < term.rows - 1 : row === 0;
        handle.classList.toggle('below', below);
        handle.classList.toggle('above', !below);
        handle.style.left = `${r.left - box.left + (cell.col + i) * w}px`;
        handle.style.top = `${r.top - box.top + row * h}px`;
        handle.style.height = `${h}px`;
      });
    }
    // Dragging a handle is a long-press selection anchored at the other end.
    // The finger holds the knob, not the text, so the point it moves is
    // shifted back onto the row and into the end cell.
    function grabHandle(e, which) {
      const cells = selectedCells();
      if (!cells || (e.pointerType === 'mouse' && e.button !== 0)) return;
      e.preventDefault();
      e.stopPropagation();
      const handle = e.currentTarget;
      const box = handle.getBoundingClientRect();
      const w = screen().width / term.cols;
      const dx = e.clientX - (box.left + (which === 'start' ? w / 2 : -w / 2));
      const dy = e.clientY - (box.top + box.height / 2);
      stop();
      gesture = null;
      cancelPress();
      selecting = { id: e.pointerId, anchor: which === 'start' ? cells.last : cells.first, edge: 0, x: 0, y: 0, handle: true };
      handle.setPointerCapture(e.pointerId);
      const move = (m) => {
        if (m.pointerId === selecting?.id) dragSelection({ clientX: m.clientX - dx, clientY: m.clientY - dy });
      };
      const up = (u) => {
        if (u.pointerId !== selecting?.id) return;
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        endSelection();
        if (u.type === 'pointerup' && term.hasSelection()) onSelect?.();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
      move(e);
    }
    const selectionChange = term.onSelectionChange(placeHandles);
    const render = term.onRender(placeHandles);
    const beginSelection = (p) => {
      press = null;
      if (!el.isConnected || gesture?.scrolling) return;
      gesture = null;
      stop();
      selecting = { id: p.id, anchor: cellAt(p.x, p.y), edge: 0, x: p.x, y: p.y };
      placeHandles();
      selectAt(p.x, p.y);
      if (navigator.vibrate) navigator.vibrate(10);
    };
    const dragSelection = (t) => {
      const s = selecting;
      s.x = t.clientX;
      s.y = t.clientY;
      selectAt(s.x, s.y);
      // Past the top or bottom edge, scroll a line at a time and keep extending.
      const r = screen();
      const dir = s.y < r.top ? -1 : s.y > r.bottom ? 1 : 0;
      stopEdge();
      if (dir) {
        s.edge = setInterval(() => {
          term.scrollLines(dir);
          selectAt(s.x, s.y);
        }, 80);
      }
    };
    const scroll = (g, pixels) => {
      g.remainder += pixels;
      const height = lineHeight();
      if (!(height > 0)) return false;
      const lines = Math.trunc(g.remainder / height);
      if (!lines) return true;
      g.remainder -= lines * height;
      const before = term.buffer.active.viewportY;
      term.scrollLines(lines);
      return before !== term.buffer.active.viewportY;
    };
    const start = (e) => {
      stop();
      gesture = null;
      cancelPress();
      endSelection();
      suppressClickUntil = 0;
      if (!media.matches || e.touches.length !== 1 || !e.target.closest('.xterm-screen')) return;
      const t = e.touches[0];
      press = { id: t.identifier, x: t.clientX, y: t.clientY };
      press.timer = setTimeout(() => beginSelection(press), SELECT_DELAY);
      if (term.buffer.active.type !== 'normal') return;
      gesture = { id: t.identifier, x: t.clientX, y: t.clientY, lastY: t.clientY,
        started: performance.now(), time: performance.now(), remainder: 0, velocity: 0, scrolling: false };
    };
    const move = (e) => {
      if (selecting) {
        const t = Array.from(e.touches).find((x) => x.identifier === selecting.id);
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
        if (t) dragSelection(t);
        return;
      }
      if (press) {
        const t = e.touches[0];
        if (e.touches.length !== 1 || !t || t.identifier !== press.id || Math.hypot(t.clientX - press.x, t.clientY - press.y) > 8) cancelPress();
      }
      const g = gesture;
      if (!g) return;
      if (e.touches.length !== 1 || term.buffer.active.type !== 'normal') { gesture = null; return; }
      const t = e.touches[0];
      if (t.identifier !== g.id) return;
      const now = performance.now();
      if (!g.scrolling) {
        const dx = Math.abs(t.clientX - g.x), dy = Math.abs(t.clientY - g.y);
        if (Math.max(dx, dy) < 8) return;
        if (dx > dy || now - g.started > 350) { gesture = null; return; }
        g.scrolling = true;
      }
      e.preventDefault();
      e.stopPropagation();
      const delta = g.lastY - t.clientY;
      g.velocity = delta / Math.max(8, now - g.time);
      scroll(g, delta);
      g.lastY = t.clientY;
      g.time = now;
      suppressClickUntil = now + 500;
    };
    // A tap in a program with mouse reporting on is a press and release at
    // the finger, sent through xterm so it encodes them the program's way.
    // The browser's own emulated mouse events are cancelled: iOS may drop or
    // delay them, and they must not arrive a second time.
    const reportTap = (e, p) => {
      if (term.modes.mouseTrackingMode === 'none' || !e.cancelable) return false;
      e.preventDefault();
      const target = el.querySelector('.xterm-screen');
      const init = { bubbles: true, cancelable: true, view: window, button: 0, clientX: p.x, clientY: p.y };
      target.dispatchEvent(new MouseEvent('mousedown', { ...init, buttons: 1 }));
      target.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }));
      // Still a tap on the terminal: focus it as a click would.
      target.dispatchEvent(new MouseEvent('click', { ...init, buttons: 0, detail: 1 }));
      return true;
    };
    const end = (e) => {
      const tap = press && !selecting && e.type === 'touchend' && e.touches.length === 0 &&
        Array.from(e.changedTouches).some((t) => t.identifier === press.id) && press;
      cancelPress();
      if (tap && reportTap(e, tap)) {
        gesture = null;
        return;
      }
      if (selecting) {
        // Keep the selection: no click, focus or mouse events for this touch.
        endSelection();
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
        suppressClickUntil = performance.now() + 500;
        // In the touchend itself: iOS lets the clipboard be written only there.
        if (e.type === 'touchend' && term.hasSelection()) onSelect?.();
        return;
      }
      const g = gesture;
      gesture = null;
      if (!g || !g.scrolling) return;
      e.preventDefault();
      e.stopPropagation();
      suppressClickUntil = performance.now() + 500;
      if (e.type === 'touchcancel' || performance.now() - g.time > 100) return;
      let last = performance.now();
      const coast = (now) => {
        frame = 0;
        const elapsed = Math.min(32, now - last);
        last = now;
        g.velocity *= Math.pow(0.92, elapsed / 16);
        if (!media.matches || !el.isConnected || term.buffer.active.type !== 'normal' ||
            Math.abs(g.velocity) < 0.03 || !scroll(g, g.velocity * elapsed)) return;
        frame = requestAnimationFrame(coast);
      };
      frame = requestAnimationFrame(coast);
    };
    const click = (e) => {
      if (performance.now() < suppressClickUntil) { e.preventDefault(); e.stopImmediatePropagation(); }
    };
    el.addEventListener('touchstart', start, { passive: true, capture: true });
    el.addEventListener('touchmove', move, { passive: false, capture: true });
    el.addEventListener('touchend', end, { passive: false, capture: true });
    el.addEventListener('touchcancel', end, { passive: false, capture: true });
    el.addEventListener('click', click, true);
    const input = term.onData(stop);
    const dispose = () => {
      stop();
      cancelPress();
      endSelection();
      input.dispose();
      selectionChange.dispose();
      render.dispose();
      for (const handle of handles) handle.remove();
      el.removeEventListener('touchstart', start, true);
      el.removeEventListener('touchmove', move, true);
      el.removeEventListener('touchend', end, true);
      el.removeEventListener('touchcancel', end, true);
      el.removeEventListener('click', click, true);
    };
    return dispose;
  }
  window.PhoneTerminal = { media, COLUMN_OPTIONS, DEFAULT_COLUMNS, getColumns, setColumns, fit, bindTouch };
})();
