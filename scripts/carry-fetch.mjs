// scripts/carry-fetch.mjs
// One-shot FMP backfill → data/lab/carry-cache/. Treasury curve (stable/treasury-rates) +
// IEF/TLT/TIP/QQQ/SPY EOD bars (stable/historical-price-eod/full), 2002→today. Prints the
// Task-0 data-wall probe. Requires FMP_API_KEY (source project-root .env first).
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fmpEodToBars } from './ema-bars.mjs';
import { CARRY_CACHE_SUBDIR, CARRY_TICKERS, FETCH_FROM } from './carry-universe.mjs';

const KEY = process.env.FMP_API_KEY;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Normalize FMP treasury fields → our keys; null when a maturity is absent.
function normCurveRow(r) {
  const num = (v) => (v == null || v === '' ? null : Number(v));
  return { date: r.date, m3: num(r.month3), y2: num(r.year2), y5: num(r.year5),
    y7: num(r.year7), y10: num(r.year10), y30: num(r.year30) };
}

async function fetchCurve(to) {
  const url = `https://financialmodelingprep.com/stable/treasury-rates?from=${FETCH_FROM}&to=${to}&apikey=${KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`treasury-rates: HTTP ${res.status}`);
  const rows = (await res.json()).map(normCurveRow).filter((r) => r.date)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  return rows;
}

async function fetchBars(ticker, to) {
  const url = `https://financialmodelingprep.com/stable/historical-price-eod/full?symbol=${ticker}&from=${FETCH_FROM}&to=${to}&apikey=${KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${ticker}: HTTP ${res.status}`);
  return fmpEodToBars(await res.json());
}

{
  if (!KEY) { process.stderr.write('FMP_API_KEY not set — source project-root .env first.\n'); process.exit(2); }
  const root = process.cwd();
  const to = new Date().toISOString().slice(0, 10);
  mkdirSync(join(root, CARRY_CACHE_SUBDIR), { recursive: true });

  const curve = await fetchCurve(to);
  writeFileSync(join(root, CARRY_CACHE_SUBDIR, 'treasury-rates.json'),
    JSON.stringify({ written_at: new Date().toISOString(), curve }));

  // ── Task-0 data-wall probe ──
  const fields = curve.length ? Object.keys(curve[0]).filter((k) => k !== 'date' && curve[0][k] != null) : [];
  const y7present = curve.some((r) => r.y7 != null);
  process.stdout.write(`\n[TASK-0 PROBE] curve rows: ${curve.length}; earliest: ${curve[0]?.date}; latest: ${curve.at(-1)?.date}\n`);
  process.stdout.write(`[TASK-0 PROBE] non-null fields in first row: ${fields.join(', ')}\n`);
  process.stdout.write(`[TASK-0 PROBE] y7 (year7) present anywhere: ${y7present} (if false → interpolate y5/y10 in carry-signal)\n`);

  let ok = 0, fail = 0;
  for (const t of CARRY_TICKERS) {
    try {
      const bars = await fetchBars(t, to);
      writeFileSync(join(root, CARRY_CACHE_SUBDIR, `${t}.json`),
        JSON.stringify({ written_at: new Date().toISOString(),
          bars: bars.map((b) => ({ Timestamp: `${b.date}T12:00:00Z`, Open: b.open, High: b.high, Low: b.low, Close: b.close, Volume: b.volume })) }));
      ok += 1;
      process.stdout.write(`${t}: ${bars.length} bars (${bars[0]?.date} → ${bars.at(-1)?.date})\n`);
    } catch (e) { fail += 1; process.stderr.write(`${e.message}\n`); }
    await sleep(250);
  }
  process.stdout.write(`\ncarry-fetch done: curve ${curve.length} rows, ${ok}/${CARRY_TICKERS.length} ETFs ok, ${fail} failed\n`);
}
