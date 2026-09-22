// Find/replace rules shared by the editor (browser) and the large-file search
// (lib/sftp.js), modelled on VS Code: match case, whole word, regular
// expressions, and replacement patterns ($1, $&, $<name>, \n, \u...) with
// optional case preservation.
'use strict';
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TextSearch = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /**
   * options: { query, regex, caseSensitive, wholeWord }
   * Returns { re } (a global, multiline RegExp) or { error } for an invalid
   * pattern, or {} for an empty query.
   */
  function compile({ query = '', regex = false, caseSensitive = false, wholeWord = false } = {}) {
    if (!query) return {};
    let source = regex ? query : escapeRegExp(query);
    // Not preceded or followed by a word character (accented Latin letters
    // count), which unlike \b also works when the query starts with a symbol.
    if (wholeWord) source = `(?<![A-Za-z0-9_\\u00C0-\\u024F])(?:${source})(?![A-Za-z0-9_\\u00C0-\\u024F])`;
    try {
      return { re: new RegExp(source, `gm${caseSensitive ? '' : 'i'}`) };
    } catch (err) {
      return { error: String(err.message || err).replace(/^Invalid regular expression: \/.*\/[a-z]*: /, '') };
    }
  }

  /**
   * Matches of re in text as [start, end] pairs, skipping empty matches.
   * { from, to } limit the range searched; limit caps the count.
   */
  function findAll(text, re, { from = 0, to = text.length, limit = Infinity } = {}) {
    const out = [];
    if (!re) return out;
    re.lastIndex = from;
    for (let m = re.exec(text); m && out.length < limit; m = re.exec(text)) {
      if (m.index >= to) break;
      if (m[0].length === 0) {
        re.lastIndex = m.index + 1;
        continue;
      }
      if (m.index + m[0].length > to) break;
      out.push([m.index, m.index + m[0].length]);
    }
    return out;
  }

  // The match exec() result at exactly `start`, so a replacement can use its groups.
  function matchAt(text, re, start) {
    const sticky = new RegExp(re.source, re.flags.replace('g', '') + 'y');
    sticky.lastIndex = start;
    return sticky.exec(text);
  }

  // Applies VS Code's \u \l (next char) and \U \L (until \E) case operators.
  function applyCaseOps(parts) {
    let out = '';
    let next = null;
    let mode = null;
    for (const part of parts) {
      if (part.op) {
        if (part.op === 'E') mode = null;
        else if (part.op === 'U' || part.op === 'L') mode = part.op;
        else next = part.op;
        continue;
      }
      let s = part.text;
      if (!s) continue;
      if (mode === 'U') s = s.toUpperCase();
      else if (mode === 'L') s = s.toLowerCase();
      if (next) {
        s = (next === 'u' ? s[0].toUpperCase() : s[0].toLowerCase()) + s.slice(1);
        next = null;
      }
      out += s;
    }
    return out;
  }

  // "foo" -> "BAR" when the match was "FOO", "Bar" when it was "Foo".
  function preserveCase(match, replacement) {
    if (!match || !replacement) return replacement;
    const letters = match.replace(/[^\p{L}]/gu, '');
    if (!letters) return replacement;
    if (letters === letters.toUpperCase() && letters !== letters.toLowerCase()) return replacement.toUpperCase();
    if (letters === letters.toLowerCase()) return replacement.toLowerCase();
    const first = match.match(/\p{L}/u)[0];
    const rest = letters.slice(1);
    if (first === first.toUpperCase() && rest === rest.toLowerCase()) {
      return replacement[0].toUpperCase() + replacement.slice(1).toLowerCase();
    }
    return replacement;
  }

  /**
   * The text to put in place of `m` (an exec() result from matchAt). In regex
   * mode the replacement understands $$ $& $0 $` $' $1..$99 $<name>, \n \t \\ and
   * the case operators \u \l \U \L \E. Plain mode inserts it literally.
   */
  function expand(m, replacement, { regex = false, preserve = false, input = '' } = {}) {
    let result;
    if (!regex) {
      result = replacement;
    } else {
      const parts = [];
      let text = '';
      const flush = () => { if (text) parts.push({ text }); text = ''; };
      for (let i = 0; i < replacement.length; i++) {
        const c = replacement[i];
        const d = replacement[i + 1];
        if (c === '\\' && d !== undefined) {
          if (d === 'n') text += '\n';
          else if (d === 't') text += '\t';
          else if (d === '\\') text += '\\';
          else if ('ulULE'.includes(d)) {
            flush();
            parts.push({ op: d });
          } else {
            text += c + d;
          }
          i++;
        } else if (c === '$' && d !== undefined) {
          const piece = { '&': () => m[0], '`': () => input.slice(0, m.index), "'": () => input.slice(m.index + m[0].length) }[d];
          if (d === '$') {
            text += '$';
            i++;
          } else if (piece) {
            flush();
            parts.push({ text: piece() });
            i++;
          } else if (d === '<' && m.groups) {
            const close = replacement.indexOf('>', i + 2);
            if (close === -1) { text += c; continue; }
            flush();
            parts.push({ text: m.groups[replacement.slice(i + 2, close)] || '' });
            i = close;
          } else if (/\d/.test(d)) {
            // Two digits when that group exists ($10), else one ($1 then "0").
            const two = replacement.slice(i + 1, i + 3);
            const group = (n, width) => {
              flush();
              parts.push({ text: m[n] || '' });
              i += width;
            };
            if (/^\d\d$/.test(two) && Number(two) > 0 && Number(two) < m.length) group(Number(two), 2);
            else if (Number(d) < m.length) group(Number(d), 1); // $0 is the whole match
            else text += c;
          } else {
            text += c;
          }
        } else {
          text += c;
        }
      }
      flush();
      result = applyCaseOps(parts);
    }
    return preserve ? preserveCase(m[0], result) : result;
  }

  /**
   * The next character of UTF-8 `bytes` at byte `b`, as TextDecoder reads it:
   * [bytes it takes, UTF-16 units it decodes to]. An invalid sequence decodes
   * to one U+FFFD per maximal bad subpart, so a Latin-1 "é" (0xE9) is one
   * byte and one unit, like any other invalid byte.
   */
  function utf8Step(bytes, b) {
    const lead = bytes[b];
    if (lead < 0x80) return [1, 1];
    let need;
    let lower = 0x80;
    let upper = 0xbf;
    if (lead >= 0xc2 && lead <= 0xdf) need = 1;
    else if (lead >= 0xe0 && lead <= 0xef) {
      need = 2;
      if (lead === 0xe0) lower = 0xa0;
      if (lead === 0xed) upper = 0x9f;
    } else if (lead >= 0xf0 && lead <= 0xf4) {
      need = 3;
      if (lead === 0xf0) lower = 0x90;
      if (lead === 0xf4) upper = 0x8f;
    } else return [1, 1];
    for (let i = 1; i <= need; i++) {
      const c = bytes[b + i];
      if (c === undefined || c < lower || c > upper) return [i, 1];
      lower = 0x80;
      upper = 0xbf;
    }
    return [need + 1, need === 3 ? 2 : 1];
  }

  // Byte offsets in UTF-8 `bytes` for ascending UTF-16 indices into its decoded text.
  function byteOffsets(bytes, indices) {
    const out = [];
    let unit = 0;
    let b = 0;
    for (const target of indices) {
      while (unit < target && b < bytes.length) {
        const [size, units] = utf8Step(bytes, b);
        b += size;
        unit += units;
      }
      out.push(Math.min(b, bytes.length));
    }
    return out;
  }

  // The UTF-16 index in the decoded text of byte `offset` into UTF-8 `bytes`.
  function charIndex(bytes, offset) {
    let unit = 0;
    for (let b = 0; b < offset && b < bytes.length;) {
      const [size, units] = utf8Step(bytes, b);
      b += size;
      unit += units;
    }
    return unit;
  }

  return { compile, findAll, matchAt, expand, preserveCase, escapeRegExp, byteOffsets, charIndex };
});
