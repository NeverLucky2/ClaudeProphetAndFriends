// Backfill split/dividend-adjusted daily bars for universe names missing from
// data/bar-cache, in the existing cache format. adjustment=all is mandatory — an
// unadjusted split would masquerade as a huge forward return and corrupt the test.
// Usage: node scripts/stage1_backfill_bars.mjs SYM1 SYM2 ...   (defaults to the 15 gaps)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT = ['DIA', 'GOOG', 'TSM', 'C', 'PFE', 'COP', 'OXY', 'MSTR', 'COIN', 'MARA', 'PLTR', 'INTC', 'MU', 'QQQ', 'IWM'];
const START = '2021-11-01';   // ~warmup before 2022-01 (SMA20 + 5d ret need ~25 sessions)
const END = '2026-05-31';

function creds() {
  const env = readFileSync('.env', 'utf8');
  const m = {};
  for (const line of env.split(/\r?\n/)) {
    const mm = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (mm) m[mm[1]] = mm[2].trim().replace(/^["']|["']$/g, '');
  }
  return { id: m.ALPACA_PUBLIC_KEY || m.ALPACA_API_KEY, sec: m.ALPACA_SECRET_KEY || m.ALPACA_API_SECRET };
}

async function fetchBars(symbol, id, sec) {
  const headers = { 'APCA-API-KEY-ID': id, 'APCA-API-SECRET-KEY': sec };
  let token = null;
  const out = [];
  for (let page = 0; page < 50; page += 1) {
    const q = new URLSearchParams({ timeframe: '1Day', start: START, end: END, adjustment: 'all', limit: '10000', feed: 'iex' });
    if (token) q.set('page_token', token);
    const url = `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/bars?${q}`;
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error(`${symbol}: HTTP ${r.status} ${await r.text().then(t => t.slice(0, 120))}`);
    const j = await r.json();
    for (const b of (j.bars || [])) {
      out.push({ Symbol: symbol, Timestamp: b.t, Open: b.o, High: b.h, Low: b.l, Close: b.c, Volume: b.v, VWAP: b.vw });
    }
    token = j.next_page_token;
    if (!token) break;
  }
  return out;
}

const { id, sec } = creds();
if (!id || !sec) { console.error('missing Alpaca creds in .env'); process.exit(1); }
const symbols = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT;
mkdirSync('data/bar-cache', { recursive: true });
for (const sym of symbols) {
  try {
    const bars = await fetchBars(sym, id, sec);
    if (!bars.length) { console.log(`${sym}: 0 bars (skipped)`); continue; }
    const obj = {
      symbol: sym, timeframe: '1Day', start_date: START, end_date: END,
      written_at: new Date().toISOString(), bars,
    };
    const fname = `${sym}_1Day_${START}_${END}.json`;
    writeFileSync(join('data/bar-cache', fname), JSON.stringify(obj));
    console.log(`${sym}: ${bars.length} bars -> ${fname} (${bars[0].Timestamp.slice(0,10)}..${bars[bars.length-1].Timestamp.slice(0,10)})`);
  } catch (e) {
    console.log(`${sym}: ERROR ${e.message}`);
  }
  await new Promise(r => setTimeout(r, 300));
}
