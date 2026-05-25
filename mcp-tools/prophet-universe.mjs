// Prophet's tradable universe loader for the weekly screeners.
//
// The VCP screener's default path calls FMP's get_sp500_constituents(), a
// legacy endpoint deprecated for subscriptions created after 2025-08-31 — it
// 403s on the starter tier and the screener dies before writing anything.
// Passing --universe from the curated floor bypasses that endpoint entirely.
//
// Single source of truth: config/prophet_tradable_universe.txt — the same file
// services/tradable_universe.go (the Go guard) and the catalyst/analyst skills'
// universe_builder.py read. One ticker per line, '#' comments and blank lines
// ignored, upper-cased. If that file is empty or unreadable we fall back to a
// small committed default so the screener always has a valid, scoped universe.

import fs from 'fs/promises';

// Committed fallback: a handful of the most liquid, optionable names. Only used
// when config/prophet_tradable_universe.txt is absent or empty (e.g. a fresh
// checkout before the floor file is populated). Kept small on purpose — its job
// is to keep the screener off the dead constituents endpoint, not to be the
// real universe.
export const PROPHET_UNIVERSE_FALLBACK = Object.freeze([
  'SPY', 'QQQ', 'IWM',
  'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA', 'AVGO',
  'JPM', 'XOM', 'UNH', 'WMT',
]);

// parseUniverseFile turns the raw file text into a deduped, upper-cased ticker
// list. Pure; mirrors the parsing in services/tradable_universe.go and
// universe_builder.py so all three agree on membership.
export function parseUniverseFile(raw) {
  if (typeof raw !== 'string') return [];
  const seen = new Set();
  const out = [];
  for (const line of raw.split('\n')) {
    const ticker = line.split('#')[0].trim().toUpperCase();
    if (ticker && !seen.has(ticker)) {
      seen.add(ticker);
      out.push(ticker);
    }
  }
  return out;
}

// loadProphetUniverse reads `filePath`, parses it, and returns the tickers — or
// a copy of `fallback` if the file is missing, unreadable, or parses to empty.
// The fs.readFile is the only side-effecting line; parseUniverseFile and the
// fallback selection are pure and unit-tested.
export async function loadProphetUniverse(filePath, fallback = PROPHET_UNIVERSE_FALLBACK) {
  try {
    const tickers = parseUniverseFile(await fs.readFile(filePath, 'utf-8'));
    if (tickers.length > 0) return tickers;
  } catch {
    // ENOENT / EACCES / etc → fall through to the committed default.
  }
  return [...fallback];
}
