// market.js — l'indice comme climat du monde.
// Avec FINNHUB_KEY : cotation SPY (ETF répliquant le S&P 500) en REST au démarrage et toutes les
// 10 min, puis trades en direct par WebSocket (wss://ws.finnhub.io). Le climat respire pendant la séance.
// Sans clé : Stooq → Yahoo → FRED (sans clé, valeur journalière) ; repli synthétique daté si tout échoue.

const FINNHUB_KEY = process.env.FINNHUB_KEY || '';
const SYMBOL = process.env.MARKET_SYMBOL || 'SPY';

const SOURCES = [
  FINNHUB_KEY && {
    name: 'finnhub',
    url: `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(SYMBOL)}&token=${FINNHUB_KEY}`,
    parse(text) {
      const q = JSON.parse(text);
      if (!(q.c > 0 && q.pc > 0)) throw new Error('cotation vide');
      return { date: new Date((q.t || Date.now() / 1000) * 1000).toISOString().slice(0, 10), close: q.c, prev: q.pc, change: ((q.c - q.pc) / q.pc) * 100 };
    },
  },
  {
    name: 'stooq',
    url: 'https://stooq.com/q/l/?s=^spx&f=sd2t2ohlcv&h&e=csv',
    parse(text) {
      const lines = text.trim().split('\n'); if (lines.length < 2) throw new Error('csv vide');
      const [, date, , open, , , close] = lines[1].split(',');
      const c = +close, o = +open; if (!(c > 0)) throw new Error('clôture absente');
      return { date, close: c, prev: o, change: ((c - o) / o) * 100 };
    },
  },
  {
    name: 'yahoo',
    url: 'https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?range=5d&interval=1d',
    parse(text) {
      const r = JSON.parse(text).chart.result[0], m = r.meta;
      const c = m.regularMarketPrice, p = m.chartPreviousClose || m.previousClose;
      if (!(c > 0 && p > 0)) throw new Error('prix absent');
      return { date: new Date(m.regularMarketTime * 1000).toISOString().slice(0, 10), close: c, prev: p, change: ((c - p) / p) * 100 };
    },
  },
  {
    name: 'fred',
    url: 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=SP500',
    parse(text) {
      const rows = text.trim().split('\n').slice(1).map(l => l.split(',')).filter(r => r[1] && r[1] !== '.');
      if (rows.length < 2) throw new Error('série vide');
      const [d, c] = rows[rows.length - 1], [, p] = rows[rows.length - 2];
      return { date: d, close: +c, prev: +p, change: ((+c - +p) / +p) * 100 };
    },
  },
].filter(Boolean);

// Marche aléatoire datée : même valeur pour tous le même jour, sans réseau.
export function synthetic(day = new Date()) {
  const d0 = Date.UTC(2026, 0, 1), n = Math.floor((day.getTime() - d0) / 86400_000);
  let v = 6000, prev = 6000, seed = 0x2545F491;
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) / 4294967296) - 0.5; };
  for (let i = 0; i <= n; i++) { prev = v; v *= 1 + rnd() * 0.02 + 0.0003; }
  return { date: day.toISOString().slice(0, 10), close: Math.round(v * 100) / 100, prev: Math.round(prev * 100) / 100, change: ((v - prev) / prev) * 100, source: 'synthétique' };
}

