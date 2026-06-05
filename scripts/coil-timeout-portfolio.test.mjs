import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulateTimeoutPortfolio, blockedByExtension, deepestDD } from './coil-timeout-portfolio.mjs';

test('caps at maxPositions, takes most-oversold first, records blocked candidates', () => {
  // 5 candidates same day; cap=4 → the highest-rsi2 one is blocked
  const cand = [
    { ticker: 'A', date: '2020-01-01', rsi2: 1, exitDate: '2020-01-09', net: 0.01 },
    { ticker: 'B', date: '2020-01-01', rsi2: 2, exitDate: '2020-01-09', net: 0.01 },
    { ticker: 'C', date: '2020-01-01', rsi2: 3, exitDate: '2020-01-09', net: 0.01 },
    { ticker: 'D', date: '2020-01-01', rsi2: 4, exitDate: '2020-01-09', net: 0.01 },
    { ticker: 'E', date: '2020-01-01', rsi2: 9, exitDate: '2020-01-09', net: 0.01 },
  ];
  const r = simulateTimeoutPortfolio(cand, { maxPositions: 4, deployCap: 1 });
  assert.equal(r.nTrades, 4);
  assert.deepEqual(r.fills.map(f => f.ticker), ['A', 'B', 'C', 'D']);
  assert.deepEqual(r.blocked.map(f => f.ticker), ['E']);
});

test('frees a slot when a held position exits, then admits a later candidate', () => {
  const cand = [
    { ticker: 'A', date: '2020-01-01', rsi2: 1, exitDate: '2020-01-02', net: 0.05 },
    { ticker: 'B', date: '2020-01-03', rsi2: 1, exitDate: '2020-01-09', net: 0.10 },
  ];
  const r = simulateTimeoutPortfolio(cand, { maxPositions: 1, deployCap: 1 });
  assert.equal(r.nTrades, 2);                       // A exits 01-02, frees the single slot for B
  assert.ok(Math.abs(r.totalNet - (0.05 + 0.10) * 0.05) < 1e-12); // sizePct 0.05 each
});

test('blockedByExtension = signals filled at baseline but lost at the longer variant', () => {
  const p5 = { fills: [{ ticker: 'A', date: '2020-01-01', rsi2: 1, net: 0.02 }, { ticker: 'B', date: '2020-01-02', rsi2: 2, net: 0.03 }] };
  const pT = { fills: [{ ticker: 'A', date: '2020-01-01', rsi2: 1, net: 0.02 }] }; // B lost (slot held longer)
  const r = blockedByExtension(p5, pT);
  assert.equal(r.count, 1);
  assert.deepEqual(r.signals, [{ ticker: 'B', date: '2020-01-02', rsi2: 2, net: 0.03 }]);
});

test('deepestDD finds the worst peak-to-trough on a curve', () => {
  const curve = [{ date: 'a', cum: 0.05 }, { date: 'b', cum: 0.02 }, { date: 'c', cum: 0.08 }];
  const r = deepestDD(curve);
  assert.ok(Math.abs(r.dd - (-0.03)) < 1e-12); // 0.05 -> 0.02
  assert.equal(r.at, 'b');
});
