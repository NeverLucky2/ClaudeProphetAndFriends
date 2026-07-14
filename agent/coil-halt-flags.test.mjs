import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coilLiveHaltFlags } from './coil-halt-flags.js';
import { COIL_LIVE_STRATEGY_ID } from './coil-strategy-ids.js';

test('live Coil with the operator env set to true arms the halt', () => {
  assert.deepEqual(coilLiveHaltFlags(COIL_LIVE_STRATEGY_ID, 'true'), {
    ENABLE_COIL_LIVE_HALT: 'true',
  });
});

test('live Coil with the operator env unset keeps the halt off (operator keeps the kill switch)', () => {
  assert.deepEqual(coilLiveHaltFlags(COIL_LIVE_STRATEGY_ID, undefined), {
    ENABLE_COIL_LIVE_HALT: 'false',
  });
});

test('live Coil with the operator env explicitly false keeps the halt off', () => {
  assert.deepEqual(coilLiveHaltFlags(COIL_LIVE_STRATEGY_ID, 'false'), {
    ENABLE_COIL_LIVE_HALT: 'false',
  });
});

// This is the actual bug: a shared .env with ENABLE_COIL_LIVE_HALT=true must
// NOT arm the halt on any bot other than live Coil.
test('every other strategy gets an explicit false, even when the shared .env says true', () => {
  for (const sid of ['mean-rev-rsi2', 'trend', 'earnings-drift', 'v2-options', 'prophet-defensive']) {
    assert.deepEqual(coilLiveHaltFlags(sid, 'true'), {
      ENABLE_COIL_LIVE_HALT: 'false',
    });
  }
});