export function createMarket(db, { every = (FINNHUB_KEY ? 10 : 30) * 60_000, log = console.log } = {}) {
  db.exec('CREATE TABLE IF NOT EXISTS market (date TEXT PRIMARY KEY, close REAL, prev REAL, change REAL, source TEXT, fetched_at INTEGER)');
  const qPut = db.prepare('INSERT INTO market (date, close, prev, change, source, fetched_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(date) DO UPDATE SET close = excluded.close, prev = excluded.prev, change = excluded.change, source = excluded.source, fetched_at = excluded.fetched_at');
  const qLast = db.prepare('SELECT date, close, prev, change, source, fetched_at FROM market ORDER BY date DESC LIMIT 1');
  const qHist = db.prepare('SELECT date, close, change FROM market ORDER BY date DESC LIMIT 30');

  let current = qLast.get() || null;      // { date, close, prev, change, source, fetched_at, live?, at? }
  const listeners = new Set();
  const notify = () => { for (const f of listeners) f(current); };

  async function fetchOnce() {
    for (const s of SOURCES) {
      try {
        const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
        const res = await fetch(s.url, { signal: ctl.signal, headers: { 'user-agent': 'drakar.tech/0.2 (+https://drakar.tech)' } });
        clearTimeout(t);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const m = s.parse(await res.text());
        if (!Number.isFinite(m.change)) throw new Error('variation invalide');
        return { ...m, change: Math.round(m.change * 1000) / 1000, source: s.name };
      } catch (e) { log(`marché · ${s.name} indisponible : ${e.message}`); }
    }
    return null;
  }

  async function refresh() {
    const m = (await fetchOnce()) || (current && Date.now() - current.fetched_at < 3 * 86400_000 ? null : synthetic());
    if (m) {
      m.fetched_at = Date.now();
      qPut.run(m.date, m.close, m.prev, m.change, m.source, m.fetched_at);
      const changed = !current || current.date !== m.date || current.close !== m.close || current.source !== m.source;
      current = { ...m, live: current?.live && current.source === m.source ? current.live : false, at: Date.now() };
      if (changed) { log(`marché · ${m.source} · ${m.date} · ${m.close} (${m.change > 0 ? '+' : ''}${m.change.toFixed(2)} %)`); notify(); }
    }
    return current;
  }

  // ---- flux temps réel Finnhub ----
  let ws = null, backoff = 5000, lastNotify = 0, lastTradeAt = 0, pending = null, stopped = false;
  function connectLive() {
    if (!FINNHUB_KEY || stopped || typeof WebSocket === 'undefined') return;
    try { ws = new WebSocket(`wss://ws.finnhub.io?token=${FINNHUB_KEY}`); } catch (e) { log('marché · websocket impossible : ' + e.message); return; }
    ws.onopen = () => { backoff = 5000; ws.send(JSON.stringify({ type: 'subscribe', symbol: SYMBOL })); log(`marché · flux ${SYMBOL} connecté`); };
    ws.onmessage = ev => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type !== 'trade' || !msg.data?.length || !current || !(current.prev > 0)) return;
      const last = msg.data[msg.data.length - 1];
      const price = last.p; if (!(price > 0)) return;
      lastTradeAt = Date.now();
      const change = Math.round(((price - current.prev) / current.prev) * 100 * 1000) / 1000;
      const moved = Math.abs(change - current.change) >= 0.005 || current.close !== price;
      current = { ...current, close: price, change, source: 'finnhub', live: true, at: lastTradeAt };
      if (!moved) return;
      // au plus une diffusion par seconde
      const now = Date.now();
      if (now - lastNotify >= 1000) { lastNotify = now; notify(); }
      else if (!pending) pending = setTimeout(() => { pending = null; lastNotify = Date.now(); notify(); }, 1000 - (now - lastNotify));
    };
    ws.onerror = () => {};
    ws.onclose = () => { ws = null; if (current?.live) { current = { ...current, live: false }; notify(); } if (!stopped) { setTimeout(connectLive, backoff); backoff = Math.min(60_000, backoff * 2); } };
  }
  // sans trade depuis 2 min (marché fermé ou flux muet), on cesse de dire « en direct »
  const liveWatch = setInterval(() => { if (current?.live && Date.now() - lastTradeAt > 120_000) { current = { ...current, live: false }; notify(); } }, 30_000); liveWatch.unref();

  const timer = setInterval(refresh, every); timer.unref();
  refresh().then(connectLive);
  return {
    get current() { return current; },
    get symbol() { return SYMBOL; },
    get hasKey() { return !!FINNHUB_KEY; },
    history: () => qHist.all(),
    refresh,
    onChange: f => listeners.add(f),
    stop: () => { stopped = true; clearInterval(timer); clearInterval(liveWatch); try { ws?.close(); } catch {} },
  };
}
