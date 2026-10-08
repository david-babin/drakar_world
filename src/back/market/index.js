// The index as the world's climate.
// With a Finnhub key: SPY quote (the ETF tracking the S&P 500) over REST at startup and every 10 min,
// then live trades over WebSocket (wss://ws.finnhub.io). The climate breathes during the session.
// Without a key: Stooq → Yahoo → FRED (keyless, daily value); dated synthetic fallback if everything fails.
import { MARKET_EVERY_KEY_MS, MARKET_EVERY_FREE_MS, MARKET_FETCH_TIMEOUT_MS, MARKET_STALE_MS, MARKET_NOTIFY_MS, MARKET_FEED_SILENT_MS, MARKET_LIVE_STALE_MS, MARKET_HISTORY, USER_AGENT } from '../constants.js';
import { sources } from './sources.js';
import { synthetic } from '../../lib/market.js';

export function createMarket(db, { key = '', symbol = 'SPY', every = key ? MARKET_EVERY_KEY_MS : MARKET_EVERY_FREE_MS, log = console.log } = {}) {
  const FINNHUB_KEY = key, SYMBOL = symbol, SOURCES = sources({ key, symbol });
  db.exec('CREATE TABLE IF NOT EXISTS market (date TEXT PRIMARY KEY, close REAL, prev REAL, change REAL, source TEXT, fetched_at INTEGER)');
  const qPut = db.prepare('INSERT INTO market (date, close, prev, change, source, fetched_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(date) DO UPDATE SET close = excluded.close, prev = excluded.prev, change = excluded.change, source = excluded.source, fetched_at = excluded.fetched_at');
  const qLast = db.prepare('SELECT date, close, prev, change, source, fetched_at FROM market ORDER BY date DESC LIMIT 1');
  const qHist = db.prepare('SELECT date, close, change FROM market ORDER BY date DESC LIMIT ' + MARKET_HISTORY);

  let current = qLast.get() || null;      // { date, close, prev, change, source, fetched_at, live?, at? }
  const listeners = new Set();
  const notify = () => { for (const f of listeners) f(current); };

  async function fetchOnce() {
    for (const s of SOURCES) {
      try {
        const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), MARKET_FETCH_TIMEOUT_MS);
        const res = await fetch(s.url, { signal: ctl.signal, headers: { 'user-agent': USER_AGENT } });
        clearTimeout(t);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const m = s.parse(await res.text());
        if (!Number.isFinite(m.change)) throw new Error('invalid change');
        return { ...m, change: Math.round(m.change * 1000) / 1000, source: s.name };
      } catch (e) { log(`market · ${s.name} unavailable: ${e.message}`); }
    }
    return null;
  }

  async function refresh() {
    const m = (await fetchOnce()) || (current && Date.now() - current.fetched_at < MARKET_STALE_MS ? null : synthetic());
    if (m) {
      m.fetched_at = Date.now();
      qPut.run(m.date, m.close, m.prev, m.change, m.source, m.fetched_at);
      const changed = !current || current.date !== m.date || current.close !== m.close || current.source !== m.source;
      current = { ...m, live: current?.live && current.source === m.source ? current.live : false, at: Date.now() };
      if (changed) { log(`market · ${m.source} · ${m.date} · ${m.close} (${m.change > 0 ? '+' : ''}${m.change.toFixed(2)} %)`); notify(); }
    }
    return current;
  }

  // ---- Finnhub live feed ----
  let ws = null, backoff = 5000, lastNotify = 0, lastTradeAt = 0, lastMsgAt = 0, pending = null, stopped = false;
  function connectLive() {
    if (!FINNHUB_KEY || stopped || typeof WebSocket === 'undefined') return;
    try { ws = new WebSocket(`wss://ws.finnhub.io?token=${FINNHUB_KEY}`); } catch (e) { log('market · websocket failed: ' + e.message); return; }
    lastMsgAt = Date.now();
    ws.onopen = () => { backoff = 5000; lastMsgAt = Date.now(); ws.send(JSON.stringify({ type: 'subscribe', symbol: SYMBOL })); log(`market · ${SYMBOL} feed connected`); };
    ws.onmessage = ev => {
      lastMsgAt = Date.now();
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type !== 'trade' || !msg.data?.length || !current || !(current.prev > 0)) return;
      const last = msg.data[msg.data.length - 1];
      const price = last.p; if (!(price > 0)) return;
      lastTradeAt = Date.now();
      const change = Math.round(((price - current.prev) / current.prev) * 100 * 1000) / 1000;
      const moved = Math.abs(change - current.change) >= 0.005 || current.close !== price;
      current = { ...current, close: price, change, source: 'finnhub', live: true, at: lastTradeAt };
      if (!moved) return;
      // at most one broadcast per second
      const now = Date.now();
      if (now - lastNotify >= MARKET_NOTIFY_MS) { lastNotify = now; notify(); }
      else if (!pending) pending = setTimeout(() => { pending = null; lastNotify = Date.now(); notify(); }, MARKET_NOTIFY_MS - (now - lastNotify));
    };
    ws.onerror = () => {};
    ws.onclose = () => { ws = null; if (current?.live) { current = { ...current, live: false }; notify(); } if (!stopped) { setTimeout(connectLive, backoff); backoff = Math.min(60_000, backoff * 2); } };
  }
  // silent connection (Finnhub sends regular pings): close it, which triggers a reconnect — useful after a sleep
  const deadWatch = setInterval(() => { if (ws && Date.now() - lastMsgAt > MARKET_FEED_SILENT_MS) { log('market · feed silent, reconnecting'); try { ws.close(); } catch {} } }, 30_000); deadWatch.unref();
  // no trade for 2 min (market closed or silent feed): stop claiming "live"
  const liveWatch = setInterval(() => { if (current?.live && Date.now() - lastTradeAt > MARKET_LIVE_STALE_MS) { current = { ...current, live: false }; notify(); } }, 30_000); liveWatch.unref();

  const timer = setInterval(refresh, every); timer.unref();
  refresh().then(connectLive);
  return {
    get current() { return current; },
    get symbol() { return SYMBOL; },
    get hasKey() { return !!FINNHUB_KEY; },
    history: () => qHist.all(),
    refresh,
    onChange: f => listeners.add(f),
    stop: () => { stopped = true; clearInterval(timer); clearInterval(liveWatch); clearInterval(deadWatch); try { ws?.close(); } catch {} },
  };
}
