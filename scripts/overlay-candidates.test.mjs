// scripts/overlay-candidates.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { staticSleeveDaily, hedgeDaily } from './overlay-candidates.mjs';

const gld = [{ date: '2020-01-02', close: 100 }, { date: '2020-01-03', close: 102 }, { date: '2020-01-06', close: 101 }];

test('staticSleeveDaily = close-to-close ETF returns', () => {
  const s = staticSleeveDaily(gld, { start: '2020-01-01', end: '2020-12-31' });
  assert.equal(s.length, 2);
  assert.ok(Math.abs(s[0].ret - 0.02) < 1e-9);
  assert.ok(Math.abs(s[1].ret - (101 / 102 - 1)) < 1e-9);
  assert.equal(s[0].active, true);
});

test('hedgeDaily routes static candidates to the sleeve builder', () => {
  const barsByTicker = new Map([['GLD', gld]]);
  const s = hedgeDaily({ id: 'gld', kind: 'static', ticker: 'GLD' }, { barsByTicker, qqqBars: [], start: '2020-01-01', end: '2020-12-31' });
  assert.equal(s.length, 2);
});
