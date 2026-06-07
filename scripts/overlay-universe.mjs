// scripts/overlay-universe.mjs
// Source of truth for the hedge-overlay study: parse the Merrill Holdings CSV into
// {symbol,value} weights, and declare the four hedge candidates + isolated cache dir.
import { join } from 'node:path';

export const OVERLAY_CACHE_SUBDIR = join('data', 'lab', 'overlay-cache');

// VFIAX (mutual fund, no clean FMP daily bar) → VOO proxy (spec §3.1).
const SYMBOL_REMAP = { VFIAX: 'VOO' };

// Candidates (spec §4). `kind` drives funding/convexity handling downstream.
export const CANDIDATES = [
  { id: 'def_prophet', label: 'def-Prophet proxy', kind: 'spread', sizes: [0.005, 0.01, 0.02], convex: true },
  { id: 'gld', label: 'Static GLD', kind: 'static', ticker: 'GLD', sizes: [0.025, 0.05, 0.10, 0.15, 0.20], convex: false },
  { id: 'tlt', label: 'Static TLT', kind: 'static', ticker: 'TLT', sizes: [0.025, 0.05, 0.10, 0.15, 0.20], convex: false },
  { id: 'vixm', label: 'Static VIXM', kind: 'static', ticker: 'VIXM', sizes: [0.025, 0.05, 0.10, 0.15, 0.20], convex: true },
];

// One CSV record line → array of fields, honoring double-quoted fields (commas inside quotes kept).
function splitCsvLine(line) {
  const out = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') { inQ = !inQ; continue; }
    if (ch === ',' && !inQ) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

// "4,209.90" → 4209.90 ; "(213.55)" → -213.55 ; "--" → null
function parseMoney(s) {
  const t = String(s).trim();
  if (!t || t === '--') return null;
  const neg = /^\(.*\)$/.test(t);
  const n = Number(t.replace(/[(),]/g, ''));
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

export function parseHoldings(csvText) {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) return [];
  const header = splitCsvLine(lines[0]);
  const iSym = header.indexOf('Symbol');
  const iVal = header.indexOf('Value ($)');
  const iQty = header.indexOf('Quantity');
  const out = [];
  for (let r = 1; r < lines.length; r += 1) {
    const f = splitCsvLine(lines[r]);
    let symbol = (f[iSym] || '').trim();
    if (!symbol || symbol === '--') continue;          // cash / non-security row
    symbol = SYMBOL_REMAP[symbol] || symbol;
    const value = parseMoney(f[iVal]);
    if (value == null || value <= 0) continue;
    out.push({ symbol, quantity: parseMoney(f[iQty]), value });
  }
  // Collapse duplicate symbols (e.g. VFIAX+VOO both → VOO) by summing value.
  const merged = new Map();
  for (const h of out) merged.set(h.symbol, (merged.get(h.symbol) || 0) + h.value);
  return [...merged.entries()].map(([symbol, value]) => ({ symbol, value }));
}
