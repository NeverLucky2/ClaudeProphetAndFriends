// scripts/orb-score.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideOrb } from './orb-score.mjs';

const floor = { trades: 200, distinct_dates: 100 };
const ok = { gateNet: { lo: 0.02, n: 500 }, gateMktrel: { lo: 0.01, n: 400 }, trainNetMean: 0.03, trainMktrelMean: 0.02, nTrades: 500, distinctDates: 300, powerFloor: floor };

test('KEEP-CANDIDATE only when both holdout CIs > 0 and train both positive', () => {
  assert.equal(decideOrb(ok).verdict, 'KEEP-CANDIDATE');
});
test('REJECT if gate_mktrel CI includes zero', () => {
  assert.equal(decideOrb({ ...ok, gateMktrel: { lo: -0.001, n: 400 } }).verdict, 'REJECT');
});
test('REJECT if train sign not consistent', () => {
  assert.equal(decideOrb({ ...ok, trainMktrelMean: -0.001 }).verdict, 'REJECT');
});
test('UNDERPOWERED takes precedence on thin samples', () => {
  assert.equal(decideOrb({ ...ok, nTrades: 50, distinctDates: 20 }).verdict, 'UNDERPOWERED');
});
