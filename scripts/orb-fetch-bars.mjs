// scripts/orb-fetch-bars.mjs
// Backfill Alpaca IEX 5-min bars → data/lab/orb-bar-cache/{TICKER}.json. Creds from root .env.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ORB_CACHE_SUBDIR } from './orb-bars.mjs';
import { allOrbTickers } from './orb-universe.mjs';

const START = '2016-01-01', END = new Date().toISOString().slice(0, 10);
function creds() {
  const env = readFileSync('.env', 'utf8'); const m = {};
  for (const line of env.split(/\r?\n/)) { const mm = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/); if (mm) m[mm[1]] = mm[2].trim().replace(/^["']|["']$/g, ''); }
  return { id: m.ALPACA_PUBLIC_KEY || m.ALPACA_API_KEY, sec: m.ALPACA_SECRET_KEY || m.ALPACA_API_SECRET };
}
async function fetchBars(sym, id, sec) {
  const headers = { 'APCA-API-KEY-ID': id, 'APCA-API-SECRET-KEY': sec };
  let token = null; const out = [];
  for (let page = 0; page < 2000; page += 1) {
    const q = new URLSearchParams({ timeframe: '5Min', start: START, end: END, adjustment: 'all', limit: '10000', feed: 'iex' });
    if (token) q.set('page_token', token);
    const r = await fetch(`https://data.alpaca.markets/v2/stocks/${encodeURIComponent(sym)}/bars?${q}`, { headers });
    if (!r.ok) throw new Error(`${sym}: HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
    const j = await r.json();
    for (const b of (j.bars || [])) out.push({ Timestamp: b.t, Open: b.o, High: b.h, Low: b.l, Close: b.c, Volume: b.v });
    token = j.next_page_token; if (!token) break;
  }
  return out;
}
{
  const { id, sec } = creds();
  if (!id || !sec) { console.error('missing Alpaca creds in .env'); process.exit(1); }
  mkdirSync(join(process.cwd(), ORB_CACHE_SUBDIR), { recursive: true });
  for (const sym of allOrbTickers()) {
    try { const bars = await fetchBars(sym, id, sec);
      writeFileSync(join(process.cwd(), ORB_CACHE_SUBDIR, `${sym}.json`), JSON.stringify({ written_at: new Date().toISOString(), bars }));
      console.log(`${sym}: ${bars.length} 5-min bars`);
    } catch (e) { console.log(`${sym}: ${e.message}`); }
    await new Promise(r => setTimeout(r, 350));
  }
}
