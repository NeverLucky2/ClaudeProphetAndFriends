// Tests for preflight skip logic, focused on the economic-blackout integration
// added for the cross-agent blackout feature. Uses node:test (Node ≥ 20).
//
// Run: npm test  (or: node --test agent/preflight.test.mjs)

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

import {
  isEconomicBlackout,
  econBlackoutSkipIfNoPositions,
  isRegimeGateBlock,
  regimeGateBlockSkipIfNoPositions,
  resolvePreflight,
  positionCountFromResponse,
} from './preflight.js';

// ── helpers ────────────────────────────────────────────────────────

function makeRuntime(routes) {
  return {
    goAxios: {
      async get(url, _opts) {
        for (const [pattern, handler] of routes) {
          const match = typeof pattern === 'string' ? url === pattern : pattern.test(url);
          if (match) return handler(url);
        }
        throw new Error(`unmocked URL: ${url}`);
      },
    },
  };
}

const candidates = (count) => ({ data: { count } });
const byStrategy = (count) => ({ data: { count } });
const blackoutOn = (reason = 'CPI release at 2026-05-13 12:30 UTC') => ({
  data: { is_blackout: true, reason },
});
const blackoutOff = () => ({ data: { is_blackout: false } });

// Regime gate response shapes. The Go side returns the full status payload —
// preflight only cares about block_new_entries + tier (tier goes into the
// skip reason for operator visibility).
const regimeBlock = (tier = 'RED', score = 10) => ({
  data: {
    score,
    tier,
    sizing_multiplier: 0.0,
    block_new_entries: true,
  },
});
const regimeAllow = (tier = 'NORMAL', score = 60) => ({
  data: {
    score,
    tier,
    sizing_multiplier: 0.8,
    block_new_entries: false,
  },
});

// Turtle Go scheduler status helpers. When the scheduler is enabled in the Go
// process, the trend preflight kill switch fires unconditionally and skips
// the LLM beat. When the controller is absent (env flag off), the endpoint
// 404s; preflight catches and falls through to the existing logic.
const turtleStatusEnabled = () => ({ data: { scheduler_enabled: true, last_run: null } });
const turtleStatusDisabled404 = () => { const e = new Error('not found'); e.response = { status: 404 }; throw e; };

// ── positionCountFromResponse ──────────────────────────────────────
//
// /api/v1/positions[?strategy=] returns a PLAIN ARRAY (order_controller.go
// HandleGetPositions). Reading `.count` off it (the prior trend/prophet bug)
// always yields undefined. The helper reads array length and returns -1 for any
// non-array body so callers fail open on an ambiguous shape.

test('positionCountFromResponse: array length is the count', () => {
  assert.equal(positionCountFromResponse([]), 0);
  assert.equal(positionCountFromResponse([{ symbol: 'A' }, { symbol: 'B' }]), 2);
});

test('positionCountFromResponse: {count} object (old bug shape) → -1', () => {
  // The endpoint never returns this; the prior code assumed it did. Treat as
  // ambiguous so the caller fails open instead of trusting a phantom count.
  assert.equal(positionCountFromResponse({ count: 5 }), -1);
});

test('positionCountFromResponse: null/undefined → -1', () => {
  assert.equal(positionCountFromResponse(null), -1);
  assert.equal(positionCountFromResponse(undefined), -1);
});

// ── isEconomicBlackout ─────────────────────────────────────────────

test('isEconomicBlackout: returns blackout=true when service reports blackout', async () => {
  const rt = makeRuntime([['/api/v1/econ/blackout', () => blackoutOn('NFP release')]]);
  const r = await isEconomicBlackout(new Date(), rt);
  assert.equal(r.blackout, true);
  assert.match(r.reason, /NFP/);
});

test('isEconomicBlackout: returns blackout=false when service reports no blackout', async () => {
  const rt = makeRuntime([['/api/v1/econ/blackout', () => blackoutOff()]]);
  const r = await isEconomicBlackout(new Date(), rt);
  assert.equal(r.blackout, false);
});

test('isEconomicBlackout: fails open on axios error', async () => {
  const rt = makeRuntime([['/api/v1/econ/blackout', () => { throw new Error('ECONNREFUSED'); }]]);
  const r = await isEconomicBlackout(new Date(), rt);
  assert.equal(r.blackout, false, 'preflight must fail open');
  assert.match(r.error || '', /ECONNREFUSED/);
});

