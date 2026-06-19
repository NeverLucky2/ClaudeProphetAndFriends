// scripts/eov-fetch-corpactions.mjs
// In-window forward stock splits per name -> data/lab/eov-splits.json
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { EOV_UNIVERSE } from './eov-universe.mjs';

const START = '2024-01-01', END = new Date().toISOString().slice(0, 10);
function creds() {
  const env = readFileSync('.env', 'utf8'); const m = {};
  for (const line of env.split(/\r?\n/)) { const mm = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/); if (mm) m[mm[1]] = mm[2].trim().replace(/^["']|["']$/g, ''); }
  return { id: m.ALPACA_PUBLIC_KEY || m.ALPACA_API_KEY, sec: m.ALPACA_SECRET_KEY || m.ALPACA_API_SECRET };
}
async function splitsFor(sym, id, sec) {
  const headers = { 'APCA-API-KEY-ID': id, 'APCA-API-SECRET-KEY': sec };
  const out = []; let token = null;
  for (let page = 0; page < 100; page += 1) {
    const q = new URLSearchParams({ types: 'forward_split,reverse_split', symbols: sym, start: START, end: END, limit: '1000' });
    if (token) q.set('page_token', token);
    const r = await fetch(`https://paper-api.alpaca.markets/v2/corporate_actions/announcements?${q}`, { headers });
    if (!r.ok) throw new Error(`${sym}: HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
    const j = await r.json();
    const rows = Array.isArray(j) ? j : (j.corporate_actions || j.announcements || []);
    for (const c of rows) { const d = c.ex_date || c.effective_date || c.process_date; if (d) out.push(d); }
    token = (j && j.next_page_token) || null; if (!token) break;
  }
  return [...new Set(out)].sort();
}
{
  const { id, sec } = creds();
  if (!id || !sec) { console.error('missing Alpaca creds in .env'); process.exit(1); }
  const splits = {};
  for (const sym of EOV_UNIVERSE) {
    try { splits[sym] = await splitsFor(sym, id, sec); console.log(`${sym}: splits ${JSON.stringify(splits[sym])}`); }
    catch (e) { splits[sym] = []; console.log(`${sym}: ${e.message}`); }
    await new Promise(r => setTimeout(r, 300));
  }
  mkdirSync(join(process.cwd(), 'data/lab'), { recursive: true });
  writeFileSync(join(process.cwd(), 'data/lab/eov-splits.json'), JSON.stringify(splits, null, 2));
}
