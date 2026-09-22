// File manager endpoints under /api/sessions/:id/sftp?op=...
// Transfers are streamed: downloads pipe an SFTP read stream into the response,
// uploads pipe the raw request body (one file per request) into a write stream.
//
// Both survive a link that drops. Downloads answer Range requests, so a
// browser can resume one. An upload goes to a hidden part file next to the
// target and replaces it only once complete, so a failed upload never costs
// the file it was replacing; a client that names its upload (`id`) can ask
// how much of it arrived (op=upload-offset) and send the rest (`offset`).
const crypto = require('crypto');
const { posix, join: localJoin } = require('path');
const { Worker } = require('worker_threads');
const { pipeline } = require('stream/promises');
const { once } = require('events');
const archiver = require('archiver');
const { HttpError } = require('./store');
const TextSearch = require('../public/text-search');
const { ENCODINGS, decodeText, encodeText, TextEncodingError } = require('./text-encoding');

// Largest file the text editor opens or saves. The browser holds it in a
// textarea and highlights it, so this stays well below "any file". Bigger
// files open in the read-only viewer, which fetches byte ranges (op=range)
// and searches on the server (op=search).
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_RANGE_BYTES = 4 * 1024 * 1024;
const SEARCH_BLOCK = 256 * 1024;
const SEARCH_READERS = 8; // parallel SFTP reads; results are still used in order
const SEARCH_LIMIT = 10000;
const SEARCH_BLOCK_TIMEOUT_MS = 10000;
const LINE_INDEX_EVERY = 1000;

const S_IFMT = 0o170000;
const typeOf = (mode) => {
  switch (mode & S_IFMT) {
    case 0o040000: return 'dir';
    case 0o120000: return 'symlink';
    case 0o100000: return 'file';
    default: return 'other';
  }
};

const call = (sftp, method, ...args) =>
  new Promise((resolve, reject) => {
    sftp[method](...args, (err, result) => (err ? reject(sftpError(err)) : resolve(result)));
  });

function sftpError(err) {
  if (err instanceof HttpError) return err;
  const status = err.code === 2 ? 404 : err.code === 3 ? 403 : 500;
  return new HttpError(status, err.message || 'SFTP error');
}

function requirePath(value, what = 'path') {
  if (typeof value !== 'string' || value === '' || value.includes('\0')) throw new HttpError(400, `Missing ${what}`);
  return value;
}

function checkName(name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[/\0]/.test(name)) {
    throw new HttpError(400, 'Invalid file name');
  }
  return name;
}

