import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wilderRSI } from './coil-meanrev-signal.mjs';
import { loadBars } from './coil-eventstudy-bars.mjs';
import { MEANREV_UNIVERSE, chronoSplit } from './coil-eventstudy-build.mjs';
import { entryFiresAt, simulateTrade } from './coil-threshold-exitsim.mjs';
import { earningsWithinNext5 } from './coil-threshold-earnings.mjs';

export const MIN_BARS = 210, ENTRY_RSI = 5, BASELINE = 5, VARIANTS = [7, 8, 10];

// Canonical paired enumeration on the BASELINE (5-day) schedule. For each fresh RSI<5 entry
// whose 5-day exit is `time_stop`, re-simulate under every variant T and record the per-T exit.
// entryFires/sim are injectable for deterministic unit tests.
export function enumeratePaired(bars, {
  earningsDates = [], variants = VARIANTS, baseline = BASELINE, minBars = MIN_BARS,
  entryFires = (closes, i) => entryFiresAt(closes, i, ENTRY_RSI),
  sim = simulateTrade,
} = {}) {
  const closes = bars.map(b => b.close);
  const barDates = bars.map(b => b.date);
  const out = [];
  let openUntil = -1;
  for (let i = Math.max(minBars - 1, 0); i < bars.length; i += 1) {
    if (i <= openUntil) continue;
    if (!entryFires(closes, i)) continue;
    if (earningsWithinNext5(barDates, i, earningsDates)) continue;
    const base = sim(bars, i, { maxHold: baseline });
    openUntil = i + (base.censored ? bars.length : base.daysHeld); // advance on the 5-day schedule
    if (base.censored) break;
    if (base.exitReason !== 'time_stop') continue;                 // only stuck trades are paired
    const rsi2 = wilderRSI(closes.slice(0, i + 1), 2);
    const perT = {};
    for (const T of variants) {
      const t = sim(bars, i, { maxHold: T });
      perT[String(T)] = { gross: t.grossReturn, exitReason: t.exitReason, daysHeld: t.daysHeld, censored: t.censored };
    }
    out.push({ idx: i, date: barDates[i], rsi2, gross5: base.grossReturn, perT });
  }
  return out;
}

// Per-variant fresh enumeration at maxHold=T (entries are all RSI<5). openUntil advances by
// THIS variant's hold, so a longer T can suppress a nearby same-ticker re-entry. Censored
// trades (no exit within the data) are excluded — they cannot enter a finite-horizon book.
export function enumeratePortfolio(bars, {
  T = BASELINE, earningsDates = [], minBars = MIN_BARS,
  entryFires = (closes, i) => entryFiresAt(closes, i, ENTRY_RSI),
  sim = simulateTrade,
} = {}) {
  const closes = bars.map(b => b.close);
  const barDates = bars.map(b => b.date);
  const out = [];
  let openUntil = -1;
  for (let i = Math.max(minBars - 1, 0); i < bars.length; i += 1) {
    if (i <= openUntil) continue;
    if (!entryFires(closes, i)) continue;
    if (earningsWithinNext5(barDates, i, earningsDates)) continue;
    const t = sim(bars, i, { maxHold: T });
    openUntil = i + (t.censored ? bars.length : t.daysHeld);
    if (t.censored) break;
    const rsi2 = wilderRSI(closes.slice(0, i + 1), 2);
    out.push({ idx: i, date: barDates[i], rsi2, exitDate: barDates[i + t.daysHeld], gross: t.grossReturn });
  }
  return out;
}

// Single chronological 50/50 boundary, derived once from the canonical entry dates and applied
// identically to the paired set and every portfolio variant (keeps the split consistent).
export function boundaryFrom(records) {
  const { holdout } = chronoSplit(records);
  return holdout.length ? holdout[0].date : null;
}

export function tagSplit(records, boundaryDate) {
  return records.map(r => ({ ...r, split: boundaryDate && r.date >= boundaryDate ? 'holdout' : 'train' }));
}

// CLI: node scripts/coil-timeout-build.mjs [--earnings ...] [--out data/lab/coil-timeout-instances.json]
{
  const argv1 = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (fileURLToPath(import.meta.url) === argv1) {
    const args = process.argv.slice(2);
    const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
    const root = process.cwd();
    const earnPath = flag('--earnings', join(root, 'data', 'lab', 'coil-earnings-dates.json'));
    const out = flag('--out', join(root, 'data', 'lab', 'coil-timeout-instances.json'));
    let earningsByTicker = {};
    if (existsSync(earnPath)) earningsByTicker = JSON.parse(readFileSync(earnPath, 'utf8'));
    else process.stderr.write(`WARNING: ${earnPath} missing — running WITHOUT the earnings filter (verdict not trustworthy until present)\n`);

    const paired = [];
    const portfolio = { 5: [], 7: [], 8: [], 10: [] };
    const canonicalDates = []; // every baseline (5-day) fresh entry date, for the split boundary
    for (const t of MEANREV_UNIVERSE) {
      const bars = loadBars(root, t);
      if (bars.length < MIN_BARS) continue;
      const ed = earningsByTicker[t] || [];
      for (const p of enumeratePaired(bars, { earningsDates: ed })) { paired.push({ ticker: t, ...p }); }
      for (const T of [5, 7, 8, 10]) {
        for (const c of enumeratePortfolio(bars, { T, earningsDates: ed })) {
          portfolio[T].push({ ticker: t, ...c });
          if (T === 5) canonicalDates.push({ date: c.date });
        }
      }
    }
    const boundaryDate = boundaryFrom(canonicalDates);
    const taggedPaired = tagSplit(paired, boundaryDate);
    const taggedPortfolio = {};
    for (const T of [5, 7, 8, 10]) taggedPortfolio[T] = tagSplit(portfolio[T], boundaryDate);

    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({
      boundaryDate, variants: [5, 7, 8, 10],
      paired: taggedPaired, portfolio: taggedPortfolio,
      counts: { paired: paired.length, portfolio5: portfolio[5].length },
    }, null, 2));
    process.stdout.write(JSON.stringify({
      out, boundaryDate, paired: paired.length,
      portfolio: Object.fromEntries([5, 7, 8, 10].map(T => [T, portfolio[T].length])),
    }, null, 2) + '\n');
  }
}
