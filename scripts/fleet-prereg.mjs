// scripts/fleet-prereg.mjs
// Pre-registration: a canonical sha256-hashed methodology block, written before scoring.
import { createHash } from 'node:crypto';

export function buildPrereg() {
  return {
    study: 'fleet-correlation-diagnostic',
    windows: {
      headline_4way: { start: '2022-01-01', end: '2026-06-06', lanes: ['coil', 'turtle', 'drift', 'defensive_proxy'] },
      crisis_3way: { start: '2016-01-01', end: '2026-06-06', lanes: ['coil', 'turtle', 'defensive_proxy'] },
      drift_floor: '2022-01-01',
    },
    representation: 'daily_mark_to_market_then_weekly_gross',
    benchmark: { primary: 'QQQ', reference: 'SPY' },
    crisis: { primary: 'worst_quintile', secondary: 'worst_decile', primary_metric: 'crisis_mean_return_bootstrap_CI' },
    effective_n_floor: 8,
    rotation_band: { K: 1000, method: 'circular_rotation', role: 'context_band_not_gate', stats: ['rho_crisis', 'downside_beta'] },
    sparse_lane_rule: { zero_week_threshold: 0.40, metric: 'active_week_conditional' },
    primary_beta_detector: 'full_sample_beta_with_block_bootstrap_CI',
    methods: ['pearson', 'spearman', 'ols_beta', 'block_bootstrap_CI'],
    lane_simplifications: {
      turtle: 'omits corr-guard, aggregate-risk cap, segment circuit-breaker; regime gate neutral',
      coil: 'entry-day mark anchored to tape entry fill (matches grossReturn)',
      drift: 'continuation-path only (weekly-PEAD-ready path omitted; rarely reachable), 2022+ floor, timing inferred when vendor omits',
      defensive_proxy: 'QQQ<200DMA price-only trigger + BSM put-spread; no timing-coverage inference; never a headline full-sample number',
      regime_gate: 'neutral (ENABLE_REGIME_GATE=false live)',
    },
    acceptable_findings: [
      'fleet is secretly correlated to QQQ',
      'diversification evaporates in crisis weeks',
      'large equity-selloff ballast gap',
      'crisis sample too small to distinguish tail co-move from selection artifact',
    ],
  };
}

// Canonical JSON: object keys sorted recursively, so the hash is stable regardless of key order.
function canonical(o) {
  if (Array.isArray(o)) return '[' + o.map(canonical).join(',') + ']';
  if (o && typeof o === 'object') return '{' + Object.keys(o).sort().map(k => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}';
  return JSON.stringify(o);
}

export function hashPrereg(prereg) {
  return createHash('sha256').update(canonical(prereg)).digest('hex');
}
