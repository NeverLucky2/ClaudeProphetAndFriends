// scripts/stage1-build-signals.mjs
// Orchestrator (Build B): catalyst table + raw OHLC bar-cache -> firings.json + exact
// n per split. Maps each news item to the ET trading SESSION it can first be acted on
// (lookahead-safe: news at/after 16:00 ET -> next session), then reuses the tested
// buildFirings/thinFirings/splitByDate library. Reports n only; the SCORER does the
// hit-rate/verdict so the holdout stays one-shot.

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFirings, thinFirings, splitByDate } from './stage1-signals.mjs';

const ET_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', hour12: false,
});

export function etParts(iso) {
  const parts = ET_FMT.formatToParts(new Date(iso));
  const m = {};
  for (const p of parts) m[p.type] = p.value;
  let hour = Number(m.hour);
  if (hour === 24) hour = 0;
  return { date: `${m.year}-${m.month}-${m.day}`, hour };
}

export function nextCalendarDate(d) {
  const dt = new Date(`${d}T12:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}

// First tradable session >= the actionable date. News at/after 16:00 ET (close) rolls
// to the next calendar day before the session search; weekends/holidays fall through
// to the next present session automatically.
export function newsToSession(published, sortedSessionDates) {
  const { date, hour } = etParts(published);
  const candidate = hour < 16 ? date : nextCalendarDate(date);
  for (const d of sortedSessionDates) if (d >= candidate) return d;
  return null;
}

export function medianDate(dates) {
  if (!dates.length) return null;
  const s = [...dates].sort();
  return s[Math.floor(s.length / 2)];
}

export function parseBarsObject(obj) {
  const bars = Array.isArray(obj) ? obj : (obj.bars || []);
  const byDate = new Map();
  for (const b of bars) {
    const ts = b.Timestamp || b.timestamp;
    const open = typeof b.Open === 'number' ? b.Open : b.open;
    const high = typeof b.High === 'number' ? b.High : b.high;
    const low = typeof b.Low === 'number' ? b.Low : b.low;
    const close = typeof b.Close === 'number' ? b.Close : b.close;
    if (!ts || typeof open !== 'number' || typeof close !== 'number') continue;
    const { date } = etParts(ts);
    byDate.set(date, { date, open, high, low, close }); // last wins within a file
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// Merge all rolling-window cache files per ticker; newest written_at wins per date.
export function loadBarsByTicker(projectRoot, tickers) {
  const dir = join(projectRoot, 'data', 'bar-cache');
  let files = [];
  try { files = readdirSync(dir); } catch { return new Map(); }
  const out = new Map();
  for (const t of tickers) {
    const prefix = `${t.toUpperCase()}_1Day_`;
    const winner = new Map(); // date -> { bar, writtenAt }
    for (const f of files) {
      if (!f.startsWith(prefix) || !f.endsWith('.json')) continue;
      let obj;
      try { obj = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
      const writtenAt = (obj && obj.written_at) || '';
      for (const bar of parseBarsObject(obj)) {
        const prev = winner.get(bar.date);
        if (!prev || writtenAt >= prev.writtenAt) winner.set(bar.date, { bar, writtenAt });
      }
    }
    if (winner.size) {
      out.set(t.toUpperCase(), [...winner.values()].map(v => v.bar)
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)));
    }
  }
  return out;
}

export function buildAndSplit({ catalysts, barsByTicker, H }) {
  const sessionsByTicker = new Map();
  for (const [t, bars] of barsByTicker) sessionsByTicker.set(t, bars.map(b => b.date));
  let dropped_no_bars = 0;
  let dropped_no_session = 0;
  const mapped = [];
  for (const c of catalysts) {
    const t = (c.ticker || '').toUpperCase();
    const sessions = sessionsByTicker.get(t);
    if (!sessions) { dropped_no_bars += 1; continue; }
    const published = c.published || `${c.date}T12:00:00Z`;
    const sd = newsToSession(published, sessions);
    if (!sd) { dropped_no_session += 1; continue; }
    mapped.push({ ...c, ticker: t, date: sd });
  }
  const firings = thinFirings(buildFirings(mapped, barsByTicker, H), H);
  const splitDate = medianDate(firings.map(f => f.date));
  const split = splitDate ? splitByDate(firings, splitDate) : [];
  const n_train = split.filter(f => f.split === 'train').length;
  const n_holdout = split.filter(f => f.split === 'holdout').length;
  return {
    firings: split, splitDate,
    n_total: split.length, n_train, n_holdout,
    dropped_no_bars, dropped_no_session,
    catalysts_in: catalysts.length, mapped: mapped.length,
  };
}

// CLI: node scripts/stage1-build-signals.mjs [--catalysts <path>] [--out <path>] [--horizon 3]
{
  const __filename = fileURLToPath(import.meta.url);
  const argv1abs = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (__filename === argv1abs) {
    const args = process.argv.slice(2);
    const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
    const projectRoot = process.cwd();
    const catalystsPath = flag('--catalysts', join(projectRoot, 'data', 'lab', 'catalysts-2022-2026.json'));
    const outPath = flag('--out', join(projectRoot, 'data', 'lab', 'firings.json'));
    const H = Number(flag('--horizon', '3'));
    let catalysts;
    try { catalysts = JSON.parse(readFileSync(catalystsPath, 'utf8')); }
    catch (e) { process.stderr.write(`cannot read catalysts at ${catalystsPath}: ${e.message}\n`); process.exit(2); }
    const tickers = [...new Set(catalysts.map(c => (c.ticker || '').toUpperCase()).filter(Boolean))];
    const barsByTicker = loadBarsByTicker(projectRoot, tickers);
    const r = buildAndSplit({ catalysts, barsByTicker, H });
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(r.firings, null, 2));
    const byType = {};
    for (const c of catalysts) byType[c.event_type] = (byType[c.event_type] || 0) + 1;
    process.stdout.write(JSON.stringify({
      out: outPath, horizon: H,
      catalysts_in: r.catalysts_in, catalyst_rows_by_type: byType,
      tickers_requested: tickers.length, tickers_with_bars: barsByTicker.size,
      mapped_to_session: r.mapped, dropped_no_bars: r.dropped_no_bars, dropped_no_session: r.dropped_no_session,
      split_date: r.splitDate, n_total_firings: r.n_total, n_train: r.n_train, n_holdout: r.n_holdout,
      required_n_per_split: 235,
      verdict: (r.n_train >= 235 && r.n_holdout >= 235)
        ? 'POWERED (n>=235 both splits) -> freeze prereg + score'
        : 'UNDERPOWERED (a split < 235) -> STOP',
    }, null, 2) + '\n');
  }
}
