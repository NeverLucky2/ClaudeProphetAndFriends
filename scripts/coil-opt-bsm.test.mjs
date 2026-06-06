// scripts/coil-opt-bsm.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bsPrice, normCdf } from './coil-opt-bsm.mjs';
const approx = (a, b, e = 1e-3) => assert.ok(Math.abs(a - b) <= e, `${a} ≈ ${b}`);

test('normCdf basics', () => { approx(normCdf(0), 0.5); approx(normCdf(1.96), 0.975, 2e-3); });
test('ATM call r=0 known value (~7.9656)', () => {
  approx(bsPrice('call', 100, 100, 1, 0, 0.2), 7.9656, 5e-3);
});
test('put-call parity: C - P = S - K e^{-rT}', () => {
  const C = bsPrice('call', 105, 100, 0.5, 0.04, 0.3);
  const P = bsPrice('put', 105, 100, 0.5, 0.04, 0.3);
  approx(C - P, 105 - 100 * Math.exp(-0.04 * 0.5), 1e-6);
});
test('T<=0 or sigma<=0 → intrinsic', () => {
  approx(bsPrice('call', 110, 100, 0, 0.04, 0.3), 10);
  approx(bsPrice('put', 90, 100, -1, 0.04, 0.3), 10);
  approx(bsPrice('call', 90, 100, 0.5, 0.04, 0), 0);
});
