// scripts/ema-indicators.mjs
// Pure technical indicators for the EMA-pullback study. Each returns an array aligned to
// the input (value[i] uses only bars[0..i] — no lookahead). null until enough history.

export function ema(closes, period) {
  const out = new Array(closes.length).fill(null);
  if (period <= 0 || closes.length < period) return out;
  let seed = 0;
  for (let i = 0; i < period; i += 1) seed += closes[i];
  seed /= period;
  out[period - 1] = seed;
  const k = 2 / (period + 1);
  let prev = seed;
  for (let i = period; i < closes.length; i += 1) {
    prev = (closes[i] - prev) * k + prev;
    out[i] = prev;
  }
  return out;
}

function trueRanges(bars) {
  const tr = new Array(bars.length).fill(null);
  for (let i = 1; i < bars.length; i += 1) {
    const h = bars[i].high, l = bars[i].low, pc = bars[i - 1].close;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  return tr;
}

export function atrWilder(bars, period = 14) {
  const out = new Array(bars.length).fill(null);
  const tr = trueRanges(bars);
  if (bars.length <= period) return out;
  let seed = 0;
  for (let i = 1; i <= period; i += 1) seed += tr[i]; // TR[1..period]
  seed /= period;
  out[period] = seed;
  let prev = seed;
  for (let i = period + 1; i < bars.length; i += 1) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

export function cci(bars, period = 20) {
  const out = new Array(bars.length).fill(null);
  const tp = bars.map(b => (b.high + b.low + b.close) / 3);
  for (let i = period - 1; i < bars.length; i += 1) {
    let sma = 0;
    for (let j = i - period + 1; j <= i; j += 1) sma += tp[j];
    sma /= period;
    let md = 0;
    for (let j = i - period + 1; j <= i; j += 1) md += Math.abs(tp[j] - sma);
    md /= period;
    out[i] = md === 0 ? 0 : (tp[i] - sma) / (0.015 * md);
  }
  return out;
}
