import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remarkTrade, simulateCoilDaily } from './fleet-coil-marks.mjs';

test('remarkTrade: day-0 from entry fill, close-to-close after, through exitDate', () => {
  const bars = [
    { date: '2016-03-01', close: 100 },
    { date: '2016-03-02', close: 95 },
    { date: '2016-03-03', close: 102 },
  ];
  const trade = { ticker: 'AAPL', date: '2016-03-01', entry: 98, exitDate: '2016-03-03' };
  const marks = remarkTrade(trade, bars);
  assert.ok(Math.abs(marks[0].ret - (100 / 98 - 1)) < 1e-9);
  assert.ok(Math.abs(marks[1].ret - (95 / 100 - 1)) < 1e-9);
  assert.ok(Math.abs(marks[2].ret - (102 / 95 - 1)) < 1e-9);
  assert.deepEqual(marks.map(m => m.date), ['2016-03-01', '2016-03-02', '2016-03-03']);
});

test('remarkTrade returns [] when entry or exit date is missing from bars', () => {
  const bars = [{ date: '2016-03-01', close: 100 }];
  assert.deepEqual(remarkTrade({ ticker: 'X', date: '2016-03-01', entry: 100, exitDate: '2016-03-09' }, bars), []);
});

test('simulateCoilDaily overlays sizing: <=4 concurrent, 24% cap, most-oversold-first; daily {date,ret,active}', () => {
  const trades = [
    { ticker: 'AAPL', date: '2016-03-01', rsi2: 3, entry: 100, exitDate: '2016-03-02' },
    { ticker: 'MSFT', date: '2016-03-01', rsi2: 1, entry: 50, exitDate: '2016-03-02' },
  ];
  const barsByTicker = new Map([
    ['AAPL', [{ date: '2016-03-01', close: 100 }, { date: '2016-03-02', close: 110 }]],
    ['MSFT', [{ date: '2016-03-01', close: 50 }, { date: '2016-03-02', close: 55 }]],
  ]);
  const series = simulateCoilDaily(trades, barsByTicker, { sizePct: 0.05, maxPositions: 4, deployCap: 0.24 });
  const d2 = series.find(p => p.date === '2016-03-02');
  // AAPL 110/100-1=0.10, MSFT 55/50-1=0.10 -> 0.05*0.10 + 0.05*0.10 = 0.01
  assert.ok(Math.abs(d2.ret - 0.01) < 1e-9);
  assert.equal(d2.active, true);
});

test('simulateCoilDaily respects maxPositions, admitting most-oversold first', () => {
  const mk = (t, rsi) => ({ ticker: t, date: '2016-03-01', rsi2: rsi, entry: 100, exitDate: '2016-03-02' });
  const trades = [mk('A', 9), mk('B', 1), mk('C', 5), mk('D', 7), mk('E', 3)];
  const bt = new Map(['A','B','C','D','E'].map(t => [t, [{ date: '2016-03-01', close: 100 }, { date: '2016-03-02', close: 100 }]]));
  const series = simulateCoilDaily(trades, bt, { sizePct: 0.05, maxPositions: 4, deployCap: 0.24 });
  // 4 admitted, flat returns -> ret 0 but active true on 03-02
  const d2 = series.find(p => p.date === '2016-03-02');
  assert.equal(d2.active, true);
  assert.ok(Math.abs(d2.ret) < 1e-9);
});
