// scripts/graduation-gate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trackOf, alphaVerdict, ballastVerdict } from './graduation-gate.mjs';

test('trackOf classifies by strategy id', () => {
  assert.equal(trackOf('sbx_mean_rev', 'default'), 'alpha');     // Coil
  assert.equal(trackOf('prophet-defensive'), 'ballast');
});

test('alphaVerdict GRADUATE when all criteria clear', () => {
  const v = alphaVerdict({
    eligibleTrades: 25, edgeCI: { lo: 12, hi: 60 }, adversityCleared: true,
    durationMonths: 4, deployedBeta: { point: 0.2, lo: 0.05, hi: 0.4, n: 40 },
  }, { N: 20, BETA_BAND: 0.6 });
  assert.equal(v.verdict, 'GRADUATE');
});

test('alphaVerdict REJECT when deployed-beta CI lower bound on |beta| exceeds band', () => {
  const v = alphaVerdict({
    eligibleTrades: 25, edgeCI: { lo: 12, hi: 60 }, adversityCleared: true,
    durationMonths: 4, deployedBeta: { point: 0.9, lo: 0.7, hi: 1.1, n: 40 },
  }, { N: 20, BETA_BAND: 0.6 });
  assert.equal(v.verdict, 'REJECT');
});

test('alphaVerdict HOLD when edge CI straddles 0 (not yet demonstrable)', () => {
  const v = alphaVerdict({
    eligibleTrades: 25, edgeCI: { lo: -5, hi: 40 }, adversityCleared: true,
    durationMonths: 4, deployedBeta: { point: 0.2, lo: 0.05, hi: 0.4, n: 40 },
  }, { N: 20, BETA_BAND: 0.6 });
  assert.equal(v.verdict, 'HOLD');
});

test('alphaVerdict RETIRE when HOLD past the deadline', () => {
  const v = alphaVerdict({
    eligibleTrades: 5, edgeCI: { lo: -5, hi: 40 }, adversityCleared: false,
    durationMonths: 7, deployedBeta: { insufficient: true, n: 10 },
  }, { N: 20, BETA_BAND: 0.6, retireMonths: 6 });
  assert.equal(v.verdict, 'RETIRE');
});

test('ballastVerdict ignores expectancy; GRADUATE on structural+bounded-bleed+nonpositive downside', () => {
  const v = ballastVerdict({
    structurallyConvex: true, expectancy: -50, bleedBudgetPerTrade: -100,
    downsideBeta: { point: -0.6, lo: -0.9, hi: -0.1, n: 35 }, durationMonths: 4,
  }, { retireMonths: 6 });
  assert.equal(v.verdict, 'GRADUATE');
});

test('ballastVerdict REJECT when it ADDS crash risk (downside-beta CI lower bound > 0)', () => {
  const v = ballastVerdict({
    structurallyConvex: true, expectancy: -50, bleedBudgetPerTrade: -100,
    downsideBeta: { point: 0.5, lo: 0.2, hi: 0.8, n: 35 }, durationMonths: 4,
  }, { retireMonths: 6 });
  assert.equal(v.verdict, 'REJECT');
});
