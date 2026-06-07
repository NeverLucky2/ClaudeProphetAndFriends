// scripts/overlay-fetch.mjs
// One-shot FMP backfill → data/lab/overlay-cache/. Bars: noon-UTC timestamps (etDate round-trip,
// see fleet-bars). Treasury curve: {curve:[{date,m3,y2,y5,y7,y10,y30}]}. Records earliest dates.
// Run: node scripts/overlay-fetch.mjs   (source project-root .env first for FMP_API_KEY)
import { writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fmpEodToBars } from './ema-bars.mjs';
import { OVERLAY_CACHE_SUBDIR, CANDIDATES, parseHoldings } from './overlay-universe.mjs';

const FROM = '2014-01-01';
const KEY = process.env.FMP_API_KEY;

function latestHoldingsPath(root) {
  const dir = join(root, 'data', 'portfolio');
  const files = readdirSync(dir).filter((f) => /^Holdings_.*\.csv$/.test(f)).sort();
  if (!files.length) throw new Error('no Holdings_*.csv in data/portfolio');
  return join(dir, files[files.length - 1]);
}

async function fetchBars(ticker, to) {
  const url = `https://financialmodelingprep.com/stable/historical-price-eod/full?symbol=${ticker}&from=${FROM}&to=${to}&apikey=${KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${ticker}: HTTP ${res.status}`);
  return fmpEodToBars(await res.json());
}

async function fetchCurve(to) {
  const url = `https://financialmodelingprep.com/stable/treasury-rates?from=${FROM}&to=${to}&apikey=${KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`treasury: HTTP ${res.status}`);
  const raw = await res.json();
  const curve = raw.map((r) => ({
    date: r.date, m3: r.month3 ?? null, y2: r.year2 ?? null, y5: r.year5 ?? null,
    y7: r.year7 ?? null, y10: r.year10 ?? null, y30: r.year30 ?? null,
  })).sort((a, b) => (a.date < b.date ? -1 : 1));
  return curve;
}

{
  if (!KEY) { process.stderr.write('FMP_API_KEY not set — source project-root .env first.\n'); process.exit(2); }
  const root = process.cwd();
  const to = new Date().toISOString().slice(0, 10);
  mkdirSync(join(root, OVERLAY_CACHE_SUBDIR), { recursive: true });

  const holdings = parseHoldings(readFileSync(latestHoldingsPath(root), 'utf8'));
  const etfs = CANDIDATES.filter((c) => c.ticker).map((c) => c.ticker);
  const tickers = [...new Set([...holdings.map((h) => h.symbol), ...etfs, 'QQQ'])];

  const earliest = {};
  let ok = 0, fail = 0;
  for (const t of tickers) {
    try {
      const bars = await fetchBars(t, to);
      if (bars.length) earliest[t] = bars[0].date;
      writeFileSync(join(root, OVERLAY_CACHE_SUBDIR, `${t}.json`),
        JSON.stringify({ written_at: new Date().toISOString(),
          bars: bars.map((b) => ({ Timestamp: `${b.date}T12:00:00Z`, Open: b.open, High: b.high, Low: b.low, Close: b.close, Volume: b.volume })) }));
      ok += 1; process.stdout.write(`${t}: ${bars.length} bars\n`);
    } catch (e) { fail += 1; process.stderr.write(`${e.message}\n`); }
  }
  try {
    const curve = await fetchCurve(to);
    writeFileSync(join(root, OVERLAY_CACHE_SUBDIR, 'treasury-rates.json'), JSON.stringify({ written_at: new Date().toISOString(), curve }));
    earliest.__curve = curve.length ? curve[0].date : null;
    process.stdout.write(`treasury: ${curve.length} rows\n`);
  } catch (e) { fail += 1; process.stderr.write(`${e.message}\n`); }

  writeFileSync(join(root, OVERLAY_CACHE_SUBDIR, '_earliest.json'), JSON.stringify(earliest, null, 2));
  process.stdout.write(`\noverlay-fetch done: ${ok}/${tickers.length} ok, ${fail} failed\n`);
}
