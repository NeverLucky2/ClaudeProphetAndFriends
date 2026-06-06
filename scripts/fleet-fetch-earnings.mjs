// scripts/fleet-fetch-earnings.mjs
// FMP earnings report dates for the fleet equity universe → data/lab/fleet-earnings.json
// {ticker:[{date, timing}]}. Serves BOTH Coil's no-earnings-within-5-days filter (2016+) and
// Drift's PEAD events (2022+). Timing left '' when the vendor omits it → the Drift sim infers it.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { MEANREV_UNIVERSE } from './fleet-universe.mjs';

const FROM = '2014-01-01';
const TODAY = new Date().toISOString().slice(0, 10);
const KEY = process.env.FMP_API_KEY;

function normTiming(row) {
  const t = String(row.time || row.when || row.timing || '').toLowerCase();
  if (t.includes('bmo') || t.includes('before') || t === 'pre') return 'bmo';
  if (t.includes('amc') || t.includes('after') || t === 'post') return 'amc';
  return '';
}

async function fetchOne(ticker) {
  const url = `https://financialmodelingprep.com/stable/earnings?symbol=${ticker}&apikey=${KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${ticker}: HTTP ${res.status}`);
  const data = await res.json();
  const rows = Array.isArray(data) ? data : (data.earnings || []);
  return rows
    .filter(r => r && r.date && String(r.date).slice(0, 10) >= FROM && String(r.date).slice(0, 10) <= TODAY)
    .map(r => ({ date: String(r.date).slice(0, 10), timing: normTiming(r) }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

{
  if (!KEY) { process.stderr.write('FMP_API_KEY not set — source project-root .env first.\n'); process.exit(2); }
  const root = process.cwd();
  mkdirSync(join(root, 'data', 'lab'), { recursive: true });
  const out = {};
  let ok = 0, fail = 0, total = 0;
  for (const t of MEANREV_UNIVERSE) {
    try {
      const dates = await fetchOne(t);
      out[t] = dates; ok += 1; total += dates.length;
      process.stdout.write(`${t}: ${dates.length} earnings dates\n`);
    } catch (e) { fail += 1; out[t] = []; process.stderr.write(`${e.message}\n`); }
  }
  writeFileSync(join(root, 'data', 'lab', 'fleet-earnings.json'), JSON.stringify(out));
  process.stdout.write(`\nfleet-fetch-earnings done: ${ok}/${MEANREV_UNIVERSE.length} tickers, ${total} dates total, ${fail} failed\n`);
}
