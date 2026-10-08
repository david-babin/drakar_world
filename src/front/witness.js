// The witness. Nothing explains the page. After five seconds the witness block invites with a halo; on contact, a whisper.
import { ROMAN } from '../lib/index.js';
import { app } from './state.js';
import { witness, whisper } from './dom.js';
import { ME } from './identity.js';
import { tele } from './telemetry.js';
import { t, L, fill, fmt } from './i18n.js';
import { INVITE_AFTER_MS, WHISPER_MS } from './constants.js';

// Nothing explains the page. After five seconds the witness block invites with a halo; on contact, a whisper.
let whisperTimer = null, whispered = 0;
const inviteTimer = setTimeout(() => witness.classList.add('invite'), INVITE_AFTER_MS);
witness.addEventListener('click', () => {
  clearTimeout(inviteTimer); witness.classList.remove('invite');
  const lines = L().whispers || [];
  whisper.querySelector('p').innerHTML = fill(lines[whispered++ % Math.max(1, lines.length)], { me: ME });
  whisper.querySelector('small').textContent = [
    tele.cores ? t('machine.cpu', { n: tele.cores }) : null, tele.mem ? t('machine.mem', { n: tele.mem }) : null,
    tele.dps ? t('machine.dps', { n: fmt(tele.dps) }) : null, app.lease ? t('machine.region', { r: ROMAN[app.lease.unit.region] }) : null,
    app.online > 1 ? t('machine.online', { n: app.online }) : null,
  ].filter(Boolean).join(' · ');
  whisper.classList.add('on'); clearTimeout(whisperTimer); whisperTimer = setTimeout(() => whisper.classList.remove('on'), WHISPER_MS);
});
