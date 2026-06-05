import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildThresholdPrereg, verifyThresholdPrereg } from './coil-threshold-prereg.mjs';

test('buildThresholdPrereg is self-consistent and hash-verifies', () => {
  const a = buildThresholdPrereg({ trainN: 100, holdoutN: 100, createdUtc: '2026-06-05T00:00:00.000Z' });
  assert.equal(a.primary_T, 8);
  assert.deepEqual(a.secondary_T, [10, 15]);
  assert.equal(a.expected_outcome, 'KEEP');
  assert.equal(verifyThresholdPrereg(a).ok, true);
});

test('verifyThresholdPrereg fails on tampering', () => {
  const a = buildThresholdPrereg({ trainN: 100, holdoutN: 100, createdUtc: '2026-06-05T00:00:00.000Z' });
  a.friction_bps.representative = 9999;
  assert.equal(verifyThresholdPrereg(a).ok, false);
});
