// scripts/eov-fetch-contracts.mjs
// Enumerate CALL contracts (active + inactive/expired) per underlying. Creds from .env.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { EOV_UNIVERSE } from './eov-universe.mjs';

const TRADE = 'https://paper-api.alpaca.markets';
const WINDOW_START = '2024-01-01';
const TODAY = new Date().toISOString().slice(0, 10);
function creds() {
  const env = readFileSync('.env', 'utf8'); const m = {};
  for (const line of env.split(/\r?\n/)) { const mm = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/); if (mm) m[mm[1]] = mm[2].trim().replace(/^["']|["']$/g, ''); }
  return { id: m.ALPACA_PUBLIC_KEY || m.ALPACA_API_KEY, sec: m.ALPACA_SECRET_KEY || m.ALPACA_API_SECRET };
}
// Alpaca's contracts endpoint returns 0 `active` rows unless an expiration_date bound is given,
// so `active` is queried with expiration_date_gte=TODAY (unexpired contracts that may have traded
// in-window). `inactive` is bounded to expiration_date_gte=WINDOW_START to skip contracts that
// expired before the window (they have no in-window bars).
async function listContracts(sym, status, id, sec, expGte) {
  const headers = { 'APCA-API-KEY-ID': id, 'APCA-API-SECRET-KEY': sec };
  const out = []; let token = null;
  for (let page = 0; page < 5000; page += 1) {
    const q = new URLSearchParams({ underlying_symbols: sym, type: 'call', status, limit: '10000', expiration_date_gte: expGte });
    if (token) q.set('page_token', token);
    const r = await fetch(`${TRADE}/v2/options/contracts?${q}`, { headers });
    if (!r.ok) throw new Error(`${sym}/${status}: HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
    const j = await r.json();
    for (const c of (j.option_contracts || [])) out.push(c.symbol);
    token = j.next_page_token; if (!token) break;
  }
  return out;
}
{
  const { id, sec } = creds();
  if (!id || !sec) { console.error('missing Alpaca creds in .env'); process.exit(1); }
  mkdirSync(join(process.cwd(), 'data/lab/eov-contracts'), { recursive: true });
  for (const sym of EOV_UNIVERSE) {
    try {
      const active = await listContracts(sym, 'active', id, sec, TODAY);
      const inactive = await listContracts(sym, 'inactive', id, sec, WINDOW_START);
      const symbols = [...new Set([...active, ...inactive])];
      writeFileSync(join(process.cwd(), 'data/lab/eov-contracts', `${sym}.json`), JSON.stringify({ written_at: new Date().toISOString(), symbols }));
      console.log(`${sym}: ${symbols.length} call contracts (active ${active.length} / inactive ${inactive.length})`);
    } catch (e) { console.log(`${sym}: ${e.message}`); }
    await new Promise(r => setTimeout(r, 350));
  }
}
