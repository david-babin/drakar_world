// Daily quote sources, tried in order: Finnhub (with a key), then keyless Stooq → Yahoo → FRED.
// Each returns { date, close, prev, change } — change in % since the previous close.
export const sources = ({ key, symbol }) => [
  key && {
    name: 'finnhub',
    url: `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${key}`,
    parse(text) {
      const q = JSON.parse(text);
      if (!(q.c > 0 && q.pc > 0)) throw new Error('empty quote');
      return { date: new Date((q.t || Date.now() / 1000) * 1000).toISOString().slice(0, 10), close: q.c, prev: q.pc, change: ((q.c - q.pc) / q.pc) * 100 };
    },
  },
  {
    name: 'stooq',
    url: 'https://stooq.com/q/l/?s=^spx&f=sd2t2ohlcv&h&e=csv',
    parse(text) {
      const lines = text.trim().split('\n'); if (lines.length < 2) throw new Error('empty csv');
      const [, date, , open, , , close] = lines[1].split(',');
      const c = +close, o = +open; if (!(c > 0)) throw new Error('missing close');
      return { date, close: c, prev: o, change: ((c - o) / o) * 100 };
    },
  },
  {
    name: 'yahoo',
    url: 'https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?range=5d&interval=1d',
    parse(text) {
      const r = JSON.parse(text).chart.result[0], m = r.meta;
      const c = m.regularMarketPrice, p = m.chartPreviousClose || m.previousClose;
      if (!(c > 0 && p > 0)) throw new Error('missing price');
      return { date: new Date(m.regularMarketTime * 1000).toISOString().slice(0, 10), close: c, prev: p, change: ((c - p) / p) * 100 };
    },
  },
  {
    name: 'fred',
    url: 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=SP500',
    parse(text) {
      const rows = text.trim().split('\n').slice(1).map(l => l.split(',')).filter(r => r[1] && r[1] !== '.');
      if (rows.length < 2) throw new Error('empty series');
      const [d, c] = rows[rows.length - 1], [, p] = rows[rows.length - 2];
      return { date: d, close: +c, prev: +p, change: ((+c - +p) / +p) * 100 };
    },
  },
].filter(Boolean);
