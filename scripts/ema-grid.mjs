// scripts/ema-grid.mjs
// One-knob-at-a-time sensitivity sweep off the locked primary (limits forking paths).
// TRAIN-ONLY and exploratory: it never feeds the verdict.
export function gridConfigs(primary, grid) {
  const cfgs = [{ label: 'primary', ...primary }];
  for (const [f, s] of grid.ema_pairs) cfgs.push({ label: `ema_${f}_${s}`, ...primary, fast: f, slow: s });
  for (const w of grid.W) cfgs.push({ label: `W_${w}`, ...primary, W: w });
  for (const k of grid.kStop) cfgs.push({ label: `kStop_${k}`, ...primary, kStop: k });
  for (const k of grid.kTarget) cfgs.push({ label: `kTarget_${k}`, ...primary, kTarget: k });
  for (const m of grid.maxHold) cfgs.push({ label: `maxHold_${m}`, ...primary, maxHold: m });
  for (const w of grid.width_filter) cfgs.push({ label: `width_${w}`, ...primary, width_filter: w });
  for (const c of grid.cci) cfgs.push({ label: `cci_${c}`, ...primary, cci: c });
  return cfgs;
}
