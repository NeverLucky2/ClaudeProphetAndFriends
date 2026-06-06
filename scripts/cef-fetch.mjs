// scripts/cef-fetch.mjs
// One-shot CEFConnect backfill → data/lab/cef-cache/{TICKER}.json (weekly, ~5Y). Keyless API.
// DiscountData is signed premium% (positive=premium, negative=discount) → store discount=/100.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CEF_CACHE_SUBDIR } from './cef-bars.mjs';
import { allCefTickers } from './cef-universe.mjs';

const HEADERS = { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchHistory(ticker) {
  const url = `https://www.cefconnect.com/api/v3/pricinghistory/${ticker}/5Y`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`${ticker}: HTTP ${res.status}`);
  const j = await res.json();
  const rows = (j?.Data?.PriceHistory || [])
    .filter((r) => r && r.DataDateJs && typeof r.Data === 'number' && typeof r.NAVData === 'number')
    .map((r) => ({ date: String(r.DataDateJs).replaceAll('/', '-'), price: r.Data, nav: r.NAVData, discount: r.DiscountData / 100 }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  return rows;
}

async function distributionSpike() {
  const tries = [
    'https://www.cefconnect.com/api/v3/distributionhistory/PDI',
    'https://www.cefconnect.com/api/v3/fundbasicinformation/PDI',
    'https://www.cefconnect.com/api/v3/distribution/fund/PDI',
  ];
  for (const url of tries) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      const txt = await res.text();
      const isJson = (res.headers.get('content-type') || '').includes('json') || txt.trim().startsWith('{');
      if (res.ok && isJson) { process.stdout.write(`DIST-SPIKE FOUND: ${url} :: ${txt.slice(0, 200).replace(/\s+/g, ' ')}\n`); return; }
    } catch { /* ignore */ }
  }
  process.stdout.write('DIST-SPIKE: distributions unavailable; price-change basis stands.\n');
}

{
  const root = process.cwd();
  mkdirSync(join(root, CEF_CACHE_SUBDIR), { recursive: true });
  const tickers = allCefTickers();
  let ok = 0, empty = 0, fail = 0;
  const emptied = [];
  for (const t of tickers) {
    try {
      const weekly = await fetchHistory(t);
      if (weekly.length === 0) { empty += 1; emptied.push(t); process.stderr.write(`${t}: EMPTY history (dropped)\n`); }
      else {
        writeFileSync(join(root, CEF_CACHE_SUBDIR, `${t}.json`), JSON.stringify({ written_at: new Date().toISOString(), weekly }));
        ok += 1; process.stdout.write(`${t}: ${weekly.length} weeks\n`);
      }
    } catch (e) { fail += 1; process.stderr.write(`${e.message}\n`); }
    await sleep(250);
  }
  await distributionSpike();
  process.stdout.write(`\ncef-fetch done: ${ok} ok, ${empty} empty${emptied.length ? ' ['+emptied.join(',')+']' : ''}, ${fail} failed (of ${tickers.length})\n`);
}
