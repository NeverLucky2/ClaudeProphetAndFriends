// scripts/overlay-prereg.mjs
// Pre-registration for the hedge-overlay study — sha256-hashed methodology block, written before scoring.
import { createHash } from 'node:crypto';

export function buildPrereg() {
  return {
    study: 'fleet-hedge-overlay',
    window: { start: '2016-01-01', end: '2026-06-06' },
    targets: ['reconstructed_merrill_book', 'QQQ'],
    candidates: ['def_prophet_proxy', 'static_GLD', 'static_TLT', 'static_VIXM'],
    size_grids: { static: [0.025, 0.05, 0.10, 0.15, 0.20], spread_premium: [0.005, 0.01, 0.02] },
    cost_metric: 'calm_period_non_crisis_drag',
    funding: { primary: 'cash_rf', conservative_bracket: 'book_funded_reallocation', read_against: 'conservative_bound' },
    cushion_metric: 'crisis_mean_contribution_paired_difference_bootstrap_CI',
    crisis: { definition: 'QQQ_worst_quintile', split: ['lumped', 'rate_shock', 'growth_scare'], rate_shock: 'top_decile_weekly_dy10_full_window' },
    episode_rule: 'subset_cushion_with_le_2_episodes_is_descriptive_CI_decorative',
    convex_candidates: ['def_prophet_proxy', 'static_VIXM'],
    convexity_guard: 'branch_a_not_winnable_by_convex_candidate_without_stress_corroboration',
    stress_shocks: [-0.10, -0.20, -0.30],
    bleed_budget_reference_pct_yr: 2,
    effective_n_floor: 8,
    decision_branches: ['a_robust_cheap_dominates', 'b_def_prophet_primary', 'c_honest_null'],
    data_wall_gate: { dropped_weight_threshold: 0.30, action: 'suppress_era_merrill_cuts' },
    acceptable_findings: [
      'a cheap static sleeve robustly cushions and is recommended',
      'only def-Prophet is regime-robust; activate it, statics as complements',
      'honest null: no static hedge worth adding; rely on def-Prophet, accept residual gap',
    ],
  };
}

function canonical(o) {
  if (Array.isArray(o)) return '[' + o.map(canonical).join(',') + ']';
  if (o && typeof o === 'object') return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}';
  return JSON.stringify(o);
}
export function hashPrereg(prereg) { return createHash('sha256').update(canonical(prereg)).digest('hex'); }
