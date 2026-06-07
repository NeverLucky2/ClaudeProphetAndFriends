import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  monthEndCurve, carryRollSignal, termSpread, decideHold,
  monthlyDecisions, thresholdBindingFraction,
} from './carry-signal.mjs';

const CURVE = [
  { date: '2021-12-15', m3: 0.05, y7: 1.30, y10: 1.50 },
  { date: '2021-12-31', m3: 0.06, y7: 1.40, y10: 1.52 }, // month-end Dec 2021
  { date: '2022-01-31', m3: 0.20, y7: 1.80, y10: 1.78 }, // month-end Jan 2022
];

test('monthEndCurve keeps the last row of each calendar month', () => {
  const me = monthEndCurve(CURVE);
  assert.equal(me.length, 2);
  assert.equal(me[0].date, '2021-12-31');
  assert.equal(me[1].date, '2022-01-31');
});

test('carryRollSignal = (y10 + ModDur*(y10-y7)) - m3, in percent', () => {
  // (1.52 + 7.5*(1.52-1.40)) - 0.06 = 1.52 + 0.9 - 0.06 = 2.36
  assert.ok(Math.abs(carryRollSignal(CURVE[1]) - 2.36) < 1e-9);
});

test('carryRollSignal goes negative when the curve inverts (y10<y7) and cash is high', () => {
  const inv = { date: '2023-06-30', m3: 5.4, y7: 4.2, y10: 4.0 };
  // (4.0 + 7.5*(4.0-4.2)) - 5.4 = 4.0 - 1.5 - 5.4 = -2.9
  assert.ok(carryRollSignal(inv) < 0);
});

test('termSpread = y10 - m3 (ModDur-free twin)', () => {
  assert.ok(Math.abs(termSpread(CURVE[1]) - (1.52 - 0.06)) < 1e-9);
});

test('decideHold is sign>buffer (sign-zero primary)', () => {
  assert.equal(decideHold(2.36, 0), true);
  assert.equal(decideHold(-2.9, 0), false);
  assert.equal(decideHold(0.20, 0.25), false); // +25bp buffer not cleared
  assert.equal(decideHold(null, 0), false);
});

test('monthlyDecisions maps each month-end to {month, value, hold}', () => {
  const d = monthlyDecisions(CURVE, carryRollSignal, { buffer: 0 });
  assert.equal(d.length, 2);
  assert.equal(d[0].month, '2021-12');
  assert.equal(d[0].hold, true);
});

test('thresholdBindingFraction reports how often a buffer flips the sign-only decision', () => {
  assert.equal(thresholdBindingFraction(CURVE, carryRollSignal, 0.25), 0);
});
