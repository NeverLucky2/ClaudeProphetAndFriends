// Pre-flight skip registry.
//
// Each entry is an async function `(runtime, agentConfig) -> { skip, reason }`.
// When skip=true, the harness logs a beat_skip event and bypasses the LLM
// invocation for this heartbeat. When skip=false, the heartbeat proceeds
// normally.
//
// Strategies not registered here always run their LLM beat. The empty
// registry is the safe default — adding the wiring without registering any
// predicates is a no-op.
//
// See docs/preflight-skip-spec.md for the full design.

import { isMarketHoliday } from './market-calendar.js';
import {
  occUnderlying, normalizePnlPct, decideHoldingSkip, loadSkipConfig,
} from './prophet-beat-decision.js';

// isEconomicBlackout queries /api/v1/econ/blackout for the shared US-release
// blackout window (30 min before / 15 min after CPI, NFP, FOMC, PCE, PPI,
// core retail). Fails open: any error → { blackout: false, error } so the
// predicate runs the LLM beat. The LLM then sees the error via
// get_econ_blackout_status and applies the rules-side fail-closed policy
// (no new entries when the source is flaky).
//
// Uses a 1500ms inner timeout so a slow blackout endpoint doesn't consume
// the full 2s budget of the surrounding resolvePreflight Promise.race.
export async function isEconomicBlackout(_now, runtime) {
  if (!runtime || !runtime.goAxios) {
    return { blackout: false, error: 'no runtime' };
  }
  try {
    const resp = await runtime.goAxios.get('/api/v1/econ/blackout', { timeout: 1500 });
    const body = resp?.data || {};
    if (body.is_blackout === true) {
      return { blackout: true, reason: body.reason || 'econ blackout' };
    }
    if (body.error) {
      return { blackout: false, error: body.error };
    }
    return { blackout: false };
  } catch (err) {
    return { blackout: false, error: err.message };
  }
}

// econBlackoutSkipIfNoPositions returns a {skip:true, reason} object when the
// strategy has zero live positions AND we are in an econ blackout, otherwise
// null. Predicates call this AFTER they've decided they would otherwise run.
//
// Positions-existing always wins: exit-management beats must run during a
// blackout. Endpoint errors fail open here (null) so the predicate proceeds.
export async function econBlackoutSkipIfNoPositions(runtime, livePositionCount) {
  if (livePositionCount > 0) return null;
  const econ = await isEconomicBlackout(new Date(), runtime);
  if (econ.blackout) {
    return {
      skip: true,
      reason: `econ blackout: ${econ.reason} (no positions to manage)`,
    };
  }
  return null;
}

// isRegimeGateBlock queries /api/v1/regime-gate/status for the daily-computed
// cross-agent regime tier. Returns {block, tier?, error?}. block=true means
// tier=RED with enforcement on (scores < 20 plus ENABLE_REGIME_GATE=true).
//
// Fail-open at the preflight layer (per the dual-layer policy in
// memory/architectural-patterns.md): on any error or unparseable response,
// return block:false so the LLM beat runs. The rules side fails CLOSED —
// agents are told not to open new entries when get_regime_gate_status
// returns an error or tier=UNKNOWN.
//
// 1500ms inner timeout matches isEconomicBlackout so it doesn't consume the
// full 2s resolvePreflight budget when stacked.
export async function isRegimeGateBlock(runtime) {
  if (!runtime || !runtime.goAxios) {
    return { block: false, error: 'no runtime' };
  }
  try {
    const resp = await runtime.goAxios.get('/api/v1/regime-gate/status', { timeout: 1500 });
    const body = resp?.data || {};
    if (body.block_new_entries === true) {
      return { block: true, tier: body.tier || 'RED' };
    }
    return { block: false, tier: body.tier };
  } catch (err) {
    return { block: false, error: err.message };
  }
}

