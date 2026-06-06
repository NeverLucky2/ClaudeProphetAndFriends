// scripts/cef-prereg.mjs
import { createHash } from 'node:crypto';

export function buildPrereg() {
  return {
    study: 'cef-discount-reversion',
    window: { start: '2021-01-01', end: '2026-06-06', grain: 'weekly', split: 'chronological_midpoint', regime_caveat: 'midpoint straddles 2022-23 rate-regime break; holdout interpreted with caveat; train-half reported alongside' },
    signal: { L: 52, z_enter: 1.5, exit: 'z>=0 OR 26w time stop', max_positions: 10, sizing: 'equal_weight_fixed_fractional', admission: 'most_negative_z_first' },
    return_basis: 'price_change_decomposed_navmove_vs_discountchange',
    yield_handling: 'descriptive_only_never_gated',
    friction: { half_spread_bps: { liquid: 25, mid: 50, thin: 100 }, round_trip: '2x_half_spread', stress: 2 },
    edge_gate: { basis: 'weekly_sleeve_price_change_net', block_weeks: 8, rule: 'holdout_CI_lower_bound>0' },
    orthogonality_gate: { qqq_beta_ci_near_0: true, crisis_mean_ci_not_below_0: true, lane_rho_max: 0.3, lanes: ['Coil', 'Turtle', 'Drift'] },
    checks: ['regime_chase', 'train_half_reported', 'independent_episode_count'],
    acceptable_findings: [
      'edge dies after CEF friction',
      'edge survives but carries equity-beta or co-crashes (not ballast)',
      'edge is NAV-drift or yield-carry not reversion',
      'genuinely orthogonal but no edge',
      'apparent edge is a survivorship artifact (false-KEEP direction)',
    ],
  };
}

function canonical(o) {
  if (Array.isArray(o)) return '[' + o.map(canonical).join(',') + ']';
  if (o && typeof o === 'object') return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}';
  return JSON.stringify(o);
}
export function hashPrereg(prereg) { return createHash('sha256').update(canonical(prereg)).digest('hex'); }
