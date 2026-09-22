// Serves public/ and a few vendor files straight from node_modules (no build step).
// Text files go out gzipped to clients that take it (about a quarter of the
// size: the first load on a slow link is mostly xterm.js), compressed once and
// kept until the file changes.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

// Where a dependency is installed: next to the app from a checkout, but
// hoisted to a parent node_modules when installed with npm or run with npx.
function packageDir(name) {
  for (const dir of require.resolve.paths(name) || []) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
  }
  return path.join(ROOT, 'node_modules', name);
}

const XTERM = packageDir('@xterm/xterm');
const VENDOR = {
  '/vendor/xterm.js': path.join(XTERM, 'lib/xterm.js'),
  '/vendor/xterm.css': path.join(XTERM, 'css/xterm.css'),
  '/vendor/addon-fit.js': path.join(packageDir('@xterm/addon-fit'), 'lib/addon-fit.js'),
  '/vendor/addon-webgl.js': path.join(packageDir('@xterm/addon-webgl'), 'lib/addon-webgl.js'),
  // iOS asks for these by convention, whatever the page links to.
  '/apple-touch-icon.png': path.join(PUBLIC, 'icon-180.png'),
  '/apple-touch-icon-precomposed.png': path.join(PUBLIC, 'icon-180.png'),
};

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
};

const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.svg', '.json', '.webmanifest']);
const gzipped = new Map(); // file -> { key, data }

function gzipOf(file, stat) {
  const key = `${stat.size}-${stat.mtimeMs}`;
  const cached = gzipped.get(file);
  if (cached && cached.key === key) return cached.data;
  const data = zlib.gzipSync(fs.readFileSync(file), { level: 9 });
  gzipped.set(file, { key, data });
  return data;
}

// "gzip" in Accept-Encoding, unless given q=0.
function acceptsGzip(req) {
  return String((req && req.headers['accept-encoding']) || '').split(',').some((part) => {
    const [coding, ...params] = part.split(';').map((s) => s.trim().toLowerCase());
    const q = params.find((p) => p.startsWith('q='));
    return (coding === 'gzip' || coding === '*') && !(q && Number(q.slice(2)) === 0);
  });
}

// xterm injects <style> elements, hence 'unsafe-inline' for styles only. Older
// Safari does not match ws:/wss: against 'self', so the socket host is explicit.
function csp(req) {
  const host = /^[\w.:[\]-]+$/.test(req.headers.host || '') ? req.headers.host : '';
  const sockets = host ? ` wss://${host} ws://${host}` : '';
  return `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'${sockets}; frame-ancestors 'none'; base-uri 'none'`;
}

// Whole vendor folders, for assets loaded on demand (highlight.js languages).
const VENDOR_DIRS = {
  '/vendor/hljs/': packageDir('@highlightjs/cdn-assets') + path.sep,
};

function resolveFile(pathname) {
  if (VENDOR[pathname]) return { file: VENDOR[pathname], cache: 'public, max-age=86400' };
  for (const [prefix, base] of Object.entries(VENDOR_DIRS)) {
    if (!pathname.startsWith(prefix)) continue;
    let file;
    try {
      file = path.resolve(base, decodeURIComponent(pathname.slice(prefix.length)));
    } catch {
      return null;
    }
    return file.startsWith(base) && /\.(js|css)$/.test(file) ? { file, cache: 'public, max-age=86400' } : null;
  }
  let rel;
  try {
    rel = pathname === '/' ? 'index.html' : pathname === '/admin' || pathname === '/admin/' ? 'admin.html' : decodeURIComponent(pathname.slice(1));
  } catch {
    return null;
  }
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) return null;
  return { file, cache: 'no-cache' };
}

// Returns true when it handled the request.
function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const target = resolveFile(pathname);
  if (!target) return false;
  let stat;
  try {
    stat = fs.statSync(target.file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  const gzip = COMPRESSIBLE.has(path.extname(target.file)) && acceptsGzip(req);
  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}${gzip ? '-gz' : ''}"`;
  const headers = {
    Vary: 'Accept-Encoding',
    'Content-Type': TYPES[path.extname(target.file)] || 'application/octet-stream',
    'Cache-Control': target.cache,
    ETag: etag,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
  if (target.file.endsWith('.html')) headers['Content-Security-Policy'] = csp(req);

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  if (gzip) {
    let data;
    try {
      data = gzipOf(target.file, stat);
    } catch {
      return false;
    }
    res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': data.length });
    res.end(req.method === 'HEAD' ? undefined : data);
    return true;
  }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  // A client that goes away part way through (a phone backgrounded on a slow
  // link) leaves pipe() holding the file open, and the descriptor is never
  // given back: enough of those and the server can no longer open anything.
  const file = fs.createReadStream(target.file);
  res.on('close', () => file.destroy());
  file.on('error', () => res.destroy());
  file.pipe(res);
  return true;
}

module.exports = { serveStatic, acceptsGzip, resolveFile };
