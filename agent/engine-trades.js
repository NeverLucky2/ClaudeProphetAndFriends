// Surfaces trades placed directly by Go-scheduler agents (Turtle, DefensiveProphet),
// which bypass the LLM trade log. Pure logic over the broker order history returned by
// the Go bot's /api/v1/orders. Read-only; never places or mutates anything.

// Strategy tag -> agent display name. A held order is shown only if its strategy is a
// key here, which both attributes it and keeps the view to Go agents (so it never
// double-counts the LLM Trades tab). Add a future Go agent with one line.
export const ENGINE_AGENTS = {
  trend: 'Turtle',
  'prophet-defensive': 'DefensiveProphet',
};

// normalizeEngineOrder maps the Go interfaces.Order JSON (PascalCase, no json tags) to
// the lower-camel shape the view uses. Lowercase fallbacks guard against future
// json-tag changes. Self-contained (does not depend on trade-reconciliation.js).
export function normalizeEngineOrder(o) {
  const g = o || {};
  return {
    id: g.ID ?? g.id ?? '',
    symbol: g.Symbol ?? g.symbol ?? '',
    side: g.Side ?? g.side ?? '',
    qty: g.Qty ?? g.qty ?? 0,
    type: g.Type ?? g.type ?? '',
    status: g.Status ?? g.status ?? '',
    limitPrice: g.LimitPrice ?? g.limitPrice ?? null,
    stopPrice: g.StopPrice ?? g.stopPrice ?? null,
    filledQty: g.FilledQty ?? g.filledQty ?? 0,
    filledAvgPrice: g.FilledAvgPrice ?? g.filledAvgPrice ?? null,
    submittedAt: g.SubmittedAt ?? g.submittedAt ?? null,
    strategy: g.Strategy ?? g.strategy ?? '',
  };
}

// filterEngineTrades normalizes broker orders, keeps only Go-engine strategies, tags
// each with its agent display name, and returns them newest-first.
export function filterEngineTrades(rawOrders) {
  const list = Array.isArray(rawOrders) ? rawOrders : [];
  const rows = [];
  for (const raw of list) {
    const o = normalizeEngineOrder(raw);
    const agentName = ENGINE_AGENTS[o.strategy];
    if (!agentName) continue; // LLM agent, or untagged — not a Go engine trade
    rows.push({ ...o, agentName });
  }
  rows.sort((a, b) => new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0));
  return rows;
}
