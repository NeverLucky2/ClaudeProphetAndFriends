import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coilLiveHaltFlags } from './coil-halt-flags.js';
import { COIL_LIVE_STRATEGY_ID } from './coil-strategy-ids.js';

test('live Coil with the operator env set to true arms the halt', () => {
  assert.deepEqual(coilLiveHaltFlags(COIL_LIVE_STRATEGY_ID, 'true'), {
    ENABLE_COIL_LIVE_HALT: 'true',
    ENABLE_COIL_ORPHAN_AUTOFLATTEN: 'false',
    ORPHAN_AUTOFLATTEN_ACCOUNT_IS_DEDICATED: 'false',
  });
});

test('live Coil with the operator env unset keeps the halt off (operator keeps the kill switch)', () => {
  assert.deepEqual(coilLiveHaltFlags(COIL_LIVE_STRATEGY_ID, undefined), {
    ENABLE_COIL_LIVE_HALT: 'false',
    ENABLE_COIL_ORPHAN_AUTOFLATTEN: 'false',
    ORPHAN_AUTOFLATTEN_ACCOUNT_IS_DEDICATED: 'false',
  });
});

test('live Coil with the operator env explicitly false keeps the halt off', () => {
  assert.deepEqual(coilLiveHaltFlags(COIL_LIVE_STRATEGY_ID, 'false'), {
    ENABLE_COIL_LIVE_HALT: 'false',
    ENABLE_COIL_ORPHAN_AUTOFLATTEN: 'false',
    ORPHAN_AUTOFLATTEN_ACCOUNT_IS_DEDICATED: 'false',
  });
});

// This is the actual bug: a shared .env with ENABLE_COIL_LIVE_HALT=true must
// NOT arm the halt on any bot other than live Coil.
test('every other strategy gets an explicit false, even when the shared .env says true', () => {
  for (const sid of ['mean-rev-rsi2', 'trend', 'earnings-drift', 'v2-options', 'prophet-defensive']) {
    assert.deepEqual(coilLiveHaltFlags(sid, 'true'), {
      ENABLE_COIL_LIVE_HALT: 'false',
      ENABLE_COIL_ORPHAN_AUTOFLATTEN: 'false',
      ORPHAN_AUTOFLATTEN_ACCOUNT_IS_DEDICATED: 'false',
    });
  }
});

// Orphan auto-flatten (2026-07-14 spec): same per-bot scoping as the halt.
// The brief's example test assumed a `coilHaltFlags(strategyId, envObject)`
// signature; the real module is `coilLiveHaltFlags(strategyId, ...operatorValues)`
// with one positional operator-value argument per flag (mirrors the existing
// ENABLE_COIL_LIVE_HALT parameter, not an env object).
test('orphan-autoflatten flags: live Coil gets the operator value, others hard-false', () => {
  const liveTrue = coilLiveHaltFlags(COIL_LIVE_STRATEGY_ID, 'true', 'true', 'true');
  assert.equal(liveTrue.ENABLE_COIL_ORPHAN_AUTOFLATTEN, 'true');
  assert.equal(liveTrue.ORPHAN_AUTOFLATTEN_ACCOUNT_IS_DEDICATED, 'true');

  const liveUnset = coilLiveHaltFlags(COIL_LIVE_STRATEGY_ID, 'true', undefined, undefined);
  assert.equal(liveUnset.ENABLE_COIL_ORPHAN_AUTOFLATTEN, 'false');
  assert.equal(liveUnset.ORPHAN_AUTOFLATTEN_ACCOUNT_IS_DEDICATED, 'false');

  for (const sid of ['mean-rev-rsi2', 'trend', 'earnings-drift', 'v2-options', 'prophet-defensive']) {
    const other = coilLiveHaltFlags(sid, 'true', 'true', 'true');
    assert.equal(other.ENABLE_COIL_ORPHAN_AUTOFLATTEN, 'false', `${sid} must hard-false the enable flag`);
    assert.equal(other.ORPHAN_AUTOFLATTEN_ACCOUNT_IS_DEDICATED, 'false', `${sid} must hard-false the dedicated flag`);
  }
});
