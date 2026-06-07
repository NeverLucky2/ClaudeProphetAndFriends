// scripts/overlay-stress.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spreadIntrinsicPayoff, spreadStressGrid } from './overlay-stress.mjs';

test('spreadIntrinsicPayoff = capped long-minus-short put intrinsic', () => {
  // S0=100, long 95 put, short 85 put. At S=80: long=15, short=5 → 10. Width cap = 10.
  assert.equal(spreadIntrinsicPayoff(80, 95, 85), 10);
  assert.equal(spreadIntrinsicPayoff(96, 95, 85), 0); // OTM
  assert.equal(spreadIntrinsicPayoff(70, 95, 85), 10); // capped at width
});

test('spreadStressGrid returns intrinsic at each shock for 95/85 strikes off S0=100', () => {
  const g = spreadStressGrid(100, { longPct: 0.95, shortPct: 0.85, shocks: [-0.10, -0.20, -0.30] });
  assert.equal(g['-0.10'], 5);  // S=90: long 95→5, short 85→0 → 5
  assert.equal(g['-0.20'], 10); // S=80: 15-5 = 10 (capped)
  assert.equal(g['-0.30'], 10); // S=70: capped at width 10
});
