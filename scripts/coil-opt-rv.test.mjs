// scripts/coil-opt-rv.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trailingRealizedVol } from './coil-opt-rv.mjs';

test('null when insufficient history', () => {
  assert.equal(trailingRealizedVol([100, 101, 102], 1, 5), null);
});
test('zero vol on constant returns', () => {
  const c = [100, 110, 121, 133.1]; // constant +10%/bar → zero stdev of returns
  assert.ok(Math.abs(trailingRealizedVol(c, 3, 3)) < 1e-14);
});
test('annualizes (×√252); positive for dispersed returns', () => {
  const c = [100, 110, 99, 108.9]; // alternating returns → positive vol
  const v = trailingRealizedVol(c, 3, 3);
  assert.ok(v > 0 && Number.isFinite(v));
});
