// scripts/eov-fetch-bars.mjs
// Daily option bars per call contract -> per-name daily CallVol. Creds from .env.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { EOV_UNIVERSE } from './eov-universe.mjs';
import { aggregateCallVol } from './eov-aggregate.mjs';

const DATA = 'https://data.alpaca.markets';
const START = '2024-01-01', END = new Date().toISOString().slice(0, 10);
function creds() {
  const env = readFileSync('.env', 'utf8'); const m = {};
  for (const line of env.split(/\r?\n/)) { const mm = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/); if (mm) m[mm[1]] = mm[2].trim().replace(/^["']|["']$/g, ''); }
  return { id: m.ALPACA_PUBLIC_KEY || m.ALPACA_API_KEY, sec: m.ALPACA_SECRET_KEY || m.ALPACA_API_SECRET };
}
async function barsForBatch(symbols, id, sec) {
  const headers = { 'APCA-API-KEY-ID': id, 'APCA-API-SECRET-KEY': sec };
  const byContract = {}; let token = null;
  for (let page = 0; page < 20000; page += 1) {
    const q = new URLSearchParams({ symbols: symbols.join(','), timeframe: '1Day', start: START, end: END, limit: '10000' });
    if (token) q.set('page_token', token);
    const r = await fetch(`${DATA}/v1beta1/options/bars?${q}`, { headers });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
    const j = await r.json();
    for (const [sym, bars] of Object.entries(j.bars || {})) {
      byContract[sym] = byContract[sym] || [];
      for (const b of bars) byContract[sym].push({ date: b.t.slice(0, 10), v: b.v });
    }
    token = j.next_page_token; if (!token) break;
  }
  return byContract;
}
{
  const { id, sec } = creds();
  if (!id || !sec) { console.error('missing Alpaca creds in .env'); process.exit(1); }
  mkdirSync(join(process.cwd(), 'data/lab/eov-volume-cache'), { recursive: true });
  for (const sym of EOV_UNIVERSE) {
    try {
      const { symbols } = JSON.parse(readFileSync(join(process.cwd(), 'data/lab/eov-contracts', `${sym}.json`), 'utf8'));
      const byContract = {};
      for (let i = 0; i < symbols.length; i += 200) {
        Object.assign(byContract, await barsForBatch(symbols.slice(i, i + 200), id, sec));
        await new Promise(r => setTimeout(r, 350));
      }
      const callVol = aggregateCallVol(byContract);
      writeFileSync(join(process.cwd(), 'data/lab/eov-volume-cache', `${sym}.json`), JSON.stringify({ written_at: new Date().toISOString(), callVol }));
      console.log(`${sym}: ${Object.keys(callVol).length} days of CallVol from ${symbols.length} contracts`);
    } catch (e) { console.log(`${sym}: ${e.message}`); }
  }
}
