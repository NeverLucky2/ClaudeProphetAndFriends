// scripts/coil-threshold-earnings.mjs
// Replicates Coil's FORWARD earnings skip for the backtest: exclude an entry iff the
// ticker has an earnings date within the next 5 trading bars. Past earnings do NOT
// exclude (Coil trades post-earnings gap-downs). Earnings dates come from FMP's stable
// earnings-calendar (v3 is dead — see the screener migration notes).
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const FMP_HOST = 'https://financialmodelingprep.com';

// barDates: ascending 'YYYY-MM-DD' for one ticker. tickerEarningsDates: array of 'YYYY-MM-DD'.
// True iff an earnings date e satisfies date[idx] < e <= date[min(idx+5, last)].
export function earningsWithinNext5(barDates, idx, tickerEarningsDates, horizon = 5) {
  const startExclusive = barDates[idx];
  const endInclusive = barDates[Math.min(idx + horizon, barDates.length - 1)];
  for (const e of tickerEarningsDates) {
    if (e > startExclusive && e <= endInclusive) return true;
  }
  return false;
}

// One FMP /stable/earnings-calendar fetch over [from,to], filtered to `tickers`.
// Returns { TICKER: [sorted unique 'YYYY-MM-DD', ...] }. Never throws on a bad ticker;
// throws only on transport/HTTP failure so the caller can soft-fail loudly.
export async function fetchEarningsDates({ tickers, from, to, apiKey, fetchImpl = globalThis.fetch }) {
  if (!apiKey) throw new Error('FMP_API_KEY not set (source the root .env)');
  const want = new Set(tickers.map(t => t.toUpperCase()));
  const url = `${FMP_HOST}/stable/earnings-calendar?from=${from}&to=${to}&apikey=${apiKey}`;
  const resp = await fetchImpl(url);
  if (!resp.ok) throw new Error(`FMP earnings-calendar failed (${resp.status})`);
  const items = await resp.json();
  if (!Array.isArray(items)) throw new Error('FMP earnings-calendar malformed (expected array)');
  const out = {};
  for (const it of items) {
    const sym = (it.symbol || '').toUpperCase();
    if (!want.has(sym) || !it.date) continue;
    (out[sym] ||= new Set()).add(it.date);
  }
  for (const k of Object.keys(out)) out[k] = [...out[k]].sort();
  return out;
}

// Per-symbol earnings fetch: one /stable/earnings?symbol=X call per ticker (works on tiers
// where the bulk earnings-calendar historical range is gated). Soft-fails per ticker — a
// failed symbol lands in `failed` and is simply not earnings-filtered downstream.
export async function fetchEarningsDatesPerSymbol({ tickers, apiKey, fetchImpl = globalThis.fetch }) {
  if (!apiKey) throw new Error('FMP_API_KEY not set (source the root .env)');
  const byTicker = {};
  const failed = [];
  for (const t of tickers) {
    const sym = t.toUpperCase();
    try {
      const url = `${FMP_HOST}/stable/earnings?symbol=${sym}&apikey=${apiKey}`;
      const resp = await fetchImpl(url);
      if (!resp.ok) { failed.push(sym); continue; }
      const items = await resp.json();
      if (!Array.isArray(items)) { failed.push(sym); continue; }
      const set = new Set();
      for (const it of items) { if (it && it.date) set.add(it.date); }
      byTicker[sym] = [...set].sort();
    } catch { failed.push(sym); }
  }
  return { byTicker, failed };
}

// CLI: source .env first. node scripts/coil-threshold-earnings.mjs --from 2019-01-01 --to 2026-06-05
{
  const argv1 = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (fileURLToPath(import.meta.url) === argv1) {
    const { MEANREV_UNIVERSE } = await import('./coil-eventstudy-build.mjs');
    const args = process.argv.slice(2);
    const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
    const from = flag('--from', '2019-01-01');
    const to = flag('--to', new Date().toISOString().slice(0, 10));
    const out = flag('--out', 'data/lab/coil-earnings-dates.json');
    try {
      const { byTicker, failed } = await fetchEarningsDatesPerSymbol({
        tickers: MEANREV_UNIVERSE, apiKey: process.env.FMP_API_KEY,
      });
      if (Object.keys(byTicker).length === 0) throw new Error(`all ${MEANREV_UNIVERSE.length} per-symbol earnings fetches failed`);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, JSON.stringify(byTicker, null, 2));
      process.stdout.write(`wrote ${out} (${Object.keys(byTicker).length} tickers, ${failed.length} failed${failed.length ? ': ' + failed.join(',') : ''})\n`);
    } catch (e) {
      process.stderr.write(`coil-threshold-earnings FAILED: ${e.message}\n`);
      process.stderr.write('Backtest can still run WITHOUT the earnings filter, but the [0,5) baseline will then include pre-earnings entries Coil would skip. Re-run with FMP available before trusting the verdict.\n');
      process.exit(3);
    }
  }
}
