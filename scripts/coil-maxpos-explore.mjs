// EXPLORATORY (not pre-registered): max-positions sensitivity for Coil.
// Reuses the validated threshold portfolio sim. Reads coil-threshold-instances.json,
// applies the studies' representative 20bps friction, filters to the LIVE entry (rsi2<5),
// and sweeps maxPositions. NOTE: this reuses data already touched by prior studies, so it
// is a directional read for a deploy decision — NOT a holdout-virgin verdict.
import fs from 'node:fs';
import { simulatePortfolio } from './coil-threshold-portfolio.mjs';

const BPS = 20;
const all = JSON.parse(fs.readFileSync('data/lab/coil-threshold-instances.json', 'utf8'))
  .filter(r => r.exitDate && Number.isFinite(r.grossReturn))
  .map(r => ({ ticker: r.ticker, date: r.date, rsi2: r.rsi2, exitDate: r.exitDate,
               net: r.grossReturn - BPS / 10000, split: r.split }));

const live = all.filter(r => r.rsi2 < 5);                 // live entry threshold
const bySplit = (s) => s === 'all' ? live : live.filter(r => r.split === s);

function row(label, trades, { maxPositions, sizePct, deployCap }) {
  const p = simulatePortfolio(trades, { T: 5, maxPositions, sizePct, deployCap });
  // totalNet is cumulative *fractional* return; scale-free comparisons need size held constant.
  return { label, maxPos: maxPositions, size: sizePct, nTrades: p.nTrades,
           totalNet: +(p.totalNet * 100).toFixed(2), maxDD: +(p.maxDrawdown * 100).toFixed(2) };
}

console.log(`Live RSI(2)<5 signal instances: all=${live.length}, train=${bySplit('train').length}, holdout=${bySplit('holdout').length}\n`);

for (const split of ['train', 'holdout', 'all']) {
  const t = bySplit(split);
  console.log(`========== split=${split} (n=${t.length}) ==========`);

  console.log('-- A) Pure concurrency effect: size held at 5%, deployCap unbinding --');
  console.table([4, 5, 6, 7, 8].map(mp => row(`maxPos=${mp}`, t, { maxPositions: mp, sizePct: 0.05, deployCap: 1.0 })));

  console.log('-- B) Real config change: current(4x5%/24%) vs new(7x6%/42%) --');
  console.table([
    row('CURRENT 4x5%', t, { maxPositions: 4, sizePct: 0.05, deployCap: 0.24 }),
    row('NEW 7x6%',     t, { maxPositions: 7, sizePct: 0.06, deployCap: 0.42 }),
  ]);
  console.log('');
}
