// scripts/segment-beta.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDailyReturns, computeBeta, assertNotCumulative } from './segment-beta.mjs';

const rows = [ // realized increments + EoD unrealized + pv
  { date: '2026-03-02', realizedPnl: 0,  unrealizedPnl: 0,   deployedPercent: 0,  portfolioValue: 100000 },
  { date: '2026-03-03', realizedPnl: 0,  unrealizedPnl: 200, deployedPercent: 20, portfolioValue: 100000 },
  { date: '2026-03-04', realizedPnl: 50, unrealizedPnl: 100, deployedPercent: 20, portfolioValue: 100200 },
];
const spy = { dates: ['2026-03-02','2026-03-03','2026-03-04'], close: { '2026-03-02':580,'2026-03-03':585,'2026-03-04':583 }, gaps: new Set() };

test('computeDailyReturns uses r_d=(realized+Δunrealized)/pv_{d-1}, gap-aware', () => {
  const r = computeDailyReturns(rows, spy);
  // 03-03: (0 + (200-0))/100000 = 0.002 ; 03-04: (50 + (100-200))/100000 = -0.0005
  const by = Object.fromEntries(r.map((x) => [x.date, x.ret]));
  assert.ok(Math.abs(by['2026-03-03'] - 0.002) < 1e-9);
  assert.ok(Math.abs(by['2026-03-04'] - (-0.0005)) < 1e-9);
});

test('computeDailyReturns drops an observation spanning a missing SPY day', () => {
  const gapped = { dates: ['2026-03-02','2026-03-04'], close: { '2026-03-02':580,'2026-03-04':583 }, gaps: new Set() };
  const r = computeDailyReturns(rows, gapped);
  assert.ok(!r.find((x) => x.date === '2026-03-04')); // 03-03 not consecutive in spy.dates → dropped
});

test('computeBeta returns deployed/unconditional/downside slope + CI, insufficient under MIN', () => {
  const stratR = [{ date: 'd1', ret: 0.01, deployed: true }, { date: 'd2', ret: -0.02, deployed: true }];
  const spyR = { d1: 0.01, d2: -0.02 };
  const b = computeBeta(stratR, spyR, { minDays: 30 });
  assert.equal(b.deployed.insufficient, true); // only 2 days < 30
});

test('assertNotCumulative throws on a monotone realized series', () => {
  assert.throws(() => assertNotCumulative([{ realizedPnl: 10 }, { realizedPnl: 20 }, { realizedPnl: 30 }]));
});
