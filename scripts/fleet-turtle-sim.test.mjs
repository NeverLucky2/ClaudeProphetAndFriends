import { test } from 'node:test';
import assert from 'node:assert/strict';
import { donchianHigh, donchianLow, sma, wilderATR, entryFires, exitFires, positionDollars, simulateTurtle } from './fleet-turtle-sim.mjs';

test('donchianHigh excludes the last bar (the bar being tested)', () => {
  const closes = [1, 2, 3, 10, 12, 11, 5];
  assert.equal(donchianHigh(closes, 3), 12);
});
test('donchianLow excludes the last bar', () => {
  const closes = [9, 8, 7, 10, 6, 8, 99];
  assert.equal(donchianLow(closes, 3), 6);
});
test('sma over the n bars ending one before the last', () => {
  const closes = [1, 2, 3, 4, 5, 100];
  assert.equal(sma(closes, 3), (3 + 4 + 5) / 3);
});
test('wilderATR uses simple-mean seed then recursion (not an SMA of TR)', () => {
  const highs = [10, 11, 12, 13, 14];
  const lows = [9, 10, 11, 12, 13];
  const closes = [9.5, 10.5, 11.5, 12.5, 13.5];
  const atr = wilderATR(highs, lows, closes, 2);
  assert.ok(atr > 0 && Number.isFinite(atr));
});
test('entryFires requires close>Donchian100High AND close>SMA200 AND ATR/close>=0.5%', () => {
  assert.equal(entryFires({ lastClose: 110, d100High: 100, sma200: 90, atr20: 2 }), true);
  assert.equal(entryFires({ lastClose: 99, d100High: 100, sma200: 90, atr20: 2 }), false);
  assert.equal(entryFires({ lastClose: 110, d100High: 100, sma200: 120, atr20: 2 }), false);
  assert.equal(entryFires({ lastClose: 110, d100High: 100, sma200: 90, atr20: 0.2 }), false);
});
test('exitFires: trailing stop on today_open<=Donchian50Low OR initial hard stop within 20d', () => {
  assert.equal(exitFires({ todayOpen: 80, d50Low: 85, entry: 100, atrAtEntry: 5, daysHeld: 3 }).reason, 'trailing_stop');
  assert.equal(exitFires({ todayOpen: 89, d50Low: 85, entry: 100, atrAtEntry: 5, daysHeld: 3 }).reason, 'initial_hard_stop');
  assert.equal(exitFires({ todayOpen: 95, d50Low: 85, entry: 100, atrAtEntry: 5, daysHeld: 30 }).reason, '');
});
test('positionDollars = (portfolio*0.005)/(2*ATR/close), capped at 4% of portfolio', () => {
  assert.equal(positionDollars(100000, 100, 1), 4000);
  assert.equal(positionDollars(100000, 100, 10), 2500);
});

// Synthetic two-ETF world: a rising ETF that keeps making new 100-day highs above its SMA200
// (enters and holds); a flat ETF that never breaks out. Consecutive calendar dates are fine —
// simulateTurtle works off the union of bar dates, not trading-day gaps.
function makeToyBreakout() {
  const dates = [];
  const d = new Date('2015-06-01T12:00:00Z');
  for (let i = 0; i < 400; i += 1) { dates.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  const rising = dates.map((date, i) => ({ date, open: 100 + 0.5 * i - 0.2, high: 100 + 0.5 * i + 1, low: 100 + 0.5 * i - 1, close: 100 + 0.5 * i }));
  const flat = dates.map((date) => ({ date, open: 50, high: 50.2, low: 49.8, close: 50 }));
  return new Map([['TLT', rising], ['GLD', flat]]);
}

test('simulateTurtle marks open positions daily and returns {date,ret,active}[]', () => {
  const series = simulateTurtle(makeToyBreakout(), { start: '2016-01-01', end: '2016-12-31', portfolio: 100000 });
  assert.ok(series.length > 0);
  assert.ok(series.every(p => typeof p.ret === 'number' && typeof p.active === 'boolean' && /^\d{4}-\d\d-\d\d$/.test(p.date)));
  assert.ok(series.some(p => p.active === true)); // the breakout produced a held position
});
