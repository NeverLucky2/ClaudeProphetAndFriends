// scripts/carry-bars.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCarryBars, loadCurve } from './carry-bars.mjs';
import { CARRY_CACHE_SUBDIR } from './carry-universe.mjs';

function tmpRoot() {
  const root = mkdtempSync(join(tmpdir(), 'carry-'));
  mkdirSync(join(root, CARRY_CACHE_SUBDIR), { recursive: true });
  return root;
}

test('loadCarryBars returns [] when the ticker cache is missing', () => {
  assert.deepEqual(loadCarryBars(tmpRoot(), 'IEF'), []);
});
test('loadCarryBars parses the fleet-style bar JSON ascending', () => {
  const root = tmpRoot();
  writeFileSync(join(root, CARRY_CACHE_SUBDIR, 'IEF.json'), JSON.stringify({
    written_at: 'x',
    bars: [
      { Timestamp: '2002-07-30T12:00:00Z', Open: 80, High: 81, Low: 79, Close: 80.5, Volume: 1000 },
      { Timestamp: '2002-07-31T12:00:00Z', Open: 80.5, High: 82, Low: 80, Close: 81.2, Volume: 1200 },
    ],
  }));
  const bars = loadCarryBars(root, 'IEF');
  assert.equal(bars.length, 2);
  assert.equal(bars[0].date, '2002-07-30');
  assert.equal(bars[1].close, 81.2);
});
test('loadCurve returns rows sorted ascending by date', () => {
  const root = tmpRoot();
  writeFileSync(join(root, CARRY_CACHE_SUBDIR, 'treasury-rates.json'), JSON.stringify({
    written_at: 'x',
    curve: [
      { date: '2022-02-01', m3: 0.3, y7: 1.8, y10: 1.9 },
      { date: '2022-01-03', m3: 0.1, y7: 1.6, y10: 1.7 },
    ],
  }));
  const curve = loadCurve(root);
  assert.equal(curve.length, 2);
  assert.equal(curve[0].date, '2022-01-03');
  assert.equal(curve[1].y10, 1.9);
});
test('loadCurve returns [] when absent', () => {
  assert.deepEqual(loadCurve(tmpRoot()), []);
});
