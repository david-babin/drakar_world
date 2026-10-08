// The visitor's sigil: derived once from the machine, then remembered.
import { hashStr } from '../lib/index.js';
import { STORAGE } from './constants.js';

function sigil() {
  try { const s = localStorage.getItem(STORAGE.sigil); if (s) return s; } catch {}
  const src = [navigator.hardwareConcurrency, navigator.deviceMemory, screen.width, screen.height, screen.colorDepth,
    Intl.DateTimeFormat().resolvedOptions().timeZone, navigator.language, navigator.platform, Math.random()].join('|');
  const h = hashStr(src).toString(36).toUpperCase().padStart(8, '0');
  const sg = `${h.slice(0, 4)}-${h.slice(4, 8)}`;
  try { localStorage.setItem(STORAGE.sigil, sg); } catch {}
  return sg;
}
export const ME = sigil();
