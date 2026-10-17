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
//      versioned URL (?v=) carries the file's fingerprint, the same one the server uses as ETag. The fonts come
//      from the @fontsource packages (latin + latin-ext only) and are served by the app itself: public/fonts/.
//      The legal pages (confidentialite.html, conditions.html) are built from src/front/legal/*.md.
//   3. bin/backend.js: src/back/main.js bundled and minified for Node 22 (no runtime dependencies).
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { fingerprint } from '../src/back/fingerprint.js';
import { markdown } from './markdown.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = (...p) => path.join(ROOT, ...p);
const EARTH = ['terrain.bin', 'base.png', 'land.bin', 'coasts.bin', 'contours.bin'];
const PUBLIC = at('public'), BIN = at('bin');
// the legal pages: URL path → source name (src/front/legal/<name>.<lang>.md); the locale key of its link label
const LEGAL = { confidentialite: 'privacy', conditions: 'terms' };
// self-hosted fonts (@fontsource, dev dependencies): package → weights; only these subsets are shipped
const FONTS = { 'inter-tight': [800], 'manrope': [400, 600, 700, 800], 'jetbrains-mono': [400, 500] };
const FONT_SUBSETS = ['latin-ext', 'latin'];
const args = new Set(process.argv.slice(2));
// the commit being built, shown at the bottom left of the page: from the CI (Coolify passes SOURCE_COMMIT),
// otherwise read from .git without needing git itself (the Docker build stage has no git binary)
function commitOf() {
  const env = process.env.SOURCE_COMMIT || process.env.COMMIT_SHA || process.env.GIT_COMMIT;
  if (env && /^[0-9a-f]{7,40}$/i.test(env)) return env.slice(0, 7);
  try {
    const head = fs.readFileSync(at('.git/HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return head.slice(0, 7);                         // detached HEAD
    const ref = head.slice(5), loose = at('.git', ref);
    if (fs.existsSync(loose)) return fs.readFileSync(loose, 'utf8').trim().slice(0, 7);
    const packed = fs.readFileSync(at('.git/packed-refs'), 'utf8').split('\n').find(l => l.endsWith(' ' + ref));
    if (packed) return packed.slice(0, 7);
  } catch {}
  return 'dev';
}
const VERSION = commitOf();
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

// the compute engine alone (src/lib/engine.js → global DrakarEngine): loaded by the page and the Android app
async function bundleEngine() {
  const r = await esbuild.build({
    entryPoints: [at('src/lib/engine.js')], bundle: true, minify: true, format: 'iife', globalName: 'DrakarEngine',
    target: ['es2020'], legalComments: 'none', write: false, logLevel: 'silent',
  });
  return r.outputFiles[0].contents;
}
async function bundleFront(assets, engineVersion) {
  const r = await esbuild.build({
    entryPoints: [at('src/front/main.js')], bundle: true, minify: true, format: 'iife', target: ['es2020'],
    define: { __LOCALES__: JSON.stringify(locales()), __ASSETS__: JSON.stringify(assets), __ENGINE__: JSON.stringify(engineVersion) },
    legalComments: 'none', write: false, logLevel: 'silent',
  });
  return r.outputFiles[0].contents;
}
const minCss = async css => (await esbuild.transform(css, { loader: 'css', minify: true })).code.trim();
const cssOf = (...files) => minCss(files.map(f => fs.readFileSync(at('src/front', f), 'utf8')).join('\n'));
// the language picker's style comes from the brand (submodule brand/), like its script
const styles = () => cssOf('tokens.css', '../../brand/css/lang.css', 'styles.css');
// @font-face rules of FONTS, taken from the packages' CSS (which carries the unicode-range of each subset);
// each woff2 is handed to `url(file name, bytes)`, which returns the URL to write in the rule
function fontFaces(url) {
  const out = [];
  for (const [pkg, weights] of Object.entries(FONTS)) for (const w of weights) {
    const css = fs.readFileSync(at('node_modules/@fontsource', pkg, `${w}.css`), 'utf8');
    for (const sub of FONT_SUBSETS) {
      const block = css.split('/* ').find(b => b.startsWith(`${pkg}-${sub}-${w}-normal */`));
      if (!block) throw new Error(`font ${pkg} ${sub} ${w} not found`);
      const file = `${pkg}-${sub}-${w}-normal.woff2`;
      out.push(block.slice(block.indexOf('@font-face'))
        .replace(/src:[^;]*;/, () => `src: url(${url(file, fs.readFileSync(at('node_modules/@fontsource', pkg, 'files', file)))}) format('woff2');`));
    }
  }
  return out.join('\n');
}
// light HTML minification: comments and whitespace between tags
const squeezeHtml = h => h.replace(/<!--[\s\S]*?-->/g, '').replace(/>\s+</g, '><').trim() + '\n';
// (function replacers: minified code is full of `$&`-like sequences that a replacement string would expand)
const page = async (script, fonts) => { const css = fonts + (await styles()); return squeezeHtml(fs.readFileSync(at('src/front/index.html'), 'utf8'))
  .replace('/*__CSS__*/', () => css)
  .replace('/*__VERSION__*/', () => VERSION)
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
  const engine = await bundleEngine(), engineVersion = fingerprint(Buffer.from(engine));
  put(path.join(PUBLIC, 'engine.js'), engine);
  const app = await bundleFront(assets, engineVersion);
  put(path.join(PUBLIC, 'app.js'), app);
  const fonts = fontFaces((file, data) => { put(path.join(PUBLIC, 'fonts', file), data); return `/fonts/${file}?v=${fingerprint(data)}`; });
  const html = await page(`<script src="/engine.js?v=${engineVersion}" defer></script><script src="/app.js?v=${fingerprint(Buffer.from(app))}" defer></script>`, await minCss(fonts));
  put(path.join(PUBLIC, 'index.html'), html);
  await buildLegal(await minCss(fonts));
  return { app, engine, html };
}

// the legal pages: static, every language in the page, a few lines of script to show the visitor's; they load
// neither the globe nor the engine. Texts: src/front/legal/<name>.<lang>.md; labels: the locales' "legal" key.
async function buildLegal(fonts) {
  const L = locales(), langs = Object.keys(L).filter(l => Object.values(LEGAL).every(n => fs.existsSync(at('src/front/legal', `${n}.${l}.md`))));
  const js = (await esbuild.build({
    entryPoints: [at('src/front/legal.js')], bundle: true, minify: true, format: 'iife', target: ['es2020'],
    define: { __LANGS__: JSON.stringify(langs) }, legalComments: 'none', write: false, logLevel: 'silent',
  })).outputFiles[0].text.trim();
  const style = fonts + await cssOf('tokens.css', '../../brand/css/lang.css', 'legal.css'), template = squeezeHtml(fs.readFileSync(at('src/front/legal.html'), 'utf8'));
  const first = langs.includes('en') ? 'en' : langs[0];
  for (const [page, name] of Object.entries(LEGAL)) {
    const text = Object.fromEntries(langs.map(l => [l, fs.readFileSync(at('src/front/legal', `${name}.${l}.md`), 'utf8')]));
    const hide = l => l === first ? '' : ' hidden';
    const link = (l, to, label) => `<a data-page="${to}" href="${to}"${to === '/' + page ? ' aria-current="page"' : ''}>${label}</a>`;
    const html = template
      .replace('/*__TITLE__*/', () => text[first].match(/^# (.*)$/m)[1].replace(/&/g, '&amp;').replace(/</g, '&lt;'))
      .replace('/*__CSS__*/', () => style)
      .replace('/*__ARTICLES__*/', () => langs.map(l => `<article data-lang="${l}" lang="${l}"${hide(l)}>${markdown(text[l])}</article>`).join(''))
      .replace('/*__NAV__*/', () => langs.map(l => `<nav data-lang="${l}"${hide(l)}>${
        Object.entries(LEGAL).map(([p, n]) => link(l, '/' + p, L[l].legal[n])).join(' · ')} · ${link(l, '/', L[l].legal.globe)}</nav>`).join(''))
      .replace('/*__JS__*/', () => js.replace(/<\/script/gi, '<\\/script'));
    put(path.join(PUBLIC, page + '.html'), html);
  }
}

async function buildDemo(app, engine) {
  const data = Object.fromEntries(EARTH.map(f => [f, fs.readFileSync(at('assets/earth', f)).toString('base64')]));
  const safe = s => s.replace(/<\/script/gi, '<\\/script');
  const html = (await page(`<script>window.DRAKAR_DATA=${JSON.stringify(data)}</script><script>${safe(Buffer.from(engine).toString('utf8'))}</script><script>${safe(Buffer.from(app).toString('utf8'))}</script>`,
    await minCss(fontFaces((file, bytes) => `data:font/woff2;base64,${bytes.toString('base64')}`))))
    .replace('<title>drakar world</title>', '<title>drakar world · demo</title>');
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
  const [{ app, engine, html }, back] = await Promise.all([buildSite(), buildBack()]);
  let line = `${VERSION} · public/engine.js ${kB(engine.length)} · app.js ${kB(app.length)} · index.html ${kB(html.length)} · bin/backend.js ${kB(back)}`;
  if (args.has('--demo')) line += ` · demo.html ${kB((await buildDemo(app, engine)).length)}`;
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
