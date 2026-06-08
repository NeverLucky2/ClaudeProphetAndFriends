import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStopPrereg, verifyStopPrereg } from './coil-stop-prereg.mjs';

test('buildStopPrereg fixes the primary -5% and the two 0.90 thresholds', () => {
  const a = buildStopPrereg({ marginalN: 100, trainN: 50, holdoutN: 50, createdUtc: '2026-06-08T00:00:00Z' });
  assert.equal(a.primary_stop_pct, 0.05);
  assert.equal(a.baseline_stop_pct, 0.07);
  assert.deepEqual(a.secondary_stop_pct, [0.03, 0.04, 0.06]);
  assert.equal(a.decision_rule.dd_reduction_floor, 0.90);
  assert.equal(a.decision_rule.return_retention_floor, 0.90);
  assert.equal(a.expected_outcome, 'KEEP');
});

test('verifyStopPrereg passes on a clean artifact and fails after tampering', () => {
  const a = buildStopPrereg({ marginalN: 100, trainN: 50, holdoutN: 50, createdUtc: '2026-06-08T00:00:00Z' });
  assert.equal(verifyStopPrereg(a).ok, true);
  const tampered = { ...a, primary_stop_pct: 0.04 }; // changed AFTER hashing
  assert.equal(verifyStopPrereg(tampered).ok, false);
});
