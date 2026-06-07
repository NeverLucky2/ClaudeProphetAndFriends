// scripts/graduation-report.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleVerdict } from './graduation-report.mjs';

test('assembleVerdict routes a ballast agent through ballastVerdict', () => {
  const v = assembleVerdict('prophet-defensive', {
    ledger: { eligible: { count: 4 }, edgeCI: { lo: -10, hi: 10 } },
    beta: { deployed: { insufficient: true, n: 5 }, downside: { insufficient: true, n: 3 } },
    structurallyConvex: true, expectancy: -20, bleedBudgetPerTrade: -100, durationMonths: 1,
  }, { N: 20, BETA_BAND: 0.6 });
  assert.equal(v.track, 'ballast');
  assert.equal(v.verdict, 'HOLD'); // convex+bounded but <3mo and downside insufficient → structural HOLD
});

test('assembleVerdict routes an equity agent through alphaVerdict and HOLDs on thin data', () => {
  const v = assembleVerdict('default', {
    ledger: { eligible: { count: 0 }, edgeCI: { lo: null, hi: null } },
    beta: { deployed: { insufficient: true, n: 0 } }, adversityCleared: false, durationMonths: 0,
  }, { N: 20, BETA_BAND: 0.6 });
  assert.equal(v.track, 'alpha');
  assert.equal(v.verdict, 'HOLD');
});
