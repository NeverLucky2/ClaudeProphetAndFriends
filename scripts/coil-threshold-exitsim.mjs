// scripts/coil-threshold-exitsim.mjs
// Pure backtest primitives for the Coil RSI-threshold study:
//   - entryFiresAt: Coil's entry predicate with a parametrized RSI bound (only the
//     RSI threshold moves; the SMA200 regime + SMA5 pullback gates are unchanged).
//   - simulateTrade: faithful simulation of Coil's real exits.
// Reuses the production signal math; never mutates it.
import { wilderRSI, sma } from './coil-meanrev-signal.mjs';

// Mirror coil-meanrev-signal.mjs's module-local constants (not exported there).
const RSI_PERIOD = 2, SMA200 = 200, SMA5 = 5, MIN_BARS = 210;

// Coil's entry predicate with RSI(2) < rsiMax (rsiMax=5 reproduces production entryFires).
export function entryFiresAt(closes, idx, rsiMax) {
  if (idx + 1 < MIN_BARS) return false;
  const rsi2 = wilderRSI(closes.slice(0, idx + 1), RSI_PERIOD);
  const s200 = sma(closes, idx, SMA200);
  const s5 = sma(closes, idx, SMA5);
  if (s200 === null || s5 === null) return false;
  const c = closes[idx];
  return rsi2 < rsiMax && c > s200 && c < s5;
}

function done(entry, exit, reason, k) {
  return { entry, exit, exitReason: reason, daysHeld: k, grossReturn: (exit - entry) / entry, censored: false };
}

// Simulate Coil's real exits from a fill at close[entryIdx]. First trigger wins; within a
// bar the intraday -7% stop (gap-honest) precedes the close-based exits, then the 5-day
// timeout. No lookahead: each check at d+k uses only bars[0..d+k].
export function simulateTrade(bars, entryIdx, { stopPct = 0.07, maxHold = 5, rsiExit = 70 } = {}) {
  const closes = bars.map(b => b.close);
  const entry = closes[entryIdx];
  const stop = entry * (1 - stopPct);
  for (let k = 1; k <= maxHold; k += 1) {
    const j = entryIdx + k;
    if (j >= bars.length) {
      return { entry, exit: null, exitReason: null, daysHeld: k - 1, grossReturn: null, censored: true };
    }
    const bar = bars[j];
    if (bar.open <= stop) return done(entry, bar.open, 'stop', k);   // gap-through fills at open
    if (bar.low <= stop) return done(entry, stop, 'stop', k);         // intraday touch fills at stop
    const rsi2 = wilderRSI(closes.slice(0, j + 1), RSI_PERIOD);
    if (rsi2 > rsiExit) return done(entry, bar.close, 'rsi_mean_cross', k);
    const s5 = sma(closes, j, SMA5);
    if (s5 !== null && bar.close > s5) return done(entry, bar.close, 'sma5_cross', k);
    if (k === maxHold) return done(entry, bar.close, 'time_stop', k);
  }
  return { entry, exit: null, exitReason: null, daysHeld: maxHold, grossReturn: null, censored: true };
}
