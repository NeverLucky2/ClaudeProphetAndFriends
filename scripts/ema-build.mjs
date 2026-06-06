// scripts/ema-build.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signalContext, emaPullbackFiresAt, isStalePair } from './ema-signal.mjs';
import { atrWilder } from './ema-indicators.mjs';
import { simulateEmaTrade } from './ema-exitsim.mjs';
import { loadEmaBars } from './ema-bars.mjs';
import { EMA_ETF_UNIVERSE, EMA_LARGECAP_UNIVERSE } from './ema-universe.mjs';
import { chronoSplit } from './coil-eventstudy-build.mjs';

export function enumerateEmaTrades(bars, { fast, slow, W, kStop, kTarget, maxHold, warmup }) {
  const ctx = signalContext(bars, fast, slow);
  const atr = atrWilder(bars, 14);
  const trades = [];
  let stalePairs = 0;
  let openUntil = -1;
  for (let i = Math.max(warmup, 1); i < bars.length; i += 1) {
    if (i <= openUntil) continue;
    let direction = 0;
    if (emaPullbackFiresAt(bars, i, { fast, slow, W, direction: 1, ctx })) direction = 1;
    else if (emaPullbackFiresAt(bars, i, { fast, slow, W, direction: -1, ctx })) direction = -1;
    else {
      if (isStalePair(bars, i, { fast, slow, W, direction: 1, ctx }) || isStalePair(bars, i, { fast, slow, W, direction: -1, ctx })) stalePairs += 1;
      continue;
    }
    if (atr[i] == null) continue;
    const t = simulateEmaTrade(bars, i, { direction, atr: atr[i], kStop, kTarget, maxHold });
    const exitDate = t.censored ? null : bars[i + t.daysHeld].date;
    trades.push({ idx: i, date: bars[i].date, exitDate, direction, atr: atr[i], ...t });
    openUntil = i + (t.censored ? bars.length : t.daysHeld);
    if (t.censored) break;
  }
  trades.stalePairs = stalePairs;
  return trades;
}

// CLI: node scripts/ema-build.mjs [--out data/lab/ema-instances.json]
{
  const argv1 = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (fileURLToPath(import.meta.url) === argv1) {
    const args = process.argv.slice(2);
    const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
    const root = process.cwd();
    const cfg = { fast: 25, slow: 75, W: 10, kStop: 1.5, kTarget: 1.5, maxHold: 10, warmup: 250 };
    const cuts = [['etf', EMA_ETF_UNIVERSE], ['largecap', EMA_LARGECAP_UNIVERSE]];
    const rows = [];
    let stale = 0;
    for (const [cut, uni] of cuts) {
      for (const t of uni) {
        const bars = loadEmaBars(root, t);
        if (bars.length < cfg.warmup + 30) continue;
        const trades = enumerateEmaTrades(bars, cfg);
        stale += trades.stalePairs;
        for (const tr of trades) if (!tr.censored) rows.push({ ticker: t, cut, ...tr });
      }
    }
    const { all } = chronoSplit(rows);
    const out = flag('--out', join(root, 'data', 'lab', 'ema-instances.json'));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(all, null, 2));
    process.stdout.write(JSON.stringify({ out, trades: rows.length, stale_pairs_rejected: stale }, null, 2) + '\n');
  }
}