// regimeGateBlockSkipIfNoPositions mirrors econBlackoutSkipIfNoPositions:
// when an agent has no positions AND the regime tier is RED with enforcement
// on, skip the LLM beat — the LLM can't open new entries anyway and exit
// logic has nothing to manage.
//
// Positions-existing always wins (early return without hitting the
// endpoint). Endpoint errors fail open (null).
export async function regimeGateBlockSkipIfNoPositions(runtime, livePositionCount) {
  if (livePositionCount > 0) return null;
  const regime = await isRegimeGateBlock(runtime);
  if (regime.block) {
    return {
      skip: true,
      reason: `regime gate ${regime.tier || 'RED'}: new entries blocked (no positions to manage)`,
    };
  }
  return null;
}

// Reads the open-position count from a /api/v1/positions[?strategy=] response.
// That endpoint returns a PLAIN ARRAY (order_controller.go HandleGetPositions),
// NOT a {count} object — every predicate must read it via array length. Returns
// -1 for any non-array (ambiguous) body so callers fail open instead of trusting
// a phantom count.
export function positionCountFromResponse(data) {
  return Array.isArray(data) ? data.length : -1;
}



// isClosedPhase returns { closed, reason } for a given Date. Mirrors the
// 'closed' bucket from harness.js getCurrentPhase(): weekends, full-close
// market holidays, OR weekdays before 04:00 ET (240 min), OR weekdays at/after
// 20:00 ET (1200 min). The holiday list is shared via market-calendar.js.
//
// Duplicated from harness.js to avoid an import cycle (harness.js imports
// from preflight.js). Same pattern as outOfTrendWindow below. If the phase
// boundaries in harness.js PHASE_DEFAULTS change, update this function too.
export function isClosedPhase(now) {
  const day = now.getDay();
  if (day === 0 || day === 6) {
    return { closed: true, reason: 'weekend' };
  }
  if (isMarketHoliday(now)) {
    return { closed: true, reason: 'market holiday' };
  }
  const etTime = now.toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const [h, m] = etTime.split(':').map(Number);
  const mins = h * 60 + m;
  if (mins < 240) {
    return { closed: true, reason: `${etTime} ET — overnight (pre-4am)` };
  }
  if (mins >= 1200) {
    return { closed: true, reason: `${etTime} ET — overnight (post-8pm)` };
  }
  return { closed: false, reason: '' };
}

// Prophet predicate. Only considers skipping during the 'closed' phase
// (overnight 8pm-4am ET on weekdays + full weekends). All other phases
// always run the LLM because Prophet's mandates depend on them.
//
// Uses /api/v1/positions?strategy=v2-options so co-located agents on a
// shared Alpaca account (e.g., TrendProphet) don't keep
// Prophet awake. Attribution is derived from each position's most recent
// buy order's strategy tag (see HandleGetPositions). The open-orders check
// from the prior implementation is dropped: during 'closed' phase the
// broker is shut, partial fills can't occur, and day orders are
// auto-canceled by Alpaca at close.
async function prophetPreflight(runtime, agentConfig, opts = {}) {
  const phase = isClosedPhase(new Date());
  const { goAxios } = runtime;

  if (phase.closed) {
    const positionsResp = await goAxios.get('/api/v1/positions?strategy=v2-options');
    const positionCount = positionCountFromResponse(positionsResp.data);
    if (positionCount < 0) {
      return { skip: false, reason: 'positions response shape unexpected' };
    }
    if (positionCount === 0) {
      return {
        skip: true,
        reason: `closed phase (${phase.reason}), no v2-options positions`,
      };
    }
    return { skip: false, reason: `${positionCount} open position(s) to evaluate` };
  }

  // Open phase. Flat → existing regime/econ gating (unchanged).
  const positionsResp = await goAxios.get('/api/v1/positions?strategy=v2-options');
  const positionCount = positionCountFromResponse(positionsResp.data);
  if (positionCount < 0) {
    return { skip: false, reason: 'positions response shape unexpected' };
  }
  if (positionCount === 0) {
    const regimeSkip = await regimeGateBlockSkipIfNoPositions(runtime, 0);
    if (regimeSkip) return regimeSkip;
    const econSkip = await econBlackoutSkipIfNoPositions(runtime, 0);
    if (econSkip) return econSkip;
    return { skip: false, reason: 'phase active — Prophet runs (flat)' };
  }

  // Holding case — bounded-staleness skip (flag-gated, default OFF). When OFF,
  // behaves exactly as before: open positions always run.
  const cfg = loadSkipConfig();
  if (!cfg.enabled) {
    return { skip: false, reason: `${positionCount} open position(s) to evaluate` };
  }

  const positions = positionsResp.data.map((p) => ({
    symbol: p.Symbol,
    underlying: occUnderlying(p.Symbol),
    pnlPct: normalizePnlPct(Number(p.UnrealizedPLPC)),
  }));
  const underlyings = [...new Set(positions.map((p) => p.underlying))];

  // Fetch intraday signals (held names) + econ blackout concurrently. Both fail
  // TOWARD running: signal timeout → empty (not quiet → run); econ timeout/error
  // → treat as blackout → run. isEconomicBlackout has its own 1500ms inner
  // timeout; the outer PREFLIGHT_TIMEOUT_MS race is the real backstop and also
  // fails toward run.
  const [sigSettled, econSettled] = await Promise.allSettled([
    goAxios.get(`/api/v1/intraday/signals?symbols=${encodeURIComponent(underlyings.join(','))}`, { timeout: 800 }),
    isEconomicBlackout(new Date(), runtime),
  ]);

  const signalsByUnderlying = {};
  if (sigSettled.status === 'fulfilled' && Array.isArray(sigSettled.value?.data?.signals)) {
    for (const s of sigSettled.value.data.signals) signalsByUnderlying[s.symbol] = s;
  }
  const econBlackout = econSettled.status !== 'fulfilled'
    || econSettled.value?.blackout === true
    || econSettled.value?.error != null;

  const decision = decideHoldingSkip({
    positions,
    signalsByUnderlying,
    sinceLastExitEvalMs: Number.isFinite(opts?.sinceLastExitEvalMs) ? opts.sinceLastExitEvalMs : Infinity,
    maxStalenessMs: cfg.maxStalenessMs,
    econBlackout,
    thresholds: cfg.thresholds,
  });
  return { skip: decision.skip, reason: decision.reason, gate: decision.gate };
}

