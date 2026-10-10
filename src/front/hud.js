// HUD: the era (top left), the witness block (top right), the region being computed (bottom left).
import { STEPS, ROMAN, regimeOf } from '../lib/index.js';
import { app, DEMO } from './state.js';
import { $, witness } from './dom.js';
import { ME } from './identity.js';
import { t, L, fmt } from './i18n.js';

const shown = new Map();
const put = (el, key, html) => { if (shown.get(key) !== html) { shown.set(key, html); el.innerHTML = html; } };
export function hud() {
  put($('era'), 'era', t('year', { n: fmt(app.world.year) }));
  const m = app.world.market, nl = L().numberLocale || 'en-GB', n2 = v => v.toLocaleString(nl, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // charte: captions in uppercase, figures in mono, a change always carries its sign and its colour
  const mk = m ? `<span class="cap">${t('index')}</span><span class="num">${n2(m.close)}</span> <span class="num ${m.change < 0 ? 'dn' : 'up'}">${m.change >= 0 ? '+' : '−'}${n2(Math.abs(m.change))} %</span>${m.live ? ` <span class="cap">· ${t('live')}</span>` : ''}` : '';
  put(witness.querySelector('.sg'), 'sg', ME);
  put(witness.querySelector('.mk'), 'mk', `${mk}<br><span class="cap">${t('climate')}</span><b>${t('season.' + regimeOf(app.world.climate))}</b>`);
  let st = '';
  if (app.lease) st = `${t('status.computing')} <span class="num">${ROMAN[app.lease.unit.region]}</span><span class="bar"><i style="width:${(100 * app.lease.step / STEPS) | 0}%"></i></span>`;
  else if (DEMO) st = t('status.demo');
  else st = t('status.' + (app.link === 'ok' ? 'sync' : app.link));
  put($('status'), 'status', st);
}
