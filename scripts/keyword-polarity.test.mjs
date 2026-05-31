// scripts/keyword-polarity.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keywordPolarityV1 } from './keyword-polarity.mjs';

test('positive headlines -> +1', () => {
  assert.equal(keywordPolarityV1('NVDA agrees to buy Arm; raises guidance'), 1);
  assert.equal(keywordPolarityV1('Tesla tops estimates, crushes consensus'), 1);
});

test('negative headlines -> -1', () => {
  assert.equal(keywordPolarityV1('Acme issues profit warning, cuts guidance'), -1);
  assert.equal(keywordPolarityV1('Widgets misses estimates'), -1);
});

test('no keywords or balanced -> 0 (neutral, no fire)', () => {
  assert.equal(keywordPolarityV1('Company announces new product color'), 0);
  // one positive + one negative -> tie -> 0
  assert.equal(keywordPolarityV1('Beats estimates but cuts guidance'), 0);
});

test('case-insensitive and counts magnitude', () => {
  // two positive cues, zero negative -> +1
  assert.equal(keywordPolarityV1('RAISES GUIDANCE and TOPS ESTIMATES'), 1);
});
