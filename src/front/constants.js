// Page settings: rendering, interaction, recovery, timings.
export const DEG = Math.PI / 180;
export const STORAGE = { lang: 'drakar.lang', sigil: 'drakar.sigil' };   // localStorage keys

// rendering
export const MAX_DPR = 3;                  // native density up to 3× (phones are often 2.6–3×)
export const MASK_MAX = 4096;              // land mask texture width (equirectangular, height = width / 2)
export const LINE_CHUNK = 16000;           // segments per 16-bit index chunk
export const LINE_INK = [0.925, 0.922, 0.902];   // charte: ink #ecebe6
export const CONTOUR_ALPHA = [0.08, 0.12, 0.16, 0.20, 0.24];   // 500 / 1000 / 2000 / 3000 / 4000 m
export const CONTOUR_WIDTH = 0.8;
export const COAST_ALPHA = 0.34;
export const COAST_WIDTH = 1.2;
// overlay colours (charte, theme nuit), as "r,g,b" for rgba() or full CSS colours
export const COLORS = {
  slate: '138,163,180',                   // #8aa3b4: data
  inkMuted: '154,163,173',                // #9aa3ad: labels
  peerBox: 'rgba(94,107,122,.7)',          // hairline-strong: another witness computing
  ownBox: 'rgba(212,165,58,.75)',          // brass: this witness computing
};
export const FONTS = { label: '600 10px Manrope, system-ui, sans-serif', data: '500 10px "JetBrains Mono", ui-monospace, monospace' };
// lineage colours, saturation and lightness (the hue is the lineage's): the project's original bright palette,
// kept apart from the charte so that the civilisations stand out on the globe
export const LINEAGE = { route: '45%,70%', settlement: '55%,62%', group: '60%,66%', area: '60%,68%', event: '60%,66%' };
export const CITY_SOULS = 10000;           // each 10,000 souls of a settlement area makes a bigger point
export const URBAN_LINK = 3;               // groups of one lineage within this many cells form one area
export const MEMORY_MS = 20000;            // a recent event rings on the globe this long
export const PEER_TTL = 6000;              // another witness's region fades without progress for this long

// camera and interaction
export const LAT_LIMIT = 80 * DEG;
export const ZOOM_MIN = 0.6, ZOOM_MAX = 5;
export const IDLE_FRAMES = 360;            // ~6 s without interaction: the camera glides to the active region

// witness and chronicle
export const INVITE_AFTER_MS = 5000;
export const WHISPER_MS = 3600;
export const CHRONICLE_LINES = 14;         // lines shown
export const CHRONICLE_MEMORY = 60;        // entries kept client-side (for the rings)

// computing
export const PROGRESS_EVERY_MS = 500;      // progress sent to the other witnesses

// connection and recovery (the server sends a heartbeat every 20 s)
export const NET = {
  path: '/ws',
  engine: '/engine.js',
  backoffMin: 1000, backoffMax: 15000,     // reconnection delay, doubling
  deadAfterMs: 45000,                      // no message for this long: the link is dead
  watchEveryMs: 5000,
  silentOnWakeMs: 30000,                   // on focus / online: an open socket silent this long is replaced
  connectingMs: 10000,                     // a socket stuck connecting this long is replaced
  awayFreshMs: 20000,                      // back in the foreground after this long: always a fresh connection
  leaseStaleMs: 80000,                     // a unit older than this is not sent (its lease has expired)
  askTimeoutMs: 20000,                     // a lease or result unanswered this long: reconnect
  noUnitRetryMs: 4000, errorRetryMs: 5000,
  pauseMin: 900, pauseJitter: 1500,        // pause between two units
  wallpaperPauseMs: 60000,                 // wallpaper mode: one unit a minute
  wallpaperBatteryPauseMs: 300000,         // … every five minutes on battery
};

// demo mode: a simulated past
export const DEMO_WORLD = { seed: 20261007, units: 96, ageDays: 37, gapMs: 3 * 3600000, ghosts: ['K7QD-3MZA', 'B2VX-9HLP', 'ZQ0F-P1NR', 'H8WT-4ECS'] };
