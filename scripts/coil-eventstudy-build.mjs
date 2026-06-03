// scripts/coil-eventstudy-build.mjs
// Orchestrate: bars -> Coil instances -> features + market-adjusted forward returns
// at H in {5,10,20} -> chronological 50/50 split + feasibility counts.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forwardReturn } from './stage1-bars.mjs';
import { loadBars, indexByDate } from './coil-eventstudy-bars.mjs';
import { enumerateInstances } from './coil-meanrev-signal.mjs';
import { features, composite } from './coil-catalyst-features.mjs';

export const HORIZONS = [5, 10, 20];

// Coil's MeanRevUniverse (services/meanrev_signal_service.go), mirrored to avoid a Go bridge.
export const MEANREV_UNIVERSE = [
  'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'AVGO', 'JPM', 'V', 'WMT', 'UNH', 'MA', 'JNJ', 'XOM', 'PG',
  'ORCL', 'HD', 'COST', 'ABBV', 'MRK', 'KO', 'BAC', 'CVX', 'PEP', 'ADBE', 'CRM', 'NFLX', 'AMD', 'TMO', 'ACN', 'LLY',
  'MCD', 'ABT', 'CSCO', 'DHR', 'WFC', 'LIN', 'NKE', 'DIS', 'TXN', 'NEE', 'INTU', 'AMGN', 'IBM', 'PM', 'CMCSA', 'RTX',
  'QCOM', 'CAT', 'BMY', 'GS', 'UNP', 'AXP', 'LOW', 'BLK', 'SCHW', 'NOW', 'GE', 'AMAT', 'DE', 'SPGI', 'BKNG', 'ISRG',
  'MS', 'ADI', 'TJX', 'MDT', 'BA', 'PLD', 'MMC', 'VRTX', 'ADP', 'LMT', 'GILD', 'MO', 'SYK', 'CI', 'MDLZ', 'SO',
];

// Long-only (s=+1) ticker forward return minus SPY's, aligned on the SIGNAL date (idx) so
// both legs use the same entry=open[d+1] / exit=close[d+H] convention.
export function marketAdjustedForward(tickerBars, idx, spyBars, H) {
  const tk = forwardReturn(tickerBars, idx, H, 1);
  if (!tk) return null;
  const spyIdx = indexByDate(spyBars);
  const j = spyIdx.get(tickerBars[idx].date);
  if (j == null) return null;
  const sp = forwardReturn(spyBars, j, H, 1);
  if (!sp) return null;
  return tk.R - sp.R;
}

export function chronoSplit(instances) {
  const sorted = [...instances].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const mid = Math.floor(sorted.length / 2);
  const train = sorted.slice(0, mid).map(x => ({ ...x, split: 'train' }));
  const holdout = sorted.slice(mid).map(x => ({ ...x, split: 'holdout' }));
  return { train, holdout, all: [...train, ...holdout] };
}

export function feasibility(instances, H) {
  const fc = { catalyst: 0, clean: 0 };
  for (const x of instances) if (x.madj && x.madj[H] != null) fc[x.bucket] += 1;
  return fc;
}

// Build all instances across the universe (bucket assigned later, at scoring time).
export function buildInstances(projectRoot, universe, benchmark = 'SPY') {
  const spy = loadBars(projectRoot, benchmark);
  const rows = [];
  for (const t of universe) {
    const bars = loadBars(projectRoot, t);
    if (bars.length < 210) continue;
    for (const inst of enumerateInstances(bars)) {
      const f = features(bars, inst.idx);
      const madj = {};
      for (const H of HORIZONS) madj[H] = marketAdjustedForward(bars, inst.idx, spy, H);
      rows.push({ ticker: t, date: inst.date, rsi2: inst.rsi2, ...f, composite: composite(f), madj });
    }
  }
  return rows;
}

// CLI: node scripts/coil-eventstudy-build.mjs [--out data/lab/coil-instances.json]
{
  const argv1 = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (fileURLToPath(import.meta.url) === argv1) {
    const args = process.argv.slice(2);
    const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
    const root = process.cwd();
    const out = flag('--out', join(root, 'data', 'lab', 'coil-instances.json'));
    const rows = buildInstances(root, MEANREV_UNIVERSE);
    const withComposite = rows.filter(r => r.composite != null);
    const { all } = chronoSplit(withComposite);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(all, null, 2));
    const byH = {};
    for (const H of HORIZONS) byH[H] = all.filter(r => r.madj[H] != null).length;
    process.stdout.write(JSON.stringify({
      out, universe: MEANREV_UNIVERSE.length, instances: rows.length,
      with_composite: withComposite.length, scored_per_horizon: byH,
    }, null, 2) + '\n');
  }
}
