// scripts/carry-prereg.mjs
import { createHash } from 'node:crypto';
import {
  TRAIN_END, HOLDOUT_START, STUDY_END, MOD_DUR, ROLL_FROM, ROLL_TO, CASH_FIELD,
  EDGE_BLOCK_WEEKS, FRICTION_HALF_SPREAD_BPS,
} from './carry-universe.mjs';

export function buildPrereg() {
  return {
    study: 'bond-carry-rolldown',
    window: { fetch_from: '2002-07', train_end: TRAIN_END, holdout_start: HOLDOUT_START, end: STUDY_END,
      train_role: 'diagnostic_only_threshold_binding_fraction', holdout_role: 'all_gate_evaluation' },
    signal: { source: 'fmp_treasury_curve_shape_not_price', formula: 'y10 + ModDur*(y10-y7) - m3',
      mod_dur: MOD_DUR, roll_from: ROLL_FROM, roll_to: ROLL_TO, cash: CASH_FIELD,
      primary_rule: 'sign(carry_roll)>0', buffer_grid_bps: [25, 50], buffer_role: 'robustness_only',
      twin: 'term_spread_y10_minus_m3_no_ModDur', twin_rule: 'verdict_disagreement_downgrades_KEEP_to_INCONCLUSIVE',
      rebalance: 'monthly' },
    universe: { duration_leg: 'IEF', out_leg: 'cash_accrued_m3_zero_vol' },
    friction: { half_spread_bps: FRICTION_HALF_SPREAD_BPS, basis: 'round_trip_on_exit', stress: 2 },
    edge_gate: {
      ballast_graded: true,
      a_friction_net_holdout_ci_gt_0: { block_weeks: EDGE_BLOCK_WEEKS },
      b_dodge_check: 'DESCRIPTIVE_not_CI: rate-shock weeks = top-decile weekly d(y10); report cash-fraction + vs buy-hold IEF; bootstrap decorative; KEEP-on-edge requires cash through the 2022 drawdown as dated fact',
      c_2x_friction_stress: true,
      power_flag_on_b: 'independent_rate_shock_episode_count',
    },
    orthogonality_gate: {
      qqq_beta_ci_near_0: true, qqq_rho_max: 0.3, crisis_mean_ci_not_below_0: true,
      lane_rho_max: 0.3, lanes: ['Coil', 'Turtle', 'Drift', 'DefProxy'],
      turtle_rates_rho_max: 0.3, turtle_rates_rho_reported: 'all_weeks_AND_co_active_weeks',
    },
    steepening_cut: 'DESCRIPTIVE: classify each held episode bull vs bear by sign of d(y10) over the hold; report tail behavior per regime; downgrades confidence in a KEEP if ballast reading is bull-steepening-only',
    verdict: { keep_requires: 'gate2_pass AND dodge-narrative-shows-cash-through-2022 AND twin-agrees',
      keep_confidence: 'provisional_pending_more_regimes', reject_trustworthy: 'gate2_full_series_well_powered' },
    acceptable_findings: [
      'co-moves with Turtle-rates (different hat) -> REJECT (base case)',
      'too few independent rate regimes -> INCONCLUSIVE',
      'monthly signal lags the turn, still long duration into 2022 -> fails dodge',
      'genuinely orthogonal AND dodges 2022 -> provisional KEEP',
      'twin disagreement -> INCONCLUSIVE',
    ],
  };
}

function canonical(o) {
  if (Array.isArray(o)) return '[' + o.map(canonical).join(',') + ']';
  if (o && typeof o === 'object') return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}';
  return JSON.stringify(o);
}
export function hashPrereg(prereg) { return createHash('sha256').update(canonical(prereg)).digest('hex'); }