const TREND_UNIVERSE = ['TLT', 'GLD', 'USO', 'DBC', 'UUP', 'EEM'];
const TREND_WINDOW_START_MIN = 16 * 60 + 55; // 16:55 ET
const TREND_WINDOW_END_MIN   = 17 * 60 + 5;  // 17:05 ET

// outOfTrendWindow returns { out, reason } for a given Date. Extracted so
// tests can drive it with arbitrary timestamps without mocking Date globally.
export function outOfTrendWindow(now) {
  const day = now.getDay();
  if (day === 0 || day === 6) {
    return { out: true, reason: 'weekend (TrendProphet runs weekdays only)' };
  }
  if (isMarketHoliday(now)) {
    return { out: true, reason: 'market holiday (TrendProphet runs trading days only)' };
  }
  const etTime = now.toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const [h, m] = etTime.split(':').map(Number);
  const mins = h * 60 + m;
  if (mins < TREND_WINDOW_START_MIN || mins > TREND_WINDOW_END_MIN) {
    return { out: true, reason: `out of window (${etTime} ET; runs 16:55-17:05 only)` };
  }
  return { out: false, reason: '' };
}

// TrendProphet predicate. Skips the LLM beat when:
//  (a) it is outside the 16:55-17:05 ET window (cheap; no API calls), OR
//  (b) it is in window but there are no open trend positions and no universe
//      ticker shows an entry signal.
//
// Uses /api/v1/positions?strategy=trend so co-located agents on a shared
// Alpaca account don't keep TrendProphet awake. Attribution is derived from
// each position's most recent buy order's strategy tag.
async function trendPreflight(runtime, agentConfig) {
  // Kill switch: when the Turtle Go scheduler is running (TURTLE_SCHEDULER_ENABLED=true,
  // surfaced via /api/v1/turtle/status), the LLM beat has nothing to do — the
  // scheduler executes the full TRADING_RULES_TREND.md heartbeat deterministically.
  // The LLM remains configured only for the quarterly trend_parameter_review skill.
  //
  // Fail open on endpoint error (404 when the flag is off, network error otherwise)
  // so the LLM beat continues to run as today. The check carries an 800ms timeout
  // so a hung Go process can't stall the harness.
  try {
    const schedResp = await runtime.goAxios.get('/api/v1/turtle/status', { timeout: 800 });
    if (schedResp?.data?.scheduler_enabled === true) {
      return { skip: true, reason: 'Turtle Go scheduler enabled — LLM beat unnecessary' };
    }
  } catch (_err) {
    // 404 (controller not registered) or any other error → fall through to the
    // existing in-window/positions/signals logic. The kill switch should never
    // wedge the agent.
  }

  // Step 1 — time window. Skips the bulk of beats without any API calls.
  const window = outOfTrendWindow(new Date());
  if (window.out) {
    return { skip: true, reason: window.reason };
  }

  // Step 2 — in window. Check trend-attributed positions first; if any exist,
  // the agent must run to evaluate exit rules.
  const { goAxios } = runtime;
  const positionsResp = await goAxios.get('/api/v1/positions?strategy=trend');
  const positionCount = positionCountFromResponse(positionsResp.data);
  if (positionCount < 0) {
    return { skip: false, reason: 'positions response shape unexpected' };
  }
  if (positionCount > 0) {
    return { skip: false, reason: `${positionCount} open position(s) to evaluate` };
  }

  // Step 3 — no positions. Check if any universe ticker has a fresh entry
  // signal (close > Donchian-100 high, close > SMA-200, ATR/close >= 0.5%).
  // If any signal call fails, the error propagates to resolvePreflight which
  // catches it and fails open (runs the LLM).
  const signals = await Promise.all(
    TREND_UNIVERSE.map(ticker =>
      goAxios.get(`/api/v1/trend/signal/${ticker}`).then(r => r.data)
    )
  );
  const hasEntrySignal = signals.some(s =>
    s
    && typeof s.last_close === 'number'
    && typeof s.donchian_100_high === 'number'
    && typeof s.sma_200 === 'number'
    && typeof s.atr_20 === 'number'
    && s.last_close > s.donchian_100_high
    && s.last_close > s.sma_200
    && (s.atr_20 / s.last_close) >= 0.005
  );
  if (!hasEntrySignal) {
    return {
      skip: true,
      reason: 'in window, no positions, no entry signals across 6-ticker universe',
    };
  }

  // Regime gate (no positions branch — positions>0 already returned above).
  const regimeSkip = await regimeGateBlockSkipIfNoPositions(runtime, 0);
  if (regimeSkip) return regimeSkip;

  // Econ blackout (no positions branch — positions>0 already returned above).
  const econSkip = await econBlackoutSkipIfNoPositions(runtime, 0);
  if (econSkip) return econSkip;

  return { skip: false, reason: 'in window, entry signal available' };
}

