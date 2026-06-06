import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discountZ, entryFires, exitFires } from './cef-signal.mjs';

test('discountZ = (D_t - trailingMean)/trailingStd over the prior L weeks (excludes t)', () => {
  const flat = Array.from({ length: 11 }, () => -0.10);
  assert.equal(discountZ(flat, 10, 10), null);
  const d = [-0.08, -0.10, -0.12, -0.10, -0.09, -0.11, -0.13, -0.10, -0.10, -0.12, -0.18];
  const z = discountZ(d, 10, 10);
  assert.ok(z < -1.5);
});
test('entryFires when z <= -zEnter', () => {
  assert.equal(entryFires(-1.6, 1.5), true);
  assert.equal(entryFires(-1.4, 1.5), false);
  assert.equal(entryFires(null, 1.5), false);
});
test('exitFires when z >= 0 OR weeksHeld >= timeStop', () => {
  assert.equal(exitFires(0.1, 5, 26), true);
  assert.equal(exitFires(-0.5, 26, 26), true);
  assert.equal(exitFires(-0.5, 5, 26), false);
  assert.equal(exitFires(null, 5, 26), false);
});