// RFC 6266 filename with an ASCII fallback for old clients.
const disposition = (name) =>
  `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;

async function list(sftp, path) {
  // SFTP's realpath does not expand ~ (the Files tab's Go to sends it as typed).
  if (/^~(\/|$)/.test(path || '')) path = posix.join(await call(sftp, 'realpath', '.'), path.slice(1) || '.');
  const real = await call(sftp, 'realpath', path || '.');
  const entries = await call(sftp, 'readdir', real);
  const items = await Promise.all(entries.map(async (e) => {
    const item = { name: e.filename, type: typeOf(e.attrs.mode), size: e.attrs.size, mtime: e.attrs.mtime, mode: e.attrs.mode & 0o7777 };
    if (item.type === 'symlink') {
      try {
        item.target = typeOf((await call(sftp, 'stat', posix.join(real, e.filename))).mode);
      } catch {
        item.target = 'broken';
      }
    }
    return item;
  }));
  const isDir = (i) => i.type === 'dir' || i.target === 'dir';
  items.sort((a, b) => (isDir(b) - isDir(a)) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return { path: real, items };
}

// The part of the file a Range header asks for: { start, end } (end
// inclusive), 'unsatisfiable', or null for the whole file. Only a single
// range; anything else is answered with the whole file, as HTTP allows.
function byteRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header || '').trim());
  if (!m || (!m[1] && !m[2])) return null;
  let start;
  let end = size - 1;
  if (m[1]) {
    start = Number(m[1]);
    if (m[2]) end = Math.min(Number(m[2]), size - 1);
  } else {
    start = Math.max(0, size - Number(m[2]));
  }
  if (!Number.isSafeInteger(start) || start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

async function download(sftp, path, req, res) {
  const stat = await call(sftp, 'stat', path);
  if (typeOf(stat.mode) === 'dir') throw new HttpError(400, 'That is a folder; download it as a zip');
  // Size and mtime: a browser resumes a download only while these match.
  const etag = `"${stat.size.toString(16)}-${stat.mtime.toString(16)}"`;
  const lastModified = new Date(stat.mtime * 1000).toUTCString();
  const ifRange = req.headers['if-range'];
  const range = !ifRange || ifRange === etag || ifRange === lastModified ? byteRange(req.headers.range, stat.size) : null;
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': disposition(posix.basename(path)),
    'Cache-Control': 'no-store',
    'Accept-Ranges': 'bytes',
    ETag: etag,
    'Last-Modified': lastModified,
  };
  if (range === 'unsatisfiable') {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}`, 'Content-Length': 0 });
    return res.end();
  }
  if (range) {
    res.writeHead(206, { ...headers, 'Content-Length': range.end - range.start + 1, 'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}` });
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  }
  if (req.method === 'HEAD') return res.end();
  await pipeline(sftp.createReadStream(path, range || {}), res).catch((err) => {
    if (!res.destroyed) res.destroy(err);
  });
}

async function zip(sftp, path, res) {
  const root = await call(sftp, 'realpath', path);
  const stat = await call(sftp, 'stat', root);
  if (typeOf(stat.mode) !== 'dir') throw new HttpError(400, 'Not a folder');
  const base = root === '/' ? 'root' : posix.basename(root);

  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': disposition(`${base}.zip`),
    'Cache-Control': 'no-store',
  });

  const archive = archiver('zip', { zlib: { level: 5 } });
  let aborted = false;
  res.on('close', () => {
    if (!res.writableFinished) {
      aborted = true;
      archive.abort();
    }
  });
  archive.on('warning', (err) => console.log(`zip ${root}: ${err.message}`));
  archive.on('error', (err) => {
    console.log(`zip ${root} failed: ${err.message}`);
    res.destroy(err);
  });
  archive.pipe(res);

  // Files are added one at a time so only one remote file handle is open.
  // Symlinks are skipped: following them could loop or escape the folder.
  async function walk(dir, rel) {
    archive.append(null, { name: `${rel}/`, type: 'directory' });
    let entries;
    try {
      entries = await call(sftp, 'readdir', dir);
    } catch (err) {
      console.log(`zip: skipping ${dir}: ${err.message}`);
      return;
    }
    for (const e of entries) {
      if (aborted) return;
      const remote = posix.join(dir, e.filename);
      const name = `${rel}/${e.filename}`;
      const type = typeOf(e.attrs.mode);
      if (type === 'dir') {
        await walk(remote, name);
      } else if (type === 'file') {
        // Archiver does not pass on a source's error (a file that cannot be
        // opened or read): unheard, it would reach the SSH connection and
        // close it, and the entry this waits for would never come.
        const source = sftp.createReadStream(remote);
        const failed = new Promise((_, reject) => source.once('error', reject));
        failed.catch(() => {});
        archive.append(source, { name, date: new Date(e.attrs.mtime * 1000), mode: e.attrs.mode & 0o7777 });
        await Promise.race([once(archive, 'entry'), failed]);
      }
    }
  }

  try {
    await walk(root, base);
    if (!aborted) await archive.finalize();
  } catch (err) {
    if (aborted) return;
    console.log(`zip ${root} failed: ${err.message}`);
    aborted = true;
    archive.abort();
    res.destroy(err);
  }
}

const uploadId = (value) => {
  if (!/^[\w-]{8,64}$/.test(value || '')) throw new HttpError(400, 'Invalid upload id');
  return value;
};
// Hidden, and named for the upload rather than the file, so it fits any name.
const partPath = (dir, id) => posix.join(requirePath(dir, 'dir'), `.picossh-upload-${id}.part`);

const statOrNull = (sftp, path) => call(sftp, 'stat', path).catch((err) => {
  if (err.status === 404) return null;
  throw err;
});

// OpenSSH's posix-rename replaces the target in one step; resolves false when
// the server does not offer it.
const posixRename = (sftp, from, to) => new Promise((resolve, reject) => {
  try {
    sftp.ext_openssh_rename(from, to, (err) => (err ? reject(sftpError(err)) : resolve(true)));
  } catch {
    resolve(false);
  }
});

