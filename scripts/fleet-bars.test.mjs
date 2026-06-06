// scripts/fleet-bars.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadFleetBars, FLEET_CACHE_SUBDIR } from './fleet-bars.mjs';

test('loadFleetBars round-trips the lab-cache calendar date (noon-UTC, no ET backshift) ascending', () => {
  const root = mkdtempSync(join(tmpdir(), 'fleet-'));
  mkdirSync(join(root, FLEET_CACHE_SUBDIR), { recursive: true });
  // ALIGNMENT INVARIANT: the lab cache writes {date}T12:00:00Z (noon UTC) so etDate maps it back
  // to the SAME calendar date. Writing T00:00:00Z would backshift one ET day (UTC-5/-4) and
  // misalign bars against unshifted FMP earnings dates (corrupting Drift's gap). fleet-fetch-bars
  // MUST write noon-UTC; this test guards that the date a bar is filed under is the date it loads as.
  writeFileSync(join(root, FLEET_CACHE_SUBDIR, 'TLT.json'), JSON.stringify({
    written_at: '2026-06-06T00:00:00Z',
    bars: [
      { Timestamp: '2016-01-05T12:00:00Z', Open: 1, High: 2, Low: 0.5, Close: 1.5, Volume: 10 },
      { Timestamp: '2016-01-04T12:00:00Z', Open: 1, High: 2, Low: 0.5, Close: 1.2, Volume: 9 },
    ],
  }));
  const bars = loadFleetBars(root, 'TLT');
  assert.equal(bars.length, 2);
  assert.deepEqual(bars.map(b => b.date), ['2016-01-04', '2016-01-05']); // same calendar dates, ascending
  assert.equal(bars[1].close, 1.5);
});

test('loadFleetBars returns [] for a missing ticker', () => {
  const root = mkdtempSync(join(tmpdir(), 'fleet-'));
  assert.deepEqual(loadFleetBars(root, 'NOPE'), []);
});
