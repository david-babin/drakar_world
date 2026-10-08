// HUD: the era (top left), the witness block (top right), the region being computed (bottom left).
import { STEPS, ROMAN, regimeOf } from '../lib/index.js';
import { app, DEMO } from './state.js';
import { $, witness } from './dom.js';
import { ME } from './identity.js';
import { t, L, fmt } from './i18n.js';

export function hud() {
  $('era').textContent = t('year', { n: fmt(app.world.year) });
  const m = app.world.market, nl = L().numberLocale || 'en-GB';
  const mk = m ? `${t('index')} ${m.close.toLocaleString(nl, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <i class="${m.change < 0 ? 'dn' : ''}">${m.change >= 0 ? '▲' : '▼'} ${Math.abs(m.change).toLocaleString(nl, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} %</i>${m.live ? ` · <b>${t('live')}</b>` : ''}` : '';
  witness.querySelector('.sg').textContent = ME;
  witness.querySelector('.mk').innerHTML = `${mk}<br>${t('climate')} <b>${t('season.' + regimeOf(app.world.climate))}</b>`;
  let st = '';
  if (app.lease) st = `${t('status.computing')} <i>${ROMAN[app.lease.unit.region]}</i><span class="bar"><i style="width:${(100 * app.lease.step / STEPS) | 0}%"></i></span>`;
  else if (DEMO) st = t('status.demo');
  else st = t('status.' + (app.link === 'ok' ? 'sync' : app.link));
  $('status').innerHTML = st;
}
