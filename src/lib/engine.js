// The compute engine: everything a witness needs to compute a work unit, and nothing else.
// Bundled alone into public/engine.js (global `DrakarEngine`, see docs/protocol.md) and loaded at runtime by
// every witness — the page and the Android app — at the version the server announces in `hello`. A witness
// therefore always computes with exactly the server's rules, without being updated itself.
//
// Two interfaces:
//   JavaScript   loadTerrain, simulateUnitGen, simulateUnit, hashResult, packUnit, unpackUnit, packResult, unpackResult
//   strings      for hosts that only exchange strings with a JS engine (Android JavaScriptSandbox):
//                init(terrainBase64) · begin(unitJson) · step(n) → progressJson · finish() → resultJson · compute(unitJson)
import { STEPS } from './constants/grid.js';
import { loadTerrain } from './terrain.js';
import { simulateUnitGen, simulateUnit, hashResult } from './simulate.js';
import { packUnit, unpackUnit, packResult, unpackResult } from './wire.js';

export { STEPS, loadTerrain, simulateUnitGen, simulateUnit, hashResult, packUnit, unpackUnit, packResult, unpackResult };

// ---------- string interface ----------
// base64 without atob (absent from bare JS engines)
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function fromBase64(s) {
  s = s.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor(s.length * 3 / 4));
  let o = 0, acc = 0, bits = 0;
  for (let i = 0; i < s.length; i++) {
    acc = (acc << 6) | B64.indexOf(s[i]); bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 255; }
  }
  return out.subarray(0, o);
}

let terrain = null, current = null;
// terrain.bin, as base64 or bytes; returns "W×H"
export function init(data) {
  terrain = loadTerrain(typeof data === 'string' ? fromBase64(data) : data);
  return `${terrain.w}×${terrain.h}`;
}
// starts a unit (the `unit` field of the server's `unit` message, as JSON); returns its region
export function begin(unitJson) {
  if (!terrain) throw new Error('init() first');
  const unit = unpackUnit(typeof unitJson === 'string' ? JSON.parse(unitJson) : unitJson);
  current = { gen: simulateUnitGen(terrain, unit), step: 0, result: null, t0: Date.now() };
  return unit.region;
}
// advances by up to n seasons; returns {"step", "done", "decisions", "agents": [[id, x, y, lin, pop], …]}
export function step(n = 1) {
  if (!current) throw new Error('begin() first');
  let last = null;
  for (let i = 0; i < n && !current.result; i++) {
    const r = current.gen.next();
    if (r.done) current.result = r.value; else { last = r.value; current.step = r.value.step + 1; }
  }
  const agents = (last ? last.agents : []).filter(a => a.pop > 0).map(a => [a.id, a.x, a.y, a.lin, a.pop]);
  return JSON.stringify({ step: current.step, done: !!current.result, decisions: last ? last.decisions : null, agents });
}
// once done: {"result": packed result, "hash", "decisions", "ms"} — ready for the `result` message
export function finish() {
  if (!current?.result) throw new Error('unit not finished');
  const r = current.result, out = { result: packResult(r), hash: hashResult(r), decisions: r.decisions, ms: Date.now() - current.t0 };
  current = null;
  return JSON.stringify(out);
}
// the whole unit at once
export function compute(unitJson) {
  begin(unitJson);
  while (!JSON.parse(step(STEPS)).done);
  return finish();
}
