// scripts/fleet-bars.mjs
// Dedicated lab bar cache for the fleet study — isolated from production data/bar-cache
// so the deep backfill never touches live bots, and the study is reproducible.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBarsWithVolume } from './coil-eventstudy-bars.mjs';

export const FLEET_CACHE_SUBDIR = join('data', 'lab', 'fleet-bar-cache');

export function loadFleetBars(projectRoot, ticker) {
  const path = join(projectRoot, FLEET_CACHE_SUBDIR, `${ticker.toUpperCase()}.json`);
  let obj;
  try { obj = JSON.parse(readFileSync(path, 'utf8')); } catch { return []; }
  return parseBarsWithVolume(obj);
}

export function barsByDate(bars) {
  const m = new Map();
  for (let i = 0; i < bars.length; i += 1) m.set(bars[i].date, i);
  return m;
}
