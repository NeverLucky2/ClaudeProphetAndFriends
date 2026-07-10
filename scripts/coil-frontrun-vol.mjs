// scripts/coil-frontrun-vol.mjs
// SPY trailing realized-volatility terciles — the confound control for the front-run study.
// Low-volatility years produce fewer deep-oversold events regardless of any crowding, so every
// conversion statistic is reported within tercile as well as pooled.
//
// Tercile boundaries are computed ONCE over the historical sample and then FROZEN into the
// pre-registration, so the forward window is scored against fixed edges, not re-fit ones.

export const VOL_WINDOW = 20;

// realizedVolSeries: date -> stdev of the trailing `window` daily log returns.
// The value at bars[i] uses returns for bars[i-window+1 .. i] — no lookahead.
export function realizedVolSeries(bars, window = VOL_WINDOW) {
  const out = new Map();
  if (bars.length < window + 1) return out;
  const r = [];
  for (let i = 1; i < bars.length; i += 1) r.push(Math.log(bars[i].close / bars[i - 1].close));
  // r[i-1] is the return arriving at bars[i].
  for (let i = window; i < bars.length; i += 1) {
    const w = r.slice(i - window, i);
    const m = w.reduce((a, b) => a + b, 0) / w.length;
    const varr = w.reduce((a, b) => a + (b - m) * (b - m), 0) / (w.length - 1);
    out.set(bars[i].date, Math.sqrt(varr));
  }
  return out;
}

export function tercileBoundaries(volValues) {
  const s = [...volValues].filter(Number.isFinite).sort((a, b) => a - b);
  if (s.length < 3) return null;
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { lo: q(1 / 3), hi: q(2 / 3) };
}

export function tercileOf(vol, boundaries) {
  if (!boundaries || !Number.isFinite(vol)) return null;
  if (vol <= boundaries.lo) return 'low';
  if (vol <= boundaries.hi) return 'mid';
  return 'high';
}
