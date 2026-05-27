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
  // Reject null/undefined fields BEFORE coercion: Number(null)===0 is finite and
  // would wrongly pass the threshold check for a missing-data signal.
  if (signal.dist_from_vwap_pct == null) return false;
  if (signal.rvol == null) return false;
  if (signal.range_over_atr == null) return false;
  if (signal.day_change_pct == null) return false;
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

function fmtPct(n) {
  if (!Number.isFinite(n)) return '?%';
  return `${n >= 0 ? '+' : ''}${n.toFixed(0)}%`;
}

// Pure skip decision for the holding case. Returns { skip, gate, reason } where
// gate is the first failing gate (or null when skip:true / flat). Gate order is
// deliberate: econ_blackout → staleness → near_stop/near_target → not_quiet.
// Every non-skip path is a "run the beat" outcome; the function only returns
// skip:true when ALL gates affirmatively clear with valid data and >=1 position.
export function decideHoldingSkip({
  positions, signalsByUnderlying, sinceLastExitEvalMs, maxStalenessMs, econBlackout, thresholds,
}) {
  if (!Array.isArray(positions) || positions.length === 0) {
    return { skip: false, gate: null, reason: 'no positions (flat path owns this)' };
  }
  // Treat any truthy value as blackout so future callers passing a non-boolean
  // (e.g. an object) still fail toward running the beat.
  if (econBlackout) {
    return { skip: false, gate: 'econ_blackout', reason: 'econ blackout — exits may need action' };
  }
  // `!(a < b)` rather than `a >= b` so a NaN staleness lands on run, not skip.
  if (!(sinceLastExitEvalMs < maxStalenessMs)) {
    return {
      skip: false, gate: 'staleness',
      reason: `staleness ${Math.round((sinceLastExitEvalMs || 0) / 60000)}m ≥ cap ${Math.round(maxStalenessMs / 60000)}m`,
    };
  }
  for (const p of positions) {
    const band = classifyBand(p.pnlPct, thresholds);
    if (band === 'near_stop') {
      return { skip: false, gate: 'near_stop', reason: `${p.symbol} near stop (${fmtPct(p.pnlPct)})` };
    }
    if (band === 'near_target') {
      return { skip: false, gate: 'near_target', reason: `${p.symbol} near target (${fmtPct(p.pnlPct)})` };
    }
  }
  for (const p of positions) {
    if (!isUnderlyingQuiet(signalsByUnderlying?.[p.underlying], thresholds)) {
      return { skip: false, gate: 'not_quiet', reason: `${p.underlying} active (not quiet)` };
    }
  }
  const bands = positions.map((p) => fmtPct(p.pnlPct)).join(', ');
  const names = [...new Set(positions.map((p) => p.underlying))].join('/');
  return {
    skip: true, gate: null,
    reason: `${positions.length} position(s) interior (${bands}), ${names} quiet, last exit-eval ${Math.round(sinceLastExitEvalMs / 60000)}m ago < ${Math.round(maxStalenessMs / 60000)}m cap`,
  };
}

// Read the skip config from env (defaults below). Enable flag is exact-"true"
// only (matches FILLS_SUMMARY_ENABLED / BEAT_CONTEXT_ENABLED convention).
export function loadSkipConfig(env = process.env) {
  const num = (v, d) => {
    if (v == null || v === '') return d;
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  return {
    enabled: env.PROPHET_HOLDING_SKIP_ENABLED === 'true',
    maxStalenessMs: num(env.PROPHET_SKIP_MAX_STALENESS_MIN, 6) * 60 * 1000,
    thresholds: {
      nearStopPct: num(env.PROPHET_SKIP_NEAR_STOP_PCT, -10),
      nearTargetPct: num(env.PROPHET_SKIP_NEAR_TARGET_PCT, 30),
      vwap: num(env.PROPHET_SKIP_QUIET_VWAP_PCT, 1.5),
      rvol: num(env.PROPHET_SKIP_QUIET_RVOL, 2.0),
      rngAtr: num(env.PROPHET_SKIP_QUIET_RNG_ATR, 1.5),
      dayPct: num(env.PROPHET_SKIP_QUIET_DAY_PCT, 4.0),
    },
  };
}
