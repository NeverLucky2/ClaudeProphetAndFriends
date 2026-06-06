// scripts/orb-bars.mjs
// Session-aware intraday loader for the ORB study. Bars keyed by ET minute-of-day so the
// opening-range / entry-trigger boundaries are unambiguous. RTH = [09:30, 16:00) ET.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const RTH_OPEN = 570;   // 09:30 ET in minutes
export const RTH_CLOSE = 960;  // 16:00 ET
export const OR_END = 585;     // 09:45 ET (OR = [570,585) = three 5-min bars)
export const ORB_CACHE_SUBDIR = join('data', 'lab', 'orb-bar-cache');

const ET = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});
export function etParts(iso) {
  const p = {}; for (const x of ET.formatToParts(new Date(iso))) p[x.type] = x.value;
  let hh = parseInt(p.hour, 10); if (hh === 24) hh = 0; // Intl can emit 24 for midnight
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: hh * 60 + parseInt(p.minute, 10) };
}

export function toSessionBars(rawBars) {
  const byDate = new Map();
  for (const b of rawBars) {
    const ts = b.Timestamp || b.timestamp; if (!ts) continue;
    const { date, minutes } = etParts(ts);
    if (minutes < RTH_OPEN || minutes >= RTH_CLOSE) continue;
    const bar = { minutes, open: b.Open ?? b.open, high: b.High ?? b.high, low: b.Low ?? b.low, close: b.Close ?? b.close, volume: b.Volume ?? b.volume };
    if (!Number.isFinite(bar.open) || !Number.isFinite(bar.close)) continue;
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(bar);
  }
  const out = [];
  for (const [date, bars] of byDate) { bars.sort((a, b) => a.minutes - b.minutes); out.push({ date, bars }); }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

export function loadOrbSessions(projectRoot, ticker) {
  const path = join(projectRoot, ORB_CACHE_SUBDIR, `${ticker.toUpperCase()}.json`);
  let obj; try { obj = JSON.parse(readFileSync(path, 'utf8')); } catch { return []; }
  return toSessionBars(Array.isArray(obj) ? obj : (obj.bars || []));
}