// Coil predicate (mean-rev-rsi2). Coil fires once per trading day at 15:45 ET
// via an exclusive scheduledBeats window, so this only runs once daily — it
// skips the single beat on days with nothing to do.
//
// Skips when there are no strategy-attributed open positions AND no entry
// candidates. When candidates exist but there are no positions, the regime
// gate (RED block) and econ blackout still apply — TRADING_RULES_MEANREV.md
// blocks new entries during a RED tier or an econ blackout, so with nothing to
// manage the beat has no work either way.
//
// Positions are read from /api/v1/positions?strategy=mean-rev-rsi2, which
// returns a PLAIN ARRAY (order_controller.go HandleGetPositions) — hence the
// Array.isArray check + .length, not a {count} object. An open position always
// wins (exit-rule evaluation must run). Ambiguous shapes fail open.
async function meanRevPreflight(runtime, agentConfig) {
  return candidatesAndPositionsPreflight(runtime, {
    candidatesUrl: '/api/v1/meanrev/candidates',
    positionsUrl: '/api/v1/positions?strategy=mean-rev-rsi2',
    noWorkReason: 'no positions and no RSI(2) entry candidates',
    label: 'meanrev',
  });
}

// Drift predicate (earnings-drift). Drift fires once per trading day at 17:00
// ET via an exclusive scheduledBeats window. Same structure as Coil:
// TRADING_RULES_DRIFT.md blocks new entries during a RED regime tier or an
// econ blackout, so with no positions to manage the beat is skippable.
async function driftPreflight(runtime, agentConfig) {
  return candidatesAndPositionsPreflight(runtime, {
    candidatesUrl: '/api/v1/drift/candidates',
    positionsUrl: '/api/v1/positions?strategy=earnings-drift',
    noWorkReason: 'no positions and no grade A/B drift candidates',
    label: 'drift',
  });
}

