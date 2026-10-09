// Static files: read once at startup, precompressed with brotli (q11) and gzip, served with ETag (304).
// A URL carrying the file's fingerprint (?v=…, written by the build) is cached for a year, immutable:
// a changed file changes URL, so an old cache can never be read by newer code.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { MIME, PRECOMPRESSED, DAY_CACHED, IMMUTABLE } from './constants.js';
import { fingerprint } from './fingerprint.js';

export function createStatic(dir, { dev = false, commit = null } = {}) {
  const files = new Map();
  function load(rel) {
    const file = path.join(dir, rel);
    if (!file.startsWith(dir + path.sep)) return null;
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return null;
    let raw = fs.readFileSync(file);
    const ext = path.extname(file), squeeze = PRECOMPRESSED(ext);
    // the commit shown on the page: written by the build, or given at runtime when the build could not know it
    if (rel === 'index.html' && commit) raw = Buffer.from(raw.toString('utf8').replace(/(<div id="version" class="hud">)[^<]*/, (_, open) => open + commit));
    const entry = {
      raw, type: MIME[ext] || 'application/octet-stream', etag: '"' + fingerprint(raw) + '"',
      cache: DAY_CACHED.includes(ext) ? 'public, max-age=86400' : 'no-cache',      // otherwise always revalidated (cheap 304)
      br: squeeze ? zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }) : null,
      gz: squeeze ? zlib.gzipSync(raw, { level: 9 }) : null,
    };
    files.set(rel.split(path.sep).join('/'), entry);
    return entry;
  }
  for (const rel of fs.readdirSync(dir, { recursive: true })) if (fs.statSync(path.join(dir, rel)).isFile()) load(rel);
  if (dev) fs.watch(dir, { recursive: true }, (_, name) => { if (name) { files.delete(name.split(path.sep).join('/')); try { load(name); } catch {} } });   // the build rewrites public/

  function serve(req, res, url) {
    let p = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    p = path.posix.normalize(p).replace(/^(\.\.\/)+/, '');
    const e = files.get(p) || (dev ? load(p) : null);
    if (!e) return false;
    const cache = url.searchParams.get('v') === e.etag.slice(1, -1) ? IMMUTABLE : e.cache;
    if (req.headers['if-none-match'] === e.etag) { res.writeHead(304, { etag: e.etag, 'cache-control': cache }); res.end(); return true; }
    const ae = req.headers['accept-encoding'] || '';
    const enc = e.br && /\bbr\b/.test(ae) ? 'br' : e.gz && /\bgzip\b/.test(ae) ? 'gzip' : null;
    const body = enc === 'br' ? e.br : enc === 'gzip' ? e.gz : e.raw;
    const headers = { 'content-type': e.type, 'content-length': body.length, 'cache-control': cache, etag: e.etag, vary: 'Accept-Encoding' };
    if (enc) headers['content-encoding'] = enc;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }
  const sum = k => [...files.values()].reduce((n, e) => n + (e[k] || e.raw).length, 0) >> 10;
  return { serve, summary: () => `${files.size} files, ${sum('raw')} kB raw, ${sum('br')} kB brotli` };
}