// Puts a finished upload in place of the target, keeping the target's permissions.
async function replaceWith(sftp, part, target) {
  const existing = await statOrNull(sftp, target);
  if (existing && typeOf(existing.mode) === 'dir') throw new HttpError(409, 'A folder with that name already exists', { code: 'exists' });
  if (existing) await call(sftp, 'chmod', part, existing.mode & 0o7777).catch(() => {});
  if (await posixRename(sftp, part, target)) return;
  try {
    await call(sftp, 'rename', part, target);
  } catch (err) {
    // A plain SFTP rename does not replace a file. There is a moment without
    // the target here, but its new content is complete and a rename away.
    if (!existing) throw err;
    await call(sftp, 'unlink', target);
    await call(sftp, 'rename', part, target).catch((failed) => {
      // The old file is gone: the new one must not go too.
      throw new HttpError(failed.status, `Upload saved as ${posix.basename(part)} but could not be renamed: ${failed.message}`, { keepPart: true });
    });
  }
}

async function upload(sftp, url, req) {
  const q = (k) => url.searchParams.get(k);
  const dir = requirePath(q('dir'), 'dir');
  const target = posix.join(dir, checkName(q('name')));
  const resumable = q('id') !== null;
  const part = partPath(dir, resumable ? uploadId(q('id')) : crypto.randomUUID());
  const offset = resumable && q('offset') ? intParam(q('offset'), 'offset') : 0;

  const existing = await statOrNull(sftp, target);
  if (existing && typeOf(existing.mode) === 'dir') throw new HttpError(409, 'A folder with that name already exists', { code: 'exists' });
  if (resumable) {
    // An upload starts at 0 once. A second start with data already there is
    // the browser sending the same request again after its connection reset,
    // unasked (Chrome does); it resumes instead of starting over.
    const sofar = await statOrNull(sftp, part);
    if (offset ? !sofar || sofar.size !== offset : sofar && sofar.size > 0) {
      throw new HttpError(409, 'The upload cannot continue from there', { code: 'offset', offset: sofar ? sofar.size : 0 });
    }
  }

  const stream = sftp.createWriteStream(part, offset ? { flags: 'r+', start: offset } : { mode: 0o644 });
  try {
    await pipeline(req, stream);
  } catch (err) {
    // SFTP errors have a numeric status (no such folder, permission denied).
    // pipeline() destroys req on any failure, so req.destroyed does not say
    // the browser went away; its socket closing does.
    const gone = typeof err.code !== 'number' && req.socket.destroyed;
    // What arrived is kept for the client to resume; anything else is dropped.
    if (!(gone && resumable)) await call(sftp, 'unlink', part).catch(() => {});
    const status = typeof err.code === 'number' ? sftpError(err).status : gone ? 499 : 500;
    throw new HttpError(status, `Upload failed: ${err.message}`);
  }
  try {
    await replaceWith(sftp, part, target);
  } catch (err) {
    if (!err.keepPart) await call(sftp, 'unlink', part).catch(() => {});
    throw err;
  }
  return { path: target };
}

async function uploadOffset(sftp, url) {
  const sofar = await statOrNull(sftp, partPath(url.searchParams.get('dir'), uploadId(url.searchParams.get('id'))));
  return { offset: sofar ? sofar.size : 0 };
}

async function cancelUpload(sftp, body) {
  await call(sftp, 'unlink', partPath(body.dir, uploadId(body.id))).catch((err) => {
    if (err.status !== 404) throw err;
  });
  return { ok: true };
}

// Text for the editor, and the encoding (text-encoding.js) to save it back in.
// Refuses folders, big files and anything that does not look like text, so a
// binary is never mangled by being saved back.
async function readText(sftp, path) {
  const stat = await call(sftp, 'stat', path);
  if (typeOf(stat.mode) === 'dir') throw new HttpError(400, 'That is a folder', { code: 'folder' });
  if (stat.size > MAX_TEXT_BYTES) {
    throw new HttpError(413, `Too large to edit here (${Math.round(stat.size / 1024)} KB, limit ${MAX_TEXT_BYTES / 1024 / 1024} MB).`, { code: 'too-large', size: stat.size });
  }
  const buf = await call(sftp, 'readFile', path);
  let text;
  try {
    text = decodeText(buf);
  } catch (err) {
    if (!(err instanceof TextEncodingError)) throw err;
    throw new HttpError(415, err.message, { code: 'binary' });
  }
  return { path, content: text.content, encoding: text.encoding, size: buf.length, mtime: stat.mtime, mode: stat.mode & 0o7777 };
}

