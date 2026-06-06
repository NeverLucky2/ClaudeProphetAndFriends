import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCefBars, CEF_CACHE_SUBDIR } from './cef-bars.mjs';

test('loadCefBars parses weekly {date,price,nav,discount}, ascending, discount as a fraction', () => {
  const root = mkdtempSync(join(tmpdir(), 'cef-'));
  mkdirSync(join(root, CEF_CACHE_SUBDIR), { recursive: true });
  writeFileSync(join(root, CEF_CACHE_SUBDIR, 'PDI.json'), JSON.stringify({
    written_at: '2026-06-06T00:00:00Z',
    weekly: [
      { date: '2025-06-13', price: 19.0, nav: 16.9, discount: 0.1243 },
      { date: '2025-06-06', price: 18.97, nav: 16.84, discount: 0.1265 },
    ],
  }));
  const bars = loadCefBars(root, 'PDI');
  assert.equal(bars.length, 2);
  assert.deepEqual(bars.map((b) => b.date), ['2025-06-06', '2025-06-13']);
  assert.ok(Math.abs(bars[0].discount - 0.1265) < 1e-9);
});
test('loadCefBars returns [] for a missing ticker', () => {
  const root = mkdtempSync(join(tmpdir(), 'cef-'));
  assert.deepEqual(loadCefBars(root, 'NOPE'), []);
});
