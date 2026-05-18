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
