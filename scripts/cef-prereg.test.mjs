import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrereg, hashPrereg } from './cef-prereg.mjs';

test('prereg pins every committed methodology key', () => {
  const p = buildPrereg();
  for (const k of ['window', 'signal', 'return_basis', 'friction', 'edge_gate', 'orthogonality_gate', 'checks', 'acceptable_findings'])
    assert.ok(k in p, `missing ${k}`);
  assert.equal(p.signal.L, 52); assert.equal(p.signal.z_enter, 1.5); assert.equal(p.signal.admission, 'most_negative_z_first');
  assert.equal(p.return_basis, 'price_change_decomposed_navmove_vs_discountchange');
  assert.deepEqual(p.friction.half_spread_bps, { liquid: 25, mid: 50, thin: 100 });
  assert.equal(p.edge_gate.block_weeks, 8);
  assert.equal(p.orthogonality_gate.lane_rho_max, 0.3);
});
test('hashPrereg is deterministic sha256 over canonical JSON', () => {
  assert.equal(hashPrereg(buildPrereg()), hashPrereg(buildPrereg()));
  assert.match(hashPrereg(buildPrereg()), /^[0-9a-f]{64}$/);
});
