// scripts/coil-opt-rv.mjs
// Annualized trailing realized vol (sample stdev of `window` simple daily returns ending at idx).
export function trailingRealizedVol(closes, idx, window) {
  if (idx < window) return null;
  const rets = [];
  for (let i = idx - window + 1; i <= idx; i += 1) rets.push(closes[i] / closes[i - 1] - 1);
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const varc = rets.reduce((a, b) => a + (b - m) * (b - m), 0) / (rets.length - 1);
  return Math.sqrt(varc) * Math.sqrt(252);
}
