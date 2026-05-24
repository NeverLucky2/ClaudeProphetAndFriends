import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PROPHET_INTRADAY_WATCHLIST } from './harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const floorPath = join(here, '..', 'config', 'prophet_tradable_universe.txt');

function loadFloor() {
  return new Set(
    readFileSync(floorPath, 'utf8')
      .split('\n')
      .map((l) => l.split('#')[0].trim().toUpperCase())
      .filter(Boolean),
  );
}

test('intraday watchlist is a subset of the tradable floor', () => {
  const floor = loadFloor();
  for (const sym of PROPHET_INTRADAY_WATCHLIST) {
    assert.ok(floor.has(sym), `watchlist symbol ${sym} is not in the tradable floor`);
  }
});

test('intraday watchlist is ~12 deep-chain names', () => {
  assert.ok(PROPHET_INTRADAY_WATCHLIST.length >= 10 && PROPHET_INTRADAY_WATCHLIST.length <= 14,
    `expected ~12 names, got ${PROPHET_INTRADAY_WATCHLIST.length}`);
});
