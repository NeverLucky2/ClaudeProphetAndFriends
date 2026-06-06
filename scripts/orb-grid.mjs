// scripts/orb-grid.mjs
// One-knob-at-a-time ORB sensitivity sweep (train-only, exploratory; never gates the verdict).
export function orbGridConfigs(primary, grid) {
  const cfgs = [{ label: 'primary', ...primary }];
  for (const v of grid.or_minutes) cfgs.push({ label: `or_${v}`, ...primary, or_minutes: v });
  for (const v of grid.target) cfgs.push({ label: `target_${v}`, ...primary, target: v });
  for (const v of grid.ema21_filter) cfgs.push({ label: `ema21_${v}`, ...primary, ema21_filter: v });
  for (const v of grid.vwap_filter) cfgs.push({ label: `vwap_${v}`, ...primary, vwap_filter: v });
  for (const v of grid.breakout_buffer_or_frac) cfgs.push({ label: `buffer_${v}`, ...primary, breakout_buffer_or_frac: v });
  return cfgs;
}
