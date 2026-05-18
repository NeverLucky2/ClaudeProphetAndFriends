// Predicate scorer for walk-forward hold-out validation. Spec:
// docs/superpowers/specs/2026-05-17-friction-and-walkforward-design.md

const MIN_TRADES_FOR_NON_INCONCLUSIVE = 3;
const MIN_ABS_DELTA_FOR_NON_INCONCLUSIVE = 200;

export function buildVerdict({
  predicate, params, holdout_size, trades_affected, net_pl_delta_usd,
  blocked_winners, blocked_losers, details, limitation_notes = [],
}) {
  let verdict;
  if (trades_affected === 0) {
    verdict = 'INCONCLUSIVE';
  } else if (trades_affected < MIN_TRADES_FOR_NON_INCONCLUSIVE
    && Math.abs(net_pl_delta_usd) < MIN_ABS_DELTA_FOR_NON_INCONCLUSIVE) {
    verdict = 'INCONCLUSIVE';
  } else if (net_pl_delta_usd > 0) {
    verdict = 'APPROVED-BY-HOLDOUT';
  } else if (net_pl_delta_usd < 0) {
    verdict = 'REJECTED-BY-HOLDOUT';
  } else {
    verdict = 'INCONCLUSIVE';
  }
  return {
    predicate, params, review_type: 'mechanical',
    holdout_size, trades_affected, net_pl_delta_usd,
    blocked_winners, blocked_losers,
    verdict, limitation_notes, details,
  };
}

export function scoreMaxPositionSizePct(holdoutTrades, params) {
  const { limit } = params;
  let trades_affected = 0;
  let net_pl_delta_usd = 0;
  let blocked_winners = 0;
  let blocked_losers = 0;
  const details = [];

  for (const t of holdoutTrades) {
    const md = t.market_data ?? {};
    if (typeof md.entry_price !== 'number' || typeof md.size !== 'number' || typeof md.portfolio_value !== 'number') continue;
    const positionPct = (md.entry_price * md.size) / md.portfolio_value;
    if (positionPct > limit) {
      trades_affected += 1;
      const pl = md.friction_adjusted_pl ?? 0;
      net_pl_delta_usd -= pl;
      if (pl > 0) blocked_winners += 1;
      if (pl < 0) blocked_losers += 1;
      details.push({ symbol: t.symbol, position_pct: +positionPct.toFixed(4), pl });
    }
  }
  return buildVerdict({
    predicate: 'max_position_size_pct', params,
    holdout_size: holdoutTrades.length, trades_affected, net_pl_delta_usd,
    blocked_winners, blocked_losers, details,
  });
}

const STOP_AT_PCT_LIMITATION = 'stop_at_pct only sees trades that CLOSED past threshold; true firing count likely higher because intra-trade trough is not in the trade schema';

export function scoreStopAtPct(holdoutTrades, params) {
  const { stop } = params; // e.g., -0.10
  let trades_affected = 0;
  let net_pl_delta_usd = 0;
  let blocked_winners = 0;
  let blocked_losers = 0;
  const details = [];

  for (const t of holdoutTrades) {
    const md = t.market_data ?? {};
    if (typeof md.unrealized_pct !== 'number' || typeof md.entry_price !== 'number' || typeof md.size !== 'number') continue;
    const actualPctFraction = md.unrealized_pct / 100;
    if (actualPctFraction >= stop) continue; // didn't close past the stop

    trades_affected += 1;
    const entryValue = md.entry_price * md.size;
    const stoppedExitPl = stop * entryValue;
    const actualPl = md.friction_adjusted_pl ?? 0;
    const delta = stoppedExitPl - actualPl;
    net_pl_delta_usd += delta;
    if (delta > 0) blocked_losers += 1; // we'd be cutting losers earlier
    if (delta < 0) blocked_winners += 1; // unusual, but possible
    details.push({ symbol: t.symbol, actual_pl: actualPl, stopped_exit_pl: stoppedExitPl, delta });
  }
  return buildVerdict({
    predicate: 'stop_at_pct', params,
    holdout_size: holdoutTrades.length, trades_affected, net_pl_delta_usd,
    blocked_winners, blocked_losers, details,
    limitation_notes: [STOP_AT_PCT_LIMITATION],
  });
}

