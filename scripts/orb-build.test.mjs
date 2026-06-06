// scripts/orb-build.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enumerateOrbTrades } from './orb-build.mjs';

const flat = (c, v = 100) => ({ open: c, high: c, low: c, close: c, volume: v });
function day(date) {
  return { date, bars: [
    { minutes: 570, ...flat(100) }, { minutes: 575, ...flat(100) }, { minutes: 580, ...flat(100) },
    { minutes: 585, open: 100, high: 101.5, low: 100, close: 101, volume: 100 }, // break up
    { minutes: 590, open: 101.2, high: 101.2, low: 101.2, close: 101.2, volume: 100 }, // entry fill
    { minutes: 955, ...flat(102) }, // EOD winner
  ] };
}

test('one trade per signalling session, tagged with ticker/cut/date', () => {
  const trades = enumerateOrbTrades([day('2020-01-02'), day('2020-01-03')], 'QQQ', 'etf');
  assert.equal(trades.length, 2);
  for (const t of trades) {
    assert.equal(t.ticker, 'QQQ'); assert.equal(t.cut, 'etf');
    assert.equal(t.direction, 1); assert.ok(t.rMultiple > 0);
    assert.ok(t.entryMinutes === 590);
  }
});
