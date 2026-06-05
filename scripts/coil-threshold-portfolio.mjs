// scripts/coil-threshold-portfolio.mjs
// Event-driven Coil portfolio sim. Input: candidate trades {ticker,date,rsi2,exitDate,net}
// (net already friction-adjusted). Honors max positions, one-per-ticker, most-oversold-first,
// and an RSI threshold T. Non-compounding fixed-fractional accounting for fair cross-T compare.

export function simulatePortfolio(trades, { T = 5, maxPositions = 4, sizePct = 0.05, deployCap = 0.24 } = {}) {
  const eligible = trades.filter(t => t.rsi2 < T);
  const dates = [...new Set(eligible.map(t => t.date))].sort();
  const byDate = new Map(dates.map(d => [d, []]));
  for (const t of eligible) byDate.get(t.date).push(t);

  const open = [];           // [{ticker, exitDate, net}]
  const fills = [];          // trades actually entered
  let cum = 0; const curve = []; // cumulative net return after each realized exit
  const realizeUpTo = (date) => {
    for (let i = open.length - 1; i >= 0; i -= 1) {
      if (open[i].exitDate <= date) { cum += sizePct * open[i].net; curve.push(cum); open.splice(i, 1); }
    }
  };

  for (const date of dates) {
    realizeUpTo(date);                                   // free slots whose exit has passed
    const held = new Set(open.map(p => p.ticker));
    const candidates = byDate.get(date).slice().sort((a, b) => a.rsi2 - b.rsi2);
    for (const c of candidates) {
      if (open.length >= maxPositions) break;
      if (open.length * sizePct + sizePct > deployCap + 1e-9) break;
      if (held.has(c.ticker)) continue;
      open.push({ ticker: c.ticker, exitDate: c.exitDate, net: c.net });
      held.add(c.ticker);
      fills.push(c);
    }
  }
  // realize any still-open positions at the end
  for (const p of open) { cum += sizePct * p.net; curve.push(cum); }

  let peak = 0, maxDrawdown = 0;
  for (const v of curve) { peak = Math.max(peak, v); maxDrawdown = Math.min(maxDrawdown, v - peak); }
  return { T, fills, totalNet: cum, maxDrawdown, nTrades: fills.length, curve };
}

// Trades present in `loose` fills but absent from `base` fills, keyed by ticker+date.
export function marginalFills(baseFills, looseFills) {
  const key = (f) => `${f.ticker}@${f.date}`;
  const baseKeys = new Set(baseFills.map(key));
  return looseFills.filter(f => !baseKeys.has(key(f)));
}
