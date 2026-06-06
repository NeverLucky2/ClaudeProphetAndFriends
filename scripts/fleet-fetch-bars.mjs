// scripts/fleet-fetch-bars.mjs
// One-shot FMP EOD backfill → data/lab/fleet-bar-cache/{TICKER}.json. Noon-UTC timestamps so
// etDate round-trips the calendar date (T00:00:00Z would backshift one ET day — see fleet-bars).
// Requires FMP_API_KEY in env (source the project-root .env first).
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fmpEodToBars } from './ema-bars.mjs';
import { FLEET_CACHE_SUBDIR } from './fleet-bars.mjs';
import { allFleetTickers } from './fleet-universe.mjs';

const FROM = '2014-01-01';
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
  mkdirSync(join(root, FLEET_CACHE_SUBDIR), { recursive: true });
  const tickers = allFleetTickers();
  let ok = 0, fail = 0;
  for (const t of tickers) {
    try {
      const bars = await fetchOne(t, to);
      writeFileSync(join(root, FLEET_CACHE_SUBDIR, `${t}.json`),
        JSON.stringify({ written_at: new Date().toISOString(),
          bars: bars.map(b => ({ Timestamp: `${b.date}T12:00:00Z`, Open: b.open, High: b.high, Low: b.low, Close: b.close, Volume: b.volume })) }));
      ok += 1;
      process.stdout.write(`${t}: ${bars.length} bars\n`);
    } catch (e) { fail += 1; process.stderr.write(`${e.message}\n`); }
  }
  process.stdout.write(`\nfleet-fetch-bars done: ${ok}/${tickers.length} ok, ${fail} failed\n`);
}
