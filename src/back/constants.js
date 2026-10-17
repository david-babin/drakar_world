// Server-only settings. Environment variables override the first block (see config.js).
export const DEFAULTS = { port: 8787, seed: 20261007, symbol: 'SPY' };

// world
export const VERIFY_EVERY = 7;                 // 1 unit in 7 is recomputed server-side
export const SAVE_MS = 5000;                   // the world is written to SQLite at most this often
export const SNAPSHOT_MS = 3600_000;           // one dated snapshot per hour
export const LEGACY_DB = 'monde.db';           // former database name, adopted on startup
// retention of the witnesses' pseudonymous data (sigils, privacy policy): the unit log, the snapshots and the
// sigils kept in the world (contributors, chronicle, settlements, routes) are deleted or anonymized past this age
export const RETENTION_MS = 365 * 86400_000;   // 12 months
export const PURGE_EVERY_MS = 86400_000;       // the purge runs at startup, then daily

// visitors (WebSocket)
export const WS_PATH = '/ws';
export const ENGINE_FILE = 'engine.js';        // the compute engine every witness loads (see docs/protocol.md)
export const HEARTBEAT_MS = 20_000;            // application heartbeat: clients detect a dead link with it
export const WS_PING_MS = 25_000;              // protocol ping: the server drops silent clients with it
export const WS_MAX_MESSAGE = 4 * 1024 * 1024;
export const WS_DEFLATE_MIN = 192;             // below this, compression gains nothing
export const PROGRESS_MAX = 512;               // groups relayed per progress message
export const SIGIL_RE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
export const RECENT_UNITS = 20;                // units listed by /api/stats

// abuse limits (per visitor address, per connection) and cheating
export const WS_PER_IP = 8;                    // connections from one address (a household, an office)
export const LEASES_PER_IP = 4;                // regions computed at once from one address
export const MSG_RATE = 10, MSG_BURST = 40;    // messages a second per connection, and the burst allowed (progress: 2 a second)
export const RESYNC_MS = 5000;                 // at most one full world resent per connection in this time
export const PROBATION = 2;                    // the first results of each connection are always audited
export const BAN_MS = 24 * 3600_000;           // a cheater's address and sigil are refused this long

// read API: pages allowed to call it from the browser (the home page's live figures, local previews)
export const CORS_ORIGINS = new Set([
  'https://drakar.tech', 'https://www.drakar.tech',
  'http://localhost:8080', 'http://localhost:8081',
]);

// static files
export const MIME = {
  '.webmanifest': 'application/manifest+json', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.bin': 'application/octet-stream',
};
export const PRECOMPRESSED = ext => ext !== '.png' && ext !== '.woff2';   // already compressed formats are left alone
export const DAY_CACHED = ['.png', '.svg', '.woff2'];                      // unversioned images: cached one day
export const IMMUTABLE = 'public, max-age=31536000, immutable';            // URL carrying the file's fingerprint (?v=)

// market
export const MARKET_EVERY_KEY_MS = 10 * 60_000;     // REST refresh with a Finnhub key
export const MARKET_EVERY_FREE_MS = 30 * 60_000;    // keyless sources
export const MARKET_FETCH_TIMEOUT_MS = 8000;
export const MARKET_STALE_MS = 3 * 86400_000;       // beyond this without data, fall back to the synthetic feed
export const MARKET_NOTIFY_MS = 1000;               // live trades: at most one broadcast per second
export const MARKET_FEED_SILENT_MS = 180_000;       // silent Finnhub socket: reconnect
export const MARKET_LIVE_STALE_MS = 120_000;        // no trade for this long: no longer "live"
export const MARKET_HISTORY = 30;                   // days returned by /api/market
export const USER_AGENT = 'drakar-world/0.4 (+https://world.drakar.tech)';
