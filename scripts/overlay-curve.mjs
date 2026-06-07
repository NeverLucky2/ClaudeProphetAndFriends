// scripts/overlay-curve.mjs
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OVERLAY_CACHE_SUBDIR } from './overlay-universe.mjs';
export function loadCurveFrom(projectRoot) {
  const path = join(projectRoot, OVERLAY_CACHE_SUBDIR, 'treasury-rates.json');
  let obj; try { obj = JSON.parse(readFileSync(path, 'utf8')); } catch { return []; }
  return (obj.curve || []).slice().sort((a, b) => (a.date < b.date ? -1 : 1));
}
