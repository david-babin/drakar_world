#!/usr/bin/env node
// build.mjs — the build chain.
//
//   node tools/build.mjs             full build: public/ (the site) and bin/backend.js (the server)
//   node tools/build.mjs --watch     rebuild on every change in src/ and restart the server   (npm run dev)
//   node tools/build.mjs --demo      also writes demo.html: the page standalone, data inlined, no server
//
// Steps
//   1. Earth data: assets/earth/ holds the files built once by tools/build-earth.mjs. If one is missing,
//      it is built now (its inputs are fetched into .cache/earth/ on first use).
//   2. public/: Earth data + src/front/static/ copied as is; src/front/main.js bundled and minified into
//      app.js; styles.css minified and inlined into index.html; locales embedded in the bundle; every
//      versioned URL (?v=) carries the file's fingerprint, the same one the server uses as ETag.
//   3. bin/backend.js: src/back/main.js bundled and minified for Node 22 (no runtime dependencies).
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { fingerprint } from '../src/back/fingerprint.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = (...p) => path.join(ROOT, ...p);
const EARTH = ['terrain.bin', 'base.png', 'land.bin', 'coasts.bin', 'contours.bin'];
const PUBLIC = at('public'), BIN = at('bin');
const args = new Set(process.argv.slice(2));
const kB = n => (n / 1024).toFixed(1) + ' kB';
const log = (...a) => console.log('build ·', ...a);

// ---------- 1. Earth data ----------
function ensureEarth() {
  const missing = EARTH.filter(f => !fs.existsSync(at('assets/earth', f)));
  if (!missing.length) return;
  log(`Earth data missing (${missing.join(', ')}): building it`);
  const r = spawnSync(process.execPath, [at('tools/build-earth.mjs'), '--out', at('assets/earth')], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) throw new Error('build-earth failed');
}

// ---------- 2. the site ----------
const locales = () => Object.fromEntries(fs.readdirSync(at('src/front/locales')).filter(f => f.endsWith('.json')).sort()
  .map(f => [path.basename(f, '.json'), JSON.parse(fs.readFileSync(at('src/front/locales', f), 'utf8'))]));

async function bundleFront(assets) {
  const r = await esbuild.build({
    entryPoints: [at('src/front/main.js')], bundle: true, minify: true, format: 'iife', target: ['es2020'],
    define: { __LOCALES__: JSON.stringify(locales()), __ASSETS__: JSON.stringify(assets) },
    legalComments: 'none', write: false, logLevel: 'silent',
  });
  return r.outputFiles[0].contents;
}
async function styles() {
  const r = await esbuild.transform(fs.readFileSync(at('src/front/styles.css'), 'utf8'), { loader: 'css', minify: true });
  return r.code.trim();
}
// light HTML minification: comments and whitespace between tags
const squeezeHtml = h => h.replace(/<!--[\s\S]*?-->/g, '').replace(/>\s+</g, '><').trim() + '\n';
// (function replacers: minified code is full of `$&`-like sequences that a replacement string would expand)
const page = async (script) => { const css = await styles(); return squeezeHtml(fs.readFileSync(at('src/front/index.html'), 'utf8'))
  .replace('/*__CSS__*/', () => css)
  .replace('<script src="/*__APP__*/" defer></script>', () => script); };

function copyDir(from, to) {
  for (const rel of fs.readdirSync(from, { recursive: true })) {
    const src = path.join(from, rel), dst = path.join(to, rel);
    if (fs.statSync(src).isDirectory()) { fs.mkdirSync(dst, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst);
  }
}
// write only when the content changed: the server's dev watcher reloads exactly what moved
function put(file, data) {
  const buf = Buffer.isBuffer(data) || data instanceof Uint8Array ? Buffer.from(data) : Buffer.from(String(data));
  if (fs.existsSync(file) && fs.readFileSync(file).equals(buf)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, buf);
}

async function buildSite() {
  fs.mkdirSync(PUBLIC, { recursive: true });
  for (const f of EARTH) put(path.join(PUBLIC, f), fs.readFileSync(at('assets/earth', f)));
  copyDir(at('src/front/static'), PUBLIC);
  const assets = Object.fromEntries(EARTH.map(f => [f, fingerprint(fs.readFileSync(at('assets/earth', f)))]));
  const app = await bundleFront(assets);
  put(path.join(PUBLIC, 'app.js'), app);
  const html = await page(`<script src="/app.js?v=${fingerprint(Buffer.from(app))}" defer></script>`);
  put(path.join(PUBLIC, 'index.html'), html);
  return { app, html };
}

async function buildDemo(app) {
  const data = Object.fromEntries(EARTH.map(f => [f, fs.readFileSync(at('assets/earth', f)).toString('base64')]));
  const safe = s => s.replace(/<\/script/gi, '<\\/script');
  const html = (await page(`<script>window.DRAKAR_DATA=${JSON.stringify(data)}</script><script>${safe(Buffer.from(app).toString('utf8'))}</script>`))
    .replace('<title>drakar</title>', '<title>drakar · demo</title>');
  fs.writeFileSync(at('demo.html'), html);
  return html;
}

// ---------- 3. the server ----------
async function buildBack() {
  fs.mkdirSync(BIN, { recursive: true });
  await esbuild.build({
    entryPoints: [at('src/back/main.js')], outfile: path.join(BIN, 'backend.js'), bundle: true, minify: true,
    platform: 'node', format: 'esm', target: ['node22'], legalComments: 'none', logLevel: 'silent',
    sourcemap: 'linked', sourcesContent: false,        // bin/backend.js.map: readable stack traces (--enable-source-maps)
  });
  return fs.statSync(path.join(BIN, 'backend.js')).size;
}

async function buildAll({ clean = false } = {}) {
  const t0 = Date.now();
  if (clean) { fs.rmSync(PUBLIC, { recursive: true, force: true }); fs.rmSync(BIN, { recursive: true, force: true }); }
  ensureEarth();
  const [{ app, html }, back] = await Promise.all([buildSite(), buildBack()]);
  let line = `public/app.js ${kB(app.length)} · index.html ${kB(html.length)} · bin/backend.js ${kB(back)}`;
  if (args.has('--demo')) line += ` · demo.html ${kB((await buildDemo(app)).length)}`;
  log(`${line} · ${Date.now() - t0} ms`);
}

// ---------- run ----------
try { await buildAll({ clean: !args.has('--watch') }); }
catch (e) { console.error('build failed:', e.errors?.map(x => `${x.location?.file}:${x.location?.line} ${x.text}`).join('\n') || e.message); process.exit(1); }

if (args.has('--watch')) {
  // development: rebuild on change, restart the server (the page itself is hot-reloaded by the server)
  let server = null, timer = null;
  const start = () => {
    server = spawn(process.execPath, ['--no-warnings', '--env-file-if-exists=.env', path.join(BIN, 'backend.js')], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'development' } });
  };
  const restart = () => { if (!server) return start(); server.once('exit', start); server.kill('SIGTERM'); };
  start();
  let backChanged = false;
  fs.watch(at('src'), { recursive: true }, (_, name) => {
    if (name && !name.startsWith('front')) backChanged = true;      // lib/ or back/: the server must restart
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try { await buildAll(); if (backChanged) { backChanged = false; restart(); } }
      catch (e) { console.error('build failed:', e.errors?.map(x => `${x.location?.file}:${x.location?.line} ${x.text}`).join('\n') || e.message); }
    }, 120);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server?.kill('SIGTERM'); process.exit(0); });
}
