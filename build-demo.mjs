// Construit demo.html : index.html autonome (sim.js et données Terre inlinés), utilisable sans serveur.
import fs from 'node:fs';
const html = fs.readFileSync('public/index.html', 'utf8');
const sim = fs.readFileSync('public/sim.js', 'utf8').replace(/export /g, '');
const data = {};
for (const f of ['terre.bin', 'fond.png', 'cotes.bin', 'niveaux.bin']) data[f] = fs.readFileSync('public/' + f).toString('base64');
const out = html
  .replace("import * as S from './sim.js';", `window.DRAKAR_DATA = ${JSON.stringify(data)};\nconst S = (() => {\n${sim}\nreturn { W,H,RX,RY,RW,RH,STEPS,ROMAN,hashStr,loadTerrain,simulateUnitGen,simulateUnit,hashResult,World,lonOf,latOf,idx,walkable };\n})();`)
  .replace('<title>drakar</title>', '<title>drakar · maquette</title>');
fs.writeFileSync('demo.html', out);
console.log('demo.html ·', (out.length / 1024) | 0, 'ko');
