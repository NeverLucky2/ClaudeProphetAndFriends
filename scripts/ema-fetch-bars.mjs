// scripts/ema-fetch-bars.mjs
// One-shot backfill: FMP historical-price-eod/full → data/lab/ema-bar-cache/{TICKER}.json.
// Requires FMP_API_KEY in the environment (source project-root .env first; see memory).
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fmpEodToBars, EMA_CACHE_SUBDIR } from './ema-bars.mjs';
import { allStudyTickers } from './ema-universe.mjs';

const FROM = '2006-06-01';
const KEY = process.env.FMP_API_KEY;

async function fetchOne(ticker, to) {
  const url = `https://financialmodelingprep.com/stable/historical-price-eod/full?symbol=${ticker}&from=${FROM}&to=${to}&apikey=${KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${ticker}: HTTP ${res.status}`);
  return fmpEodToBars(await res.json());
}

{
  if (!KEY) { process.stderr.write('FMP_API_KEY not set — source project-root .env first.\n'); process.exit(2); }
  const root = process.cwd();
  const to = new Date().toISOString().slice(0, 10);
  mkdirSync(join(root, EMA_CACHE_SUBDIR), { recursive: true });
  for (const t of allStudyTickers()) {
    try {
      const bars = await fetchOne(t, to);
      writeFileSync(join(root, EMA_CACHE_SUBDIR, `${t}.json`), JSON.stringify({ written_at: new Date().toISOString(), bars: bars.map(b => ({ Timestamp: `${b.date}T00:00:00Z`, Open: b.open, High: b.high, Low: b.low, Close: b.close, Volume: b.volume })) }));
      process.stdout.write(`${t}: ${bars.length} bars\n`);
    } catch (e) { process.stderr.write(`${t}: ${e.message}\n`); }
  }
}
