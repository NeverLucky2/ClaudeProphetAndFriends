// scripts/carry-bars.mjs
// Dedicated carry-study cache (isolated from the S1 fleet cache so the 2002-start deep backfill
// never mutates it). ETF bars reuse the fleet bar parser; the treasury curve is its own JSON.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBarsWithVolume } from './coil-eventstudy-bars.mjs';
import { CARRY_CACHE_SUBDIR } from './carry-universe.mjs';

export function loadCarryBars(projectRoot, ticker) {
  const path = join(projectRoot, CARRY_CACHE_SUBDIR, `${ticker.toUpperCase()}.json`);
  try { return parseBarsWithVolume(JSON.parse(readFileSync(path, 'utf8'))); }
  catch { return []; }
}

// Treasury curve rows ascending: [{date, m3, y2, y5, y7, y10, y30}] (percent units; missing = null).
export function loadCurve(projectRoot) {
  const path = join(projectRoot, CARRY_CACHE_SUBDIR, 'treasury-rates.json');
  let obj;
  try { obj = JSON.parse(readFileSync(path, 'utf8')); } catch { return []; }
  return (obj.curve || []).slice().sort((a, b) => (a.date < b.date ? -1 : 1));
}
