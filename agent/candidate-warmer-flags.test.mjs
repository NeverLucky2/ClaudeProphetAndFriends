import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidateWarmerFlags } from './candidate-warmer-flags.js';

test('coil (mean-rev-rsi2) enables only the meanrev warmer', () => {
  assert.deepEqual(candidateWarmerFlags('mean-rev-rsi2'), {
    ENABLE_MEANREV_WARMER: 'true',
    ENABLE_DRIFT_WARMER: 'false',
  });
});

test('drift (earnings-drift) enables only the drift warmer', () => {
  assert.deepEqual(candidateWarmerFlags('earnings-drift'), {
    ENABLE_MEANREV_WARMER: 'false',
    ENABLE_DRIFT_WARMER: 'true',
  });
});

test('every other strategy (and undefined) enables neither', () => {
  for (const sid of ['v2-options', 'trend', 'penny-momentum', undefined, null]) {
    assert.deepEqual(candidateWarmerFlags(sid), {
      ENABLE_MEANREV_WARMER: 'false',
      ENABLE_DRIFT_WARMER: 'false',
    });
  }
});
