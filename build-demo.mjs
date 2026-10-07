// Construit demo.html : index.html avec sim.js inliné, utilisable sans serveur (mode démo).
import fs from 'node:fs';
const html = fs.readFileSync('public/index.html', 'utf8');
const sim = fs.readFileSync('public/sim.js', 'utf8').replace(/export /g, '');
const out = html
  .replace("import * as S from './sim.js';", `const S = (() => {\n${sim}\nreturn { W,H,RX,RY,RW,RH,STEPS,ROMAN,hashStr,makeTerrain,simulateUnitGen,simulateUnit,hashResult,World,lonOf,latOf };\n})();`)
  .replace('<title>drakar</title>', '<title>drakar · maquette</title>');
fs.writeFileSync('demo.html', out);
console.log('demo.html ·', (out.length / 1024) | 0, 'ko');
