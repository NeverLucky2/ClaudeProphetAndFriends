// scripts/ema-bars.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fmpEodToBars, loadEmaBars } from './ema-bars.mjs';

test('fmpEodToBars maps FMP historical-price-eod/full rows to bar objects, ascending', () => {
  const payload = [
    { date: '2008-01-03', open: 2, high: 3, low: 1, close: 2.5, volume: 100 },
    { date: '2008-01-02', open: 1, high: 2, low: 0.5, close: 1.5, volume: 90 },
  ];
  const bars = fmpEodToBars(payload);
  assert.equal(bars.length, 2);
  assert.equal(bars[0].date, '2008-01-02');     // ascending
  assert.deepEqual(
    { o: bars[1].open, h: bars[1].high, l: bars[1].low, c: bars[1].close, v: bars[1].volume },
    { o: 2, h: 3, l: 1, c: 2.5, v: 100 });
});

test('loadEmaBars reads {written_at,bars} from the lab cache dir', () => {
  const root = mkdtempSync(join(tmpdir(), 'emabars-'));
  mkdirSync(join(root, 'data', 'lab', 'ema-bar-cache'), { recursive: true });
  writeFileSync(join(root, 'data', 'lab', 'ema-bar-cache', 'SPY.json'),
    JSON.stringify({ written_at: '2026-06-06', bars: [
      { Timestamp: '2008-01-02T00:00:00Z', Open: 1, High: 2, Low: 0.5, Close: 1.5, Volume: 9 },
    ] }));
  const bars = loadEmaBars(root, 'SPY');
  assert.equal(bars.length, 1);
  assert.equal(bars[0].close, 1.5);
});
