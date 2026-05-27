// agent/prophet-beat-decision.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { occUnderlying } from './prophet-beat-decision.js';

test('occUnderlying extracts the underlying from an OCC option symbol', () => {
  assert.equal(occUnderlying('TSLA260529C00442500'), 'TSLA');
  assert.equal(occUnderlying('NVDA260619P00130000'), 'NVDA');
  assert.equal(occUnderlying('F260529C00012000'), 'F'); // single-letter root
});

test('occUnderlying passes through plain stock symbols and malformed input', () => {
  assert.equal(occUnderlying('AAPL'), 'AAPL');
  assert.equal(occUnderlying(''), '');
  assert.equal(occUnderlying(null), null);
  assert.equal(occUnderlying(undefined), undefined);
});
