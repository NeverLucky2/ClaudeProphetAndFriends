// scripts/coil-catalyst-features.mjs
// Deterministic price-signature features at a bar index, from OHLCV bars.
// All null-guarded: a feature is null when its trailing window is too short or
// degenerate (zero volume / zero range). The composite is null if any input is null.
const VOL_WINDOW = 30, RANGE_WINDOW = 20;

function trueRange(bars, i) {
  const h = bars[i].high, l = bars[i].low, pc = bars[i - 1].close;
  return Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
}

export function features(bars, i) {
  const f = { gap_pct: null, prior_day_return: null, drawdown_5d: null, volume_ratio: null, range_zscore: null };
  if (i < 1) return f;
  const prevC = bars[i - 1].close;
  if (prevC > 0) {
    f.gap_pct = bars[i].open / prevC - 1;
    f.prior_day_return = bars[i].close / prevC - 1;
  }
  if (i >= 4) {
    let hi = -Infinity; for (let k = i - 4; k <= i; k += 1) hi = Math.max(hi, bars[k].high);
    if (hi > 0) f.drawdown_5d = bars[i].close / hi - 1;
  }
  if (i >= VOL_WINDOW) {
    let s = 0; for (let k = i - VOL_WINDOW; k < i; k += 1) s += bars[k].volume;
    const avg = s / VOL_WINDOW;
    if (avg > 0) f.volume_ratio = bars[i].volume / avg;
  }
  if (i >= RANGE_WINDOW + 1) {
    const trs = []; for (let k = i - RANGE_WINDOW; k < i; k += 1) trs.push(trueRange(bars, k));
    const mean = trs.reduce((a, b) => a + b, 0) / trs.length;
    const sd = Math.sqrt(trs.reduce((a, b) => a + (b - mean) ** 2, 0) / trs.length);
    if (sd > 0) f.range_zscore = (trueRange(bars, i) - mean) / sd;
  }
  return f;
}

export function composite(f) {
  if (f.volume_ratio == null || f.gap_pct == null) return null;
  return f.volume_ratio * Math.abs(f.gap_pct);
}
