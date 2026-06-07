// scripts/overlay-prereg.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrereg, hashPrereg } from './overlay-prereg.mjs';

test('prereg hash is stable + records the key decisions', () => {
  const p = buildPrereg();
  assert.equal(hashPrereg(p), hashPrereg(buildPrereg()));     // deterministic
  assert.equal(p.cost_metric, 'calm_period_non_crisis_drag'); // the critical §5 fix
  assert.ok(p.funding && p.funding.primary === 'cash_rf');
  assert.ok(p.decision_branches.includes('c_honest_null'));
});
