// scripts/ema-prereg.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEmaPrereg, verifyEmaPrereg } from './ema-prereg.mjs';

test('prereg hashes stably and verifies', () => {
  const a = buildEmaPrereg({ trainN: 200, holdoutN: 200, createdUtc: '2026-06-06T00:00:00Z' });
  assert.equal(verifyEmaPrereg(a).ok, true);
  assert.equal(a.expected_outcome, 'REJECT');
  assert.deepEqual(a.benchmarks, ['SPY', 'QQQ']);
});

test('tampering breaks the hash', () => {
  const a = buildEmaPrereg({ trainN: 1, holdoutN: 1, createdUtc: '2026-06-06T00:00:00Z' });
  a.primary.fast = 9;
  assert.equal(verifyEmaPrereg(a).ok, false);
});