// Reads up to `length` bytes at `position`, fewer only at the end of the file.
async function readAt(sftp, handle, position, length) {
  const buf = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const n = await new Promise((resolve, reject) => {
      sftp.read(handle, buf, filled, length - filled, position + filled, (err, bytes) => (err ? reject(sftpError(err)) : resolve(bytes)));
    });
    if (!n) break;
    filled += n;
  }
  return buf.subarray(0, filled);
}

async function withHandle(sftp, path, fn) {
  const handle = await call(sftp, 'open', path, 'r');
  try {
    const stat = await call(sftp, 'fstat', handle);
    if (typeOf(stat.mode) === 'dir') throw new HttpError(400, 'That is a folder', { code: 'folder' });
    return await fn(handle, stat);
  } finally {
    sftp.close(handle, () => {});
  }
}

const intParam = (value, name, max = Number.MAX_SAFE_INTEGER) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0 || n > max) throw new HttpError(400, `Invalid ${name}`);
  return n;
};

// Raw bytes of part of a file, for the large-file viewer. The file's size and
// mtime come back in headers so the viewer notices when it changes.
async function range(sftp, path, url, res) {
  const start = intParam(url.searchParams.get('start'), 'start');
  const length = intParam(url.searchParams.get('length'), 'length', MAX_RANGE_BYTES);
  const { bytes, stat } = await withHandle(sftp, path, async (handle, stat) => ({
    stat,
    bytes: start < stat.size ? await readAt(sftp, handle, start, Math.min(length, stat.size - start)) : Buffer.alloc(0),
  }));
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': bytes.length,
    'Cache-Control': 'no-store',
    'X-File-Size': String(stat.size),
    'X-File-Mtime': String(stat.mtime),
  });
  res.end(bytes);
}

/**
 * Streams NDJSON about a whole file without holding it in memory. fn gets
 * { size, send(msg), closed(), blocks() }, where blocks() yields the file in
 * order as { bytes, start, last }; the blocks are read with parallel SFTP
 * requests. Stops reading when the client goes away.
 */
async function streamWholeFile(sftp, path, res, fn) {
  await withHandle(sftp, path, async (handle, stat) => {
    const size = stat.size;
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    let closed = false;
    res.on('close', () => { closed = true; });
    const reads = [];
    async function* blocks() {
      let next = 0;
      while ((reads.length || next < size) && !closed) {
        while (reads.length < SEARCH_READERS && next < size) {
          const read = readAt(sftp, handle, next, Math.min(SEARCH_BLOCK, size - next));
          read.catch(() => {}); // failures surface when awaited in order, not as unhandled rejections
          reads.push(read);
          next += SEARCH_BLOCK;
        }
        const start = next - reads.length * SEARCH_BLOCK;
        const bytes = await reads.shift();
        const last = !reads.length && next >= size;
        yield { bytes, start, last };
        if (bytes.length < SEARCH_BLOCK && !last) return; // the file shrank while reading
      }
    }
    try {
      await fn({ size, send: (msg) => { if (!closed) res.write(JSON.stringify(msg) + '\n'); }, closed: () => closed, blocks });
    } catch (err) {
      if (!closed) res.write(JSON.stringify({ t: 'error', message: err.message || 'Reading the file failed' }) + '\n');
    } finally {
      res.end();
      await Promise.allSettled(reads); // before the handle closes under them
    }
  });
}

/**
 * Searches a whole file, streaming:
 *   {"t":"matches","m":[[start,end],...]}  byte offsets, in file order
 *   {"t":"progress","scanned":n,"size":n}
 *   {"t":"done","scanned":n,"size":n,"count":n,"truncated":bool}
 *   {"t":"error","message":"..."}
 * The file is decoded in blocks cut at line ends, so matches do not span
 * lines; lines longer than a few blocks may be split.
 */
