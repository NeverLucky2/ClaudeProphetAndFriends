// agent/bar-cache-reader.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadDailyCloses, closeOnOrAfter, forwardReturn } from './bar-cache-reader.js';

async function tmpCache(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bc-'));
  const dir = path.join(root, 'data', 'bar-cache');
  await fs.mkdir(dir, { recursive: true });
  for (const [name, obj] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), JSON.stringify(obj));
  }
  return root;
}
function bar(date, close) {
  return { Symbol: 'X', Timestamp: `${date}T04:00:00Z`, Open: close, High: close, Low: close, Close: close, Volume: 1, VWAP: close };
}

test('loadDailyCloses merges rolling files, newest written_at wins on dupes', async () => {
  const root = await tmpCache({
    'X_1Day_2026-05-01_2026-05-04.json': { symbol: 'X', written_at: '2026-05-04T00:00:00Z', bars: [bar('2026-05-01', 100), bar('2026-05-04', 110)] },
    'X_1Day_2026-05-04_2026-05-06.json': { symbol: 'X', written_at: '2026-05-06T00:00:00Z', bars: [bar('2026-05-04', 111), bar('2026-05-06', 120)] },
  });
  const closes = await loadDailyCloses(root, 'X');
  assert.equal(closes.get('2026-05-01'), 100);
  assert.equal(closes.get('2026-05-04'), 111); // newer written_at wins
  assert.equal(closes.get('2026-05-06'), 120);
});

test('loadDailyCloses returns empty map for unknown symbol', async () => {
  const root = await tmpCache({});
  assert.equal((await loadDailyCloses(root, 'NOPE')).size, 0);
});

test('closeOnOrAfter finds the next available trading-day bar within lookahead', async () => {
  const closes = new Map([['2026-05-04', 111], ['2026-05-06', 120]]);
  assert.deepEqual(closeOnOrAfter(closes, '2026-05-05', 4), { date: '2026-05-06', close: 120 });
  assert.equal(closeOnOrAfter(closes, '2026-05-07', 1), null);
});

test('forwardReturn computes underlying return over a 3-trading-day window', async () => {
  // 2026-05-21 Thu close 100 ; +3 trading days = 2026-05-27 close 110 -> +10%
  const closes = new Map([['2026-05-21', 100], ['2026-05-27', 110]]);
  const r = forwardReturn(closes, '2026-05-21', 3, '2026-05-29');
  assert.equal(r.status, 'ok');
  assert.equal(r.startDate, '2026-05-21');
  assert.equal(r.endDate, '2026-05-27');
  assert.ok(Math.abs(r.ret - 0.1) < 1e-9);
});

test('forwardReturn is pending when the window end is in the future', async () => {
  const closes = new Map([['2026-05-28', 100]]);
  const r = forwardReturn(closes, '2026-05-28', 3, '2026-05-29'); // end ~ 2026-06-02 > today
  assert.equal(r.status, 'pending');
});

test('forwardReturn is no_data when the start bar is missing in the past', async () => {
  const closes = new Map();
  const r = forwardReturn(closes, '2026-05-04', 3, '2026-05-29');
  assert.equal(r.status, 'no_data');
});
