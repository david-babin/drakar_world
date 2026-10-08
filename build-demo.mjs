// Builds demo.html: a standalone index.html (sim.js, Earth data and locales inlined), usable without a server.
import fs from 'node:fs';
const html = fs.readFileSync('public/index.html', 'utf8');
const sim = fs.readFileSync('public/sim.js', 'utf8').replace(/export /g, '');
const data = {};
for (const f of ['terrain.bin', 'base.png', 'land.bin', 'coasts.bin', 'contours.bin']) data[f] = fs.readFileSync('public/' + f).toString('base64');
const locales = Object.fromEntries(fs.readdirSync('locales').filter(f => f.endsWith('.json')).map(f => [f.slice(0, -5), JSON.parse(fs.readFileSync('locales/' + f, 'utf8'))]));
const out = html
  .replace("import * as S from './sim.js';", `window.DRAKAR_DATA = ${JSON.stringify(data)};\nconst S = (() => {\n${sim}\nreturn { W,H,RX,RY,RW,RH,STEPS,ROMAN,hashStr,loadTerrain,simulateUnitGen,simulateUnit,hashResult,World,lonOf,latOf,idx,walkable,regionOf,unpackSnapshot,applyDelta,packEntry,unpackEntry,unpackUnit,packResult };\n})();`)
  .replace('/*__LOCALES__*/null', JSON.stringify(locales))
  .replace('<title>drakar</title>', '<title>drakar · demo</title>');
fs.writeFileSync('demo.html', out);
console.log('demo.html ·', (out.length / 1024) | 0, 'kB');
