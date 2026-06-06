// scripts/ema-beta.mjs
// Per-instrument beta (estimated on TRAIN returns, frozen) and sign-aware per-trade
// market-neutralized residual. residual = net - direction * beta * benchRet.

export function olsBeta(assetRets, benchRets) {
  const n = Math.min(assetRets.length, benchRets.length);
  if (n < 2) return 0;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i += 1) { mx += benchRets[i]; my += assetRets[i]; }
  mx /= n; my /= n;
  let cov = 0, varx = 0;
  for (let i = 0; i < n; i += 1) { const dx = benchRets[i] - mx; cov += dx * (assetRets[i] - my); varx += dx * dx; }
  return varx === 0 ? 0 : cov / varx;
}

export function dailyReturns(bars) {
  const r = [];
  for (let i = 1; i < bars.length; i += 1) r.push({ date: bars[i].date, ret: bars[i].close / bars[i - 1].close - 1 });
  return r;
}

export function benchReturnOverWindow(benchByDate, entryDate, exitDate) {
  const a = benchByDate.get(entryDate), b = benchByDate.get(exitDate);
  if (!a || !b) return null;
  return b.close / a.close - 1;
}

export function residual(net, { direction, beta, benchRet }) {
  return net - direction * beta * benchRet;
}
