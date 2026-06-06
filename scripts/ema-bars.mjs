// scripts/ema-bars.mjs
// Lab bar cache for the EMA study, isolated from the production data/bar-cache so deep
// 2006 backfill never touches the live bots. Reuses parseBarsWithVolume for the shape.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBarsWithVolume } from './coil-eventstudy-bars.mjs';

export const EMA_CACHE_SUBDIR = join('data', 'lab', 'ema-bar-cache');

// FMP historical-price-eod/full returns a flat array of {date, open, high, low, close, volume}.
export function fmpEodToBars(payload) {
  const raw = Array.isArray(payload) ? payload : (payload.historical || payload.bars || []);
  return raw
    .filter(r => r && r.date && typeof r.close === 'number')
    .map(r => ({ date: r.date, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export function loadEmaBars(projectRoot, ticker) {
  const path = join(projectRoot, EMA_CACHE_SUBDIR, `${ticker.toUpperCase()}.json`);
  let obj;
  try { obj = JSON.parse(readFileSync(path, 'utf8')); } catch { return []; }
  return parseBarsWithVolume(obj);
}
