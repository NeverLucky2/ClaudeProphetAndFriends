// scripts/ema-exitsim.mjs
// Exit simulation with the §3 asymmetric gap model. grossReturn is direction-signed:
// positive = the trade made money, for both longs and shorts. No lookahead.

function result(entry, exit, reason, k, direction, sameBarBoth) {
  const raw = (exit - entry) / entry;
  return { entry, exit, exitReason: reason, daysHeld: k, grossReturn: direction * raw, sameBarBoth, censored: false };
}

export function simulateEmaTrade(bars, entryIdx, { direction, atr, kStop, kTarget, maxHold }) {
  const entry = bars[entryIdx].close;
  const stop = direction === 1 ? entry - kStop * atr : entry + kStop * atr;
  const target = direction === 1 ? entry + kTarget * atr : entry - kTarget * atr;
  for (let k = 1; k <= maxHold; k += 1) {
    const j = entryIdx + k;
    if (j >= bars.length) return { entry, exit: null, exitReason: null, daysHeld: k - 1, grossReturn: null, sameBarBoth: false, censored: true };
    const b = bars[j];
    const stopHit = direction === 1 ? b.low <= stop : b.high >= stop;
    const tgtHit = direction === 1 ? b.high >= target : b.low <= target;
    if (stopHit && tgtHit) {
      // conservative: stop wins the same-bar tie; stop is a market exit → gap-honest fill
      const fill = direction === 1 ? Math.min(b.open, stop) : Math.max(b.open, stop);
      return result(entry, fill, 'stop', k, direction, true);
    }
    if (stopHit) {
      const fill = direction === 1 ? Math.min(b.open, stop) : Math.max(b.open, stop);
      return result(entry, fill, 'stop', k, direction, false);
    }
    if (tgtHit) {
      // limit: never credited the better gapped-open → fill exactly at target
      return result(entry, target, 'target', k, direction, false);
    }
    if (k === maxHold) return result(entry, b.close, 'time_stop', k, direction, false);
  }
  return { entry, exit: null, exitReason: null, daysHeld: maxHold, grossReturn: null, sameBarBoth: false, censored: true };
}

export function netWithCosts(grossReturn, { direction, daysHeld, frictionBps, borrowBpsAnnual }) {
  let net = grossReturn - frictionBps / 10000;
  if (direction === -1) net -= (borrowBpsAnnual / 10000) * (daysHeld / 252);
  return net;
}
