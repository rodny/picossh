// Read-only viewer for files too big for the editor (any size, 1 GB and up).
// Only the lines on screen are in the DOM and only a few MB of the file are
// in memory: bytes are fetched in chunks through load(start, length) and kept
// in a small LRU cache.
//
// Scrolling is native. The scroll height stands in for the file (capped, since
// browsers limit element heights): small moves scroll the rendered lines
// pixel by pixel and extend them as needed, while a jump (dragging the
// scrollbar) maps the scroll position to a byte offset and renders from the
// line there.
//
// Lines are split at "\n". A line longer than MAX_LINE bytes is shown in
// pieces: a piece also ends at a multiple of MAX_LINE, at least MAX_LINE bytes
// after the piece started. That rule gives the same pieces whether the file is
// read forwards or backwards, so the view never needs the whole line.
// Exposes window.LargeFile.
'use strict';
(() => {
  const CHUNK = 256 * 1024;
  const CACHE_CHUNKS = 16;
  const MAX_LINE = 8192;
  const MAX_SCROLL = 2000000; // px
  const OVERSCAN = 1; // screens rendered above and below the visible one
  const BATCH = 40; // lines read per step

  function createSource(load, size) {
    const cache = new Map(); // chunk index -> Promise<Uint8Array>, oldest first
    function chunk(i) {
      let p = cache.get(i);
      if (p) {
        cache.delete(i);
      } else {
        p = load(i * CHUNK, Math.min(CHUNK, size - i * CHUNK));
        p.catch(() => cache.delete(i));
      }
      cache.set(i, p);
      while (cache.size > CACHE_CHUNKS) cache.delete(cache.keys().next().value);
      return p;
    }
    // Bytes [start, end), clamped to the file.
    async function bytes(start, end) {
      start = Math.max(0, start);
      end = Math.min(size, end);
      if (end <= start) return new Uint8Array(0);
      const first = Math.floor(start / CHUNK);
      const last = Math.floor((end - 1) / CHUNK);
      const parts = await Promise.all(Array.from({ length: last - first + 1 }, (_, k) => chunk(first + k)));
      if (parts.length === 1) return parts[0].subarray(start - first * CHUNK, end - first * CHUNK);
      const out = new Uint8Array(end - start);
      let o = 0;
      parts.forEach((part, k) => {
        const base = (first + k) * CHUNK;
        const piece = part.subarray(Math.max(start, base) - base, Math.min(end, base + part.length) - base);
        out.set(piece, o);
        o += piece.length;
      });
      return out.subarray(0, o);
    }
    return { bytes };
  }

  // Line reading over a source. Offsets are bytes; a "line" is { start, end, text }
  // where end is the next line's start.
  function createLines(source, size) {
    const decoder = new TextDecoder('utf-8');

    // first: the piece starts a line (not the rest of a long one); nl: it ends with "\n".
    async function lineAt(start) {
      if (start >= size) return null;
      const limit = Math.min(size, Math.ceil(start / MAX_LINE) * MAX_LINE + MAX_LINE);
      const from = Math.max(0, start - 1); // one byte back, to see whether a line ends there
      const all = await source.bytes(from, limit);
      const buf = all.subarray(start - from);
      const nl = buf.indexOf(10);
      const end = nl === -1 ? start + buf.length : start + nl + 1;
      let body = buf.subarray(0, end - start);
      if (body[body.length - 1] === 10) body = body.subarray(0, -1);
      if (body[body.length - 1] === 13) body = body.subarray(0, -1);
      return { start, end, bytes: body, text: decoder.decode(body), first: start === 0 || all[0] === 10, nl: nl !== -1 };
    }

    // The start of the line before the one starting at `o` (o > 0).
    async function startBefore(o) {
      const q = Math.floor((o - 1) / MAX_LINE) * MAX_LINE;
      const lo = Math.max(0, q - MAX_LINE);
      const buf = await source.bytes(lo, o - 1);
      const nl = buf.lastIndexOf(10);
      return nl === -1 ? q : lo + nl + 1;
    }

    // The start of the line containing byte t.
    const startOf = (t) => (t <= 0 ? 0 : startBefore(Math.min(t, size - 1) + 1));

    async function forward(start, count) {
      const out = [];
      for (let at = start; out.length < count && at < size;) {
        const line = await lineAt(at);
        out.push(line);
        at = line.end;
      }
      return out;
    }

    async function backward(end, count) {
      const out = [];
      for (let at = end; out.length < count && at > 0;) {
        const start = await startBefore(at);
        out.unshift(await lineAt(start));
        at = start;
      }
      return out;
    }

    return { lineAt, startOf, forward, backward };
  }

  /**
   * options: { size, load(start, length) -> Promise<Uint8Array>, onPosition({ offset, size }), onError(err) }
   */
  function create(container, options) {
    const { size } = options;
    const source = createSource(options.load, size);
    const reader = createLines(source, size);

    const scroll = document.createElement('div');
    scroll.className = 'big-scroll';
    const spacer = document.createElement('div');
    spacer.className = 'big-spacer';
    const block = document.createElement('div');
    block.className = 'big-lines';
    spacer.appendChild(block);
    scroll.appendChild(spacer);
    container.appendChild(scroll);

    let lines = []; // rendered, in order: { start, end, text, el }
    let blockTop = 0;
    let height = 0; // spacer height
    let lineHeight = 20;
    let highlightLine = (text) => CodeEditor.escapeHtml(text);
    let matches = []; // [start, end] byte offsets, ascending
    let current = -1;
    let index = null; // line index from the server: { every, offsets, lines }
    let generation = 0; // bumped on jumps so stale async work is dropped
    let busy = false;
    let again = false;
    let destroyed = false;

    const setHeight = (px) => {
      height = Math.max(px, scroll.clientHeight);
      spacer.style.height = `${Math.round(height)}px`;
    };
    const blockHeight = () => block.offsetHeight;
    const pxFor = (offset) => (size ? (offset / size) * Math.max(0, height - scroll.clientHeight) : 0);

    function lineElement(line) {
      const el = document.createElement('div');
      el.className = 'big-line';
      paint(el, line);
      line.el = el;
      showNumber(line);
      return el;
    }

    function showNumber(line) {
      const n = line.first && line.number != null ? String(line.number) : '';
      if (line.el && line.el.dataset.n !== n) line.el.dataset.n = n;
    }

    // The number (from 1) of the line containing byte `offset`: exact from
    // the start of the file, else counted from the nearest indexed line.
    async function lineNumberAt(offset) {
      if (offset === 0) return 1;
      if (!index) return null;
      let lo = 0;
      let hi = index.offsets.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (index.offsets[mid] <= offset) lo = mid;
        else hi = mid - 1;
      }
      const from = index.offsets[lo];
      if (offset - from > 4 * CHUNK) return null; // very long lines: not worth the download
      let n = lo * index.every;
      for (let at = from; at < offset; at += CHUNK) {
        const bytes = await source.bytes(at, Math.min(offset, at + CHUNK));
        for (let i = bytes.indexOf(10); i !== -1; i = bytes.indexOf(10, i + 1)) n++;
      }
      return n + 1;
    }

    // Numbers the rendered lines outward from one whose number is known.
    async function ensureNumbers() {
      if (!lines.length) return;
      let known = lines.findIndex((l) => l.number != null);
      if (known === -1) {
        const gen = generation;
        const first = lines[0];
        const n = await lineNumberAt(first.start);
        if (gen !== generation || n == null || lines[0] !== first) return;
        first.number = n;
        known = 0;
      }
      for (let i = known + 1; i < lines.length; i++) {
        if (lines[i].number == null) lines[i].number = lines[i - 1].number + (lines[i - 1].nl ? 1 : 0);
      }
      for (let i = known - 1; i >= 0; i--) {
        if (lines[i].number == null) lines[i].number = lines[i + 1].number - (lines[i].nl ? 1 : 0);
      }
      lines.forEach(showNumber);
    }

    // Colours and match marks for one line.
    function paint(el, line) {
      el.innerHTML = highlightLine(line.text);
      let i = lowerBound(line.start);
      const ranges = [];
      for (; i < matches.length && matches[i][0] < line.end; i++) {
        const [s, e] = matches[i];
        const from = TextSearch.charIndex(line.bytes, Math.max(0, s - line.start));
        const to = TextSearch.charIndex(line.bytes, Math.min(e, line.end) - line.start);
        if (to > from) ranges.push([from, to, i === current ? 'current' : '']);
      }
      if (ranges.length) CodeEditor.markRanges(el, ranges);
    }

    // First match that ends after offset.
    function lowerBound(offset) {
      let lo = 0;
      let hi = matches.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (matches[mid][1] <= offset) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    }

    function place() {
      block.style.transform = `translateY(${blockTop}px)`;
    }

    function report() {
      if (!options.onPosition || !lines.length) return;
      const top = scroll.scrollTop;
      let y = blockTop;
      let line = lines[0];
      for (const l of lines) {
        const h = l.el.offsetHeight;
        if (y + h > top) {
          line = l;
          break;
        }
        y += h;
      }
      options.onPosition({ offset: line.start, size, line: line.number });
    }

    // Renders from the line containing `offset`, with that line at pixel `top`.
    async function jumpTo(offset, top) {
      const gen = ++generation;
      const start = await reader.startOf(offset);
      const count = Math.ceil(scroll.clientHeight / lineHeight) + BATCH;
      const fresh = await reader.forward(start, count);
      if (gen !== generation || destroyed) return false;
      block.textContent = '';
      lines = fresh;
      for (const line of lines) block.appendChild(lineElement(line));
      blockTop = top;
      place();
      return true;
    }

    // Brings the rendered block in line with the scroll position.
    async function sync() {
      const gen = generation;
      const vh = scroll.clientHeight;
      const st = scroll.scrollTop;
      if (!lines.length || st + vh < blockTop - vh * 2 || st > blockTop + blockHeight() + vh * 2) {
        const fraction = height > vh ? st / (height - vh) : 0;
        await jumpTo(Math.round(size * Math.min(1, fraction)), st);
        again = true;
        return;
      }
      // Below: append while the block ends before the wanted area.
      while (blockTop + blockHeight() < st + vh * (1 + OVERSCAN) && lines[lines.length - 1].end < size) {
        const more = await reader.forward(lines[lines.length - 1].end, BATCH);
        if (gen !== generation || destroyed) return;
        for (const line of more) block.appendChild(lineElement(line));
        lines.push(...more);
      }
      // Above: prepend, moving the block up by the height added.
      while (blockTop > st - vh * OVERSCAN && lines[0].start > 0) {
        const more = await reader.backward(lines[0].start, BATCH);
        if (gen !== generation || destroyed) return;
        const before = blockHeight();
        block.prepend(...more.map(lineElement));
        lines.unshift(...more);
        blockTop -= blockHeight() - before;
        place();
      }
      // Drop lines far outside the wanted area.
      let removedAbove = 0;
      while (lines.length > 1 && blockTop + removedAbove + lines[0].el.offsetHeight < st - vh * (OVERSCAN + 2)) {
        removedAbove += lines[0].el.offsetHeight;
        lines.shift().el.remove();
      }
      if (removedAbove) {
        blockTop += removedAbove;
        place();
      }
      while (lines.length > 1 && blockTop + blockHeight() - lines[lines.length - 1].el.offsetHeight > st + vh * (OVERSCAN + 3)) {
        lines.pop().el.remove();
      }

      // Edges: the first line belongs at pixel 0, and the scroll range must fit the block.
      if (lines[0].start === 0 && blockTop !== 0) {
        const shift = -blockTop;
        blockTop = 0;
        place();
        scroll.scrollTop = st + shift;
      } else if (lines[0].start > 0 && blockTop < vh * (OVERSCAN + 1)) {
        const shift = Math.max(vh * 4, pxFor(lines[0].start) - blockTop);
        blockTop += shift;
        place();
        if (blockTop + blockHeight() > height) setHeight(blockTop + blockHeight() + vh);
        scroll.scrollTop = st + shift;
      }
      const bottom = blockTop + blockHeight();
      if (lines[lines.length - 1].end >= size) {
        if (height !== bottom) setHeight(bottom);
      } else if (bottom + vh > height) {
        setHeight(bottom + vh * 4);
      }
      await ensureNumbers();
      report();
    }

    async function update() {
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      try {
        do {
          again = false;
          await sync();
        } while (again && !destroyed);
      } catch (err) {
        if (options.onError) options.onError(err);
      } finally {
        busy = false;
      }
    }

    // update() runs one sync at a time and repeats while scrolling continues.
    scroll.addEventListener('scroll', () => update(), { passive: true });
    const resizeObserver = new ResizeObserver(() => update());
    resizeObserver.observe(scroll);

    // First paint: estimate the scroll height from the average line length at the start.
    (async () => {
      try {
        const sample = await reader.forward(0, 200);
        if (destroyed) return;
        const probe = sample[0] ? lineElement({ ...sample[0] }) : null;
        if (probe) {
          block.appendChild(probe);
          lineHeight = probe.offsetHeight || lineHeight;
          probe.remove();
        }
        const sampled = sample.length ? sample[sample.length - 1].end : 1;
        const estimate = (size / Math.max(1, sampled)) * sample.length * lineHeight + 20;
        if (!index) setDigits((size / Math.max(1, sampled)) * sample.length);
        setHeight(Math.min(MAX_SCROLL, estimate));
        await update();
      } catch (err) {
        if (options.onError) options.onError(err);
      }
    })();

    function refresh() {
      for (const line of lines) paint(line.el, line);
    }

    function setDigits(lineCount) {
      scroll.style.setProperty('--gutter-digits', String(Math.max(2, String(Math.round(lineCount)).length)));
    }

    return {
      element: scroll,

      setLineNumbers(on) {
        scroll.classList.toggle('numbered', on);
        update();
      },

      // From the server's op=lines: { every, offsets, lines }.
      setLineIndex(value) {
        index = value;
        setDigits(value.lines);
        update();
      },

      setHighlighter(fn) {
        highlightLine = fn;
        refresh();
      },

      setTabSize(size) {
        scroll.style.setProperty('--tab-size', String(size));
        update();
      },

      setWrap(on) {
        scroll.classList.toggle('wrapped', on);
        update();
      },

      // Byte offset of the first line on screen.
      topOffset() {
        const top = scroll.scrollTop;
        let y = blockTop;
        for (const l of lines) {
          y += l.el.offsetHeight;
          if (y > top) return l.start;
        }
        return lines.length ? lines[lines.length - 1].start : 0;
      },

      // matches: ascending [start, end] byte offsets; index: the current one or -1.
      setMatches(list, index = -1) {
        matches = list;
        current = index;
        refresh();
      },

      // Scrolls so bytes [start, end) are on screen, a third of the way down.
      async reveal(start) {
        const vh = scroll.clientHeight;
        const lineStart = await reader.startOf(start);
        const shown = lines.find((l) => l.start === lineStart);
        let el = shown && shown.el;
        if (el) {
          const y = blockTop + el.offsetTop;
          if (y < scroll.scrollTop || y + el.offsetHeight > scroll.scrollTop + vh) scroll.scrollTop = y - vh / 3;
        } else {
          const top = Math.max(vh, Math.min(pxFor(lineStart), height - vh));
          if (!(await jumpTo(lineStart, top))) return;
          scroll.scrollTop = top - vh / 3;
          el = lines[0].el;
        }
        await update();
        const mark = block.querySelector('.code-match.current');
        if (mark) {
          const box = scroll.getBoundingClientRect();
          const r = mark.getBoundingClientRect();
          if (r.left < box.left || r.right > box.right) scroll.scrollLeft += r.left - box.left - box.width / 3;
        }
      },

      destroy() {
        destroyed = true;
        generation++;
        resizeObserver.disconnect();
        scroll.remove();
      },
    };
  }

  window.LargeFile = { create, CHUNK, MAX_LINE, createSource, createLines };
})();
