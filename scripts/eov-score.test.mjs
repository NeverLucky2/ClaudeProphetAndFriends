// scripts/eov-score.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { netSpread, netLeg, orientRows, decideEov } from './eov-score.mjs';

test('friction model: spread pays 4 legs, single leg pays 2', () => {
  assert.ok(Math.abs(netSpread(0.01, 2) - (0.01 - 4 * 2 / 1e4)) < 1e-12);
  assert.ok(Math.abs(netLeg(0.01, 2) - (0.01 - 2 * 2 / 1e4)) < 1e-12);
});

test('orientRows flips sign for a reversal direction', () => {
  const r = orientRows([{ date: 'D', net: -0.02 }], -1);
  assert.ok(Math.abs(r[0].net - 0.02) < 1e-12); // reversal: negative spread becomes positive oriented
});

test('decideEov: power floor dominates', () => {
  const v = decideEov({ trainGateLo: 0.1, gateALo: 0.1, gateBLo: 0.1, nDatesHoldout: 50, nNameTrades: 999, powerFloor: { distinct_dates: 100, name_trades: 200 } });
  assert.equal(v.verdict, 'UNDERPOWERED');
});

test('decideEov: no train signal -> NO-SIGNAL', () => {
  const v = decideEov({ trainGateLo: -0.01, gateALo: 0.1, gateBLo: 0.1, nDatesHoldout: 150, nNameTrades: 999, powerFloor: { distinct_dates: 100, name_trades: 200 } });
  assert.equal(v.verdict, 'NO-SIGNAL');
});

test('decideEov: all gates pass -> KEEP-CANDIDATE; one fails -> REJECT', () => {
  const base = { trainGateLo: 0.02, nDatesHoldout: 150, nNameTrades: 800, powerFloor: { distinct_dates: 100, name_trades: 200 } };
  assert.equal(decideEov({ ...base, gateALo: 0.01, gateBLo: 0.01 }).verdict, 'KEEP-CANDIDATE');
  assert.equal(decideEov({ ...base, gateALo: 0.01, gateBLo: -0.01 }).verdict, 'REJECT');
});
