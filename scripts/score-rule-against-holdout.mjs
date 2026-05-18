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
