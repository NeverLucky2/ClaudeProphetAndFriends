import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulateStopPortfolio, admittedByTightening } from './coil-stop-portfolio.mjs';

test('admittedByTightening returns fills present under tighter stop but absent at baseline', () => {
  const pBase = { fills: [{ ticker: 'AAA', date: '2020-01-01', rsi2: 2, net: 0.01 }] };
  const pTight = { fills: [
    { ticker: 'AAA', date: '2020-01-01', rsi2: 2, net: 0.01 },
    { ticker: 'BBB', date: '2020-01-03', rsi2: 1, net: -0.05 },
  ] };
  const a = admittedByTightening(pBase, pTight);
  assert.equal(a.count, 1);
  assert.deepEqual(a.signals, [{ ticker: 'BBB', date: '2020-01-03', rsi2: 1, net: -0.05 }]);
});

test('admittedByTightening is empty when the tighter book admits nothing new', () => {
  const p = { fills: [{ ticker: 'AAA', date: '2020-01-01', rsi2: 2, net: 0.01 }] };
  assert.equal(admittedByTightening(p, p).count, 0);
});

test('simulateStopPortfolio is the reused candidate-based book engine (cap binds at maxPositions)', () => {
  const cands = [
    { ticker: 'A', date: '2020-01-01', rsi2: 1, exitDate: '2020-01-09', net: 0.10 },
    { ticker: 'B', date: '2020-01-01', rsi2: 2, exitDate: '2020-01-09', net: 0.10 },
    { ticker: 'C', date: '2020-01-01', rsi2: 3, exitDate: '2020-01-09', net: 0.10 },
  ];
  const r = simulateStopPortfolio(cands, { maxPositions: 2 });
  assert.equal(r.nTrades, 2);          // third is blocked by the 2-position cap
  assert.equal(r.blocked.length, 1);
});
