import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrereg, hashPrereg } from './fleet-prereg.mjs';

test('prereg block contains every pre-committed methodology key', () => {
  const p = buildPrereg();
  for (const k of ['windows', 'representation', 'benchmark', 'crisis', 'effective_n_floor', 'rotation_band', 'sparse_lane_rule', 'primary_beta_detector', 'lane_simplifications', 'acceptable_findings'])
    assert.ok(k in p, `missing ${k}`);
  assert.equal(p.crisis.primary, 'worst_quintile');
  assert.equal(p.crisis.primary_metric, 'crisis_mean_return_bootstrap_CI');
  assert.equal(p.effective_n_floor, 8);
  assert.equal(p.rotation_band.K, 1000);
  assert.equal(p.rotation_band.role, 'context_band_not_gate');
  assert.equal(p.sparse_lane_rule.zero_week_threshold, 0.40);
});

test('hashPrereg is a deterministic sha256 over canonical JSON', () => {
  const p = buildPrereg();
  assert.equal(hashPrereg(p), hashPrereg(buildPrereg()));
  assert.match(hashPrereg(p), /^[0-9a-f]{64}$/);
  // key order must not change the hash
  const reordered = { acceptable_findings: p.acceptable_findings, study: p.study, ...p };
  assert.equal(hashPrereg(reordered), hashPrereg(p));
});