export function scoreMaxConcurrentPositions(holdoutTrades, params) {
  const { limit } = params;
  const open = new Set();
  let trades_affected = 0;
  let net_pl_delta_usd = 0;
  let blocked_winners = 0;
  let blocked_losers = 0;
  const details = [];

  const sorted = [...holdoutTrades].sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''));

  for (const t of sorted) {
    const isOpen = t.action === 'BUY';
    const isClose = t.action === 'SELL' || t.action === 'CLOSE';
    if (isOpen) {
      if (open.size >= limit) {
        trades_affected += 1;
        const pl = t.market_data?.friction_adjusted_pl ?? 0;
        net_pl_delta_usd -= pl;
        if (pl > 0) blocked_winners += 1;
        if (pl < 0) blocked_losers += 1;
        details.push({ symbol: t.symbol, timestamp: t.timestamp, open_count_before_block: open.size, pl });
      } else {
        open.add(t.symbol);
      }
    } else if (isClose) {
      open.delete(t.symbol);
    }
  }
  return buildVerdict({
    predicate: 'max_concurrent_positions', params,
    holdout_size: holdoutTrades.length, trades_affected, net_pl_delta_usd,
    blocked_winners, blocked_losers, details,
  });
}

export function scoreNoReentryWithinHours(holdoutTrades, params) {
  const { hours } = params;
  const windowMs = hours * 3600 * 1000;
  const sorted = [...holdoutTrades].sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''));
  const lastExitBySymbol = new Map();
  let trades_affected = 0;
  let net_pl_delta_usd = 0;
  let blocked_winners = 0;
  let blocked_losers = 0;
  const details = [];

  for (const t of sorted) {
    const ts = Date.parse(t.timestamp);
    if (!Number.isFinite(ts)) continue;
    if (t.action === 'SELL' || t.action === 'CLOSE') {
      lastExitBySymbol.set(t.symbol, ts);
    } else if (t.action === 'BUY') {
      const lastExit = lastExitBySymbol.get(t.symbol);
      if (lastExit !== undefined && (ts - lastExit) < windowMs) {
        trades_affected += 1;
        const pl = t.market_data?.friction_adjusted_pl ?? 0;
        net_pl_delta_usd -= pl;
        if (pl > 0) blocked_winners += 1;
        if (pl < 0) blocked_losers += 1;
        details.push({ symbol: t.symbol, timestamp: t.timestamp, hours_since_exit: (ts - lastExit) / 3600000, pl });
      }
    }
  }
  return buildVerdict({
    predicate: 'no_reentry_within_hours', params,
    holdout_size: holdoutTrades.length, trades_affected, net_pl_delta_usd,
    blocked_winners, blocked_losers, details,
  });
}

const OCC_FOR_DTE = /^[A-Z]{1,6}(\d{2})(\d{2})(\d{2})[CP]\d{8}$/;

function parseDteFromOcc(symbol, entryTimestamp) {
  const m = OCC_FOR_DTE.exec(symbol);
  if (!m) return null;
  const yy = Number(m[1]), mm = Number(m[2]), dd = Number(m[3]);
  // Assume 20YY for OCC (good through 2099)
  const expMs = Date.UTC(2000 + yy, mm - 1, dd);
  const entryMs = Date.parse(entryTimestamp);
  if (!Number.isFinite(entryMs) || !Number.isFinite(expMs)) return null;
  return Math.round((expMs - entryMs) / 86400000);
}

export function scoreDteBounds(holdoutTrades, params) {
  const { min, max } = params;
  let trades_affected = 0;
  let net_pl_delta_usd = 0;
  let blocked_winners = 0;
  let blocked_losers = 0;
  const details = [];

  for (const t of holdoutTrades) {
    if (t.action !== 'BUY') continue;
    const dte = parseDteFromOcc(t.symbol ?? '', t.timestamp);
    if (dte === null) continue;
    if (dte < min || dte > max) {
      trades_affected += 1;
      const pl = t.market_data?.friction_adjusted_pl ?? 0;
      net_pl_delta_usd -= pl;
      if (pl > 0) blocked_winners += 1;
      if (pl < 0) blocked_losers += 1;
      details.push({ symbol: t.symbol, dte, pl });
    }
  }
  return buildVerdict({
    predicate: 'dte_bounds', params,
    holdout_size: holdoutTrades.length, trades_affected, net_pl_delta_usd,
    blocked_winners, blocked_losers, details,
  });
}
