// scripts/overlay-combine.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contribWeekly, calmDrag, cushion, efficiency, maxDrawdown } from './overlay-combine.mjs';

const hedge = [{ ret: -0.01 }, { ret: -0.01 }, { ret: 0.05 }, { ret: -0.01 }]; // bleeds, pays in crisis
const book = [{ ret: 0.02 }, { ret: 0.01 }, { ret: -0.08 }, { ret: 0.015 }];
const rf = [0.0002, 0.0002, 0.0002, 0.0002];
const crisisIdx = [2]; // week 2 is the crash

test('contribWeekly cash-funded = w*(hedge - rf)', () => {
  const c = contribWeekly(hedge, book, { w: 1, funding: 'cash', rf });
  assert.ok(Math.abs(c[0].ret - (-0.01 - 0.0002)) < 1e-9);
  assert.ok(Math.abs(c[2].ret - (0.05 - 0.0002)) < 1e-9);
});

test('calmDrag annualizes mean over NON-crisis weeks only (sign: positive cost = positive drag)', () => {
  const c = contribWeekly(hedge, book, { w: 1, funding: 'cash', rf });
  const d = calmDrag(c, crisisIdx);
  // non-crisis contribs ≈ -0.0102,-0.0102,-0.0102 → mean ~ -0.0102 → drag = -52*mean > 0
  assert.ok(d > 0);
});

test('cushion is positive when hedge pays in the crisis week', () => {
  const c = contribWeekly(hedge, book, { w: 1, funding: 'cash', rf });
  assert.ok(cushion(c, crisisIdx) > 0);
});

test('efficiency returns free_ballast when drag<=0', () => {
  assert.equal(efficiency(0.5, -0.2).flag, 'free_ballast');
  assert.ok(Math.abs(efficiency(0.5, 2).value - 0.25) < 1e-9); // 0.5 cushion / 2% drag
});

test('maxDrawdown of a simple combined series', () => {
  const dd = maxDrawdown([0.1, -0.2, 0.05]);
  assert.ok(dd < 0);
});
