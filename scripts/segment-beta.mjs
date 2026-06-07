// scripts/segment-beta.mjs
// 2b: daily returns from the DBSegmentPnL series + beta/orientation vs SPY (spec §4.2).
// node:sqlite reader (readOnly) mirroring managed-position-repair.mjs. Gap-aware (D-B7).
import { DatabaseSync } from 'node:sqlite';

const MIN_BETA_DAYS = 30;

// Read the daily series for one strategy. NOTE: confirm column names via Step 0; adjust if GORM
// rendered them differently (e.g. realized_pn_l). Maps to camelCase row objects.
export function readSegmentDaily(dbPath, strategy) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare(
      'SELECT strategy, date, realized_pn_l AS realizedPnl, unrealized_pn_l AS unrealizedPnl, ' +
      'deployed_percent AS deployedPercent, portfolio_value AS portfolioValue ' +
      'FROM db_segment_pn_ls WHERE strategy = ? ORDER BY date ASC'
    ).all(strategy);
    return rows;
  } finally { db.close(); }
}

// Loud guard: realized_pnl must be a per-day INCREMENT (added), never cumulative (differenced).
export function assertNotCumulative(rows) {
  const r = rows.map((x) => x.realizedPnl).filter((v) => v != null);
  if (r.length >= 3) {
    // A cumulative series: running total of P&L. Signature: monotone strictly increasing.
    // Incremental: day's P&L change. Can have zeros, negatives, repeats.
    // Guard: reject if monotone strictly increasing (10, 20, 30 pattern).
    let isStrictlyIncreasing = true;
    for (let i = 1; i < r.length; i += 1) if (r[i] <= r[i - 1]) { isStrictlyIncreasing = false; break; }
    if (isStrictlyIncreasing) {
      throw new Error('segment-beta: realized_pnl looks CUMULATIVE (monotone strictly increasing) — Component-1 contract says daily increment. Aborting to avoid a bent beta.');
    }
  }
}

// r_d = (realized_d + (unrealized_d - unrealized_{d-1})) / portfolio_value_{d-1}, gap-aware (D-B7).
export function computeDailyReturns(rows, spy) {
  assertNotCumulative(rows);
  const spyIdx = new Map(spy.dates.map((d, i) => [d, i]));
  const out = [];
  for (let i = 1; i < rows.length; i += 1) {
    const cur = rows[i], prev = rows[i - 1];
    const di = spyIdx.get(cur.date), pi = spyIdx.get(prev.date);
    if (di == null || pi == null) continue;                 // a date SPY doesn't have → skip
    if (di - pi !== 1) continue;                            // not consecutive trading days → gap, drop
    if (spy.gaps.has(cur.date) || spy.gaps.has(prev.date)) continue; // SPY data outage → drop
    const pv = prev.portfolioValue;
    if (!pv) continue;
    const ret = (cur.realizedPnl + (cur.unrealizedPnl - prev.unrealizedPnl)) / pv;
    out.push({ date: cur.date, ret, deployed: cur.deployedPercent > 0 });
  }
  return out;
}

function olsBetaCI(xs, ys, { B = 2000, seed = 12345 } = {}) {
  const slope = (X, Y) => {
    const n = X.length; if (n < 2) return null;
    const mx = X.reduce((a, b) => a + b, 0) / n, my = Y.reduce((a, b) => a + b, 0) / n;
    let cov = 0, vx = 0; for (let i = 0; i < n; i += 1) { cov += (X[i] - mx) * (Y[i] - my); vx += (X[i] - mx) ** 2; }
    return vx === 0 ? null : cov / vx;
  };
  const point = slope(xs, ys);
  let a = seed >>> 0; const rnd = () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const n = xs.length; const slopes = [];
  if (n >= 2) for (let b = 0; b < B; b += 1) {
    const X = [], Y = []; for (let k = 0; k < n; k += 1) { const j = (rnd() * n) | 0; X.push(xs[j]); Y.push(ys[j]); }
    const s = slope(X, Y); if (s != null) slopes.push(s);
  }
  slopes.sort((p, q) => p - q);
  const pct = (p) => (slopes.length ? slopes[Math.min(slopes.length - 1, Math.floor((p / 100) * slopes.length))] : null);
  return { point, lo: pct(2.5), hi: pct(97.5), n };
}

// stratReturns: [{date, ret, deployed}]; spyReturns: {date→ret}. Three filtered betas + CIs.
export function computeBeta(stratReturns, spyReturns, { minDays = MIN_BETA_DAYS } = {}) {
  const mk = (filterFn) => {
    const xs = [], ys = [];
    for (const s of stratReturns) { const sp = spyReturns[s.date]; if (sp == null) continue; if (!filterFn(s, sp)) continue; xs.push(sp); ys.push(s.ret); }
    if (xs.length < minDays) return { insufficient: true, n: xs.length };
    return olsBetaCI(xs, ys);
  };
  return {
    deployed: mk((s) => s.deployed),
    unconditional: mk(() => true),
    downside: mk((s, sp) => sp < 0),
  };
}
