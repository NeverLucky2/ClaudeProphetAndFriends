// agent/prophet-beat-decision.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { occUnderlying } from './prophet-beat-decision.js';
import { classifyBand, normalizePnlPct } from './prophet-beat-decision.js';

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

const BANDS = { nearStopPct: -10, nearTargetPct: 30 };

test('classifyBand: inclusive on the actionable side', () => {
  assert.equal(classifyBand(-10, BANDS), 'near_stop');     // exactly the edge → near_stop
  assert.equal(classifyBand(-10.0001, BANDS), 'near_stop');
  assert.equal(classifyBand(-9.9999, BANDS), 'interior');  // just inside → interior
  assert.equal(classifyBand(30, BANDS), 'near_target');    // exactly the edge → near_target
  assert.equal(classifyBand(29.9999, BANDS), 'interior');
  assert.equal(classifyBand(0, BANDS), 'interior');
  assert.equal(classifyBand(-15, BANDS), 'near_stop');     // past the rule stop, still actionable
  assert.equal(classifyBand(40, BANDS), 'near_target');
});

test('classifyBand: non-finite P&L is treated as actionable (fail toward running)', () => {
  assert.equal(classifyBand(NaN, BANDS), 'near_stop');
  assert.equal(classifyBand(undefined, BANDS), 'near_stop');
});

test('normalizePnlPct returns percent units unchanged (see Task 6 verification)', () => {
  assert.equal(normalizePnlPct(12), 12);
  assert.equal(normalizePnlPct(-15), -15);
});