// ── econBlackoutSkipIfNoPositions ──────────────────────────────────

test('econBlackoutSkipIfNoPositions: returns null when positions exist (do not even check blackout)', async () => {
  let calledBlackout = false;
  const rt = makeRuntime([
    ['/api/v1/econ/blackout', () => { calledBlackout = true; return blackoutOn(); }],
  ]);
  const r = await econBlackoutSkipIfNoPositions(rt, 1);
  assert.equal(r, null);
  assert.equal(calledBlackout, false, 'should not call blackout endpoint when positions exist');
});

test('econBlackoutSkipIfNoPositions: returns skip:true when no positions and blackout', async () => {
  const rt = makeRuntime([['/api/v1/econ/blackout', () => blackoutOn('CPI release')]]);
  const r = await econBlackoutSkipIfNoPositions(rt, 0);
  assert.ok(r);
  assert.equal(r.skip, true);
  assert.match(r.reason, /econ blackout/);
  assert.match(r.reason, /CPI/);
});

test('econBlackoutSkipIfNoPositions: returns null when no positions but no blackout', async () => {
  const rt = makeRuntime([['/api/v1/econ/blackout', () => blackoutOff()]]);
  const r = await econBlackoutSkipIfNoPositions(rt, 0);
  assert.equal(r, null);
});

test('econBlackoutSkipIfNoPositions: returns null on endpoint error (fail-open in preflight)', async () => {
  const rt = makeRuntime([['/api/v1/econ/blackout', () => { throw new Error('boom'); }]]);
  const r = await econBlackoutSkipIfNoPositions(rt, 0);
  assert.equal(r, null, 'should fail open — predicate then runs normally');
});

// ── isRegimeGateBlock ──────────────────────────────────────────────

test('isRegimeGateBlock: returns block=true with tier when service reports block', async () => {
  const rt = makeRuntime([['/api/v1/regime-gate/status', () => regimeBlock('RED', 12)]]);
  const r = await isRegimeGateBlock(rt);
  assert.equal(r.block, true);
  assert.equal(r.tier, 'RED');
});

test('isRegimeGateBlock: returns block=false when service reports no block', async () => {
  const rt = makeRuntime([['/api/v1/regime-gate/status', () => regimeAllow('GREEN', 80)]]);
  const r = await isRegimeGateBlock(rt);
  assert.equal(r.block, false);
});

test('isRegimeGateBlock: fails open on axios error (preflight fail-open layer)', async () => {
  // Per the dual-layer fail policy: preflight fails OPEN on regime errors
  // (let the LLM run), the rules side fails CLOSED (LLM does not open new
  // entries when get_regime_gate_status returns an error). The combination
  // protects against silent breakage either way.
  const rt = makeRuntime([['/api/v1/regime-gate/status', () => { throw new Error('ECONNREFUSED'); }]]);
  const r = await isRegimeGateBlock(rt);
  assert.equal(r.block, false, 'preflight must fail open');
  assert.match(r.error || '', /ECONNREFUSED/);
});

test('isRegimeGateBlock: UNKNOWN tier (Go fail-open) is treated as not-blocking', async () => {
  // The Go service returns tier=UNKNOWN, block=false when the daily file is
  // missing. Preflight must not skip the LLM just because regime data is
  // absent — rules layer enforces the closed policy via get_regime_gate_status.
  const rt = makeRuntime([['/api/v1/regime-gate/status', () => ({
    data: { score: 0, tier: 'UNKNOWN', sizing_multiplier: 1.0, block_new_entries: false },
  })]]);
  const r = await isRegimeGateBlock(rt);
  assert.equal(r.block, false);
});

// ── regimeGateBlockSkipIfNoPositions ───────────────────────────────

test('regimeGateBlockSkipIfNoPositions: returns null when positions exist', async () => {
  // Positions-existing always wins. Exit logic must run during RED tier;
  // skipping when positions are open would orphan stop-loss management.
  let called = false;
  const rt = makeRuntime([
    ['/api/v1/regime-gate/status', () => { called = true; return regimeBlock(); }],
  ]);
  const r = await regimeGateBlockSkipIfNoPositions(rt, 3);
  assert.equal(r, null);
  assert.equal(called, false, 'should not even call the endpoint when positions exist');
});

