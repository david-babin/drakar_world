// The page's copy of the world.
import { app } from './state.js';
import { $ } from './dom.js';
import { renderChronicle } from './chronicle.js';

export function setWorld(w) {
  const first = !app.world;
  app.world = w;
  if (first) { app.worldAt = performance.now(); renderChronicle(); $('veil').style.opacity = 0; }
}
