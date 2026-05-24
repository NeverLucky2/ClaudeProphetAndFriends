// scripts/rank-floor-movers.mjs
// Ranks the Prophet tradable floor's biggest daily movers for a given session,
// plus a passive off-floor "forbidden winners" tally. Arithmetic only — bucket
// classification and foregone-P&L are the skill's job.
// Spec: docs/superpowers/specs/2026-05-24-hindsight-review-design.md

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve as resolvePath } from 'node:path';

const FMP_HOST = 'https://financialmodelingprep.com';

function addDays(isoDate, delta) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export function parseFloorFile(text) {
  const seen = new Set();
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const sym = line.toUpperCase();
    if (seen.has(sym)) continue;
    seen.add(sym);
    out.push(sym);
  }
  return out;
}

export function computeMovePct(rowsAsc, targetDate) {
  // rowsAsc: ascending [{ date:'YYYY-MM-DD', close:number }]. Returns percent
  // move of the last row with date <= targetDate vs the row immediately before
  // it, or null if fewer than 2 usable rows exist.
  let i = -1;
  for (let k = 0; k < rowsAsc.length; k += 1) {
    if (rowsAsc[k].date <= targetDate) i = k; else break;
  }
  if (i < 1) return null;
  const cur = rowsAsc[i].close;
  const prev = rowsAsc[i - 1].close;
  if (!Number.isFinite(cur) || !Number.isFinite(prev) || prev === 0) return null;
  return (cur / prev - 1) * 100;
}

export async function fetchDailyMove({ symbol, date, apiKey, fetchImpl = globalThis.fetch }) {
  // Soft-fail: any error, non-ok status, or malformed/empty payload returns null.
  // The caller records nulls in `missing[]`; a name is never treated as flat.
  const from = addDays(date, -10); // ~7 calendar days back guarantees >=1 prior session
  const url = `${FMP_HOST}/api/v3/historical-price-full/${symbol}?from=${from}&to=${date}&apikey=${apiKey}`;
  try {
    const resp = await fetchImpl(url);
    if (!resp || !resp.ok) return null;
    const data = await resp.json();
    if (!Array.isArray(data?.historical) || data.historical.length === 0) return null;
    const rowsAsc = data.historical
      .map((r) => ({ date: r.date, close: Number(r.close) }))
      .sort((a, b) => a.date.localeCompare(b.date));
    const move = computeMovePct(rowsAsc, date);
    if (move === null) return null;
    return { symbol, move_pct: +move.toFixed(4) };
  } catch {
    return null;
  }
}

export async function fetchOffFloorMovers({
  floorSet, apiKey, fetchImpl = globalThis.fetch, minPrice = 20, topN = 10,
}) {
  // Passive curation log (spec §6.1). Never enters the bucket analysis and never
  // throws — any failure yields an empty tally.
  const endpoints = ['stock_market/gainers', 'stock_market/losers'];
  const rows = [];
  for (const ep of endpoints) {
    try {
      const resp = await fetchImpl(`${FMP_HOST}/api/v3/${ep}?apikey=${apiKey}`);
      if (!resp || !resp.ok) continue;
      const data = await resp.json();
      if (!Array.isArray(data)) continue;
      for (const it of data) {
        const sym = String(it.symbol ?? '').toUpperCase();
        const move = Number(it.changesPercentage);
        const price = Number(it.price);
        if (!sym || !Number.isFinite(move)) continue;
        if (floorSet.has(sym)) continue;
        // Liquidity screen: an item whose price we can't determine fails the
        // screen too — a curation log should not admit names it can't size.
        if (!Number.isFinite(price) || price < minPrice) continue;
        rows.push({ symbol: sym, move_pct: +move.toFixed(4) });
      }
    } catch { /* soft-fail this endpoint */ }
  }
  rows.sort((a, b) => Math.abs(b.move_pct) - Math.abs(a.move_pct));
  return rows.slice(0, topN);
}

export async function rankFloorMovers({
  floor, date, apiKey, fetchImpl = globalThis.fetch,
  fetchDailyMoveImpl = fetchDailyMove, fetchOffFloorImpl = fetchOffFloorMovers,
}) {
  const floorSet = new Set(floor);
  const moves = [];
  const missing = [];
  for (const symbol of floor) {
    // Sequential to stay gentle on the shared FMP budget (on-demand skill, not a loop).
    const r = await fetchDailyMoveImpl({ symbol, date, apiKey, fetchImpl });
    if (r === null) missing.push(symbol);
    else moves.push(r);
  }
  moves.sort((a, b) => Math.abs(b.move_pct) - Math.abs(a.move_pct));
  const off = await fetchOffFloorImpl({ floorSet, apiKey, fetchImpl });
  return {
    date,
    floor_size: floor.length,
    movers_ranked: moves,
    missing,
    off_floor_forbidden_winners: off,
  };
}

// CLI entry — only runs when invoked directly.
{
  const __filename = fileURLToPath(import.meta.url);
  const argv1abs = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (__filename === argv1abs) {
    const args = process.argv.slice(2);
    const argFlag = (n) => { const i = args.indexOf(n); return i === -1 ? undefined : args[i + 1]; };
    const floorPath = argFlag('--floor') ?? 'config/prophet_tradable_universe.txt';
    const date = argFlag('--date') ?? new Date().toISOString().slice(0, 10);
    const apiKey = process.env.FMP_API_KEY ?? '';
    if (!apiKey) { process.stderr.write('rank-floor-movers: FMP_API_KEY not set\n'); process.exit(3); }
    const floor = parseFloorFile(readFileSync(floorPath, 'utf8'));
    rankFloorMovers({ floor, date, apiKey, fetchImpl: globalThis.fetch }).then(
      (r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); },
      (err) => { process.stderr.write(`rank-floor-movers: ${err.message}\n`); process.exit(4); },
    );
  }
}
