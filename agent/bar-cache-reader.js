// agent/bar-cache-reader.js
// Read-only daily-close lookup over data/bar-cache/<SYM>_1Day_<start>_<end>.json.
// Multiple rolling-window files exist per symbol; we merge them and dedupe by ET
// date, newest written_at winning. Pure FS + date math.
import fs from 'node:fs/promises';
import path from 'node:path';
import { etDateString, isTradingDay, nextTradingDay, addTradingDays } from './market-calendar.js';

function _addCalendarDay(etDate) {
  const d = new Date(etDate + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// loadDailyCloses returns Map<etDate, closePrice> merged across all cache files
// for the symbol. Bars use PascalCase Alpaca keys (Timestamp/Close).
export async function loadDailyCloses(projectRoot, symbol) {
  const dir = path.join(projectRoot, 'data', 'bar-cache');
  let files;
  try {
    files = await fs.readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return new Map();
    throw err;
  }
  const prefix = `${symbol.toUpperCase()}_1Day_`;
  const winner = new Map(); // etDate -> { close, writtenAt }
  for (const f of files) {
    if (!f.startsWith(prefix) || !f.endsWith('.json')) continue;
    let obj;
    try {
      obj = JSON.parse(await fs.readFile(path.join(dir, f), 'utf-8'));
    } catch {
      continue; // skip malformed cache file
    }
    const bars = Array.isArray(obj) ? obj : (obj.bars || []);
    const writtenAt = (obj && obj.written_at) || '';
    for (const b of bars) {
      const ts = b.Timestamp || b.timestamp;
      const close = typeof b.Close === 'number' ? b.Close : b.close;
      if (!ts || typeof close !== 'number') continue;
      const d = etDateString(new Date(ts));
      const prev = winner.get(d);
      if (!prev || writtenAt >= prev.writtenAt) winner.set(d, { close, writtenAt });
    }
  }
  const out = new Map();
  for (const [d, v] of winner) out.set(d, v.close);
  return out;
}

// closeOnOrAfter walks forward up to maxLookahead calendar days to tolerate
// small cache gaps. Returns { date, close } or null.
export function closeOnOrAfter(closes, etDate, maxLookahead = 4) {
  let d = etDate;
  for (let i = 0; i <= maxLookahead; i++) {
    if (closes.has(d)) return { date: d, close: closes.get(d) };
    d = _addCalendarDay(d);
  }
  return null;
}

// forwardReturn: return of the underlying from the tip's start trading day over
// `windowDays` trading days. Anchors the start to a trading day, then ends at
// addTradingDays(start, windowDays). Status:
//   'ok'      -> { status, startDate, endDate, startClose, endClose, ret }
//   'pending' -> window end is after todayEtDate (bars not available yet)
//   'no_data' -> a needed bar is missing although the date is in the past
export function forwardReturn(closes, startEtDate, windowDays, todayEtDate) {
  const start = isTradingDay(startEtDate) ? startEtDate : nextTradingDay(startEtDate);
  const endTarget = addTradingDays(start, windowDays);
  const s = closeOnOrAfter(closes, start, 4);
  if (endTarget > todayEtDate) return { status: 'pending' };
  if (!s) return { status: 'no_data' };
  const e = closeOnOrAfter(closes, endTarget, 4);
  if (!e) return { status: 'no_data' };
  return {
    status: 'ok',
    startDate: s.date,
    endDate: e.date,
    startClose: s.close,
    endClose: e.close,
    ret: e.close / s.close - 1,
  };
}
