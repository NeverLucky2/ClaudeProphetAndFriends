import { test } from 'node:test';
import assert from 'node:assert/strict';
import { halfSpreadOf, roundTripCost } from './cef-friction.mjs';

test('halfSpreadOf maps tier -> half-spread fraction (liquid 25/mid 50/thin 100 bps)', () => {
  assert.ok(Math.abs(halfSpreadOf('liquid') - 0.0025) < 1e-12);
  assert.ok(Math.abs(halfSpreadOf('mid') - 0.0050) < 1e-12);
  assert.ok(Math.abs(halfSpreadOf('thin') - 0.0100) < 1e-12);
  assert.ok(Math.abs(halfSpreadOf('unknown') - 0.0100) < 1e-12);
});
test('roundTripCost = 2x half-spread x stressMult', () => {
  assert.ok(Math.abs(roundTripCost('liquid', 1) - 0.0050) < 1e-12);
  assert.ok(Math.abs(roundTripCost('liquid', 2) - 0.0100) < 1e-12);
});