// Shared body for the once-daily mechanical equity agents (Coil, Drift). Both
// expose a candidates endpoint returning a top-level numeric `count` (already
// filtered to entry-qualifying names) and attribute managed positions by
// strategy id. The decision order mirrors trendPreflight: positions → empty
// candidates → regime gate → econ blackout.
async function candidatesAndPositionsPreflight(runtime, { candidatesUrl, positionsUrl, noWorkReason, label }) {
  const { goAxios } = runtime;
  const [candidatesResp, positionsResp] = await Promise.all([
    goAxios.get(candidatesUrl),
    goAxios.get(positionsUrl),
  ]);

  // Ambiguous responses fail open (run the LLM) rather than guessing "0".
  if (typeof candidatesResp.data?.count !== 'number') {
    return { skip: false, reason: `${label} candidates response shape unexpected` };
  }
  const positionCount = positionCountFromResponse(positionsResp.data);
  if (positionCount < 0) {
    return { skip: false, reason: 'positions response shape unexpected' };
  }

  const candidateCount = candidatesResp.data.count;

  // Open positions require exit-rule evaluation each beat — never skip them.
  if (positionCount > 0) {
    return { skip: false, reason: `${positionCount} open position(s) to evaluate` };
  }

  if (candidateCount === 0) {
    return { skip: true, reason: noWorkReason };
  }

  // No positions, candidates present. Rules block new entries during RED
  // regime / econ blackout, so skip those days.
  const regimeSkip = await regimeGateBlockSkipIfNoPositions(runtime, 0);
  if (regimeSkip) return regimeSkip;
  const econSkip = await econBlackoutSkipIfNoPositions(runtime, 0);
  if (econSkip) return econSkip;

  return { skip: false, reason: `${candidateCount} entry candidate(s) available` };
}

// defensiveProphetPreflight always skips the LLM beat. defensive-Prophet is
// 100% mechanical: the Go scheduler (ENABLE_PROPHET_DEFENSIVE) executes the
// entire strategy and there is no quarterly review, so the LLM has nothing to
// do on any beat. The agent shell exists only to host the sandbox/bot. Returns
// immediately with no I/O (cheaper than Turtle's status-endpoint check, which
// is unnecessary here since there's no LLM fallback behavior to gate).
async function defensiveProphetPreflight(_runtime, _agentConfig) {
  return { skip: true, reason: 'defensive-Prophet is fully mechanical (Go scheduler) — LLM beat unnecessary' };
}

export const PREFLIGHT_REGISTRY = {
  'trend':            trendPreflight,
  'v2-options':       prophetPreflight,
  'mean-rev-rsi2':    meanRevPreflight,
  'earnings-drift':   driftPreflight,
  'prophet-defensive': defensiveProphetPreflight,
};

const PREFLIGHT_TIMEOUT_MS = 2000;

export async function resolvePreflight(strategyId, runtime, agentConfig, opts = {}) {
  if (!strategyId) return { skip: false, reason: 'no strategy id on agent config' };
  const fn = PREFLIGHT_REGISTRY[strategyId];
  if (!fn) return { skip: false, reason: 'no preflight registered' };
  if (!runtime) return { skip: false, reason: 'no runtime available to predicate' };

  try {
    const result = await Promise.race([
      fn(runtime, agentConfig, opts),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`preflight timeout after ${PREFLIGHT_TIMEOUT_MS}ms`)), PREFLIGHT_TIMEOUT_MS)
      ),
    ]);
    if (typeof result?.skip !== 'boolean') {
      return { skip: false, reason: 'preflight returned invalid shape' };
    }
    return { skip: result.skip, reason: result.reason || '', gate: result.gate ?? null };
  } catch (err) {
    return { skip: false, reason: `preflight error: ${err.message}`, gate: null };
  }
}
