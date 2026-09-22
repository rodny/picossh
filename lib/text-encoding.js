// Text encodings the editor opens and saves back unchanged: UTF-8, UTF-16
// (what Notepad calls "Unicode" and Windows PowerShell 5.1 writes with >),
// and Windows-1252 (older Windows "ANSI" files: café, “quotes”, €). A byte
// order mark stays in the text as U+FEFF, so saving writes it back.
'use strict';

const ENCODINGS = ['utf-8', 'utf-16le', 'utf-16be', 'windows-1252'];
const SAMPLE = 8000;

// Windows-1252 bytes 0x80-0x9F; the rest match Latin-1. The five bytes it
// leaves undefined decode to the C1 control of the same number, as in browsers.
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
];
const CP1252_BYTE = new Map(CP1252_HIGH.map((code, i) => [code, 0x80 + i]));

class TextEncodingError extends Error {}

// UTF-16 without a byte order mark: mostly-ASCII text has a zero in every
// other byte, always on the same side.
function sniffUtf16(buf) {
  const pairs = Math.floor(Math.min(buf.length, SAMPLE) / 2);
  if (pairs < 2) return null;
  let even = 0;
  let odd = 0;
  for (let i = 0; i < pairs * 2; i += 2) {
    if (buf[i] === 0) even++;
    if (buf[i + 1] === 0) odd++;
  }
  if (odd >= pairs * 0.4 && even <= pairs * 0.02) return 'utf-16le';
  if (even >= pairs * 0.4 && odd <= pairs * 0.02) return 'utf-16be';
  return null;
}

// Control characters other than tab, line and page breaks and escape: rare
// in text, common in binary files.
function looksBinary(buf) {
  const sample = buf.subarray(0, SAMPLE);
  if (sample.includes(0)) return true;
  let controls = 0;
  for (const b of sample) if ((b < 0x20 && b !== 9 && b !== 10 && b !== 11 && b !== 12 && b !== 13 && b !== 27) || b === 0x7f) controls++;
  return controls > sample.length * 0.02;
}

function decodeCp1252(buf) {
  let out = '';
  for (let i = 0; i < buf.length; i += 8192) {
    const codes = Array.from(buf.subarray(i, i + 8192), (b) => (b >= 0x80 && b < 0xa0 ? CP1252_HIGH[b - 0x80] : b));
    out += String.fromCharCode(...codes);
  }
  return out;
}

function encodeCp1252(text) {
  const buf = Buffer.allocUnsafe(text.length);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const b = c < 0x80 || (c >= 0xa0 && c <= 0xff) ? c : CP1252_BYTE.get(c);
    if (b === undefined) {
      const ch = String.fromCodePoint(text.codePointAt(i));
      throw new TextEncodingError(`"${ch}" cannot be saved in this file's encoding (Windows-1252).`);
    }
    buf[i] = b;
  }
  return buf;
}

/**
 * The text in a file's bytes and the encoding it was in, trying UTF-8 first.
 * Throws TextEncodingError for anything that does not look like text.
 */
function decodeText(buf) {
  const utf16 = buf[0] === 0xff && buf[1] === 0xfe ? 'utf-16le' : buf[0] === 0xfe && buf[1] === 0xff ? 'utf-16be' : sniffUtf16(buf);
  if (utf16) {
    let content;
    try {
      content = new TextDecoder(utf16, { fatal: true, ignoreBOM: true }).decode(buf);
    } catch {
      content = null;
    }
    if (content !== null && !content.slice(0, SAMPLE).includes('\0')) return { content, encoding: utf16 };
  }
  const binary = new TextEncodingError('This looks like a binary file.');
  if (buf.subarray(0, SAMPLE).includes(0)) throw binary;
  try {
    // ignoreBOM keeps a byte order mark in the text, so saving writes it back.
    return { content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf), encoding: 'utf-8' };
  } catch {
    // Any bytes decode as Windows-1252, so only ones that look like text do.
    if (looksBinary(buf)) throw binary;
    return { content: decodeCp1252(buf), encoding: 'windows-1252' };
  }
}

// The bytes for text in one of ENCODINGS. Throws TextEncodingError for a
// character the encoding has no byte for. Half of a surrogate pair on its own
// (an emoji cut in two) has none in UTF-8 or UTF-16 either: Buffer would write
// U+FFFD in its place, or UTF-16 that no longer opens as text.
function encodeText(text, encoding = 'utf-8') {
  if (encoding !== 'windows-1252' && !text.isWellFormed()) {
    throw new TextEncodingError('The text has a broken character (half of an emoji or other symbol), which cannot be saved.');
  }
  if (encoding === 'utf-8') return Buffer.from(text, 'utf8');
  if (encoding === 'utf-16le') return Buffer.from(text, 'utf16le');
  if (encoding === 'utf-16be') return Buffer.from(text, 'utf16le').swap16();
  if (encoding === 'windows-1252') return encodeCp1252(text);
  throw new TextEncodingError(`Unknown encoding ${encoding}`);
}

module.exports = { ENCODINGS, decodeText, encodeText, TextEncodingError };
