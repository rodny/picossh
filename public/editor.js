// Text editor with syntax highlighting: a transparent native <textarea> laid
// over a <pre> that highlight.js colours. Typing, selection, undo and the iOS
// keyboard all stay native; the <pre> only draws. Both share one scroll box and
// grow to the text's size, so they never need scroll syncing.
// highlight.js is loaded on first use. Delimited files (CSV, TSV, ...) skip it
// and get one colour per column instead, like the Rainbow CSV extension.
// Find and replace (text-search.js) marks every match in the <pre>.
// Exposes window.CodeEditor.
'use strict';
(() => {
  const HLJS_BASE = '/vendor/hljs/';
  // Files this big (characters) are shown and edited without colours.
  const HIGHLIGHT_LIMIT = 400 * 1024;
  // Above this, highlighting waits until typing pauses.
  const LIVE_LIMIT = 40 * 1024;
  // Matches counted, and matches drawn at once (around the current one).
  const MATCH_LIMIT = 20000;
  const MARK_LIMIT = 4000;

  // Languages in highlight.min.js, plus ones fetched from languages/ on demand.
  const EXTRA_LANGUAGES = [
    'apache', 'awk', 'cmake', 'dart', 'dns', 'dockerfile', 'dos', 'elixir', 'erlang', 'gradle', 'groovy',
    'haskell', 'http', 'julia', 'latex', 'nginx', 'nix', 'powershell', 'properties', 'protobuf', 'puppet',
    'scala', 'scheme', 'tcl', 'twig', 'vim', 'x86asm',
  ];

  const LANGUAGE_BY_NAME = {
    dockerfile: 'dockerfile', containerfile: 'dockerfile', makefile: 'makefile', gnumakefile: 'makefile',
    'cmakelists.txt': 'cmake', 'nginx.conf': 'nginx', '.htaccess': 'apache', 'httpd.conf': 'apache',
    '.bashrc': 'bash', '.bash_profile': 'bash', '.bash_aliases': 'bash', '.bash_logout': 'bash', '.profile': 'bash',
    '.zshrc': 'bash', '.zprofile': 'bash', '.zshenv': 'bash', crontab: 'bash', '.env': 'ini', '.gitconfig': 'ini',
    '.editorconfig': 'ini', '.vimrc': 'vim', vimrc: 'vim', 'build.gradle': 'gradle', 'jenkinsfile': 'groovy',
  };
  const LANGUAGE_BY_EXT = {
    conf: 'ini', cfg: 'ini', cnf: 'ini', env: 'ini', service: 'ini', timer: 'ini', socket: 'ini', mount: 'ini',
    target: 'ini', network: 'ini', netdev: 'ini', desktop: 'ini', toml: 'ini', properties: 'properties',
    jsonc: 'json', json5: 'json', webmanifest: 'json', geojson: 'json', mjs: 'javascript', cjs: 'javascript',
    jsx: 'javascript', tsx: 'typescript', mts: 'typescript', cts: 'typescript', vue: 'xml', svelte: 'xml',
    htm: 'xml', xhtml: 'xml', plist: 'xml', svg: 'xml', ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
    bat: 'dos', cmd: 'dos', zone: 'dns', proto: 'protobuf', tf: 'ini', hcl: 'ini', txt: 'plaintext', log: 'plaintext',
    csv: 'csv', tsv: 'tsv', tab: 'tsv', psv: 'csv-pipe', pem: 'plaintext', crt: 'plaintext', key: 'plaintext', pub: 'plaintext',
  };
  const LANGUAGE_BY_SHEBANG = [
    [/\b(ba|z|k|da)?sh\b/, 'bash'], [/\bpython[\d.]*\b/, 'python'], [/\b(node|deno|bun)\b/, 'javascript'],
    [/\bperl\b/, 'perl'], [/\bruby\b/, 'ruby'], [/\bphp\b/, 'php'], [/\bpwsh\b/, 'powershell'], [/\bawk\b/, 'awk'],
  ];

  // Delimited ("rainbow") languages: columns are coloured instead of tokens.
  // The colour of column n is class rcsv-(n mod RAINBOW_COLOURS).
  const DELIMITED = {
    csv: { name: 'CSV', delimiter: ',', quoted: true },
    tsv: { name: 'TSV', delimiter: '\t', quoted: false },
    'csv-semicolon': { name: 'CSV (semicolon)', delimiter: ';', quoted: true },
    'csv-pipe': { name: 'CSV (pipe)', delimiter: '|', quoted: true },
  };
  const RAINBOW_COLOURS = 10;

  // One line's fields as [{ start, end }] (delimiters excluded). In quoted
  // dialects a field starting with " runs to its closing quote, so it may hold
  // delimiters, and "" is a literal quote; an unclosed quote runs to the end.
  function splitFields(line, delimiter, quoted = true) {
    const fields = [];
    let start = 0;
    for (let i = 0; i <= line.length; i++) {
      if (i === line.length || line[i] === delimiter) {
        fields.push({ start, end: i });
        start = i + 1;
      } else if (quoted && line[i] === '"' && i === start) {
        let j = i + 1;
        while (j < line.length && (line[j] !== '"' || line[j + 1] === '"')) j += line[j] === '"' ? 2 : 1;
        i = Math.min(j, line.length - 1); // the closing quote; the loop steps past it
      }
    }
    return fields;
  }

  // Picks the dialect whose delimiter gives every sampled line the same number
  // of fields (two or more); more fields win ties. Comma when none fits.
  function sniffDelimited(text) {
    const lines = text.split('\n', 200).filter((l) => l.trim()).slice(0, 20);
    let best = null;
    for (const [id, d] of Object.entries(DELIMITED)) {
      const counts = lines.map((l) => splitFields(l, d.delimiter, d.quoted).length);
      if (!counts.length || counts[0] < 2 || counts.some((c) => c !== counts[0])) continue;
      if (!best || counts[0] > best.count) best = { id, count: counts[0] };
    }
    return best ? best.id : 'csv';
  }

  // HTML for the highlight layer: every field wrapped in its column's colour.
  // Lines are independent (a quoted field does not continue on the next line),
  // so a stray quote cannot recolour the rest of the file.
  function highlightDelimited(text, { delimiter, quoted }) {
    const out = [];
    const lines = text.split('\n');
    for (let n = 0; n < lines.length; n++) {
      const line = lines[n];
      if (n) out.push('\n');
      if (!line) continue;
      splitFields(line, delimiter, quoted).forEach((f, i) => {
        if (i) out.push(`<span class="rcsv-sep">${escapeHtml(delimiter)}</span>`);
        out.push(`<span class="rcsv-${i % RAINBOW_COLOURS}">${escapeHtml(line.slice(f.start, f.end))}</span>`);
      });
    }
    return out.join('');
  }

  const scriptLoads = new Map();
  function loadScript(src) {
    if (!scriptLoads.has(src)) {
      scriptLoads.set(src, new Promise((resolve, reject) => {
        const el = document.createElement('script');
        el.src = src;
        el.onload = resolve;
        el.onerror = () => {
          scriptLoads.delete(src);
          reject(new Error(`Could not load ${src}`));
        };
        document.head.appendChild(el);
      }));
    }
    return scriptLoads.get(src);
  }

  const loadHljs = () => loadScript(`${HLJS_BASE}highlight.min.js`).then(() => window.hljs);

  async function ensureLanguage(name) {
    const hljs = await loadHljs();
    if (!name || name === 'plaintext' || hljs.getLanguage(name)) return !!hljs.getLanguage(name || 'plaintext');
    if (!EXTRA_LANGUAGES.includes(name)) return false;
    try {
      await loadScript(`${HLJS_BASE}languages/${name}.min.js`);
    } catch {
      return false;
    }
    return !!hljs.getLanguage(name);
  }

  // Best guess from the file name and first line; null means "detect from content".
  function languageFor(path, text) {
    const name = String(path || '').split('/').pop().toLowerCase();
    if (LANGUAGE_BY_NAME[name]) return LANGUAGE_BY_NAME[name];
    if (/^dockerfile\./.test(name)) return 'dockerfile';
    if (/nginx/.test(path || '') && name.endsWith('.conf')) return 'nginx';
    const firstLine = (text || '').slice(0, 200).split('\n')[0];
    if (firstLine.startsWith('#!')) {
      for (const [pattern, lang] of LANGUAGE_BY_SHEBANG) if (pattern.test(firstLine)) return lang;
    }
    const dot = name.lastIndexOf('.');
    if (dot > 0 || (dot === 0 && name.length > 1)) {
      const ext = name.slice(dot + 1);
      // Unknown extensions are tried as highlight.js names/aliases (yml, rs, ...).
      return LANGUAGE_BY_EXT[ext] || ext;
    }
    return null;
  }

  // The language id to use for a file: `chosen` from the picker, or detected
  // from the name and (a sample of) the text. Loads highlight.js as needed.
  async function detectLanguage(path, text, chosen = 'auto') {
    let wanted = chosen === 'auto' ? languageFor(path, text) : chosen;
    if (wanted === 'csv' && chosen === 'auto') wanted = sniffDelimited(text); // .csv files use ; | or tabs too
    if (DELIMITED[wanted]) return wanted;
    const hljs = await loadHljs();
    if (wanted && wanted !== 'plaintext' && !(await ensureLanguage(wanted))) wanted = null;
    if (!wanted) {
      wanted = 'plaintext';
      if (text.length <= 100 * 1024 && text.trim()) {
        const guess = hljs.highlightAuto(text.slice(0, 20000));
        if (guess.language && guess.relevance >= 8) wanted = guess.language;
      }
    }
    // Aliases (js, yml, sh) become the canonical id the language picker uses.
    const lang = hljs.getLanguage(wanted);
    return lang ? hljs.listLanguages().find((id) => hljs.getLanguage(id) === lang) || wanted : 'plaintext';
  }

  // A textarea keeps only LF, so text is edited with LF line ends and saved
  // with the file's own: CRLF (Windows), LF (Linux, macOS) or CR (classic Mac).
  // A file that mixes them is saved with the one most of its lines use.
  function splitLineEndings(text) {
    const counts = { lf: 0, crlf: 0, cr: 0 };
    for (const m of text.matchAll(/\r\n|\r|\n/g)) counts[m[0] === '\r\n' ? 'crlf' : m[0] === '\r' ? 'cr' : 'lf']++;
    const eol = ['lf', 'crlf', 'cr'].reduce((best, k) => (counts[k] > counts[best] ? k : best), 'lf');
    const mixed = Object.values(counts).filter(Boolean).length > 1;
    return { text: counts.crlf || counts.cr ? text.replace(/\r\n?/g, '\n') : text, eol, mixed };
  }

  const EOL = { lf: '\n', crlf: '\r\n', cr: '\r' };
  const joinLineEndings = (text, eol) => (eol === 'lf' ? text : text.replace(/\n/g, EOL[eol]));

  const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

  // Wraps each line of highlighted HTML in a block <span class="ln"> (which
  // draws its line number), closing and reopening the token spans that cross
  // a line end. Each line keeps its newline, so text offsets match the textarea.
  function htmlLines(html) {
    const out = [];
    const open = [];
    let line = '';
    let last = 0;
    for (const m of html.matchAll(/<span[^>]*>|<\/span>|\n/g)) {
      line += html.slice(last, m.index);
      last = m.index + m[0].length;
      if (m[0] === '\n') {
        out.push(`<span class="ln">${line}${'</span>'.repeat(open.length)}\n</span>`);
        line = open.join('');
      } else {
        if (m[0] === '</span>') open.pop();
        else open.push(m[0]);
        line += m[0];
      }
    }
    out.push(`<span class="ln">${line}${html.slice(last)}</span>`);
    return out.join('');
  }

  // HTML for text in a language already resolved by detectLanguage.
  function highlight(text, language) {
    if (DELIMITED[language]) return highlightDelimited(text, DELIMITED[language]);
    const hljs = window.hljs;
    if (hljs && language !== 'plaintext' && hljs.getLanguage(language)) {
      try {
        return hljs.highlight(text, { language, ignoreIllegals: true }).value;
      } catch {}
    }
    return escapeHtml(text);
  }

  /**
   * Wraps character ranges of an element's text in <mark class="code-match">,
   * splitting text nodes (and so crossing highlight spans) as needed.
   * ranges: ascending, non-overlapping [start, end, extraClass?]. Returns the
   * marks created per range.
   */
  function markRanges(root, ranges) {
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let offset = 0;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      nodes.push({ node: n, start: offset });
      offset += n.nodeValue.length;
    }
    const created = [];
    let ni = 0;
    for (const [s, e, extra] of ranges) {
      const marks = [];
      let pos = s;
      while (pos < e && ni < nodes.length) {
        const { node, start } = nodes[ni];
        const end = start + node.nodeValue.length;
        if (end <= pos) {
          ni++;
          continue;
        }
        let target = node;
        if (pos > start) target = target.splitText(pos - start);
        const stop = Math.min(e, end);
        if (stop < end) nodes[ni] = { node: target.splitText(stop - pos), start: stop };
        else ni++;
        const mark = document.createElement('mark');
        mark.className = extra ? `code-match ${extra}` : 'code-match';
        target.parentNode.insertBefore(mark, target);
        mark.appendChild(target);
        marks.push(mark);
        pos = stop;
      }
      created.push(marks);
    }
    return created;
  }

  /**
   * options: { onChange(value), onSave(), onCursor({ line, col }), keyboardOpen() -> bool }
   */
  function create(container, options = {}) {
    const scroll = document.createElement('div');
    scroll.className = 'code-scroll';
    const wrap = document.createElement('div');
    wrap.className = 'code-wrap';
    const pre = document.createElement('pre');
    pre.className = 'code-highlight';
    pre.setAttribute('aria-hidden', 'true');
    const code = document.createElement('code');
    code.className = 'hljs';
    pre.appendChild(code);
    const input = document.createElement('textarea');
    input.className = 'code-input';
    for (const [k, v] of Object.entries({ autocapitalize: 'off', autocorrect: 'off', autocomplete: 'off', spellcheck: 'false', wrap: 'off', 'aria-label': 'File contents' })) {
      input.setAttribute(k, v);
    }
    wrap.append(pre, input);
    scroll.appendChild(wrap);
    container.appendChild(scroll);

    let language = 'plaintext';
    let chosen = 'auto';
    let path = '';
    let indent = '\t';
    let indentSize = 4;
    let renderTimer = null;
    let renderToken = 0;
    let resolveToken = 0;
    let baseHtml = ''; // the highlighted text without match marks

    // options: { query, regex, caseSensitive, wholeWord }; matches: [start, end] pairs.
    const emptySearch = () => ({ options: null, re: null, error: null, matches: [], index: -1, truncated: false });
    let search = emptySearch();
    let markWindow = null; // { from, to, marks[] } for the matches drawn
    const drawn = () => !wrap.classList.contains('stale');

    function render() {
      clearTimeout(renderTimer);
      const text = input.value;
      const token = ++renderToken;
      const html = text.length <= HIGHLIGHT_LIMIT ? highlight(text, language) : escapeHtml(text);
      if (token !== renderToken) return;
      // One block per line: an empty last line (after a trailing newline) still
      // takes a line, as it does in the textarea.
      baseHtml = htmlLines(html);
      code.innerHTML = baseHtml;
      wrap.dataset.language = language;
      wrap.style.setProperty('--gutter-digits', String(Math.max(2, String(code.childElementCount).length)));
      markWindow = null;
      wrap.classList.remove('stale');
      drawMarks();
    }

    function scheduleRender() {
      if (input.value.length <= LIVE_LIMIT) return render();
      // Show the textarea's own text until the colours catch up.
      wrap.classList.add('stale');
      clearTimeout(renderTimer);
      renderTimer = setTimeout(render, 250);
    }

    // Marks up to MARK_LIMIT matches around the current one.
    function drawMarks() {
      if (!drawn()) return;
      const { matches, index } = search;
      if (markWindow) {
        code.innerHTML = baseHtml;
        markWindow = null;
      }
      if (!matches.length) return;
      const from = Math.max(0, Math.min(Math.max(index, 0) - MARK_LIMIT / 2, matches.length - MARK_LIMIT));
      const to = Math.min(matches.length, from + MARK_LIMIT);
      const ranges = matches.slice(from, to).map(([s, e], i) => [s, e, from + i === index ? 'current' : '']);
      markWindow = { from, to, marks: markRanges(code, ranges) };
    }

    // Moves the "current" highlight without redrawing every mark when it can.
    function setCurrent(index) {
      const previous = search.index;
      search.index = index;
      if (!drawn()) return;
      const w = markWindow;
      if (!w || index < w.from || index >= w.to) return drawMarks();
      const toggle = (i, on) => {
        if (i < w.from || i >= w.to) return;
        for (const m of w.marks[i - w.from]) m.classList.toggle('current', on);
      };
      toggle(previous, false);
      toggle(index, true);
    }

    function computeMatches(keep = 'position') {
      const { options: o } = search;
      const previous = search.matches[search.index];
      const { re, error } = o ? TextSearch.compile(o) : {};
      search.re = re || null;
      search.error = error || null;
      const found = re ? TextSearch.findAll(input.value, re, { limit: MATCH_LIMIT + 1 }) : [];
      search.truncated = found.length > MATCH_LIMIT;
      search.matches = found.slice(0, MATCH_LIMIT);
      search.index = -1;
      if (!search.matches.length) return;
      // After an edit keep the same match (or the next one) current; for a new
      // query, the first match at or after the selection, like VS Code.
      const from = keep === 'position' && previous ? previous[0] : input.selectionStart;
      const i = search.matches.findIndex(([s]) => s >= from);
      search.index = i === -1 ? 0 : i;
    }

    function state() {
      return { count: search.matches.length, index: search.index, error: search.error, truncated: search.truncated };
    }

    function selectMatch(index) {
      setCurrent(index);
      const m = search.matches[index];
      if (!m) return;
      input.setSelectionRange(m[0], m[1]);
      revealOffset(m[0]);
      cursor();
    }

    function cursor() {
      if (!options.onCursor) return;
      const before = input.value.slice(0, input.selectionStart);
      const line = before.split('\n').length;
      options.onCursor({ line, col: before.length - before.lastIndexOf('\n') });
    }

    function insertText(text) {
      input.focus({ preventScroll: true });
      // execCommand keeps the insertion on the native undo stack.
      const ok = document.queryCommandSupported && document.queryCommandSupported('insertText') && document.execCommand('insertText', false, text);
      if (!ok) {
        input.setRangeText(text, input.selectionStart, input.selectionEnd, 'end');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }

    // Replaces [start, end) as one undoable edit, then gives focus back to
    // whatever had it (the replace field).
    function replaceRange(start, end, text) {
      const active = document.activeElement;
      input.focus({ preventScroll: true });
      input.setSelectionRange(start, end);
      insertText(text);
      if (active && active !== input && active !== document.body && active.focus) active.focus({ preventScroll: true });
    }

    // Screen rectangles for a character range, measured on the highlighted copy.
    function rangeRects(start, end) {
      const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      let offset = 0;
      let startSet = false;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const len = node.nodeValue.length;
        if (!startSet && start <= offset + len) {
          range.setStart(node, start - offset);
          startSet = true;
        }
        if (startSet && end <= offset + len) {
          range.setEnd(node, end - offset);
          return [...range.getClientRects()].filter((r) => r.width || r.height);
        }
        offset += len;
      }
      return [];
    }

    function revealOffset(offset) {
      if (!drawn()) render();
      const rect = rangeRects(offset, Math.min(offset + 1, input.value.length))[0];
      if (!rect) return;
      const box = scroll.getBoundingClientRect();
      const margin = 40;
      if (rect.top < box.top + margin || rect.bottom > box.bottom - margin) {
        scroll.scrollTop += rect.top - box.top - box.height / 3;
      }
      if (rect.left < box.left || rect.right > box.right) {
        scroll.scrollLeft += rect.left - box.left - box.width / 3;
      }
    }

    input.addEventListener('input', () => {
      if (search.options) computeMatches('position');
      scheduleRender();
      cursor();
      if (options.onChange) options.onChange(input.value);
    });
    for (const type of ['keyup', 'click', 'select']) input.addEventListener(type, cursor);
    // A tap (not a selection) on read-only text, for following links.
    input.addEventListener('click', () => {
      if (input.readOnly && options.onReadOnlyTap && input.selectionStart === input.selectionEnd) options.onReadOnlyTap(input.selectionStart);
    });
    document.addEventListener('selectionchange', () => { if (document.activeElement === input) cursor(); });
    input.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (options.onSave) options.onSave();
      } else if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey && !input.readOnly) {
        e.preventDefault();
        if (e.shiftKey) outdent();
        else insertText(indent);
      }
    });

    // iOS opens the keyboard for a focus() inside a tap, but not when the
    // field already had focus (it keeps it after the keyboard is dismissed, and
    // gets it from a tap while read-only), and blurring and focusing the same
    // field again is not always taken as a move either. Passing focus through
    // another field first is: the keyboard opens for it and follows focus on.
    let proxy = null;
    function refocus() {
      const [start, end] = [input.selectionStart, input.selectionEnd];
      const active = document.activeElement;
      if (active && active !== document.body && active.blur) active.blur();
      if (!proxy) {
        proxy = document.createElement('input');
        proxy.className = 'code-focus-proxy';
        for (const [k, v] of Object.entries({ type: 'text', tabindex: '-1', 'aria-hidden': 'true', autocomplete: 'off', autocorrect: 'off' })) proxy.setAttribute(k, v);
        document.body.appendChild(proxy);
      }
      proxy.focus({ preventScroll: true });
      input.focus({ preventScroll: true });
      input.setSelectionRange(start, end);
    }

    let focusedAtTouch = false;
    input.addEventListener('touchstart', () => { focusedAtTouch = document.activeElement === input; }, { passive: true });
    input.addEventListener('click', () => {
      if (!focusedAtTouch || input.readOnly || !options.keyboardOpen || options.keyboardOpen()) return;
      focusedAtTouch = false;
      refocus();
    });

    function outdent() {
      const value = input.value;
      const lineStart = value.lastIndexOf('\n', input.selectionStart - 1) + 1;
      const line = value.slice(lineStart);
      const remove = line.startsWith('\t') ? 1 : (line.match(new RegExp(`^ {1,${indentSize}}`)) || [''])[0].length;
      if (!remove) return;
      const pos = input.selectionStart;
      input.focus();
      input.setSelectionRange(lineStart, lineStart + remove);
      insertText('');
      const back = Math.max(lineStart, pos - remove);
      input.setSelectionRange(back, back);
    }

    return {
      input,
      get language() { return language; },
      get chosenLanguage() { return chosen; },

      async setValue(text, { path: filePath = '', language: lang = 'auto' } = {}) {
        path = filePath;
        chosen = lang;
        input.value = text;
        input.setSelectionRange(0, 0); // browsers leave the caret at the end
        search = emptySearch();
        scroll.scrollTop = 0;
        scroll.scrollLeft = 0;
        render(); // plain text right away, colours once highlight.js is ready
        await this.setLanguage(lang);
      },

      getValue: () => input.value,

      async setLanguage(lang) {
        chosen = lang || 'auto';
        const token = ++resolveToken; // a newer file or choice wins
        const detected = await detectLanguage(path, input.value, chosen);
        if (token !== resolveToken) return;
        language = detected;
        render();
      },

      languages: listLanguages,

      setReadOnly(readOnly) {
        input.readOnly = readOnly;
        wrap.classList.toggle('readonly', readOnly);
      },

      setLineNumbers(on) {
        wrap.classList.toggle('numbered', on);
      },

      setWrap(on) {
        wrap.classList.toggle('wrapped', on);
        input.setAttribute('wrap', on ? 'soft' : 'off');
      },

      // From a tap (buttons do not take focus on iOS): focuses the text with
      // the keyboard, even if a tap on the read-only text already focused it
      // or another field (a hidden terminal's) has focus.
      focus: refocus,
      insertIndent: () => insertText(indent),

      // Tab and the indent button insert a tab or `size` spaces; tabs are drawn `size` wide.
      setIndent({ tabs = true, size = 4 } = {}) {
        indentSize = size;
        indent = tabs ? '\t' : ' '.repeat(size);
        wrap.style.setProperty('--tab-size', String(size));
      },
      outdent,

      // The selected text, when it is short and on one line (to seed Find).
      selectedText() {
        const text = input.value.slice(input.selectionStart, input.selectionEnd);
        return text && text.length <= 200 && !text.includes('\n') ? text : '';
      },

      hasSelection: () => input.selectionEnd > input.selectionStart,

      // Puts the caret at `offset` and scrolls its line to the top.
      scrollToOffset(offset) {
        if (!drawn()) render();
        input.setSelectionRange(offset, offset);
        const rect = rangeRects(offset, Math.min(offset + 1, input.value.length))[0];
        if (rect) scroll.scrollTop += rect.top - scroll.getBoundingClientRect().top - 8;
        cursor();
      },

      /**
       * Sets the query ({ query, regex, caseSensitive, wholeWord })
       * and marks its matches. With select, the current match is selected and
       * scrolled to. Returns { count, index, error, truncated }.
       */
      setSearch(o, { select = true } = {}) {
        search.options = { query: o.query, regex: !!o.regex, caseSensitive: !!o.caseSensitive, wholeWord: !!o.wholeWord };
        computeMatches('selection');
        drawMarks();
        if (select && search.index >= 0) selectMatch(search.index);
        return state();
      },

      // Moves to the next (dir 1) or previous (dir -1) match, wrapping.
      findNext(dir = 1) {
        const { matches } = search;
        if (!matches.length) return state();
        let index;
        const current = matches[search.index];
        if (current && input.selectionStart === current[0] && input.selectionEnd === current[1]) {
          index = (search.index + dir + matches.length) % matches.length;
        } else {
          // The caret moved since: continue from where it is now.
          const from = dir > 0 ? input.selectionEnd : input.selectionStart;
          index = dir > 0 ? matches.findIndex(([s]) => s >= from) : matches.findLastIndex(([s]) => s < from);
          if (index === -1) index = dir > 0 ? 0 : matches.length - 1;
        }
        selectMatch(index);
        return state();
      },

      // Replaces the current match if it is selected, else selects it first.
      replaceOne(replacement, { preserveCase = false } = {}) {
        const m = search.matches[search.index];
        if (input.readOnly || !m) return state();
        if (input.selectionStart !== m[0] || input.selectionEnd !== m[1]) {
          selectMatch(search.index);
          return state();
        }
        const exec = TextSearch.matchAt(input.value, search.re, m[0]);
        const text = exec ? TextSearch.expand(exec, replacement, { regex: search.options.regex, preserve: preserveCase, input: input.value }) : replacement;
        replaceRange(m[0], m[1], text);
        const after = m[0] + text.length;
        const next = search.matches.findIndex(([s]) => s >= after);
        if (search.matches.length) selectMatch(next === -1 ? 0 : next);
        return state();
      },

      // Replaces every match as one undoable edit; returns how many.
      replaceAll(replacement, { preserveCase = false } = {}) {
        if (input.readOnly || !search.re) return 0;
        const value = input.value;
        const all = TextSearch.findAll(value, search.re);
        if (!all.length) return 0;
        const first = all[0][0];
        const last = all[all.length - 1][1];
        let out = '';
        let pos = first;
        for (const [s, e] of all) {
          const exec = TextSearch.matchAt(value, search.re, s);
          out += value.slice(pos, s) + (exec ? TextSearch.expand(exec, replacement, { regex: search.options.regex, preserve: preserveCase, input: value }) : replacement);
          pos = e;
        }
        replaceRange(first, last, out);
        return all.length;
      },

      searchState: state,

      clearFind() {
        search = emptySearch();
        drawMarks();
      },
    };
  }

  async function listLanguages() {
    const hljs = await loadHljs();
    const names = new Set([...hljs.listLanguages(), ...EXTRA_LANGUAGES, ...Object.keys(DELIMITED)]);
    return [...names].sort().map((id) => ({ id, name: DELIMITED[id] ? DELIMITED[id].name : (hljs.getLanguage(id) && hljs.getLanguage(id).name) || id }));
  }

  window.CodeEditor = {
    create, languageFor, detectLanguage, listLanguages, loadHljs, highlight, htmlLines, markRanges, escapeHtml,
    HIGHLIGHT_LIMIT, splitLineEndings, joinLineEndings, splitFields, sniffDelimited, highlightDelimited, DELIMITED,
  };
})();
