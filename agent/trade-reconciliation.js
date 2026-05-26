// Trade-log ↔ broker reconciliation. Pure matcher + windowing/coverage helpers
// (Tasks 1-2) and injected-dep I/O (Tasks 3-4). Compares what an agent's trade
// log recorded against the broker's actual orders for the day, classifying
// discrepancies. Only TERMINAL broker states drive a verdict — non-terminal
// orders are counted as `unresolved` and never flagged, so an in-flight order
// can never produce a confident-but-wrong banner.

import { _etDate } from './trades-store.js';

// classifyBrokerStatus buckets a broker order status into 'took' | 'reject' |
// 'unresolved'. done_for_day counts as took only if something filled.
export function classifyBrokerStatus(status, filledQty = 0) {
  const s = String(status || '').toLowerCase();
  if (s === 'filled' || s === 'partially_filled') return 'took';
  if (s === 'done_for_day') return Number(filledQty) > 0 ? 'took' : 'unresolved';
  if (s === 'rejected' || s === 'canceled' || s === 'cancelled' || s === 'expired') return 'reject';
  return 'unresolved'; // new, accepted, pending_new, pending_cancel, pending_replace, …
}

// reconcileTrades groups logged trades and broker orders by (symbol, side) and
// classifies each group. Reports group-level when 1:1 attribution is ambiguous
// (no order id on the log side). Returns { mismatches, counts }.
export function reconcileTrades(loggedTrades, brokerOrders) {
  const logged = Array.isArray(loggedTrades) ? loggedTrades : [];
  const broker = Array.isArray(brokerOrders) ? brokerOrders : [];
  const keyOf = (symbol, side) => `${symbol}|${String(side || '').toLowerCase()}`;
  const groups = new Map();
  const group = (symbol, side) => {
    const k = keyOf(symbol, side);
    if (!groups.has(k)) groups.set(k, { symbol, side: String(side || '').toLowerCase(), logged: [], broker: [] });
    return groups.get(k);
  };
  for (const t of logged) group(t.symbol, t.side).logged.push(t);
  for (const o of broker) group(o.symbol, o.side).broker.push(o);

  const mismatches = [];
  const counts = { phantomSuccess: 0, falseFailure: 0, statusDivergence: 0, unresolved: 0, matched: 0, total: logged.length };

  for (const g of groups.values()) {
    const successLogs = g.logged.filter((t) => t.status === 'success');
    const failedLogs = g.logged.filter((t) => t.status === 'failed');
    let took = 0, reject = 0;
    const tookOrders = [], rejectOrders = [];
    for (const o of g.broker) {
      const c = classifyBrokerStatus(o.status, o.filledQty);
      if (c === 'took') { took++; tookOrders.push(o); }
      else if (c === 'reject') { reject++; rejectOrders.push(o); }
      else counts.unresolved++;
    }

    if (successLogs.length > 0 && took + reject === 0) {
      counts.phantomSuccess += successLogs.length;
      mismatches.push({
        class: 'phantom_success', symbol: g.symbol, side: g.side,
        loggedTrades: successLogs, brokerOrders: g.broker,
        note: `${successLogs.length} logged success, no accepted/rejected broker order`,
      });
    } else {
      if (successLogs.length > took && reject > 0) {
        const n = successLogs.length - took;
        counts.statusDivergence += n;
        mismatches.push({
          class: 'status_divergence', symbol: g.symbol, side: g.side,
          loggedTrades: successLogs, brokerOrders: rejectOrders,
          note: `${successLogs.length} logged success, broker ${took} took + ${reject} rejected → ${n} divergence`,
        });
      }
      if (failedLogs.length > 0 && took > 0) {
        const n = Math.min(failedLogs.length, took);
        counts.falseFailure += n;
        mismatches.push({
          class: 'false_failure', symbol: g.symbol, side: g.side,
          loggedTrades: failedLogs, brokerOrders: tookOrders,
          note: `${failedLogs.length} logged failed, broker has ${took} that took → ${n} false failure`,
        });
      }
    }
  }

  const flagged = mismatches.reduce((a, m) => a + m.loggedTrades.length, 0);
  counts.matched = Math.max(0, logged.length - flagged);
  return { mismatches, counts };
}

// etDayOf returns the America/New_York calendar day (YYYY-MM-DD) for an ISO
// instant, reusing the exact conversion the trade log is bucketed with. Never a
// UTC slice — after-hours orders (up to 20:00 ET) are the next UTC calendar day.
export function etDayOf(iso) {
  return _etDate(new Date(iso));
}

// isReconcilableTrade keeps only order placements that carry a real symbol. v1
// excludes close-type rows (they store a position_id in `symbol`, not a tradable
// symbol) and the '??' placeholder the harness writes when it can't resolve one.
export function isReconcilableTrade(trade) {
  if (!trade || trade.type === 'close') return false;
  const sym = trade.symbol;
  return typeof sym === 'string' && sym.length > 0 && sym !== '??';
}

// normalizeBrokerOrder maps the Go interfaces.Order JSON (PascalCase, no json
// tags) to the lower-camel shape the matcher expects. Lowercase fallbacks guard
// against future json-tag changes.
export function normalizeBrokerOrder(o) {
  return {
    id: o.ID ?? o.id ?? '',
    symbol: o.Symbol ?? o.symbol ?? '',
    side: o.Side ?? o.side ?? '',
    status: o.Status ?? o.status ?? '',
    filledQty: o.FilledQty ?? o.filledQty ?? 0,
    submittedAt: o.SubmittedAt ?? o.submittedAt ?? null,
    strategy: o.Strategy ?? o.strategy ?? '',
  };
}

// assessCoverage detects a truncated fetch: if the returned list hit the server
// limit AND its oldest order was submitted after the ET-day start, the window
// did not reach back far enough to cover the whole day. Returns { covered }.
export function assessCoverage(rawOrders, dayStartIso, limit = 500) {
  const list = Array.isArray(rawOrders) ? rawOrders : [];
  if (list.length < limit) return { covered: true };
  const dayStartMs = new Date(dayStartIso).getTime();
  let oldestMs = Infinity;
  for (const o of list) {
    const ms = new Date(o.submittedAt ?? o.SubmittedAt ?? 0).getTime();
    if (Number.isFinite(ms) && ms < oldestMs) oldestMs = ms;
  }
  return { covered: oldestMs <= dayStartMs };
}
