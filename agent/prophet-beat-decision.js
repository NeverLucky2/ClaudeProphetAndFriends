// agent/prophet-beat-decision.js
// Pure decision logic for the Prophet (v2-options) bounded-staleness holding-beat
// skip + beat-context band labels. No I/O — the caller (preflight.js) fetches and
// passes data in. See docs/superpowers/specs/2026-05-27-prophet-beat-skip-enrich-design.md.

// OCC option symbol → underlying ticker. `TSLA260529C00442500` → `TSLA`. A plain
// stock symbol or anything that doesn't match the OCC layout passes through
// unchanged (the caller then finds no signal for it → treated as not-quiet → run).
export function occUnderlying(symbol) {
  if (typeof symbol !== 'string') return symbol;
  const m = symbol.match(/^([A-Z]+)\d{6}[CP]\d{8}$/);
  return m ? m[1] : symbol;
}

// Normalize a raw position P&L value to PERCENT units (e.g. 12 for +12%).
// Mirrors renderBeatContextBlock's existing interpretation of unrealized_pnl_pct
// (it renders `toFixed(1) + '%'`). ASSUMES the upstream value is already in
// percent. Task 6 includes a blocking step to verify this against a live
// position; if Alpaca's value arrives as a fraction (0.12), change the body to
// `return raw * 100;` — this is the single point of truth for the unit.
export function normalizePnlPct(raw) {
  return raw;
}

// Classify a position's P&L (percent units) relative to its band edges.
// Boundaries are inclusive on the actionable side: <= nearStopPct → near_stop,
// >= nearTargetPct → near_target, strictly between → interior. Non-finite → the
// actionable `near_stop` so the beat runs.
export function classifyBand(pnlPct, { nearStopPct, nearTargetPct }) {
  if (!Number.isFinite(pnlPct)) return 'near_stop';
  if (pnlPct <= nearStopPct) return 'near_stop';
  if (pnlPct >= nearTargetPct) return 'near_target';
  return 'interior';
}

// True only when every required intraday metric is present, finite, and under
// its threshold. A null/partial/NaN signal → false (not quiet → run). Mirrors
// the field names emitted by /api/v1/intraday/signals (see agent/intraday-prompt.js).
export function isUnderlyingQuiet(signal, thresholds) {
  if (!signal) return false;
  const vwap = Number(signal.dist_from_vwap_pct);
  const rvol = Number(signal.rvol);
  const rng = Number(signal.range_over_atr);
  const day = Number(signal.day_change_pct);
  if (![vwap, rvol, rng, day].every(Number.isFinite)) return false;
  return Math.abs(vwap) < thresholds.vwap
    && rvol < thresholds.rvol
    && rng < thresholds.rngAtr
    && Math.abs(day) < thresholds.dayPct;
}
