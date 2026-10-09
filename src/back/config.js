// Runtime configuration: environment variables, paths. The bundle runs from bin/, the site lives in public/.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from './constants.js';

const ROOT = process.env.ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const config = {
  root: ROOT,
  publicDir: path.join(ROOT, 'public'),
  port: +(process.env.PORT || DEFAULTS.port),
  db: process.env.DB || path.join(ROOT, 'world.db'),
  seed: +(process.env.SEED || DEFAULTS.seed),
  dev: process.env.NODE_ENV !== 'production',
  finnhubKey: process.env.FINNHUB_KEY || '',
  symbol: process.env.MARKET_SYMBOL || DEFAULTS.symbol,
  // deployed commit, when the platform provides it at runtime (Coolify: SOURCE_COMMIT)
  commit: /^[0-9a-f]{7,40}$/i.test(process.env.SOURCE_COMMIT || '') ? process.env.SOURCE_COMMIT.slice(0, 7) : null,
};
