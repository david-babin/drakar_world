// What the page knows of the machine computing the world (shown in the whisper, used to size compute slices).
export const tele = { cores: navigator.hardwareConcurrency || 0, mem: navigator.deviceMemory || 0, batt: null, net: null, fps: 0, dps: 0, units: 0, ticks: 0, decisions: 0 };
(async () => {
  try { const b = await navigator.getBattery?.(); if (b) { const u = () => tele.batt = { level: b.level, charging: b.charging }; u(); b.onlevelchange = b.onchargingchange = u; } } catch {}
  try { const n = navigator.connection; if (n) { const u = () => tele.net = { type: n.effectiveType, rtt: n.rtt }; u(); n.onchange = u; } } catch {}
})();
