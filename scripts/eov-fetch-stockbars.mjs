// scripts/eov-fetch-stockbars.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { allEovStockTickers } from './eov-universe.mjs';

const START = '2024-01-01', END = new Date().toISOString().slice(0, 10);
function creds() {
  const env = readFileSync('.env', 'utf8'); const m = {};
  for (const line of env.split(/\r?\n/)) { const mm = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/); if (mm) m[mm[1]] = mm[2].trim().replace(/^["']|["']$/g, ''); }
  return { id: m.ALPACA_PUBLIC_KEY || m.ALPACA_API_KEY, sec: m.ALPACA_SECRET_KEY || m.ALPACA_API_SECRET };
}
async function fetchBars(sym, id, sec) {
  const headers = { 'APCA-API-KEY-ID': id, 'APCA-API-SECRET-KEY': sec };
  let token = null; const out = [];
  for (let page = 0; page < 2000; page += 1) {
    const q = new URLSearchParams({ timeframe: '1Day', start: START, end: END, adjustment: 'all', limit: '10000', feed: 'iex' });
    if (token) q.set('page_token', token);
    const r = await fetch(`https://data.alpaca.markets/v2/stocks/${encodeURIComponent(sym)}/bars?${q}`, { headers });
    if (!r.ok) throw new Error(`${sym}: HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
    const j = await r.json();
    for (const b of (j.bars || [])) out.push({ Timestamp: b.t, Open: b.o, Close: b.c });
    token = j.next_page_token; if (!token) break;
  }
  return out;
}
{
  const { id, sec } = creds();
  if (!id || !sec) { console.error('missing Alpaca creds in .env'); process.exit(1); }
  mkdirSync(join(process.cwd(), 'data/lab/eov-stockbars'), { recursive: true });
  for (const sym of allEovStockTickers()) {
    try { const bars = await fetchBars(sym, id, sec);
      writeFileSync(join(process.cwd(), 'data/lab/eov-stockbars', `${sym}.json`), JSON.stringify({ written_at: new Date().toISOString(), bars }));
      console.log(`${sym}: ${bars.length} daily bars`);
    } catch (e) { console.log(`${sym}: ${e.message}`); }
    await new Promise(r => setTimeout(r, 300));
  }
}