async function search(sftp, path, url, res) {
  const q = (k) => url.searchParams.get(k);
  const options = { query: q('query') || '', regex: q('regex') === '1', caseSensitive: q('case') === '1', wholeWord: q('word') === '1' };
  if (!options.query) throw new HttpError(400, 'Missing query');
  const { error } = TextSearch.compile(options);
  if (error) throw new HttpError(400, `Invalid regular expression: ${error}`, { code: 'bad-regex' });

  await streamWholeFile(sftp, path, res, async ({ size, send, blocks }) => {
    const worker = new Worker(localJoin(__dirname, 'search-worker.js'), { workerData: options });
    worker.unref();
    const scan = (buf, base, limit) => new Promise((resolve, reject) => {
      const settle = (fn, value) => {
        clearTimeout(timer);
        worker.off('message', onMessage);
        worker.off('error', onError);
        fn(value);
      };
      const onMessage = (matches) => settle(resolve, matches);
      const onError = (err) => settle(reject, err);
      const timer = setTimeout(() => onError(new Error('The search took too long; try a simpler regular expression.')), SEARCH_BLOCK_TIMEOUT_MS);
      worker.on('message', onMessage);
      worker.on('error', onError);
      const bytes = Uint8Array.prototype.slice.call(buf); // its own ArrayBuffer, moved rather than copied
      worker.postMessage({ bytes, base, limit }, [bytes.buffer]);
    });

    let count = 0;
    let scanned = 0;
    let lastProgress = Date.now();
    let carry = Buffer.alloc(0);
    try {
      for await (const { bytes, last } of blocks()) {
        const buf = carry.length ? Buffer.concat([carry, bytes]) : bytes;
        // Search whole lines only; the rest waits for the next block unless it is very long.
        let cut = last ? buf.length : buf.lastIndexOf(10) + 1;
        if (!cut && buf.length >= 4 * SEARCH_BLOCK) cut = buf.length;
        if (cut) {
          const matches = await scan(buf.subarray(0, cut), scanned, SEARCH_LIMIT - count);
          count += matches.length;
          if (matches.length) send({ t: 'matches', m: matches });
        }
        carry = Buffer.from(buf.subarray(cut));
        scanned += cut;
        if (count >= SEARCH_LIMIT) break;
        if (Date.now() - lastProgress > 300) {
          lastProgress = Date.now();
          send({ t: 'progress', scanned, size });
        }
      }
      send({ t: 'done', scanned: count >= SEARCH_LIMIT ? scanned : size, size, count, truncated: count >= SEARCH_LIMIT });
    } finally {
      worker.terminate();
    }
  });
}

/**
 * Line index for the large-file viewer's line numbers, streaming progress and
 * then {"t":"done","every":n,"offsets":[...],"lines":n,"size":n}, where
 * offsets[k] is the byte offset where line k * every (counting from 0) starts.
 */
async function lineIndex(sftp, path, res) {
  await streamWholeFile(sftp, path, res, async ({ size, send, blocks }) => {
    const offsets = [0];
    let newlines = 0;
    let lastByte = -1;
    let lastProgress = Date.now();
    for await (const { bytes, start } of blocks()) {
      for (let i = bytes.indexOf(10); i !== -1; i = bytes.indexOf(10, i + 1)) {
        newlines++;
        if (newlines % LINE_INDEX_EVERY === 0 && start + i + 1 < size) offsets.push(start + i + 1);
      }
      if (bytes.length) lastByte = bytes[bytes.length - 1];
      if (Date.now() - lastProgress > 300) {
        lastProgress = Date.now();
        send({ t: 'progress', scanned: start + bytes.length, size });
      }
    }
    // The last line has no newline unless the file ends with one (then no line follows it).
    const lines = newlines + (size && lastByte !== 10 ? 1 : 0);
    send({ t: 'done', every: LINE_INDEX_EVERY, offsets, lines, size });
  });
}

