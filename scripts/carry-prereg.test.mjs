import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrereg, hashPrereg } from './carry-prereg.mjs';

test('prereg names the study, the sign-zero primary rule, and the dual gate', () => {
  const p = buildPrereg();
  assert.equal(p.study, 'bond-carry-rolldown');
  assert.equal(p.signal.primary_rule, 'sign(carry_roll)>0');
  assert.ok(p.orthogonality_gate.turtle_rates_rho_max === 0.3);
  assert.ok(Array.isArray(p.acceptable_findings) && p.acceptable_findings.length >= 3);
});
test('hash is deterministic + sensitive to content', () => {
  const a = hashPrereg(buildPrereg());
  const b = hashPrereg(buildPrereg());
  assert.equal(a, b);
  assert.equal(a.length, 64);
  const mutated = { ...buildPrereg(), study: 'changed' };
  assert.notEqual(hashPrereg(mutated), a);
});
