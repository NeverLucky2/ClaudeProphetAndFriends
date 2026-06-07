// scripts/alpaca-spy-daily.mjs
// SPY daily closes from Alpaca Data REST (split-adjusted price returns). Full-window re-fetch
// each run (corporate-action restatement-safe); on-disk cache is an offline fallback that flags
// gaps. Spec §4.1 (D-B6: Alpaca not FMP). Pure assembly + injected fetch for testability.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const CACHE = join('data', 'cache', 'spy_daily.json');

export function buildBarsUrl(start, end, pageToken) {
  const p = new URLSearchParams({ timeframe: '1Day', start, end, adjustment: 'split', limit: '10000' });
  if (pageToken) p.set('page_token', pageToken);
  return `https://data.alpaca.markets/v2/stocks/SPY/bars?${p.toString()}`;
}

// Alpaca daily bar timestamps are the session date at 00:00Z OR close at 21:00Z depending on feed;
// bucket to the ET calendar date (a daily bar maps 1:1 to its trading day).
export function etDateOf(ts) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
}

export function assembleBars(pages) {
  const close = {}; const seen = [];
  for (const pg of pages) for (const b of (pg.bars || [])) {
    const d = etDateOf(b.t);
    if (!(d in close)) seen.push(d);
    close[d] = b.c;
  }
  const dates = seen.slice().sort();
  return { dates, close };
}

// fetchImpl(url, headers) → parsed JSON page ({ bars, next_page_token }). Injected for tests.
export async function fetchSpyDaily(start, end, { fetchImpl = defaultFetch } = {}) {
  const headers = { 'APCA-API-KEY-ID': process.env.ALPACA_PUBLIC_KEY || '', 'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY || '' };
  try {
    const pages = []; let token;
    do {
      const page = await fetchImpl(buildBarsUrl(start, end, token), headers);
      pages.push(page); token = page.next_page_token;
    } while (token);
    const { dates, close } = assembleBars(pages);
    mkdirSync(join('data', 'cache'), { recursive: true });
    writeFileSync(CACHE, JSON.stringify({ written_at: new Date().toISOString(), dates, close }));
    return { dates, close, gaps: new Set() };
  } catch (e) {
    process.stderr.write(`alpaca-spy-daily: fetch failed (${e.message}) — using cache, flagging gaps\n`);
    let obj; try { obj = JSON.parse(readFileSync(CACHE, 'utf8')); } catch { return { dates: [], close: {}, gaps: new Set() }; }
    return { dates: obj.dates, close: obj.close, gaps: new Set(obj.dates) };
  }
}

async function defaultFetch(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
