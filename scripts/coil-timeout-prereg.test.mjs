// scripts/coil-timeout-prereg.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTimeoutPrereg, verifyTimeoutPrereg } from './coil-timeout-prereg.mjs';

test('prereg self-hash verifies on match and fails on tamper', () => {
  const a = buildTimeoutPrereg({ pairedN: 120, trainN: 60, holdoutN: 60, createdUtc: '2026-06-05T00:00:00.000Z' });
  assert.equal(a.primary_maxHold, 7);
  assert.deepEqual(a.variants, [5, 7, 8, 10]);
  assert.equal(a.winsorize_pct, 90);
  assert.equal(verifyTimeoutPrereg(a).ok, true);
  const tampered = { ...a, primary_maxHold: 10 };
  assert.equal(verifyTimeoutPrereg(tampered).ok, false);
});

test('prereg hash is deterministic for identical inputs', () => {
  const opts = { pairedN: 1, trainN: 1, holdoutN: 1, createdUtc: '2026-06-05T00:00:00.000Z' };
  assert.equal(buildTimeoutPrereg(opts).artifact_hash, buildTimeoutPrereg(opts).artifact_hash);
});
