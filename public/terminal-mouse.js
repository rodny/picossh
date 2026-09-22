// Clicks and taps on the terminal. A program that turns on mouse reporting
// gets them from xterm itself (bindTouch makes sure taps reach it). Otherwise
// a click or tap on the line being typed moves the cursor there: like xterm's
// Alt+click, it sends the left or right arrow presses that get it there. It
// also spots mouse reporting left on by a program that has ended.
(() => {
  // The buffer cell under a point, or null outside the screen.
  function cellAt(term, x, y) {
    const r = term.element.querySelector('.xterm-screen').getBoundingClientRect();
    const col = Math.floor((x - r.left) / (r.width / term.cols));
    const row = Math.floor((y - r.top) / (r.height / term.rows));
    if (col < 0 || col >= term.cols || row < 0 || row >= term.rows) return null;
    return { col, row: row + term.buffer.active.viewportY };
  }

  // Arrow presses that move the cursor to the cell, or '' when the cell is
  // not on the cursor's line (wrapped rows count as one line).
  function cursorMoves(term, cell) {
    const buf = term.buffer.active;
    if (!cell || buf.type !== 'normal' || term.modes.mouseTrackingMode !== 'none') return '';
    const cursorRow = buf.baseY + buf.cursorY;
    let first = cursorRow, last = cursorRow;
    while (first > 0 && buf.getLine(first)?.isWrapped) first--;
    while (buf.getLine(last + 1)?.isWrapped) last++;
    if (cell.row < first || cell.row > last) return '';
    const cols = term.cols;
    const at = (i) => buf.getLine(first + Math.floor(i / cols))?.getCell(i % cols);
    const from = (cursorRow - first) * cols + Math.min(buf.cursorX, cols - 1);
    // Past the end of the text, stop just after its last character.
    let end = (last - first + 1) * cols;
    while (end > 0 && !at(end - 1)?.getChars()) end--;
    const to = Math.min((cell.row - first) * cols + cell.col, Math.max(end, from));
    // One press per character: the second half of a wide one takes none.
    let presses = 0;
    for (let i = Math.min(from, to); i < Math.max(from, to); i++) if (at(i)?.getWidth()) presses++;
    const arrow = (term.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[') + (to < from ? 'D' : 'C');
    return arrow.repeat(presses);
  }

  // send(data) delivers arrow presses to the program.
  function bindCursorClick(term, send) {
    const el = term.element;
    const click = (e) => {
      if (e.button !== 0 || e.detail > 1 || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
      if (!e.target.closest('.xterm-screen') || term.hasSelection()) return;
      const moves = cursorMoves(term, cellAt(term, e.clientX, e.clientY));
      if (moves) send(moves);
    };
    el.addEventListener('click', click);
    return () => el.removeEventListener('click', click);
  }

  // Every mouse reporting mode and encoding, off.
  const MOUSE_OFF = '\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1016l';

  // Mouse reporting left on by a program that is gone (killed, or cut off
  // with its own connection) turns each tap into text at the shell prompt. A
  // program that wants the mouse never prints a report back; a shell echoes
  // it. sent(data) sees each input, received(text) the output after it, and
  // onStale runs when a press comes straight back.
  function watchStaleReports(onStale) {
    let expect = null;
    let until = 0;
    return {
      get watching() { return !!expect && Date.now() < until; },
      sent(data) {
        // SGR (1006) and urxvt (1015) presses: ESC [ <b;x;y M or ESC [ b;x;y M.
        const m = /^\x1b\[<?\d+;(\d+;\d+)M/.exec(data);
        if (!m) return;
        expect = `;${m[1]}M`;
        until = Date.now() + 2000;
      },
      received(text) {
        if (!this.watching || !text.includes(expect)) return;
        expect = null;
        onStale();
      },
    };
  }

  window.TerminalMouse = { cellAt, cursorMoves, bindCursorClick, watchStaleReports, MOUSE_OFF };
})();
