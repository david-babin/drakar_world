#!/usr/bin/env node
// build-icons.mjs — renders the favicon and app icons from src/front/static/icons/icon.svg (Playwright, dev only).
//   node tools/build-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
const dir = path.resolve('src/front/static/icons');
const svg = fs.readFileSync(path.join(dir, 'icon.svg'), 'utf8');
const sizes = [32, 180, 192, 512];
const b = await chromium.launch();
for (const s of sizes) {
  const p = await (await b.newContext({ viewport: { width: s, height: s }, deviceScaleFactor: 1 })).newPage();
  await p.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg.replace('<svg ', `<svg width="${s}" height="${s}" `)}`);
  await p.screenshot({ path: path.join(dir, `icon-${s}.png`), omitBackground: true });
  console.log(`icon-${s}.png`);
}
await b.close();
