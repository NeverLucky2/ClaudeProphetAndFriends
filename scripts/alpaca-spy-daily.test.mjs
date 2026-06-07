// scripts/alpaca-spy-daily.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleBars, etDateOf, buildBarsUrl } from './alpaca-spy-daily.mjs';

test('buildBarsUrl requests 1Day split-adjusted with the window', () => {
  const url = buildBarsUrl('2026-01-01', '2026-03-31');
  assert.match(url, /\/v2\/stocks\/SPY\/bars/);
  assert.match(url, /timeframe=1Day/);
  assert.match(url, /adjustment=split/);
  assert.match(url, /start=2026-01-01/);
});

test('etDateOf buckets a UTC bar timestamp to its ET calendar date', () => {
  // 2026-03-02T21:00:00Z = 16:00 ET (market close) → 2026-03-02
  assert.equal(etDateOf('2026-03-02T21:00:00Z'), '2026-03-02');
});

test('assembleBars merges paginated pages into ordered dates + close map', () => {
  const pages = [
    { bars: [{ t: '2026-03-02T21:00:00Z', c: 580 }, { t: '2026-03-03T21:00:00Z', c: 585 }] },
    { bars: [{ t: '2026-03-04T21:00:00Z', c: 583 }] },
  ];
  const { dates, close } = assembleBars(pages);
  assert.deepEqual(dates, ['2026-03-02', '2026-03-03', '2026-03-04']);
  assert.equal(close['2026-03-04'], 583);
});
