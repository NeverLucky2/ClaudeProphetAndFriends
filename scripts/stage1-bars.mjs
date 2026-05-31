// scripts/stage1-bars.mjs
// Pure helpers over an ascending [{date,open,high,low,close}] bar array.
// Lookahead discipline: signal helpers read only indices <= d; forwardReturn
// reads only d+1 (entry) and d+H (exit). Spec §2/§2.1.

export function sma(bars, idx, window) {
  if (idx < window - 1) return null;
  let s = 0;
  for (let i = idx - window + 1; i <= idx; i += 1) s += bars[i].close;
  return s / window;
}

export function ret(bars, idx, lookback) {
  if (idx < lookback) return null;
  return bars[idx].close / bars[idx - lookback].close - 1;
}

// +1 bullish / -1 bearish / 0 neutral (no-fire). Reads only indices <= idx.
export function priceState(bars, idx) {
  const m = sma(bars, idx, 20);
  const r5 = ret(bars, idx, 5);
  if (m === null || r5 === null) return 0;
  const c = bars[idx].close;
  if (c > m && r5 > 0) return 1;
  if (c < m && r5 < 0) return -1;
  return 0;
}

// Entry = open[idx+1], exit = close[idx+H]; R signed by direction s. Lookahead-safe.
export function forwardReturn(bars, idx, H, s) {
  const entryIdx = idx + 1;
  const exitIdx = idx + H;
  if (exitIdx > bars.length - 1) return null;
  const entry = bars[entryIdx].open;
  const exit = bars[exitIdx].close;
  if (!(entry > 0)) return null;
  const R = s * (exit / entry - 1);
  return { R, hit: R > 0, entryIdx, exitIdx };
}
