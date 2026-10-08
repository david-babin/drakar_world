// The compute loop: one work unit at a time, sliced across animation frames so the page stays fluid.
import { simulateUnitGen } from '../lib/index.js';
import { app } from './state.js';
import { tele } from './telemetry.js';
import { PROGRESS_EVERY_MS } from './constants.js';

export const budgetMs = () => Math.max(3, Math.min(14, 2 + (tele.cores || 2) * 1.5));
// The unit being computed. It can be aborted at any time (connection lost, lease expired while hidden):
// the promise then resolves at once, even if the tab is hidden and no animation frame will come.
let run = null;
export const currentRun = () => run;
export function abortUnit() { if (run) { const r = run; run = null; r.aborted = true; r.resolve(); } app.lease = null; }
export async function runUnit(unit, verify, onDone, onProgress) {
  const gen = simulateUnitGen(app.T, unit);
  const L = { unit, agents: unit.agents, step: 0, t0: performance.now(), verify };
  app.lease = L;
  let lastDec = 0, lastT = performance.now(), lastProg = 0;
  await new Promise(resolve => {
    const me = run = { resolve, aborted: false, startedAt: Date.now() };
    const tickFrame = () => {
      if (me.aborted) return;
      const start = performance.now();
      let r;
      do {
        r = gen.next();
        if (r.done) break;
        L.agents = r.value.agents; L.step = r.value.step + 1;
      } while (performance.now() - start < budgetMs() && L.step % 2 !== 0);
      const now = performance.now();
      if (r.value?.decisions != null && now - lastT > 400) { tele.dps = Math.round((r.value.decisions - lastDec) / ((now - lastT) / 1000)); lastDec = r.value.decisions; lastT = now; }
      if (onProgress && !r.done && now - lastProg > PROGRESS_EVERY_MS) { lastProg = now; onProgress(L.step, L.agents); }
      if (r.done) { if (run === me) run = null; onDone(r.value, performance.now() - L.t0); resolve(); } else requestAnimationFrame(tickFrame);
    };
    requestAnimationFrame(tickFrame);
  });
}
export const sleep = ms => new Promise(r => setTimeout(r, ms));

// differential progress: the first frame is complete, the following ones only carry what changed
export function progressSender(region) {
  let prev = null;
  return (step, agents) => {
    const now = new Map(); for (const a of agents) if (a.pop > 0) now.set(a.id, [a.id, a.x, a.y, a.lin, a.pop]);
    if (!prev) { prev = now; return { t: 'progress', region, step, full: 1, agents: [...now.values()] }; }
    const changed = [], gone = [];
    for (const [id, v] of now) { const p = prev.get(id); if (!p || p[1] !== v[1] || p[2] !== v[2] || p[4] !== v[4]) changed.push(v); }
    for (const id of prev.keys()) if (!now.has(id)) gone.push(id);
    prev = now;
    return { t: 'progress', region, step, agents: changed, gone };
  };
}