test('regimeGateBlockSkipIfNoPositions: returns skip:true when no positions and tier=RED', async () => {
  const rt = makeRuntime([['/api/v1/regime-gate/status', () => regimeBlock('RED', 8)]]);
  const r = await regimeGateBlockSkipIfNoPositions(rt, 0);
  assert.equal(r.skip, true);
  assert.match(r.reason, /RED/);
});

test('regimeGateBlockSkipIfNoPositions: returns null when no positions but block=false', async () => {
  const rt = makeRuntime([['/api/v1/regime-gate/status', () => regimeAllow()]]);
  const r = await regimeGateBlockSkipIfNoPositions(rt, 0);
  assert.equal(r, null);
});

test('regimeGateBlockSkipIfNoPositions: returns null on endpoint error (fail-open)', async () => {
  const rt = makeRuntime([['/api/v1/regime-gate/status', () => { throw new Error('boom'); }]]);
  const r = await regimeGateBlockSkipIfNoPositions(rt, 0);
  assert.equal(r, null);
});

// Helper constants for frozen-time tests (used by prophet tests).
const ET_OPEN = Date.UTC(2026, 4, 21, 18, 30, 0);
const ET_CLOSED = Date.UTC(2026, 4, 22, 3, 8, 0);

async function withFrozenTime(epoch, fn) {
  mock.timers.enable({ apis: ['Date'], now: epoch });
  try {
    return await fn();
  } finally {
    mock.timers.reset();
  }
}

// ── trendPreflight kill switch ────────────────────────────────────
//
// When TURTLE_SCHEDULER_ENABLED=true, the Go service runs the full
// TRADING_RULES_TREND.md heartbeat sequence. The LLM beat is then
// unconditional dead weight — preflight must skip every beat regardless
// of time window, positions, or entry signals. When the env flag is off,
// the controller is not registered and the endpoint 404s; the kill switch
// must swallow that and let the existing logic run.

test('trend: scheduler enabled → skip with "scheduler enabled" reason', async () => {
  const rt = makeRuntime([
    ['/api/v1/turtle/status', turtleStatusEnabled],
  ]);
  const r = await resolvePreflight('trend', rt, {});
  assert.equal(r.skip, true);
  assert.match(r.reason, /Turtle Go scheduler enabled/);
});

