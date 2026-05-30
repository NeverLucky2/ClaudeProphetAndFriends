// agent/options-eligibility.js
// Read-only candidate eligibility evaluation (spec §5.4, D6). Primary gate is
// options liquidity (representative ATM monthly spread vs the live spread-gate
// threshold) using the Go backend's chain endpoint — the same Alpaca data the
// real gate consumes. Secondary context (realized vol, recent move) is from
// bar-cache and NEVER gates the verdict.
import { loadDailyCloses } from './bar-cache-reader.js';
import { etDateString } from './market-calendar.js';

const DEFAULT_SPREAD_MAX_PCT = 0.10;
const MIN_OI = 100;

function _thirdFriday(year, month0) {
  // month0: 0-11. Find the 3rd Friday (noon-UTC anchor).
  const first = new Date(Date.UTC(year, month0, 1, 12));
  const toFirstFriday = (5 - first.getUTCDay() + 7) % 7; // 5 = Friday
  return new Date(Date.UTC(year, month0, 1 + toFirstFriday + 14, 12));
}

// nextMonthlyExpiration: the standard monthly (3rd Friday) at least minDte days
// out from fromEtDate, as "YYYY-MM-DD".
export function nextMonthlyExpiration(fromEtDate, minDte = 21) {
  const from = new Date(fromEtDate + 'T12:00:00Z');
  const minDate = new Date(from.getTime() + (minDte - 1) * 86400000);
  let y = from.getUTCFullYear();
  let m = from.getUTCMonth();
  for (let i = 0; i < 6; i++) {
    const tf = _thirdFriday(y, m);
    if (tf >= minDate) return tf.toISOString().slice(0, 10);
    m += 1; if (m > 11) { m = 0; y += 1; }
  }
  return _thirdFriday(y, m).toISOString().slice(0, 10);
}

function _num(c, ...keys) {
  for (const k of keys) if (typeof c?.[k] === 'number') return c[k];
  return undefined;
}

// pickAtmContract: the call contract with |delta| closest to 0.5 and positive
// bid/ask. Tolerant of PascalCase (Go) or lowercase keys.
export function pickAtmContract(contracts) {
  let best = null;
  let bestDist = Infinity;
  for (const c of contracts || []) {
    const bid = _num(c, 'Bid', 'bid');
    const ask = _num(c, 'Ask', 'ask');
    const delta = _num(c, 'Delta', 'delta');
    if (!(bid > 0) || !(ask > 0) || typeof delta !== 'number') continue;
    const dist = Math.abs(Math.abs(delta) - 0.5);
    if (dist < bestDist) { bestDist = dist; best = c; }
  }
  return best;
}

// spreadVerdict: reject/watch/strong from a representative ATM contract.
export function spreadVerdict(contract, spreadMaxPct = DEFAULT_SPREAD_MAX_PCT, minOI = MIN_OI) {
  if (!contract) return { verdict: 'reject', reason: 'no_liquid_atm_contract', spreadPct: null };
  const bid = _num(contract, 'Bid', 'bid');
  const ask = _num(contract, 'Ask', 'ask');
  const oi = _num(contract, 'OpenInterest', 'openInterest') ?? 0;
  const vol = _num(contract, 'Volume', 'volume') ?? 0;
  const mid = (bid + ask) / 2;
  if (!(mid > 0)) return { verdict: 'reject', reason: 'no_mid', spreadPct: null };
  const spreadPct = (ask - bid) / mid;
  if (spreadPct >= spreadMaxPct) return { verdict: 'reject', reason: 'spread_exceeds_gate', spreadPct, oi, vol };
  if (spreadPct <= 0.5 * spreadMaxPct && oi >= minOI && vol > 0) {
    return { verdict: 'strong', reason: 'tight_spread_liquid', spreadPct, oi, vol };
  }
  return { verdict: 'watch', reason: 'borderline', spreadPct, oi, vol };
}

