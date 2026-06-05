// scripts/coil-threshold-build.mjs
// Enumerate Coil-faithful trades (fresh, one-per-ticker, forward-earnings-filtered) across
// the universe at the widest study threshold (RSI<15), simulate each, tag its RSI bucket,
// and chrono-split. Reuses loadBars, MEANREV_UNIVERSE, chronoSplit.
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wilderRSI } from './coil-meanrev-signal.mjs';
import { loadBars } from './coil-eventstudy-bars.mjs';
import { MEANREV_UNIVERSE, chronoSplit } from './coil-eventstudy-build.mjs';
import { entryFiresAt, simulateTrade } from './coil-threshold-exitsim.mjs';
import { earningsWithinNext5 } from './coil-threshold-earnings.mjs';

const MIN_BARS = 210, WIDEST_RSI = 15;

export function bucketOf(rsi2) {
  if (rsi2 < 5) return '[0,5)';
  if (rsi2 < 8) return '[5,8)';
  if (rsi2 < 10) return '[8,10)';
  if (rsi2 < 15) return '[10,15)';
  return null;
}

// One-per-ticker enumeration: open a trade on a fresh signal, then skip all signals until
// it exits (mirrors Coil's no-averaging / no-same-day-reentry). earningsDates excludes
// entries with forward earnings within 5 trading bars.
export function enumerateFreshTrades(bars, { rsiMax = WIDEST_RSI, earningsDates = [] } = {}) {
  const closes = bars.map(b => b.close);
  const barDates = bars.map(b => b.date);
  const trades = [];
  let openUntil = -1; // last bar index occupied by an open sim position
  for (let i = MIN_BARS - 1; i < bars.length; i += 1) {
    if (i <= openUntil) continue;
    if (!entryFiresAt(closes, i, rsiMax)) continue;
    if (earningsWithinNext5(barDates, i, earningsDates)) continue;
    const rsi2 = wilderRSI(closes.slice(0, i + 1), 2);
    if (bucketOf(rsi2) === null) continue; // outside the study bucket range (RSI >= 15)
    const t = simulateTrade(bars, i);
    const exitDate = t.censored ? null : barDates[i + t.daysHeld];
    trades.push({ idx: i, date: barDates[i], rsi2, bucket: bucketOf(rsi2), exitDate, ...t });
    openUntil = i + (t.censored ? bars.length : t.daysHeld);
    if (t.censored) break; // no usable bars left
  }
  return trades;
}

// CLI: node scripts/coil-threshold-build.mjs [--earnings data/lab/coil-earnings-dates.json] [--out ...]
{
  const argv1 = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (fileURLToPath(import.meta.url) === argv1) {
    const args = process.argv.slice(2);
    const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
    const root = process.cwd();
    const earnPath = flag('--earnings', join(root, 'data', 'lab', 'coil-earnings-dates.json'));
    const out = flag('--out', join(root, 'data', 'lab', 'coil-threshold-instances.json'));
    let earningsByTicker = {};
    if (existsSync(earnPath)) earningsByTicker = JSON.parse(readFileSync(earnPath, 'utf8'));
    else process.stderr.write(`WARNING: ${earnPath} missing — running WITHOUT the earnings filter (verdict not trustworthy until present)\n`);
    const rows = [];
    let usedEarnings = 0;
    for (const t of MEANREV_UNIVERSE) {
      const bars = loadBars(root, t);
      if (bars.length < MIN_BARS) continue;
      const ed = earningsByTicker[t] || [];
      if (ed.length) usedEarnings += 1;
      for (const tr of enumerateFreshTrades(bars, { earningsDates: ed })) rows.push({ ticker: t, ...tr });
    }
    const completed = rows.filter(r => !r.censored);
    const { all } = chronoSplit(completed);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(all, null, 2));
    process.stdout.write(JSON.stringify({
      out, universe: MEANREV_UNIVERSE.length, tickers_with_earnings: usedEarnings,
      trades_total: rows.length, completed: completed.length, censored: rows.length - completed.length,
    }, null, 2) + '\n');
  }
}
