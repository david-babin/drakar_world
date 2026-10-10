// drakar.tech — the page. Bundled by tools/build.mjs into public/app.js.
import { app, DEMO, WALLPAPER, EMBED } from './state.js';
import { cam } from './camera.js';
import { IDLE_FRAMES } from './constants.js';
import { applyLang, onLangChange } from './i18n.js';
import { renderChronicle } from './chronicle.js';
import { hud } from './hud.js';
import './render.js';                       // starts the frame loop
import './input.js';
import './witness.js';
import { loopServer } from './net.js';
import { loopDemo } from './demo.js';

onLangChange(() => { if (app.world) { renderChronicle(); hud(); } });
applyLang();
if (WALLPAPER) { document.body.classList.add('wallpaper'); cam.idle = IDLE_FRAMES; }
if (EMBED) document.body.classList.add('embed');   // no waiting: the camera follows the active region at once
(DEMO ? loopDemo : loopServer)();
