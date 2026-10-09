// Demo mode (?demo, demo.html): the world lives in the tab, with a simulated past and index.
import * as S from '../lib/index.js';
import { app } from './state.js';
import { ME } from './identity.js';
import { tele } from './telemetry.js';
import { loadAssets } from './earth.js';
import { setWorld } from './store.js';
import { addChron } from './chronicle.js';
import { runUnit, sleep } from './compute.js';
import { DEMO_WORLD, NET } from './constants.js';
import { engine } from './engine.js';

const { STEPS } = S;
// demo mode: the world lives in the tab, with a simulated past and index
const syntheticMarket = at => S.synthetic(new Date(at));
export async function loopDemo() {
  const A = await loadAssets(); app.T = engine().loadTerrain(A.terrain);
  const w = S.World.create(DEMO_WORLD.seed, app.T);
  const t0 = Date.now() - DEMO_WORLD.ageDays * 86400000, gap = DEMO_WORLD.gapMs;
  w.s.created = t0; w.s.chronicle[0].t = t0;
  const ghosts = DEMO_WORLD.ghosts;
  for (let i = 0; i < DEMO_WORLD.units; i++) {
    const g = ghosts[i % 4], at = t0 + (i < 24 ? i * gap : 19 * 86400000 + i * gap);
    w.setMarket(syntheticMarket(at));
    const u = w.lease(g, at); if (u) w.integrate(engine().simulateUnit(w.T, u), g, { now: at });
  }
  for (const c of w.s.chronicle) c.t = Math.min(c.t, Date.now() - 60000);
  w.setMarket(syntheticMarket(Date.now()));
  app.online = 1 + Math.floor(Math.random() * 3);
  setWorld(S.unpackSnapshot(JSON.parse(JSON.stringify(w.snapshot(app.online)))));
  for (;;) {
    const unit = w.lease(ME);
    await runUnit(unit, false, (result) => { const r = w.integrate(result, ME); tele.units++; tele.ticks += STEPS; tele.decisions += result.decisions; S.applyDelta(app.world, JSON.parse(JSON.stringify(r.delta))); for (const e of r.entries) addChron(S.unpackEntry(S.packEntry(e)), true); });
    app.lease = null;
    await sleep(NET.pauseMin + Math.random() * NET.pauseJitter);
  }
}
