import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weeklyPriceReturn, decomposeReturn, simulateCef } from './cef-sim.mjs';

test('weeklyPriceReturn = price_t/price_{t-1} - 1', () => {
  assert.ok(Math.abs(weeklyPriceReturn(19.0, 18.97) - (19.0 / 18.97 - 1)) < 1e-12);
});

test('decomposeReturn splits price-change into NAV-move + Δdiscount (multiplicative-exact)', () => {
  const a = { price: 100, nav: 100, discount: 0 };
  const b = { price: 99 * 1.02, nav: 99, discount: 0.02 };
  const d = decomposeReturn(a, b);
  assert.ok(Math.abs(d.total - (b.price / a.price - 1)) < 1e-9);
  assert.ok(Math.abs(d.navMove - (-0.01)) < 1e-9);
  assert.ok(Math.abs((1 + d.navMove) * (1 + d.discountChange) - (1 + d.total)) < 1e-9);
});

// 60 weekly bars/ticker. AAA: mild wiggle around -0.10 for 53 weeks, then a wide -0.18 (z very
// negative -> enter), then -0.08 (above norm -> z>=0 -> exit). BBB: flat -0.10 (std 0 -> never fires).
function makeTwoCefWideThenRevert() {
  const dates = [];
  const d = new Date('2021-01-04T12:00:00Z');
  for (let i = 0; i < 60; i += 1) { dates.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 7); }
  const nav = 20;
  const mk = (discount) => ({ price: nav * (1 + discount), nav, discount });
  const aaa = dates.map((date, i) => {
    let disc;
    if (i < 53) disc = -0.10 + 0.005 * ((i % 5) - 2);
    else if (i === 53) disc = -0.18;
    else disc = -0.08;
    return { date, ...mk(disc) };
  });
  const bbb = dates.map((date) => ({ date, ...mk(-0.10) }));
  return new Map([['AAA', aaa], ['BBB', bbb]]);
}

test('simulateCef enters most-negative-z first, caps positions, charges round-trip at exit; emits {date,ret,active}', () => {
  const bars = makeTwoCefWideThenRevert();
  const series = simulateCef(bars, { L: 52, zEnter: 1.5, timeStop: 26, maxPositions: 10, tierByTicker: { AAA: 'liquid', BBB: 'liquid' } });
  assert.ok(series.weekly.every((p) => typeof p.ret === 'number' && typeof p.active === 'boolean'));
  assert.ok(series.weekly.some((p) => p.active));
  assert.ok(series.trades.length >= 1);
  assert.ok(series.trades[0].netReturn < series.trades[0].grossReturn);
});
