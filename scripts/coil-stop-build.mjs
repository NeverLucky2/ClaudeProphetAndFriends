// scripts/coil-stop-build.mjs
// Stop-tightening study build (mirror of coil-timeout-build.mjs; the knob is stopPct, maxHold
// stays 5). Phase 1: paired marginal set on the 0.07 baseline schedule. Phase 2: per-variant
// fresh enumeration (a tighter stop frees a slot earlier -> the realized entry set is endogenous).
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wilderRSI } from './coil-meanrev-signal.mjs';
import { loadBars } from './coil-eventstudy-bars.mjs';
import { MEANREV_UNIVERSE } from './coil-eventstudy-build.mjs';
import { entryFiresAt, simulateTrade } from './coil-threshold-exitsim.mjs';
import { earningsWithinNext5 } from './coil-threshold-earnings.mjs';
import { boundaryFrom, tagSplit } from './coil-timeout-build.mjs';

export const MIN_BARS = 210, ENTRY_RSI = 5, MAX_HOLD = 5, BASELINE = 0.07;
export const VARIANTS = [0.03, 0.04, 0.05, 0.06];
export const MARGINAL_PROBE = 0.03; // shallowest tighter stop -> superset marginal set

// Phase 1: fresh RSI<5 entries on the BASELINE (0.07) schedule, re-simulated at every tighter
// stopPct. Keep only entries a tighter stop changes at all (marginal at the 0.03 probe).
export function enumerateMarginal(bars, {
  earningsDates = [], variants = VARIANTS, baseline = BASELINE, maxHold = MAX_HOLD, minBars = MIN_BARS,
  entryFires = (closes, i) => entryFiresAt(closes, i, ENTRY_RSI),
  sim = simulateTrade,
} = {}) {
  const closes = bars.map(b => b.close);
  const barDates = bars.map(b => b.date);
  const out = [];
  if (bars.length < minBars) return out;
  let openUntil = -1;
  for (let i = 0; i < bars.length; i += 1) {
    if (i <= openUntil) continue;
    if (!entryFires(closes, i)) continue;
    if (earningsWithinNext5(barDates, i, earningsDates)) continue;
    const base = sim(bars, i, { stopPct: baseline, maxHold });
    openUntil = i + (base.censored ? bars.length : base.daysHeld); // advance on the baseline schedule
    if (base.censored) break;
    const rsi2 = wilderRSI(closes.slice(0, i + 1), 2);
    const perS = {};
    for (const s of variants) {
      const t = sim(bars, i, { stopPct: s, maxHold });
      perS[String(s)] = { gross: t.grossReturn, exitReason: t.exitReason, daysHeld: t.daysHeld, censored: t.censored };
    }
    const probe = perS[String(MARGINAL_PROBE)];
    const changed = probe && (probe.exitReason !== base.exitReason || probe.gross !== base.grossReturn);
    if (!changed) continue; // tighter stop never touches this trade -> delta 0 at every variant
    out.push({ idx: i, date: barDates[i], rsi2, grossBase: base.grossReturn, baseReason: base.exitReason, perS });
  }
  return out;
}

// Phase 2: per-variant fresh enumeration at a fixed stopPct. openUntil advances by THIS variant's
// hold, so a tighter stop (shorter hold) frees the slot earlier and can admit a nearby re-entry.
// Records exitReason so the scorer's stop-slippage arm can dock slippage on stop exits only.
export function enumeratePortfolioStop(bars, {
  stopPct = BASELINE, earningsDates = [], maxHold = MAX_HOLD, minBars = MIN_BARS,
  entryFires = (closes, i) => entryFiresAt(closes, i, ENTRY_RSI),
  sim = simulateTrade,
} = {}) {
  const closes = bars.map(b => b.close);
  const barDates = bars.map(b => b.date);
  const out = [];
  if (bars.length < minBars) return out;
  let openUntil = -1;
  for (let i = 0; i < bars.length; i += 1) {
    if (i <= openUntil) continue;
    if (!entryFires(closes, i)) continue;
    if (earningsWithinNext5(barDates, i, earningsDates)) continue;
    const t = sim(bars, i, { stopPct, maxHold });
    openUntil = i + (t.censored ? bars.length : t.daysHeld);
    if (t.censored) break;
    const rsi2 = wilderRSI(closes.slice(0, i + 1), 2);
    out.push({ idx: i, date: barDates[i], rsi2, exitDate: barDates[i + t.daysHeld], exitReason: t.exitReason, gross: t.grossReturn });
  }
  return out;
}

// CLI: node scripts/coil-stop-build.mjs [--earnings ...] [--out data/lab/coil-stop-instances.json]
{
  const argv1 = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (fileURLToPath(import.meta.url) === argv1) {
    const args = process.argv.slice(2);
    const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
    const root = process.cwd();
    const earnPath = flag('--earnings', join(root, 'data', 'lab', 'coil-earnings-dates.json'));
    const out = flag('--out', join(root, 'data', 'lab', 'coil-stop-instances.json'));
    let earningsByTicker = {};
    if (existsSync(earnPath)) earningsByTicker = JSON.parse(readFileSync(earnPath, 'utf8'));
    else process.stderr.write(`WARNING: ${earnPath} missing — running WITHOUT the earnings filter (verdict not trustworthy until present)\n`);

    const allStops = [...VARIANTS, BASELINE]; // 0.03..0.06 + 0.07
    const marginal = [];
    const portfolio = Object.fromEntries(allStops.map(s => [String(s), []]));
    const canonicalDates = []; // baseline (0.07) fresh entries, for the split boundary
    for (const t of MEANREV_UNIVERSE) {
      const bars = loadBars(root, t);
      if (bars.length < MIN_BARS) continue;
      const ed = earningsByTicker[t] || [];
      for (const m of enumerateMarginal(bars, { earningsDates: ed })) marginal.push({ ticker: t, ...m });
      for (const s of allStops) {
        for (const c of enumeratePortfolioStop(bars, { stopPct: s, earningsDates: ed })) {
          portfolio[String(s)].push({ ticker: t, ...c });
          if (s === BASELINE) canonicalDates.push({ date: c.date });
        }
      }
    }
    const boundaryDate = boundaryFrom(canonicalDates);
    const taggedMarginal = tagSplit(marginal, boundaryDate);
    const taggedPortfolio = {};
    for (const s of allStops) taggedPortfolio[String(s)] = tagSplit(portfolio[String(s)], boundaryDate);

    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({
      boundaryDate, variants: VARIANTS, baseline: BASELINE,
      marginal: taggedMarginal, portfolio: taggedPortfolio,
      counts: { marginal: marginal.length, portfolioBaseline: portfolio[String(BASELINE)].length },
    }, null, 2));
    process.stdout.write(JSON.stringify({
      out, boundaryDate, marginal: marginal.length,
      portfolio: Object.fromEntries(allStops.map(s => [String(s), portfolio[String(s)].length])),
    }, null, 2) + '\n');
  }
}
