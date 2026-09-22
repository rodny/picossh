// Links in Markdown text, for following them from the read-only editor:
// which link (if any) is at a text offset, where a heading's #anchor is, and
// where a link points (a web address, an anchor, or a file on the server).
// Exposes window.MarkdownLinks.
'use strict';
(() => {
  const FENCE = /^ {0,3}(`{3,}|~{3,})/;

  // Link text: brackets may nest one level, as in [![badge](img.svg)](url).
  const TEXT = String.raw`(?:[^\[\]\n]|\[[^\[\]\n]*\])*`;
  // A destination: <anything>, or text whose parentheses balance (one level).
  const DEST = String.raw`<[^<>\n]*>|[^\s()<>]*(?:\([^\s()]*\)[^\s()<>]*)*`;
  const TITLE = String.raw`(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?`;
  const INLINE = new RegExp(String.raw`!?\[${TEXT}\]\(\s*(${DEST})${TITLE}\s*\)`, 'g');
  const REFERENCE = new RegExp(String.raw`!?\[(${TEXT})\](?:\[([^\[\]\n]*)\])?`, 'g');
  const DEFINITION = /^ {0,3}\[([^\[\]\n]+)\]:[ \t]*(<[^<>\n]*>|\S+)/;
  const AUTOLINK = /<((?:[a-z][a-z0-9+.-]{1,31}:|mailto:)[^\s<>]+)>/gi;
  const BARE_URL = /\bhttps?:\/\/[^\s<>()]+(?:\([^\s<>()]*\)[^\s<>()]*)*/gi;
  const HTML_HREF = /<a\s[^>]*?href\s*=\s*("([^"]*)"|'([^']*)')[^>]*>/gi;

  const unwrap = (dest) => (dest.startsWith('<') && dest.endsWith('>') ? dest.slice(1, -1) : dest).trim();
  const normalizeLabel = (label) => label.trim().replace(/\s+/g, ' ').toLowerCase();

  // For each line: its start offset and whether it is inside a fenced code block.
  function lines(text) {
    const out = [];
    let fence = null;
    let start = 0;
    for (const line of text.split('\n')) {
      const m = line.match(FENCE);
      let code = !!fence;
      if (m && !fence) {
        fence = m[1];
        code = true;
      } else if (m && fence && m[1][0] === fence[0] && m[1].length >= fence.length && !line.slice(m[0].length).trim()) {
        fence = null;
      }
      out.push({ text: line, start, code });
      start += line.length + 1;
    }
    return out;
  }

  // Reference definitions ([label]: target) by normalized label; the first wins.
  function definitions(all) {
    const defs = new Map();
    for (const line of all) {
      if (line.code) continue;
      const m = line.text.match(DEFINITION);
      if (m && !defs.has(normalizeLabel(m[1]))) defs.set(normalizeLabel(m[1]), unwrap(m[2]));
    }
    return defs;
  }

  // Ranges [start, end) of inline code spans on a line, where links do not count.
  function codeSpans(line) {
    const spans = [];
    for (const m of line.matchAll(/(`+)[^`]*?\1/g)) spans.push([m.index, m.index + m[0].length]);
    return spans;
  }

  /**
   * The link target at `offset` in Markdown `text`, or null. Knows inline
   * links and images, reference links (full, collapsed and shortcut) and their
   * definitions, <autolinks>, bare http(s) URLs and HTML <a href>.
   */
  function linkAt(text, offset) {
    const all = lines(text);
    const line = all.find((l) => offset >= l.start && offset <= l.start + l.text.length);
    if (!line || line.code) return null;
    const col = offset - line.start;
    const inCode = codeSpans(line.text).some(([s, e]) => col >= s && col < e);
    if (inCode) return null;
    const hit = (m) => col >= m.index && col < m.index + m[0].length;

    const def = line.text.match(DEFINITION);
    if (def && col < def[0].length) return unwrap(def[2]) || null;

    // Inline links go first: [a](b) would also read as a shortcut reference [a].
    const taken = [];
    for (const m of line.text.matchAll(INLINE)) {
      taken.push([m.index, m.index + m[0].length]);
      if (hit(m)) return unwrap(m[1]) || null;
    }
    const free = (m) => !taken.some(([s, e]) => m.index < e && m.index + m[0].length > s);
    for (const re of [HTML_HREF, AUTOLINK]) {
      for (const m of line.text.matchAll(re)) {
        taken.push([m.index, m.index + m[0].length]);
        if (hit(m)) return (re === HTML_HREF ? (m[2] ?? m[3]) : m[1]).trim() || null;
      }
    }
    let defs = null;
    for (const m of line.text.matchAll(REFERENCE)) {
      if (!hit(m) || !free(m)) continue;
      defs = defs || definitions(all);
      const target = defs.get(normalizeLabel(m[2] || m[1]));
      if (target) return target;
    }
    for (const m of line.text.matchAll(BARE_URL)) {
      if (!hit(m) || !free(m)) continue;
      return m[0].replace(/[.,;:!?'"*_~]+$/, '');
    }
    return null;
  }

  // GitHub's anchor for a heading: lower case, punctuation dropped, spaces to dashes.
  function slug(heading) {
    return heading
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // links and images: their text
      .replace(/<[^>]+>/g, '')
      .replace(/[`*~]/g, '')
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
      .replace(/ /g, '-');
  }

  /**
   * Anchors in `text` as a Map from name to offset: headings (ATX and setext,
   * numbered -1, -2... when repeated, like GitHub) and HTML id/name attributes.
   */
  function anchors(text) {
    const found = new Map();
    const seen = new Map();
    const add = (name, offset) => {
      if (!found.has(name)) found.set(name, offset);
    };
    const heading = (title, offset) => {
      const base = slug(title);
      const n = seen.get(base) || 0;
      seen.set(base, n + 1);
      add(n ? `${base}-${n}` : base, offset);
    };
    const all = lines(text);
    all.forEach((line, i) => {
      if (line.code) return;
      const atx = line.text.match(/^ {0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/);
      const next = all[i + 1];
      if (atx) heading(atx[1] || '', line.start);
      else if (line.text.trim() && next && !next.code && /^ {0,3}(=+|-+)[ \t]*$/.test(next.text) && !/^ {0,3}([-*+]|\d+[.)])[ \t]/.test(line.text)) heading(line.text, line.start);
      for (const m of line.text.matchAll(/<[a-z][^>]*?\s(?:id|name)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) add(m[1] ?? m[2], line.start + m.index);
    });
    return found;
  }

  function decode(s) {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  }

  // Joins `rel` onto the absolute directory `dir`, resolving . and ..
  function resolvePath(dir, rel) {
    const parts = rel.startsWith('/') ? [] : dir.split('/').filter(Boolean);
    for (const part of rel.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') parts.pop();
      else parts.push(part);
    }
    return '/' + parts.join('/');
  }

  /**
   * Where `href`, found in the file at `filePath`, points:
   *   { kind: 'anchor', anchor }            a heading in the same file
   *   { kind: 'file', path, anchor, dir }   a file (or folder, `dir` when it ends in /) on the server
   *   { kind: 'url', url }                  a web or mail address
   *   null                                  nothing to follow (other schemes, empty)
   */
  function resolve(href, filePath) {
    href = (href || '').trim();
    if (!href) return null;
    const scheme = href.match(/^([a-z][a-z0-9+.-]*):/i);
    if (scheme) {
      const name = scheme[1].toLowerCase();
      if (name === 'file') return resolve(href.replace(/^file:\/\/(localhost)?/i, ''), filePath);
      return ['http', 'https', 'mailto', 'ftp'].includes(name) ? { kind: 'url', url: href } : null;
    }
    if (href.startsWith('//')) return { kind: 'url', url: `https:${href}` };
    const hash = href.indexOf('#');
    const anchor = hash === -1 ? '' : decode(href.slice(hash + 1));
    const target = decode((hash === -1 ? href : href.slice(0, hash)).replace(/\?.*$/, ''));
    if (!target) return anchor ? { kind: 'anchor', anchor } : null;
    const dir = filePath.replace(/\/[^/]*$/, '') || '/';
    return { kind: 'file', path: resolvePath(dir, target), anchor, dir: target.endsWith('/') };
  }

  // The offset to show for `anchor` in `text`, or -1. Matches GitHub's anchors
  // first, then ignores case (links are often written by hand).
  function anchorOffset(text, anchor) {
    const all = anchors(text);
    if (all.has(anchor)) return all.get(anchor);
    const wanted = anchor.toLowerCase();
    for (const [name, offset] of all) if (name.toLowerCase() === wanted) return offset;
    return -1;
  }

  window.MarkdownLinks = { linkAt, slug, anchors, anchorOffset, resolve, resolvePath };
})();
