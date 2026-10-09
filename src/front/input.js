// Interactions: drag to rotate, wheel / pinch to zoom (confined to the globe: the page never zooms).
import { gcv, tip } from './dom.js';
import { cam, view, clampLat } from './camera.js';
import { hoverAt } from './render.js';
import { ZOOM_MIN, ZOOM_MAX } from './constants.js';
import { WALLPAPER } from './state.js';

const ptrs = new Map();                        // active pointers (mouse, fingers)
export const gesture = { drag: null, pinch: null };      // one finger / mouse: rotate · two fingers: zoom
const zoomTo = z => { cam.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z)); cam.idle = 0; };
if (!WALLPAPER) {
gcv.addEventListener('pointerdown', e => {
  gcv.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  cam.vlon = cam.vlat = 0; cam.idle = 0;
  if (ptrs.size === 1) { gesture.drag = { x: e.clientX, y: e.clientY, lon: cam.lon, lat: cam.lat }; gcv.classList.add('drag'); }
  else if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; gesture.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: cam.zoom }; gesture.drag = null; }
});
gcv.addEventListener('pointermove', e => {
  if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (gesture.pinch && ptrs.size >= 2) { const [a, b] = [...ptrs.values()]; zoomTo(gesture.pinch.z * Math.hypot(a.x - b.x, a.y - b.y) / gesture.pinch.d); return; }
  if (gesture.drag) {
    const k = 1 / view.R;
    const nlon = gesture.drag.lon - (e.clientX - gesture.drag.x) * k, nlat = clampLat(gesture.drag.lat + (e.clientY - gesture.drag.y) * k);
    cam.vlon = (nlon - cam.lon) * 0.5; cam.vlat = (nlat - cam.lat) * 0.5;
    cam.lon = nlon; cam.lat = nlat; cam.idle = 0;
  } else if (ptrs.size === 0) hoverAt(e.clientX, e.clientY);
});
const endPtr = e => { ptrs.delete(e.pointerId); if (ptrs.size < 2) gesture.pinch = null; if (ptrs.size === 0) { gesture.drag = null; gcv.classList.remove('drag'); } else if (ptrs.size === 1 && !gesture.drag) { const [p] = [...ptrs.values()]; gesture.drag = { x: p.x, y: p.y, lon: cam.lon, lat: cam.lat }; } cam.idle = 0; };
gcv.addEventListener('pointerup', endPtr); gcv.addEventListener('pointercancel', endPtr);
// the wheel (and the trackpad pinch, which arrives as ctrl+wheel) only zooms the globe, never the page
addEventListener('wheel', e => { e.preventDefault(); zoomTo(cam.zoom * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0012))); }, { passive: false });
addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && ['+', '-', '=', '0'].includes(e.key)) e.preventDefault(); });
addEventListener('gesturestart', e => e.preventDefault());
gcv.addEventListener('mouseleave', () => tip.style.display = 'none');
}
