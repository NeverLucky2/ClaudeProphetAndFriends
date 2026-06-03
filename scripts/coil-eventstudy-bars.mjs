// scripts/coil-eventstudy-bars.mjs
// Bar loader for the Coil event study. UNLIKE stage1-build-signals' parseBarsObject,
// this RETAINS volume (the price-signature features need it). ET-date keyed, ascending.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ET_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
});
export function etDate(iso) {
  const p = {}; for (const x of ET_FMT.formatToParts(new Date(iso))) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}`;
}

export function parseBarsWithVolume(obj) {
  const raw = Array.isArray(obj) ? obj : (obj.bars || []);
  const byDate = new Map();
  for (const b of raw) {
    const ts = b.Timestamp || b.timestamp;
    const o = b.Open ?? b.open, h = b.High ?? b.high, l = b.Low ?? b.low, c = b.Close ?? b.close;
    const v = b.Volume ?? b.volume;
    if (!ts || typeof o !== 'number' || typeof c !== 'number') continue;
    byDate.set(etDate(ts), { date: etDate(ts), open: o, high: h, low: l, close: c, volume: v });
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export function loadBars(projectRoot, ticker) {
  const dir = join(projectRoot, 'data', 'bar-cache');
  const prefix = `${ticker.toUpperCase()}_1Day_`;
  let files = [];
  try { files = readdirSync(dir); } catch { return []; }
  const winner = new Map(); // date -> { bar, writtenAt }
  for (const f of files) {
    if (!f.startsWith(prefix) || !f.endsWith('.json')) continue;
    let obj; try { obj = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
    const writtenAt = (obj && obj.written_at) || '';
    for (const bar of parseBarsWithVolume(obj)) {
      const prev = winner.get(bar.date);
      if (!prev || writtenAt >= prev.writtenAt) winner.set(bar.date, { bar, writtenAt });
    }
  }
  return [...winner.values()].map(v => v.bar).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export function indexByDate(bars) {
  const m = new Map();
  for (let i = 0; i < bars.length; i += 1) m.set(bars[i].date, i);
  return m;
}
