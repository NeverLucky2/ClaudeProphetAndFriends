// scripts/cef-signal.mjs
// Discount z-score vs the fund's own trailing norm. `discounts` ascending; z uses the L weeks
// STRICTLY BEFORE index t (no look-ahead).
export function discountZ(discounts, t, L = 52) {
  if (t < L) return null;
  const win = discounts.slice(t - L, t);
  const m = win.reduce((a, b) => a + b, 0) / win.length;
  let v = 0; for (const x of win) v += (x - m) * (x - m);
  const sd = Math.sqrt(v / win.length);
  if (sd < 1e-12) return null;
  return (discounts[t] - m) / sd;
}
export function entryFires(z, zEnter = 1.5) { return z != null && z <= -zEnter; }
export function exitFires(z, weeksHeld, timeStop = 26) {
  if (weeksHeld >= timeStop) return true;
  return z != null && z >= 0;
}
