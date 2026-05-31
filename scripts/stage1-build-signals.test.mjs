// scripts/stage1-build-signals.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  etParts, nextCalendarDate, newsToSession, medianDate, parseBarsObject, buildAndSplit,
} from './stage1-build-signals.mjs';

test('etParts: UTC -> ET date/hour across DST', () => {
  assert.deepEqual(etParts('2024-04-02T01:00:00Z'), { date: '2024-04-01', hour: 21 }); // EDT -4
  assert.deepEqual(etParts('2024-01-02T01:00:00Z'), { date: '2024-01-01', hour: 20 }); // EST -5
});

test('nextCalendarDate rolls month/year', () => {
  assert.equal(nextCalendarDate('2024-04-30'), '2024-05-01');
  assert.equal(nextCalendarDate('2024-12-31'), '2025-01-01');
});

test('newsToSession: intraday->same, after-close->next, weekend->Mon, past-end->null', () => {
  const s = ['2024-04-01', '2024-04-02', '2024-04-03', '2024-04-04', '2024-04-05', '2024-04-08'];
  assert.equal(newsToSession('2024-04-01T14:30:00Z', s), '2024-04-01'); // 10:30 ET, before close
  assert.equal(newsToSession('2024-04-01T21:00:00Z', s), '2024-04-02'); // 17:00 ET, after close -> next
  assert.equal(newsToSession('2024-04-06T15:00:00Z', s), '2024-04-08'); // Sat -> Mon session
  assert.equal(newsToSession('2024-04-09T12:00:00Z', s), null);          // beyond last session
});

test('medianDate', () => {
  assert.equal(medianDate(['2024-01-01', '2024-02-01', '2024-03-01', '2024-04-01']), '2024-03-01');
  assert.equal(medianDate([]), null);
});

test('parseBarsObject: cache shape -> ET-dated ascending OHLC', () => {
  const obj = {
    written_at: '2026-01-01', bars: [
      { Symbol: 'X', Timestamp: '2024-04-02T04:00:00Z', Open: 10, High: 11, Low: 9, Close: 10.5 },
      { Symbol: 'X', Timestamp: '2024-04-01T04:00:00Z', Open: 9, High: 10, Low: 8, Close: 9.5 },
    ],
  };
  const bars = parseBarsObject(obj);
  assert.deepEqual(bars.map(b => b.date), ['2024-04-01', '2024-04-02']);
  assert.equal(bars[0].open, 9);
  assert.equal(bars[1].close, 10.5);
});

test('buildAndSplit: end-to-end on mock catalysts+bars; drops names without bars', () => {
  const bars = [];
  for (let i = 0; i < 30; i += 1) {
    const c = 100 + i;
    bars.push({ date: `2024-04-${String(i + 1).padStart(2, '0')}`, open: c - 0.5, high: c + 1, low: c - 1, close: c });
  }
  const barsByTicker = new Map([['AAA', bars]]);
  const catalysts = [
    { ticker: 'AAA', published: '2024-04-21T14:00:00Z', event_type: 'earnings', headline: 'tops estimates', snippet: '' },
    { ticker: 'ZZZ', published: '2024-04-21T14:00:00Z', event_type: 'earnings', headline: 'tops estimates', snippet: '' }, // no bars
  ];
  const r = buildAndSplit({ catalysts, barsByTicker, H: 3 });
  assert.equal(r.dropped_no_bars, 1);
  assert.equal(r.catalysts_in, 2);
  assert.ok(r.n_total >= 1);
  assert.equal(r.n_train + r.n_holdout, r.n_total);
});
