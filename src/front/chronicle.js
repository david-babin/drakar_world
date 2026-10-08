// Chronicle (bottom right). Entries are structured (kind + parameters) and rendered in the current language.
import { ROMAN, regionOf } from '../lib/index.js';
import { app } from './state.js';
import { chron } from './dom.js';
import { ME } from './identity.js';
import { LOCALES, t, fmt, lineageName } from './i18n.js';
import { CHRONICLE_MEMORY, CHRONICLE_LINES } from './constants.js';

// Entries are structured (kind + parameters) and rendered in the current language. Entries written before
// this format only carry a text: it is shown as is when it cannot be rebuilt.
// Legacy entries: their frozen text is matched against every locale's templates for that kind, which recovers
// the parameters (names, lineages, sea or land, regime) without hard-coding any language here.
const legacyCache = new Map();
function templateRegex(tpl) {
  const keys = [];
  const src = String(tpl).replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{(\w+)\}/g, (_, k) => { keys.push(k); return '(.+?)'; });
  return { re: new RegExp('^' + src + '$'), keys };
}
function parseLegacy(e) {
  if (legacyCache.has(e.text)) return legacyCache.get(e.text);
  const variants = { found: ['found'], raid: ['raid'], route: ['route', 'seaRoute'], freeze: ['freezeOne', 'freezeMany'], wind: ['wind.plenty', 'wind.scarcity', 'wind.ordinary'] }[e.kind] || [];
  let out = null;
  for (const loc of Object.values(LOCALES)) {
    for (const v of variants) {
      const tpl = v.split('.').reduce((o, k) => o?.[k], loc.chronicle); if (!tpl) continue;
      const { re, keys } = templateRegex(tpl), m = String(e.text).match(re); if (!m) continue;
      const got = Object.fromEntries(keys.map((k, i) => [k, m[i + 1]]));
      const linId = name => (loc.lineages || []).indexOf(name);
      out = {};
      if (got.name) out.name = got.name;
      if (got.from) { out.from = got.from; out.to = got.to; out.sea = v === 'seaRoute' ? 1 : 0; }
      if (got.vs != null && linId(got.vs) >= 0) out.vs = linId(got.vs);
      if (got.days) out.days = +got.days;
      if (v.startsWith('wind.')) out.regime = v.slice(5);
      break;
    }
    if (out) break;
  }
  legacyCache.set(e.text, out);
  return out;
}
export function entryText(e) {
  let p = e.p || {}; const C = 'chronicle.';
  const legacy = e.text && !Object.keys(p).length;
  if (legacy) p = parseLegacy(e) || {};
  const lin = e.lin != null ? lineageName(e.lin) : '';
  const where = e.x != null ? ROMAN[regionOf(e.x, e.y)] : '';
  switch (e.kind) {
    case 'genesis': return t(C + 'genesis', { n: p.n || 16 });
    case 'found': return p.name ? t(C + 'found', { name: p.name, lin }) : e.text || '';
    case 'raid': return p.vs != null ? t(C + 'raid', { lin, vs: lineageName(p.vs), where }) : e.text || '';
    case 'voyage': return t(C + 'voyage', { lin, where });
    case 'route': return p.from ? t(C + (p.sea ? 'seaRoute' : 'route'), { from: p.from, to: p.to }) : e.text || '';
    case 'extinction': return t(C + 'extinction', { lin });
    case 'freeze': { const days = p.days || +(String(e.text || '').match(/\d+/) || [1])[0]; return t(C + (days > 1 ? 'freezeMany' : 'freezeOne'), { days }); }
    case 'wind': return p.regime ? t(C + 'wind.' + p.regime) : e.text || '';
    case 'crossing': return t(C + 'crossing', { lin, where });
    case 'assimilate': return t(C + 'assimilate', { lin, vs: lineageName(p.vs), where });
    case 'revolt': return t(C + 'revolt', { lin, vs: lineageName(p.vs), where });
    case 'takeover': return t(C + 'takeover', { name: p.name, lin, vs: lineageName(p.vs) });
    case 'abandon': return t(C + 'abandon', { name: p.name });
    case 'rebirth': return t(C + 'rebirth', { lin, where });
    default: return e.text || '';
  }
}
function chronLine(e, isNew) {
  const d = document.createElement('div'); if (isNew) d.className = 'new';
  const yr = document.createElement('span'); yr.className = 'yr'; yr.textContent = t('year', { n: fmt(Math.floor(e.tick / 4)) });
  const who = document.createElement('em'); who.textContent = e.sigil === ME ? '◆' : e.sigil;
  d.append(yr, entryText(e), who);
  return d;
}
export function addChron(e, isNew) {
  if (isNew && app.world) { app.world.chronicle.push(e); if (app.world.chronicle.length > CHRONICLE_MEMORY) app.world.chronicle.shift(); }   // the "memory" rings read world.chronicle
  chron.appendChild(chronLine(e, isNew)); while (chron.children.length > CHRONICLE_LINES) chron.firstChild.remove();
}
export function renderChronicle() { chron.innerHTML = ''; for (const e of app.world.chronicle.slice(-CHRONICLE_LINES)) chron.appendChild(chronLine(e, false)); }