test('trend: turtle/status 404 → falls through to existing window check', async () => {
  // Outside the 16:55-17:05 ET window → the existing window-skip wins.
  // The kill switch swallows the 404 and lets trendPreflight continue.
  //
  // We cannot easily fake the wall clock from this test, so we just check
  // that the result is SOMETHING (skip or run), NOT the scheduler-enabled
  // reason. This proves the kill switch fell through cleanly.
  const rt = makeRuntime([
    ['/api/v1/turtle/status', turtleStatusDisabled404],
    // Provide other routes so the function can complete without unmocked-URL errors.
    // /positions returns a PLAIN ARRAY (matches order_controller.go).
    [/^\/api\/v1\/positions\?strategy=trend/, () => ({ data: [] })],
    [/^\/api\/v1\/trend\/signal\//, () => ({ data: { last_close: 90, donchian_100_high: 95, sma_200: 88, atr_20: 1 } })],
    ['/api/v1/regime-gate/status', () => regimeAllow()],
    ['/api/v1/econ/blackout', () => blackoutOff()],
  ]);
  const r = await resolvePreflight('trend', rt, {});
  // Either out-of-window (most of the time), or in-window-no-signals, both fine.
  // The key assertion: it did NOT short-circuit on "scheduler enabled".
  assert.notEqual(r.reason, 'Turtle Go scheduler enabled — LLM beat unnecessary');
});

test('trend: turtle/status returns scheduler_enabled=false → falls through', async () => {
  // If someone hits the endpoint and it returns scheduler_enabled=false for
  // some reason (which shouldn't happen in this controller, but defensively),
  // the kill switch must NOT trip.
  const rt = makeRuntime([
    ['/api/v1/turtle/status', () => ({ data: { scheduler_enabled: false } })],
    [/^\/api\/v1\/positions\?strategy=trend/, () => ({ data: [] })],
    [/^\/api\/v1\/trend\/signal\//, () => ({ data: { last_close: 90, donchian_100_high: 95, sma_200: 88, atr_20: 1 } })],
    ['/api/v1/regime-gate/status', () => regimeAllow()],
    ['/api/v1/econ/blackout', () => blackoutOff()],
  ]);
  const r = await resolvePreflight('trend', rt, {});
  assert.notEqual(r.reason, 'Turtle Go scheduler enabled — LLM beat unnecessary');
});

// ── meanRevPreflight integration (Coil, strategy=mean-rev-rsi2) ─────
//
// /api/v1/positions?strategy=X returns a PLAIN ARRAY (order_controller.go),
// so positions are read via Array.isArray + .length — not a {count} object.

test('coil: no positions + no candidates → skip', async () => {
  const rt = makeRuntime([
    ['/api/v1/meanrev/candidates', () => candidates(0)],
    ['/api/v1/positions?strategy=mean-rev-rsi2', () => ({ data: [] })],
  ]);
  const r = await resolvePreflight('mean-rev-rsi2', rt, {});
  assert.equal(r.skip, true);
  assert.match(r.reason, /no positions and no.*candidate/i);
});

test('coil: open position + no candidates → run (exits must happen)', async () => {
  const rt = makeRuntime([
    ['/api/v1/meanrev/candidates', () => candidates(0)],
    ['/api/v1/positions?strategy=mean-rev-rsi2', () => ({ data: [{ symbol: 'AAPL', qty: 50 }] })],
  ]);
  const r = await resolvePreflight('mean-rev-rsi2', rt, {});
  assert.equal(r.skip, false);
  assert.match(r.reason, /position/i);
});

test('coil: candidates exist + regime allow + no blackout → run', async () => {
  const rt = makeRuntime([
    ['/api/v1/meanrev/candidates', () => candidates(2)],
    ['/api/v1/positions?strategy=mean-rev-rsi2', () => ({ data: [] })],
    ['/api/v1/regime-gate/status', () => regimeAllow()],
    ['/api/v1/econ/blackout', () => blackoutOff()],
  ]);
  const r = await resolvePreflight('mean-rev-rsi2', rt, {});
  assert.equal(r.skip, false);
  assert.match(r.reason, /candidate/i);
});

test('coil: candidates exist + regime RED + no positions → skip', async () => {
  const rt = makeRuntime([
    ['/api/v1/meanrev/candidates', () => candidates(2)],
    ['/api/v1/positions?strategy=mean-rev-rsi2', () => ({ data: [] })],
    ['/api/v1/regime-gate/status', () => regimeBlock('RED', 10)],
    ['/api/v1/econ/blackout', () => blackoutOff()],
  ]);
  const r = await resolvePreflight('mean-rev-rsi2', rt, {});
  assert.equal(r.skip, true);
  assert.match(r.reason, /regime gate RED/);
});

test('coil: candidates exist + econ blackout + no positions → skip', async () => {
  const rt = makeRuntime([
    ['/api/v1/meanrev/candidates', () => candidates(2)],
    ['/api/v1/positions?strategy=mean-rev-rsi2', () => ({ data: [] })],
    ['/api/v1/regime-gate/status', () => regimeAllow()],
    ['/api/v1/econ/blackout', () => blackoutOn('CPI release')],
  ]);
  const r = await resolvePreflight('mean-rev-rsi2', rt, {});
  assert.equal(r.skip, true);
  assert.match(r.reason, /econ blackout/);
});

test('coil: open position wins even at regime RED → run (exits not orphaned)', async () => {
  const rt = makeRuntime([
    ['/api/v1/meanrev/candidates', () => candidates(0)],
    ['/api/v1/positions?strategy=mean-rev-rsi2', () => ({ data: [{ symbol: 'MSFT', qty: 10 }] })],
    ['/api/v1/regime-gate/status', () => regimeBlock('RED', 8)],
    ['/api/v1/econ/blackout', () => blackoutOn('NFP release')],
  ]);
  const r = await resolvePreflight('mean-rev-rsi2', rt, {});
  assert.equal(r.skip, false);
});

test('coil: positions response wrong shape (object not array) → fail open (run)', async () => {
  const rt = makeRuntime([
    ['/api/v1/meanrev/candidates', () => candidates(0)],
    ['/api/v1/positions?strategy=mean-rev-rsi2', () => byStrategy(0)], // {data:{count}} — wrong
  ]);
  const r = await resolvePreflight('mean-rev-rsi2', rt, {});
  assert.equal(r.skip, false, 'ambiguous positions shape must fail open');
});

test('coil: candidates response wrong shape → fail open (run)', async () => {
  const rt = makeRuntime([
    ['/api/v1/meanrev/candidates', () => ({ data: { candidates: [] } })], // no numeric count
    ['/api/v1/positions?strategy=mean-rev-rsi2', () => ({ data: [] })],
  ]);
  const r = await resolvePreflight('mean-rev-rsi2', rt, {});
  assert.equal(r.skip, false);
});

// ── driftPreflight integration (Drift, strategy=earnings-drift) ─────

test('drift: no positions + no candidates → skip', async () => {
  const rt = makeRuntime([
    ['/api/v1/drift/candidates', () => candidates(0)],
    ['/api/v1/positions?strategy=earnings-drift', () => ({ data: [] })],
  ]);
  const r = await resolvePreflight('earnings-drift', rt, {});
  assert.equal(r.skip, true);
  assert.match(r.reason, /no positions and no.*candidate/i);
});

test('drift: open position + no candidates → run (exits must happen)', async () => {
  const rt = makeRuntime([
    ['/api/v1/drift/candidates', () => candidates(0)],
    ['/api/v1/positions?strategy=earnings-drift', () => ({ data: [{ symbol: 'NVDA', qty: 20 }] })],
  ]);
  const r = await resolvePreflight('earnings-drift', rt, {});
  assert.equal(r.skip, false);
  assert.match(r.reason, /position/i);
});

test('drift: candidates exist + regime allow + no blackout → run', async () => {
  const rt = makeRuntime([
    ['/api/v1/drift/candidates', () => candidates(1)],
    ['/api/v1/positions?strategy=earnings-drift', () => ({ data: [] })],
    ['/api/v1/regime-gate/status', () => regimeAllow()],
    ['/api/v1/econ/blackout', () => blackoutOff()],
  ]);
  const r = await resolvePreflight('earnings-drift', rt, {});
  assert.equal(r.skip, false);
  assert.match(r.reason, /candidate/i);
});

test('drift: candidates exist + regime RED + no positions → skip', async () => {
  const rt = makeRuntime([
    ['/api/v1/drift/candidates', () => candidates(1)],
    ['/api/v1/positions?strategy=earnings-drift', () => ({ data: [] })],
    ['/api/v1/regime-gate/status', () => regimeBlock('RED', 9)],
    ['/api/v1/econ/blackout', () => blackoutOff()],
  ]);
  const r = await resolvePreflight('earnings-drift', rt, {});
  assert.equal(r.skip, true);
  assert.match(r.reason, /regime gate RED/);
});

test('drift: candidates exist + econ blackout + no positions → skip', async () => {
  const rt = makeRuntime([
    ['/api/v1/drift/candidates', () => candidates(1)],
    ['/api/v1/positions?strategy=earnings-drift', () => ({ data: [] })],
    ['/api/v1/regime-gate/status', () => regimeAllow()],
    ['/api/v1/econ/blackout', () => blackoutOn('PCE release')],
  ]);
  const r = await resolvePreflight('earnings-drift', rt, {});
  assert.equal(r.skip, true);
  assert.match(r.reason, /econ blackout/);
});

test('drift: positions response wrong shape (object not array) → fail open (run)', async () => {
  const rt = makeRuntime([
    ['/api/v1/drift/candidates', () => candidates(0)],
    ['/api/v1/positions?strategy=earnings-drift', () => byStrategy(0)],
  ]);
  const r = await resolvePreflight('earnings-drift', rt, {});
  assert.equal(r.skip, false, 'ambiguous positions shape must fail open');
});

// ── prophetPreflight holding-skip integration (Task 6) ────────────
//
// Tests run under open-phase time (ET_OPEN = Thu 14:30 ET) to ensure the
// closed-phase branch of prophetPreflight is not taken. Time is frozen via
// withFrozenTime so these tests are deterministic regardless of wall clock.
//
// The runtime helper dispatches goAxios.get by URL prefix. sinceLastExitEvalMs
// is passed as opts (4th arg) to resolvePreflight — not read from runtime.

function makeProphetRuntime({ positions, signals, blackout = { is_blackout: false } }) {
  return {
    goAxios: {
      get: async (url) => {
        if (url.startsWith('/api/v1/positions')) return { data: positions };
        if (url.startsWith('/api/v1/intraday/signals')) {
          if (signals instanceof Error) throw signals;
          return { data: { signals } };
        }
        if (url.startsWith('/api/v1/econ/blackout')) return { data: blackout };
        if (url.startsWith('/api/v1/regime-gate/status')) return { data: { block_new_entries: false } };
        throw new Error(`unexpected url: ${url}`);
      },
    },
  };
}

const PROPHET_CFG = { strategyId: 'v2-options' };
const HELD = [{ Symbol: 'TSLA260529C00442500', UnrealizedPLPC: 5 }];
const quietSignals = [{ symbol: 'TSLA', dist_from_vwap_pct: 0.2, rvol: 1.0, range_over_atr: 0.7, day_change_pct: 0.5 }];

test('prophetPreflight holding: enabled + interior + quiet + fresh → skip', async () => {
  process.env.PROPHET_HOLDING_SKIP_ENABLED = 'true';
  const rt = makeProphetRuntime({ positions: HELD, signals: quietSignals });
  const r = await withFrozenTime(ET_OPEN, () =>
    resolvePreflight('v2-options', rt, PROPHET_CFG, { sinceLastExitEvalMs: 60_000 })
  );
  assert.equal(r.skip, true);
  assert.equal(r.gate, null);
  delete process.env.PROPHET_HOLDING_SKIP_ENABLED;
});

test('prophetPreflight holding: flag OFF → always runs (today behavior)', async () => {
  delete process.env.PROPHET_HOLDING_SKIP_ENABLED;
  const rt = makeProphetRuntime({ positions: HELD, signals: quietSignals });
  const r = await withFrozenTime(ET_OPEN, () =>
    resolvePreflight('v2-options', rt, PROPHET_CFG, { sinceLastExitEvalMs: 60_000 })
  );
  assert.equal(r.skip, false);
});

test('prophetPreflight holding: enabled but position near boundary → run', async () => {
  process.env.PROPHET_HOLDING_SKIP_ENABLED = 'true';
  const rt = makeProphetRuntime({
    positions: [{ Symbol: 'TSLA260529C00442500', UnrealizedPLPC: -12 }],
    signals: quietSignals,
  });
  const r = await withFrozenTime(ET_OPEN, () =>
    resolvePreflight('v2-options', rt, PROPHET_CFG, { sinceLastExitEvalMs: 60_000 })
  );
  assert.equal(r.skip, false);
  assert.equal(r.gate, 'near_stop');
  delete process.env.PROPHET_HOLDING_SKIP_ENABLED;
});

test('prophetPreflight holding: enabled but econ blackout → run', async () => {
  process.env.PROPHET_HOLDING_SKIP_ENABLED = 'true';
  const rt = makeProphetRuntime({
    positions: HELD,
    signals: quietSignals,
    blackout: { is_blackout: true, reason: 'CPI' },
  });
  const r = await withFrozenTime(ET_OPEN, () =>
    resolvePreflight('v2-options', rt, PROPHET_CFG, { sinceLastExitEvalMs: 60_000 })
  );
  assert.equal(r.skip, false);
  assert.equal(r.gate, 'econ_blackout');
  delete process.env.PROPHET_HOLDING_SKIP_ENABLED;
});

test('prophetPreflight holding: enabled, intraday fetch throws → run (fail toward run)', async () => {
  process.env.PROPHET_HOLDING_SKIP_ENABLED = 'true';
  const rt = makeProphetRuntime({ positions: HELD, signals: new Error('timeout') });
  const r = await withFrozenTime(ET_OPEN, () =>
    resolvePreflight('v2-options', rt, PROPHET_CFG, { sinceLastExitEvalMs: 60_000 })
  );
  assert.equal(r.skip, false);
  delete process.env.PROPHET_HOLDING_SKIP_ENABLED;
});

test('prophetPreflight flat (no positions) → existing flat path (skip false, regime ok)', async () => {
  process.env.PROPHET_HOLDING_SKIP_ENABLED = 'true';
  const rt = makeProphetRuntime({ positions: [], signals: [] });
  const r = await withFrozenTime(ET_OPEN, () =>
    resolvePreflight('v2-options', rt, PROPHET_CFG, { sinceLastExitEvalMs: 60_000 })
  );
  assert.equal(r.skip, false); // no regime block / no blackout → runs
  delete process.env.PROPHET_HOLDING_SKIP_ENABLED;
});

test('prophetPreflight holding: enabled + interior + quiet but stale (700s) → run, gate=staleness', async () => {
  process.env.PROPHET_HOLDING_SKIP_ENABLED = 'true';
  const rt = makeProphetRuntime({ positions: HELD, signals: quietSignals });
  const r = await withFrozenTime(ET_OPEN, () =>
    resolvePreflight('v2-options', rt, PROPHET_CFG, { sinceLastExitEvalMs: 700_000 })
  );
  assert.equal(r.skip, false);
  assert.equal(r.gate, 'staleness');
  delete process.env.PROPHET_HOLDING_SKIP_ENABLED;
});

test('prophetPreflight holding: enabled + interior + quiet but no sinceLastExitEvalMs (production-until-harness) → run, gate=staleness', async () => {
  // Bare opts (no sinceLastExitEvalMs) → defaults to Infinity in prophetPreflight
  // → staleness gate fires because !(Infinity < maxStalenessMs).
  process.env.PROPHET_HOLDING_SKIP_ENABLED = 'true';
  const rt = makeProphetRuntime({ positions: HELD, signals: quietSignals });
  const r = await withFrozenTime(ET_OPEN, () =>
    resolvePreflight('v2-options', rt, PROPHET_CFG, {})
  );
  assert.equal(r.skip, false);
  assert.equal(r.gate, 'staleness');
  delete process.env.PROPHET_HOLDING_SKIP_ENABLED;
});

test('prophetPreflight holding: enabled + interior + fresh but underlying active → run, gate=not_quiet', async () => {
  // TSLA signal has rvol=3.0 (> 2.0 threshold) → not quiet → run.
  process.env.PROPHET_HOLDING_SKIP_ENABLED = 'true';
  const activeSignals = [{ symbol: 'TSLA', dist_from_vwap_pct: 0.2, rvol: 3.0, range_over_atr: 0.7, day_change_pct: 0.5 }];
  const rt = makeProphetRuntime({ positions: HELD, signals: activeSignals });
  const r = await withFrozenTime(ET_OPEN, () =>
    resolvePreflight('v2-options', rt, PROPHET_CFG, { sinceLastExitEvalMs: 60_000 })
  );
  assert.equal(r.skip, false);
  assert.equal(r.gate, 'not_quiet');
  delete process.env.PROPHET_HOLDING_SKIP_ENABLED;
});

test('prophetPreflight holding: econ fetch REJECTS (throws) → skip:false (fail toward run)', async () => {
  // Core invariant: a degraded/throwing econ endpoint must never permit a skip.
  // makeProphetRuntime supports passing an Error as `blackout` — when the url
  // starts with /api/v1/econ/blackout it checks instanceof Error and throws.
  process.env.PROPHET_HOLDING_SKIP_ENABLED = 'true';
  const rt = {
    goAxios: {
      get: async (url) => {
        if (url.startsWith('/api/v1/positions')) return { data: HELD };
        if (url.startsWith('/api/v1/intraday/signals')) return { data: { signals: quietSignals } };
        if (url.startsWith('/api/v1/econ/blackout')) throw new Error('econ endpoint down');
        if (url.startsWith('/api/v1/regime-gate/status')) return { data: { block_new_entries: false } };
        throw new Error(`unexpected url: ${url}`);
      },
    },
  };
  const r = await withFrozenTime(ET_OPEN, () =>
    resolvePreflight('v2-options', rt, PROPHET_CFG, { sinceLastExitEvalMs: 60_000 })
  );
  assert.equal(r.skip, false, 'econ fetch throw must fail toward run, not skip');
  delete process.env.PROPHET_HOLDING_SKIP_ENABLED;
});

test('defensive-prophet: always skips (fully mechanical Go scheduler, no LLM beat)', async () => {
  // Makes no HTTP calls; an empty-route runtime proves it never touches the bot.
  const rt = makeRuntime([]);
  const r = await withFrozenTime(ET_OPEN, () => resolvePreflight('prophet-defensive', rt, {}));
  assert.equal(r.skip, true);
  assert.match(r.reason, /mechanical/i);
});

test('defensive-prophet: skips even at a closed-market time (no time/window dependence)', async () => {
  const rt = makeRuntime([]);
  const r = await withFrozenTime(ET_CLOSED, () => resolvePreflight('prophet-defensive', rt, {}));
  assert.equal(r.skip, true);
});
