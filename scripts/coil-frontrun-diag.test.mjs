import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversionByYear, conversionByTercile, returnTrendByYear, renderDiag } from './coil-frontrun-diag.mjs';

const ep = (date, outcome, vol = 0.01) => ({ ticker: 'AAA', date, outcome, vol, rsi2: 9, bars: 2 });

test('conversionByYear buckets by calendar year and reports n/fire/bounce/rate', () => {
  const eps = [
    ep('2021-03-01', 'FIRE'), ep('2021-04-01', 'BOUNCE'),
    ep('2021-05-01', 'UNRESOLVED'),                       // excluded from the rate
    ep('2022-03-01', 'BOUNCE'), ep('2022-04-01', 'BOUNCE'),
  ];
  const r = conversionByYear(eps);
  assert.equal(r['2021'].n, 2);
  assert.equal(r['2021'].fire, 1);
  assert.equal(r['2021'].rate, 0.5);
  assert.equal(r['2022'].rate, 0);
  assert.ok(Number.isFinite(r['2021'].lo) && Number.isFinite(r['2021'].hi));
});

test('conversionByTercile assigns on the frozen boundaries', () => {
  const b = { lo: 0.01, hi: 0.02 };
  const eps = [
    ep('2021-03-01', 'FIRE', 0.005), ep('2021-03-02', 'BOUNCE', 0.008),
    ep('2021-03-03', 'FIRE', 0.03),
  ];
  const r = conversionByTercile(eps, b);
  assert.equal(r.low.n, 2);
  assert.equal(r.low.rate, 0.5);
  assert.equal(r.high.n, 1);
  assert.equal(r.high.rate, 1);
  assert.equal(r.mid.n, 0);
});

test('conversionByTercile ignores episodes with a null vol', () => {
  const b = { lo: 0.01, hi: 0.02 };
  const eps = [ep('2021-03-01', 'FIRE', null), ep('2021-03-02', 'FIRE', 0.005)];
  assert.equal(conversionByTercile(eps, b).low.n, 1);
});

test('returnTrendByYear separates shallow from deep and reports the gap', () => {
  const inst = [
    { date: '2021-03-01', bucket: '[0,5)', grossReturn: 0.02, censored: false },
    { date: '2021-03-02', bucket: '[0,5)', grossReturn: 0.01, censored: false },
    { date: '2021-03-03', bucket: '[8,10)', grossReturn: 0.00, censored: false },
    { date: '2021-03-04', bucket: '[10,15)', grossReturn: -0.01, censored: false },
    { date: '2021-03-05', bucket: '[5,8)', grossReturn: 0.00, censored: true },  // excluded
  ];
  const r = returnTrendByYear(inst, 20);
  assert.equal(r['2021'].deep.n, 2);
  assert.equal(r['2021'].shallow.n, 2);
  // net = gross - 0.0020
  assert.ok(Math.abs(r['2021'].deep.mean - (0.015 - 0.002)) < 1e-12);
  assert.ok(Math.abs(r['2021'].shallow.mean - (-0.005 - 0.002)) < 1e-12);
  assert.ok(r['2021'].gap.mean < 0, 'shallow underperforms deep in this fixture');
});

test('renderDiag emits the mandatory EXPLORATORY banner and per-cell n', () => {
  const md = renderDiag({
    byYear: { 2021: { n: 2, fire: 1, bounce: 1, rate: 0.5, lo: 0, hi: 1 } },
    byTercile: { low: { n: 2, fire: 1, bounce: 1, rate: 0.5, lo: 0, hi: 1 }, mid: { n: 0, fire: 0, bounce: 0, rate: null, lo: null, hi: null }, high: { n: 0, fire: 0, bounce: 0, rate: null, lo: null, hi: null } },
    returns: { 2021: { shallow: { n: 2, mean: -0.007 }, deep: { n: 2, mean: 0.013 }, gap: { mean: -0.02, lo: -0.05, hi: 0.01 } } },
    prereg: { artifact_hash: 'abc12345', benchmark_conversion_rate: 0.5 },
  });
  assert.match(md, /EXPLORATORY/);
  assert.match(md, /holdout was already spent/);
  assert.match(md, /must not drive a live Coil change/i);
  assert.match(md, /\| 2021 \| 2 \|/);
});