// computeContext: secondary, NEVER-gating context from daily closes — annualized
// realized volatility and a trailing ~5-trading-day move. Null-safe.
export function computeContext(closes, asOfEtDate) {
  const dates = [...closes.keys()].filter(d => d <= asOfEtDate).sort();
  if (dates.length === 0) return { lastClose: null, realizedVol: null, trailing5dMove: null, asOf: asOfEtDate };
  const series = dates.map(d => closes.get(d));
  const lastClose = series[series.length - 1];
  // realized vol: stdev of up to the last 20 daily log returns, annualized (252).
  const rets = [];
  for (let i = Math.max(1, series.length - 20); i < series.length; i++) {
    if (series[i - 1] > 0 && series[i] > 0) rets.push(Math.log(series[i] / series[i - 1]));
  }
  let realizedVol = null;
  if (rets.length >= 2) {
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const variance = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1);
    realizedVol = +(Math.sqrt(variance) * Math.sqrt(252)).toFixed(4);
  }
  const back = series.length > 5 ? series[series.length - 6] : series[0];
  const trailing5dMove = back > 0 ? +(lastClose / back - 1).toFixed(4) : null;
  return { lastClose, realizedVol, trailing5dMove, asOf: asOfEtDate };
}

async function _defaultFetchChain(tradingBotUrl, ticker, expiration) {
  const url = `${tradingBotUrl}/api/options/chain/${encodeURIComponent(ticker)}`
    + `?expiration=${expiration}&type=call&delta_min=0.3&delta_max=0.7`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) { const e = new Error(`chain HTTP ${res.status}`); e.status = res.status; throw e; }
  const j = await res.json();
  return Array.isArray(j.contracts) ? j.contracts : [];
}

// evaluateCandidate: the standalone, read-only verdict (spec §5.4). Primary gate
// = options liquidity (live chain); secondary context = bar-cache (never gating).
// Injectable fetchChain/loadCloses for tests. Never throws on data outages.
export async function evaluateCandidate(projectRoot, ticker, opts = {}) {
  const t = String(ticker || '').toUpperCase();
  const spreadMaxPct = opts.spreadMaxPct
    ?? Number(process.env.PROPHET_OPTIONS_SPREAD_MAX_PCT || DEFAULT_SPREAD_MAX_PCT);
  const todayEtDate = opts.todayEtDate ?? etDateString(new Date());
  const expiration = opts.expiration ?? nextMonthlyExpiration(todayEtDate);
  const tradingBotUrl = opts.tradingBotUrl || process.env.TRADING_BOT_URL || 'http://localhost:4534';
  const fetchChain = opts.fetchChain ?? ((tk) => _defaultFetchChain(tradingBotUrl, tk, expiration));
  const loadCloses = opts.loadCloses ?? ((sym) => loadDailyCloses(projectRoot, sym));

  let liquidity;
  try {
    const contracts = await fetchChain(t, expiration);
    const atm = pickAtmContract(contracts);
    const v = spreadVerdict(atm, spreadMaxPct);
    liquidity = {
      ...v,
      available: true,
      contract: atm ? {
        bid: _num(atm, 'Bid', 'bid'), ask: _num(atm, 'Ask', 'ask'),
        delta: _num(atm, 'Delta', 'delta'), oi: _num(atm, 'OpenInterest', 'openInterest'),
        vol: _num(atm, 'Volume', 'volume'), strike: _num(atm, 'StrikePrice', 'strike'),
      } : null,
    };
  } catch (err) {
    const why = err && err.status === 429 ? 'rate_limited' : (err && err.message) || 'chain_unavailable';
    liquidity = { verdict: 'reject', reason: `options_data_unavailable:${why}`, spreadPct: null, available: false, contract: null };
  }

  let context;
  try {
    context = computeContext(await loadCloses(t), todayEtDate);
  } catch {
    context = { lastClose: null, realizedVol: null, trailing5dMove: null, asOf: todayEtDate };
  }
  return { ticker: t, expiration, spreadMaxPct, verdict: liquidity.verdict, liquidity, context, evaluatedAt: new Date().toISOString() };
}
