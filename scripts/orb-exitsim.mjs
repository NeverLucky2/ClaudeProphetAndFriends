// scripts/orb-exitsim.mjs
// ORB exit: gap-honest market stop, else exit at the session's last bar close (half-day safe).
// R-multiple is the primary unit; retPct reported alongside.

export function simulateOrbTrade(sessionBars, sig) {
  const bars = sessionBars.bars;
  const start = bars.findIndex(b => b.minutes === sig.entryMinutes);
  const entry = sig.entryFill, stop = sig.stop, dir = sig.direction;
  const R = Math.abs(entry - stop);
  const finish = (exit, reason, minutes) => ({
    entry, exit, exitReason: reason, direction: dir, R,
    rMultiple: R > 0 ? (dir * (exit - entry)) / R : 0,
    retPct: dir * (exit - entry) / entry,
    entryMinutes: sig.entryMinutes, exitMinutes: minutes,
  });
  for (let j = start; j < bars.length; j += 1) {
    const b = bars[j];
    const stopHit = dir === 1 ? b.low <= stop : b.high >= stop;
    if (stopHit) {
      const fill = dir === 1 ? Math.min(b.open, stop) : Math.max(b.open, stop); // gap-through → open
      return finish(fill, 'stop', b.minutes);
    }
    if (j === bars.length - 1) return finish(b.close, 'eod', b.minutes);
  }
  // unreachable when start is valid; defensive:
  const last = bars[bars.length - 1];
  return finish(last.close, 'eod', last.minutes);
}
