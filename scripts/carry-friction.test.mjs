import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roundTripCost } from './carry-friction.mjs';

test('round trip = 2 * half-spread (1.5bps) = 3bps', () => {
  assert.ok(Math.abs(roundTripCost(1) - 0.0003) < 1e-9);
});
test('2x stress doubles it', () => {
  assert.ok(Math.abs(roundTripCost(2) - 0.0006) < 1e-9);
});