// Saves editor text, in the encoding it was read in (UTF-8 by default).
// Unless forced, refuses when the file changed on the server since it was
// opened (compared by mtime and size).
async function writeText(sftp, body) {
  const path = requirePath(body.path);
  if (typeof body.content !== 'string') throw new HttpError(400, 'Missing content');
  const encoding = body.encoding === undefined ? 'utf-8' : body.encoding;
  if (!ENCODINGS.includes(encoding)) throw new HttpError(400, 'Unknown encoding');
  let buf;
  try {
    buf = encodeText(body.content, encoding);
  } catch (err) {
    if (!(err instanceof TextEncodingError)) throw err;
    throw new HttpError(422, err.message, { code: 'encoding' });
  }
  if (buf.length > MAX_TEXT_BYTES) throw new HttpError(413, `Too large to save here (limit ${MAX_TEXT_BYTES / 1024 / 1024} MB)`, { code: 'too-large' });

  if (body.create) {
    await call(sftp, 'writeFile', path, buf, { flag: 'wx', mode: 0o644 }).catch((err) => {
      throw err.status === 500 ? new HttpError(409, 'A file or folder with that name already exists', { code: 'exists' }) : err;
    });
  } else {
    let stat = null;
    try {
      stat = await call(sftp, 'stat', path);
    } catch (err) {
      if (err.status !== 404) throw err;
    }
    if (stat && typeOf(stat.mode) === 'dir') throw new HttpError(400, 'That is a folder');
    const expected = body.expected;
    if (expected && !body.force) {
      if (!stat) throw new HttpError(409, 'The file was deleted on the server since you opened it.', { code: 'deleted' });
      if (stat.mtime !== expected.mtime || stat.size !== expected.size) {
        // A save sent again because the answer to the first was lost finds
        // its own text there already: that is not someone else's change.
        const same = stat.size === buf.length && typeOf(stat.mode) === 'file' && buf.equals(await call(sftp, 'readFile', path));
        if (same) return { path, size: stat.size, mtime: stat.mtime };
        throw new HttpError(409, 'The file changed on the server since you opened it.', { code: 'changed' });
      }
    }
    await call(sftp, 'writeFile', path, buf, { flag: 'w' });
  }
  const after = await call(sftp, 'stat', path);
  return { path, size: after.size, mtime: after.mtime };
}

async function remove(sftp, path) {
  const stat = await call(sftp, 'lstat', path);
  if (typeOf(stat.mode) === 'dir') {
    for (const e of await call(sftp, 'readdir', path)) await remove(sftp, posix.join(path, e.filename));
    await call(sftp, 'rmdir', path);
  } else {
    await call(sftp, 'unlink', path);
  }
}

// Returns a JSON-able result, or undefined when the response was streamed.
async function handle({ req, res, url, sftp, readBody }) {
  const op = url.searchParams.get('op');
  const q = (k) => url.searchParams.get(k);

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (op === 'list') return list(sftp, q('path'));
    if (op === 'download') return download(sftp, requirePath(q('path')), req, res);
    if (op === 'zip') return zip(sftp, requirePath(q('path')), res);
    if (op === 'read') return readText(sftp, requirePath(q('path')));
    if (op === 'range') return range(sftp, requirePath(q('path')), url, res);
    if (op === 'search') return search(sftp, requirePath(q('path')), url, res);
    if (op === 'lines') return lineIndex(sftp, requirePath(q('path')), res);
    if (op === 'upload-offset') return uploadOffset(sftp, url);
  }
  if (req.method === 'POST') {
    if (op === 'upload') {
      return upload(sftp, url, req).catch((err) => {
        // Otherwise Node reads the rest of the body to keep the connection,
        // and a slow phone uploads the whole file to be told no.
        if (!req.complete) res.setHeader('Connection', 'close');
        throw err;
      });
    }
    // JSON-escaped text can be twice its size, plus room for the envelope.
    const body = await readBody(op === 'write' ? MAX_TEXT_BYTES * 2 + 64 * 1024 : undefined);
    if (op === 'write') return writeText(sftp, body);
    if (op === 'upload-cancel') return cancelUpload(sftp, body);
    if (op === 'mkdir') {
      const path = requirePath(body.path);
      await call(sftp, 'mkdir', path).catch(async (err) => {
        // SFTP has no "already exists" status; servers answer a plain failure.
        if (err.status === 500 && (await call(sftp, 'lstat', path).then(() => true, () => false))) {
          throw new HttpError(409, 'A file or folder with that name already exists', { code: 'exists' });
        }
        throw err;
      });
      return { ok: true };
    }
    if (op === 'rename') {
      await call(sftp, 'rename', requirePath(body.from, 'from'), requirePath(body.to, 'to'));
      return { ok: true };
    }
    if (op === 'delete') {
      // Relative paths start at the login folder: never delete the root, the
      // login folder or anything above it, however the path is written.
      const path = posix.normalize(requirePath(body.path)).replace(/(.)\/+$/, '$1');
      if (path === '/' || path === '.' || path === '..' || path.startsWith('../')) throw new HttpError(400, 'Refusing to delete that');
      await remove(sftp, path);
      return { ok: true };
    }
  }
  throw new HttpError(400, `Unknown file operation: ${op}`);
}

module.exports = { handle, disposition, MAX_TEXT_BYTES };
