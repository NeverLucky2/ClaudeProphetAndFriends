// scripts/cef-bars.mjs
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CEF_CACHE_SUBDIR = join('data', 'lab', 'cef-cache');

export function loadCefBars(projectRoot, ticker) {
  const path = join(projectRoot, CEF_CACHE_SUBDIR, `${ticker.toUpperCase()}.json`);
  let obj;
  try { obj = JSON.parse(readFileSync(path, 'utf8')); } catch { return []; }
  const rows = (obj.weekly || [])
    .filter((r) => r && r.date && typeof r.price === 'number' && typeof r.nav === 'number')
    .map((r) => ({ date: r.date, price: r.price, nav: r.nav, discount: r.discount }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return rows;
}
