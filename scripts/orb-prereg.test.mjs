// scripts/orb-prereg.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOrbPrereg, verifyOrbPrereg } from './orb-prereg.mjs';

test('prereg hashes stably and verifies; expected outcome uncertain', () => {
  const a = buildOrbPrereg({ trainN: 100, holdoutN: 100, createdUtc: '2026-06-06T00:00:00Z' });
  assert.equal(verifyOrbPrereg(a).ok, true);
  assert.equal(a.expected_outcome, 'UNCERTAIN');
  assert.equal(a.gated_metric, 'r_multiple');
});
test('tampering breaks the hash', () => {
  const a = buildOrbPrereg({ trainN: 1, holdoutN: 1, createdUtc: '2026-06-06T00:00:00Z' });
  a.primary.or_minutes = 5;
  assert.equal(verifyOrbPrereg(a).ok, false);
});
