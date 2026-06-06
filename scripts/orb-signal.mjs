// scripts/orb-signal.mjs
// Mechanical ORB signal: 15-min opening range, first VWAP-aligned close-break after 09:45,
// entry FILLED at the next bar's open (the breakout is only confirmed at the trigger close).
import { OR_END } from './orb-bars.mjs';
import { sessionVWAP } from './orb-indicators.mjs';

export function orbSignal(sessionBars) {
  const bars = sessionBars.bars;
  const orBars = bars.filter(b => b.minutes < OR_END);
  if (orBars.length < 3) return null; // need the full opening range
  const orHigh = Math.max(...orBars.map(b => b.high));
  const orLow = Math.min(...orBars.map(b => b.low));
  const vwap = sessionVWAP(bars);
  for (let i = 0; i < bars.length; i += 1) {
    if (bars[i].minutes < OR_END) continue;            // only post-OR bars trigger
    const c = bars[i].close;
    let dir = 0;
    if (c > orHigh && c > vwap[i]) dir = 1;
    else if (c < orLow && c < vwap[i]) dir = -1;
    if (!dir) continue;
    if (i + 1 >= bars.length) return null;              // no next bar to fill on
    const entry = bars[i + 1].open;
    return {
      direction: dir, triggerMinutes: bars[i].minutes, entryMinutes: bars[i + 1].minutes,
      entryFill: entry, stop: dir === 1 ? orLow : orHigh, orHigh, orLow,
    };
  }
  return null;
}
