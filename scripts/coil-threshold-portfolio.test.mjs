import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulatePortfolio, marginalFills } from './coil-threshold-portfolio.mjs';

// Minimal candidate-trade fixtures: {ticker, date, rsi2, exitDate, net}
const trades = [
  { ticker: 'A', date: '2026-01-02', rsi2: 2, exitDate: '2026-01-05', net: 0.03 },
  { ticker: 'B', date: '2026-01-02', rsi2: 3, exitDate: '2026-01-06', net: 0.01 },
  { ticker: 'C', date: '2026-01-02', rsi2: 4, exitDate: '2026-01-06', net: -0.02 },
  { ticker: 'D', date: '2026-01-02', rsi2: 4.5, exitDate: '2026-01-06', net: 0.04 },
  { ticker: 'E', date: '2026-01-02', rsi2: 6, exitDate: '2026-01-06', net: 0.05 }, // shallow
];

test('cap binds at 4 — the 5th (shallow) candidate is not taken at T=5', () => {
  const r = simulatePortfolio(trades, { T: 5, maxPositions: 4, sizePct: 0.05 });
  assert.equal(r.fills.length, 4);
  assert.ok(!r.fills.some(f => f.ticker === 'E'));
});

test('looser T=8 admits E only when a slot is free', () => {
  // Drop D so only 3 sub-5 names exist on the day → E can fill the 4th slot at T=8.
  const t2 = trades.filter(t => t.ticker !== 'D');
  const r5 = simulatePortfolio(t2, { T: 5, maxPositions: 4, sizePct: 0.05 });
  const r8 = simulatePortfolio(t2, { T: 8, maxPositions: 4, sizePct: 0.05 });
  assert.ok(!r5.fills.some(f => f.ticker === 'E'));
  assert.ok(r8.fills.some(f => f.ticker === 'E'));
  const marg = marginalFills(r5.fills, r8.fills);
  assert.deepEqual(marg.map(f => f.ticker), ['E']);
});

test('one-per-ticker: a name already open is not re-entered', () => {
  const dup = [
    { ticker: 'A', date: '2026-01-02', rsi2: 2, exitDate: '2026-01-09', net: 0.03 },
    { ticker: 'A', date: '2026-01-05', rsi2: 2, exitDate: '2026-01-12', net: 0.10 },
  ];
  const r = simulatePortfolio(dup, { T: 5, maxPositions: 4, sizePct: 0.05 });
  assert.equal(r.fills.length, 1);
});

test('reports total net return and max drawdown', () => {
  const r = simulatePortfolio(trades, { T: 5, maxPositions: 4, sizePct: 0.05 });
  assert.ok(typeof r.totalNet === 'number');
  assert.ok(r.maxDrawdown <= 0);
});
