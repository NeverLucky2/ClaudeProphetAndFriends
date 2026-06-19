import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reducedEOV, splitExcludedDates, crossSectionalRank } from './eov-signal.mjs';
import { forwardReturnOpenToOpen, dailySpread } from './eov-portfolio.mjs';
import { dailyReturns } from './ema-beta.mjs';

export function buildPanel({ callVolByName, stockBarsByName, splitsByName, universe,
  window = 21, horizons = [1, 3, 5], kLeg = 5, minNames = 12, splitFrac = 0.7 }) {
  // common trading-date axis = union of stock bar dates across the universe, sorted
  const dateSet = new Set();
  for (const nm of universe) for (const b of (stockBarsByName[nm] || [])) dateSet.add(b.date);
  const dates = [...dateSet].sort();

  // per-name aligned callVol arrays + open maps + exclusion sets
  const cvArr = {}, openByName = {}, exclByName = {};
  for (const nm of universe) {
    cvArr[nm] = dates.map(d => (callVolByName[nm]?.[d] ?? null));
    openByName[nm] = new Map((stockBarsByName[nm] || []).map(b => [b.date, b.open]));
    let ex = new Set();
    for (const sd of (splitsByName[nm] || [])) ex = new Set([...ex, ...splitExcludedDates(dates, sd, window)]);
    exclByName[nm] = ex;
  }
  const qOpen = new Map((stockBarsByName.QQQ || []).map(b => [b.date, b.open]));
  const sOpen = new Map((stockBarsByName.SPY || []).map(b => [b.date, b.open]));
  const benchRet = (openMap, t, h) => forwardReturnOpenToOpen(openMap, dates, t, h);

  // reducedEOV with null when in a split window or warm-up incomplete
  const eovArr = {};
  for (const nm of universe) {
    eovArr[nm] = dates.map((d, i) => (exclByName[nm].has(d) ? null : (() => {
      const vals = cvArr[nm];
      if (vals[i] == null) return null;
      // trailing window must be fully populated (no nulls) to be valid
      if (i < window) return null;
      for (let j = i - window; j < i; j += 1) if (vals[j] == null) return null;
      return reducedEOV(vals, i, window);
    })()));
  }

  const spread = Object.fromEntries(horizons.map(h => [h, []]));
  const legs = Object.fromEntries(horizons.map(h => [h, []]));
  const validDatesSet = new Set();

  for (let t = 0; t < dates.length; t += 1) {
    const valueByTicker = {};
    for (const nm of universe) { const e = eovArr[nm][t]; if (e != null) valueByTicker[nm] = e; }
    const rank = crossSectionalRank(valueByTicker, minNames);
    if (!rank) continue;
    for (const h of horizons) {
      const retByTicker = {};
      for (const nm of Object.keys(rank)) { const r = forwardReturnOpenToOpen(openByName[nm], dates, t, h); if (r != null) retByTicker[nm] = r; }
      const ds = dailySpread(rank, retByTicker, kLeg);
      if (!ds) continue;
      const qqqRet = benchRet(qOpen, t, h), spyRet = benchRet(sOpen, t, h);
      const date = dates[t];
      spread[h].push({ date, grossSpread: ds.spread, qqqRet, spyRet, split: 'train' });
      for (const tk of ds.top) legs[h].push({ date, ticker: tk, leg: 'top', grossRet: retByTicker[tk], qqqRet, spyRet, split: 'train' });
      for (const tk of ds.bottom) legs[h].push({ date, ticker: tk, leg: 'bottom', grossRet: retByTicker[tk], qqqRet, spyRet, split: 'train' });
      if (h === 3) validDatesSet.add(date); // confirmatory horizon defines valid formation dates
    }
  }

  const validDates = [...validDatesSet].sort();
  const cut = Math.floor(validDates.length * splitFrac);
  const splitBoundary = validDates[cut - 1] ?? null;
  const holdoutDates = new Set(validDates.slice(cut));
  const label = (d) => (holdoutDates.has(d) ? 'holdout' : 'train');
  for (const h of horizons) {
    for (const row of spread[h]) row.split = label(row.date);
    for (const row of legs[h]) row.split = label(row.date);
  }

  const nameDailyRet = {};
  for (const nm of universe) nameDailyRet[nm] = dailyReturns(stockBarsByName[nm] || []);
  nameDailyRet.QQQ = dailyReturns(stockBarsByName.QQQ || []);

  return {
    meta: { validDates, splitBoundary, trainN: validDates.length - holdoutDates.size, holdoutN: holdoutDates.size, horizons, kLeg, window },
    spread, legs, nameDailyRet,
  };
}

// CLI: load caches under data/lab/, write data/lab/eov-instances.json + integrity table
{
  const argv1 = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (fileURLToPath(import.meta.url) === argv1) {
    const { EOV_UNIVERSE } = await import('./eov-universe.mjs');
    const { contractCountByMonth } = await import('./eov-aggregate.mjs');
    const root = process.cwd();
    const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
    const callVolByName = {}, stockBarsByName = {}, splitsByName = {};
    for (const nm of [...EOV_UNIVERSE, 'QQQ', 'SPY']) {
      const sb = readJson(join(root, 'data/lab/eov-stockbars', `${nm}.json`));
      stockBarsByName[nm] = sb.bars.map(b => ({ date: b.Timestamp.slice(0, 10), open: b.Open, close: b.Close }));
    }
    for (const nm of EOV_UNIVERSE) {
      callVolByName[nm] = readJson(join(root, 'data/lab/eov-volume-cache', `${nm}.json`)).callVol;
    }
    const splits = readJson(join(root, 'data/lab/eov-splits.json'));
    for (const nm of EOV_UNIVERSE) splitsByName[nm] = splits[nm] || [];
    const bundle = buildPanel({ callVolByName, stockBarsByName, splitsByName, universe: EOV_UNIVERSE });
    mkdirSync(join(root, 'data/lab'), { recursive: true });
    writeFileSync(join(root, 'data/lab/eov-instances.json'), JSON.stringify(bundle));
    process.stdout.write(`panel: ${bundle.meta.validDates.length} valid dates (train ${bundle.meta.trainN} / holdout ${bundle.meta.holdoutN}), boundary ${bundle.meta.splitBoundary}\n`);
  }
}
