// Canonical Day P&L rule, shared by the dashboard (agent/public/index.html)
// and the Slack daily-summary (agent/server.js).
//
// Day P&L is the intraday change in equity: equity - last_equity. It is only
// defined when Alpaca gives us a prior-session close to measure against.
// Alpaca returns last_equity=0 when it has none — e.g. a brand-new or
// freshly-reset paper account — and the naive `equity - 0` then equals the
// FULL PORTFOLIO VALUE, which the UI would show as if it were the day's gain.
//
// Treat any non-positive baseline as "unavailable" and let callers render a
// placeholder ("—") instead of a misleading number. This mirrors the guard
// every other consumer already applies: server.js's daily-loss watcher
// (`if (!lastEquity) return;`) and Go's TradeGuard (`LastEquity <= 0` → skip).

function readNum(acc, keys) {
  if (!acc) return 0;
  for (const k of keys) {
    const v = acc[k];
    if (v == null || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

/**
 * @param {object|null|undefined} acc  Account payload from /api/v1/account
 *   (accepts both Go's PascalCase and Alpaca's snake_case field names).
 * @returns {{available: boolean, equity: number, lastEquity: number,
 *   pnl: number|null, pnlPct: number|null}}
 *   `available` is false when there is no positive prior-close baseline; in
 *   that case `pnl`/`pnlPct` are null (callers should show a placeholder).
 */
export function computeDayPnl(acc) {
  const equity = readNum(acc, ['PortfolioValue', 'portfolio_value', 'Equity', 'equity']);
  const lastEquity = readNum(acc, ['LastEquity', 'last_equity']);

  if (!(lastEquity > 0)) {
    return { available: false, equity, lastEquity, pnl: null, pnlPct: null };
  }

  const pnl = equity - lastEquity;
  return { available: true, equity, lastEquity, pnl, pnlPct: (pnl / lastEquity) * 100 };
}
