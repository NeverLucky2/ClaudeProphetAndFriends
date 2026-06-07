// Curve-SHAPE carry+roll signal (fundamental, NOT ETF price — the orthogonality bet). Monthly:
// hold IEF when the curve pays positive carry+roll over cash; else cash. Term-spread is the
// ModDur-free robustness twin. All yields in percent (curve units).
import { MOD_DUR, ROLL_FROM, ROLL_TO, CASH_FIELD } from './carry-universe.mjs';

// Last available curve row of each calendar month (month-end sample), ascending.
export function monthEndCurve(curve) {
  const byMonth = new Map();
  for (const row of curve) byMonth.set(row.date.slice(0, 7), row); // ascending input → last wins
  return [...byMonth.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

// carry + roll over cash, percent units. roll = ModDur * (y_from - y_to) (slide down the curve).
export function carryRollSignal(row, { modDur = MOD_DUR, from = ROLL_FROM, to = ROLL_TO, cash = CASH_FIELD } = {}) {
  const yFrom = row[from], yTo = row[to], yCash = row[cash];
  if (yFrom == null || yTo == null || yCash == null) return null;
  return (yFrom + modDur * (yFrom - yTo)) - yCash;
}

// ModDur-free twin: term spread y10 - y3mo.
export function termSpread(row, { from = ROLL_FROM, cash = CASH_FIELD } = {}) {
  if (row[from] == null || row[cash] == null) return null;
  return row[from] - row[cash];
}

// Hold when value strictly exceeds buffer (percent). buffer=0 is the parameter-free primary rule.
export function decideHold(value, buffer = 0) { return value != null && value > buffer; }

// Monthly decisions for a signal fn. Returns [{month, date, value, hold}].
export function monthlyDecisions(curve, signalFn, { buffer = 0 } = {}) {
  return monthEndCurve(curve).map((row) => {
    const value = signalFn(row);
    return { month: row.date.slice(0, 7), date: row.date, value, hold: decideHold(value, buffer) };
  });
}

// Diagnostic: fraction of months where a nonzero buffer flips the sign-only decision.
export function thresholdBindingFraction(curve, signalFn, buffer) {
  let flips = 0, n = 0;
  for (const row of monthEndCurve(curve)) {
    const v = signalFn(row); if (v == null) continue;
    n += 1;
    if (decideHold(v, 0) !== decideHold(v, buffer)) flips += 1;
  }
  return n ? flips / n : 0;
}
