// Dated random walk: the same value for everyone on a given day, no network needed.
// Shared: the server falls back to it without a market feed, the demo mode runs on it.
export function synthetic(day = new Date()) {
  const d0 = Date.UTC(2026, 0, 1), n = Math.floor((day.getTime() - d0) / 86400_000);
  let v = 6000, prev = 6000, seed = 0x2545F491;
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) / 4294967296) - 0.5; };
  for (let i = 0; i <= n; i++) { prev = v; v *= 1 + rnd() * 0.02 + 0.0003; }
  return { date: day.toISOString().slice(0, 10), close: Math.round(v * 100) / 100, prev: Math.round(prev * 100) / 100, change: ((v - prev) / prev) * 100, source: 'synthetic' };
}
