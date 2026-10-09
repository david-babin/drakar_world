// Rendering loop: the GPU globe, then life on the 2D canvas (regions being computed, routes, settlements,
// groups and settlement areas, recent events), then the HUD.
import { W, H, RX, RW, RH, STEPS, lonOf, latOf } from '../lib/index.js';
import { app, peers, WALLPAPER } from './state.js';
import { gcv, octx, tip } from './dom.js';
import { cam, view, resize, layout, project, projectLL, geodesic, regionCenter, cameraMatrix, clampLat } from './camera.js';
import { gl, drawGlobe, drawLines } from './gl/globe.js';
import { gesture } from './input.js';
import { tele } from './telemetry.js';
import { hud } from './hud.js';
import { urbanAreas } from './urban.js';
import { t, fmt } from './i18n.js';
import { DEG, PEER_TTL, MAX_DPR, CITY_SOULS, IDLE_FRAMES, MEMORY_MS } from './constants.js';

export const hue = lin => app.world?.lineages[lin]?.hue ?? 0;
let last = performance.now(), frames = 0, fpsAt = last, hits = [], lowStreak = 0;
let drawnAt = 0;
function frame(now) {
  // wallpaper mode: the next frame is requested only when due — no 60 Hz wake-ups between drawn frames
  if (WALLPAPER) setTimeout(() => requestAnimationFrame(frame), Math.max(0, 1000 / WALLPAPER.fps - (performance.now() - now)));
  else requestAnimationFrame(frame);
  if (!app.world) return;
  const k = drawnAt ? Math.min(4, (now - drawnAt) / 16.667) : 1;          // motion per 60 Hz frame: same speed at any rate
  drawnAt = now;
  frames++;
  if (now - fpsAt > 2000) {
    tele.fps = Math.round(frames * 1000 / (now - fpsAt));
    // sustained low frame rate (two slow windows in a row, not during start-up, page visible):
    // lower the resolution a notch, never below 1×
    lowStreak = !WALLPAPER && document.visibilityState === 'visible' && now - app.worldAt > 6000 && tele.fps < 40 ? lowStreak + 1 : 0;
    if (lowStreak >= 2 && Math.min(MAX_DPR, devicePixelRatio || 1) * view.quality * 0.8 >= 1) { view.quality *= 0.8; lowStreak = 0; resize(); }
    frames = 0; fpsAt = now;
  }
  // inertia and slow rotation at rest
  if (!gesture.drag && !gesture.pinch) {
    cam.lon += cam.vlon * k; cam.lat = clampLat(cam.lat + cam.vlat * k);
    cam.vlon *= 0.92 ** k; cam.vlat *= 0.92 ** k;
    cam.idle += k;
    // after 6 s without interaction, the camera glides to the region being computed (mine, otherwise another witness's)
    if (cam.idle > IDLE_FRAMES) {
      let reg = app.lease ? app.lease.unit.region : null;
      if (reg == null) { let best = 0; for (const pr of peers.values()) if (pr.at > best) { best = pr.at; reg = pr.region; } }
      if (reg != null) cam.target = regionCenter(reg);
      const ease = Math.min(0.012, (cam.idle - IDLE_FRAMES) / 20000) * k;
      if (cam.target) {
        let dl = cam.target.lon - cam.lon; dl = Math.atan2(Math.sin(dl), Math.cos(dl));
        cam.lon += dl * ease; cam.lat += (clampLat(cam.target.lat) - cam.lat) * ease;
      } else cam.lon += 0.00035 * k * Math.min(1, (cam.idle - IDLE_FRAMES) / 300);
    }
  }
  layout();

  gl.viewport(0, 0, gcv.width, gcv.height);
  drawGlobe(view.cw * view.dpr, view.ch * view.dpr, view.cx * view.dpr, view.cy * view.dpr, view.R * view.dpr);
  drawLines(cameraMatrix(), view.R * view.dpr, view.cx * view.dpr, view.cy * view.dpr, view.cw * view.dpr, view.ch * view.dpr);

  octx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0); octx.clearRect(0, 0, view.cw, view.ch);
  const o = {};
  hits = [];

  // regions being computed (lat/lon outline)
  const regionBox = (reg, color, dash) => {
    const rx = reg % RX, ry = Math.floor(reg / RX);
    const x0 = rx * RW, y0 = ry * RH, x1 = x0 + RW, y1 = y0 + RH;
    const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
    octx.strokeStyle = color; octx.lineWidth = 1; octx.setLineDash(dash); octx.lineDashOffset = -now / 40;
    octx.beginPath();
    for (let i = 0; i < 4; i++) {
      const [ax, ay] = corners[i], [bx, by] = corners[i + 1], pts = [];
      for (let j = 0; j <= 16; j++) { const x = ax + (bx - ax) * j / 16, y = ay + (by - ay) * j / 16; const p = projectLL(((x / W) * 360 - 180) * DEG, (90 - (y / H) * 180) * DEG, o); pts.push(p ? [p.x, p.y] : null); }
      strokePath(pts);
    }
    octx.stroke(); octx.setLineDash([]);
  };
  const tnow = Date.now();
  for (const [sg, pr] of peers) if (tnow - pr.at > PEER_TTL) peers.delete(sg);
  for (const [sg, pr] of peers) {
    regionBox(pr.region, 'rgba(201,194,178,.26)', [2, 6]);
    const rx = pr.region % RX, ry = Math.floor(pr.region / RX);
    const c = projectLL(((rx + .5) * RW / W * 360 - 180) * DEG, (90 - (ry + .5) * RH / H * 180) * DEG, o);
    if (c && c.c > 0.2) { octx.font = '300 9px IBM Plex Mono'; octx.fillStyle = `rgba(201,194,178,${0.5 * c.c})`; octx.textAlign = 'center'; octx.fillText(`${sg} · ${(100 * pr.step / STEPS) | 0} %`, c.x, c.y); }
  }
  if (app.lease) regionBox(app.lease.unit.region, 'rgba(217,168,92,.6)', [3, 5]);

  // routes
  const byId = new Map(app.world.settlements.map(s => [s.id, s]));
  octx.lineWidth = 0.9;
  for (const r of app.world.routes) {
    const a = byId.get(r.a), b = byId.get(r.b); if (!a || !b) continue;
    const age = Math.min(1, (app.world.tick - r.tick) / 600);
    octx.strokeStyle = `hsla(${hue(r.lin)},45%,70%,${0.18 + 0.3 * age})`;
    octx.setLineDash(r.sea ? [2, 4] : []);
    octx.beginPath(); strokePath(geodesic(a.x, a.y, b.x, b.y, 48)); octx.stroke();
  }
  octx.setLineDash([]);

  // settlements
  const showLabels = view.R > 420;
  for (const st of app.world.settlements) {
    const p = project(st.x, st.y, o); if (!p) continue;
    const a = 0.35 + 0.65 * p.c;
    octx.strokeStyle = `hsla(${hue(st.lin)},55%,62%,${a})`; octx.lineWidth = 1;
    octx.beginPath(); octx.rect(p.x - 2.5, p.y - 2.5, 5, 5); octx.stroke();
    octx.beginPath(); octx.moveTo(p.x, p.y - 2.5); octx.lineTo(p.x, p.y - 7); octx.stroke();
    if (showLabels && p.c > 0.35) { octx.font = '300 9px IBM Plex Mono'; octx.fillStyle = `rgba(201,194,178,${0.55 * p.c})`; octx.textAlign = 'left'; octx.fillText(st.name, p.x + 6, p.y + 3); }
    hits.push({ x: p.x, y: p.y, st });
  }

  // groups
  const animated = new Set(app.lease ? app.lease.agents.map(a => a.id) : []);
  for (const pr of peers.values()) for (const a of pr.agents) animated.add(a[0]);
  const drawAgent = (a, alpha) => {
    const p = project(a.x, a.y, o); if (!p) return;
    const r = Math.min(4, 1 + Math.sqrt(a.pop) * .2) * (0.6 + 0.4 * p.c);
    octx.fillStyle = `hsla(${hue(a.lin)},60%,66%,${alpha * (0.3 + 0.7 * p.c)})`;
    octx.beginPath(); octx.arc(p.x, p.y, r, 0, 6.283); octx.fill();
    hits.push({ x: p.x, y: p.y, ag: a });
  };
  // settled world. Groups of one lineage within 3 cells of each other form a settlement area (single
  // linkage, in world space). Below 10,000 souls it shows as its groups; each 10,000 makes it a bigger
  // point — village, town, city — with its groups drawn faintly around the core.
  const still = app.world.agents.filter(a => !animated.has(a.id) && a.pop > 0);
  for (const c of urbanAreas(still)) {
    const tier = Math.floor(c.pop / CITY_SOULS);
    if (!tier) { for (const a of c.members) drawAgent(a, .8); continue; }
    for (const a of c.members) drawAgent(a, .28);
    const p = projectLL(lonOf(c.x) * DEG, latOf(c.y) * DEG, o); if (!p) continue;
    const k = 0.6 + 0.4 * p.c, al = 0.3 + 0.7 * p.c, col = `hsla(${hue(c.lin)},60%,68%,`;
    const r = (3.4 + 1.8 * Math.sqrt(tier)) * k;
    octx.fillStyle = col + (.9 * al) + ')';
    octx.beginPath(); octx.arc(p.x, p.y, r, 0, 6.283); octx.fill();
    octx.strokeStyle = col + (.35 * al) + ')'; octx.lineWidth = .8;
    for (let i = 0, rings = Math.min(3, Math.ceil(Math.log2(tier + 1))); i < rings; i++) { octx.beginPath(); octx.arc(p.x, p.y, r + 2.5 + i * 2.5, 0, 6.283); octx.stroke(); }
    hits.push({ x: p.x, y: p.y, ag: c.core });
  }
  for (const pr of peers.values()) for (const [id, x, y, lin, pop] of pr.agents) if (pop > 0) drawAgent({ id, x, y, lin, pop, food: 0, g: [] }, .9);
  if (app.lease) for (const a of app.lease.agents) if (a.pop > 0) drawAgent(a, 1);

  // memories: recent events
  const tm = Date.now();
  for (const e of app.world.chronicle.slice(-12)) if (e.x != null && tm - e.t < MEMORY_MS) {
    const p = project(e.x, e.y, o); if (!p) continue;
    const k = 1 - (tm - e.t) / MEMORY_MS;
    octx.strokeStyle = `hsla(${hue(e.lin)},60%,66%,${k * .5})`; octx.lineWidth = .8;
    octx.beginPath(); octx.arc(p.x, p.y, 6 + (1 - k) * 18, 0, 6.283); octx.stroke();
  }

  if (now - last > 250) { last = now; hud(); }
}
requestAnimationFrame(frame);

// ---------- hover ----------
export function hoverAt(mx, my) {
  if (!app.world) return;
  let best = null, bd = 64;
  for (const h of hits) { const d = (h.x - mx) ** 2 + (h.y - my) ** 2; if (d < bd) { bd = d; best = h; } }
  if (!best || !best.st) { tip.style.display = 'none'; return; }           // groups stay nameless
  tip.style.display = 'block'; tip.style.left = mx + 14 + 'px'; tip.style.top = my + 14 + 'px';
  tip.innerHTML = `${best.st.name}<small>${t('yearLower', { n: fmt(Math.floor(best.st.founded / 4)) })}</small>`;
}

function strokePath(pts) {
  let on = false;
  for (const p of pts) {
    if (!p) { on = false; continue; }
    if (!on) { octx.moveTo(p[0], p[1]); on = true; } else octx.lineTo(p[0], p[1]);
  }
}
