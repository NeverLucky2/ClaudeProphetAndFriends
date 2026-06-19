import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trailingMean, reducedEOV, splitExcludedDates, crossSectionalRank } from './eov-signal.mjs';

test('trailingMean needs full window, excludes current', () => {
  const v = Array.from({ length: 25 }, (_, i) => i + 1); // 1..25
  assert.equal(trailingMean(v, 20, 21), null);              // only 20 priors
  assert.equal(trailingMean(v, 21, 21), 11);                // mean(1..21)=11
});

test('reducedEOV is current / trailing mean, null-safe', () => {
  const v = [...Array(21).fill(10), 30]; // idx21 current=30, trailing mean=10
  assert.equal(reducedEOV(v, 21, 21), 3);
  const z = [...Array(21).fill(0), 5];
  assert.equal(reducedEOV(z, 21, 21), null);  // zero trailing mean
});

test('splitExcludedDates covers split day through split+window trading days', () => {
  const dates = Array.from({ length: 30 }, (_, i) => `D${String(i).padStart(2, '0')}`);
  const ex = splitExcludedDates(dates, 'D05', 21);
  assert.ok(ex.has('D05'));        // split day
  assert.ok(ex.has('D26'));        // +21 trading days
  assert.ok(!ex.has('D27'));       // window closed
  assert.ok(!ex.has('D04'));       // before split
});

test('crossSectionalRank: percentile in [0,1], null below minNames', () => {
  const r = crossSectionalRank({ A: 1, B: 2, C: 3, D: 4 }, 4);
  assert.equal(r.A, 0); assert.equal(r.D, 1);
  assert.ok(r.B > 0 && r.B < r.C);
  assert.equal(crossSectionalRank({ A: 1, B: 2 }, 12), null);     // too few
  assert.equal(crossSectionalRank({ A: 1, B: NaN, C: 3 }, 3), null); // NaN dropped -> 2 valid < 3
});
