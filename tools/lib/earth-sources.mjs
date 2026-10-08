// Fetches the inputs of build-earth.mjs when none are given, into .cache/earth/ (not versioned):
//   etopo1.jpg, bmng.jpg   from the PyPI package basemap-data (a wheel is a plain zip archive)
//   land-50m.json          from the npm package world-atlas (dev dependency)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const PYPI = 'https://pypi.org/pypi/basemap-data/json';
const WANTED = { 'etopo1.jpg': 'mpl_toolkits/basemap_data/etopo1.jpg', 'bmng.jpg': 'mpl_toolkits/basemap_data/bmng.jpg' };

// minimal zip reader: end of central directory → central directory → local headers (stored or deflated)
function unzip(buf, names) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip archive');
  const count = buf.readUInt16LE(eocd + 10), out = {};
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt central directory');
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20), nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (names.includes(name)) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28), data = buf.subarray(start, start + size);
      out[name] = method === 0 ? data : method === 8 ? zlib.inflateRawSync(data) : (() => { throw new Error('unsupported compression ' + method); })();
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

export async function earthSources(cacheDir, log = console.error) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const files = Object.fromEntries(Object.keys(WANTED).map(k => [k, path.join(cacheDir, k)]));
  if (!Object.values(files).every(f => fs.existsSync(f))) {
    log('earth · fetching basemap-data from PyPI…');
    const meta = await (await fetch(PYPI)).json();
    const wheel = meta.urls.find(u => u.filename.endsWith('.whl'));
    if (!wheel) throw new Error('basemap-data: no wheel on PyPI');
    const res = await fetch(wheel.url); if (!res.ok) throw new Error(`basemap-data: HTTP ${res.status}`);
    const got = unzip(Buffer.from(await res.arrayBuffer()), Object.values(WANTED));
    for (const [k, inZip] of Object.entries(WANTED)) { if (!got[inZip]) throw new Error('basemap-data: missing ' + inZip); fs.writeFileSync(files[k], got[inZip]); }
    log(`earth · ${wheel.filename} → ${cacheDir}`);
  }
  const land = createRequire(import.meta.url).resolve('world-atlas/land-50m.json');
  return { etopo: files['etopo1.jpg'], bmng: files['bmng.jpg'], land };
}
