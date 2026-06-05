// Event-driven Coil book sim on the TIMEOUT axis. Every candidate is already an RSI<5 entry
// (no threshold filter); the variant is encoded in each candidate's exitDate/net. Most-oversold
// first, one-per-ticker, max positions, deploy cap. Non-compounding fixed-fractional accounting.
export function simulateTimeoutPortfolio(candidates, { maxPositions = 4, sizePct = 0.05, deployCap = 0.24 } = {}) {
  const elig = candidates.filter(c => c.exitDate && Number.isFinite(c.net));
  const dates = [...new Set(elig.map(c => c.date))].sort();
  const byDate = new Map(dates.map(d => [d, []]));
  for (const c of elig) byDate.get(c.date).push(c);

  const open = []; const fills = []; const blocked = []; let cum = 0; const curve = [];
  const realizeUpTo = (date) => {
    for (let i = open.length - 1; i >= 0; i -= 1) {
      if (open[i].exitDate <= date) { cum += sizePct * open[i].net; curve.push({ date, cum }); open.splice(i, 1); }
    }
  };
  for (const date of dates) {
    realizeUpTo(date);
    const held = new Set(open.map(p => p.ticker));
    const cands = byDate.get(date).slice().sort((a, b) => a.rsi2 - b.rsi2);
    for (const c of cands) {
      if (held.has(c.ticker)) continue;                                       // dup ticker, not "blocked"
      if (open.length >= maxPositions || open.length * sizePct + sizePct > deployCap + 1e-9) { blocked.push(c); continue; }
      open.push({ ticker: c.ticker, exitDate: c.exitDate, net: c.net }); held.add(c.ticker); fills.push(c);
    }
  }
  for (const p of open) { cum += sizePct * p.net; curve.push({ date: p.exitDate, cum }); }

  let peak = 0, maxDrawdown = 0;
  for (const pt of curve) { peak = Math.max(peak, pt.cum); maxDrawdown = Math.min(maxDrawdown, pt.cum - peak); }
  return { fills, blocked, totalNet: cum, maxDrawdown, nTrades: fills.length, curve };
}

// Signals entered at baseline (T=5) but NOT entered at variant T — the realized opportunity cost
// of holding slots longer. Keyed by ticker@date.
export function blockedByExtension(p5, pT) {
  const key = (f) => `${f.ticker}@${f.date}`;
  const filledT = new Set(pT.fills.map(key));
  const lost = p5.fills.filter(f => !filledT.has(key(f)));
  return { count: lost.length, signals: lost.map(f => ({ ticker: f.ticker, date: f.date, rsi2: f.rsi2, net: f.net })) };
}

// Deepest peak-to-trough on a [{date,cum}] curve (cum is cumulative return). dd <= 0.
export function deepestDD(curve) {
  let peak = 0, dd = 0, at = null;
  for (const pt of curve) { peak = Math.max(peak, pt.cum); const d = pt.cum - peak; if (d < dd) { dd = d; at = pt.date; } }
  return { dd, at };
}
