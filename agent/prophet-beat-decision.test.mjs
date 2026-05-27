// agent/prophet-beat-decision.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { occUnderlying } from './prophet-beat-decision.js';
import { classifyBand, normalizePnlPct } from './prophet-beat-decision.js';
import { isUnderlyingQuiet } from './prophet-beat-decision.js';
import { decideHoldingSkip } from './prophet-beat-decision.js';
import { loadSkipConfig } from './prophet-beat-decision.js';

test('occUnderlying extracts the underlying from an OCC option symbol', () => {
  assert.equal(occUnderlying('TSLA260529C00442500'), 'TSLA');
  assert.equal(occUnderlying('NVDA260619P00130000'), 'NVDA');
  assert.equal(occUnderlying('F260529C00012000'), 'F'); // single-letter root
});

test('occUnderlying passes through plain stock symbols and malformed input', () => {
  assert.equal(occUnderlying('AAPL'), 'AAPL');
  assert.equal(occUnderlying(''), '');
  assert.equal(occUnderlying(null), null);
  assert.equal(occUnderlying(undefined), undefined);
});

const BANDS = { nearStopPct: -10, nearTargetPct: 30 };

test('classifyBand: inclusive on the actionable side', () => {
  assert.equal(classifyBand(-10, BANDS), 'near_stop');     // exactly the edge → near_stop
  assert.equal(classifyBand(-10.0001, BANDS), 'near_stop');
  assert.equal(classifyBand(-9.9999, BANDS), 'interior');  // just inside → interior
  assert.equal(classifyBand(30, BANDS), 'near_target');    // exactly the edge → near_target
  assert.equal(classifyBand(29.9999, BANDS), 'interior');
  assert.equal(classifyBand(0, BANDS), 'interior');
  assert.equal(classifyBand(-15, BANDS), 'near_stop');     // past the rule stop, still actionable
  assert.equal(classifyBand(40, BANDS), 'near_target');
});

test('classifyBand: non-finite P&L is treated as actionable (fail toward running)', () => {
  assert.equal(classifyBand(NaN, BANDS), 'near_stop');
  assert.equal(classifyBand(undefined, BANDS), 'near_stop');
});

test('normalizePnlPct returns percent units unchanged (see Task 6 verification)', () => {
  assert.equal(normalizePnlPct(12), 12);
  assert.equal(normalizePnlPct(-15), -15);
});

const T = { vwap: 1.5, rvol: 2.0, rngAtr: 1.5, dayPct: 4.0 };
const quietSig = { dist_from_vwap_pct: 0.3, rvol: 1.1, range_over_atr: 0.8, day_change_pct: 1.2 };

test('isUnderlyingQuiet: all metrics under threshold → quiet', () => {
  assert.equal(isUnderlyingQuiet(quietSig, T), true);
  assert.equal(isUnderlyingQuiet({ ...quietSig, dist_from_vwap_pct: -0.9 }, T), true); // abs()
});

test('isUnderlyingQuiet: any single breach → not quiet', () => {
  assert.equal(isUnderlyingQuiet({ ...quietSig, dist_from_vwap_pct: 2.0 }, T), false);
  assert.equal(isUnderlyingQuiet({ ...quietSig, rvol: 2.5 }, T), false);
  assert.equal(isUnderlyingQuiet({ ...quietSig, range_over_atr: 1.9 }, T), false);
  assert.equal(isUnderlyingQuiet({ ...quietSig, day_change_pct: -5.0 }, T), false); // abs()
});

test('isUnderlyingQuiet: missing/partial/NaN signal → not quiet (fail toward running)', () => {
  assert.equal(isUnderlyingQuiet(null, T), false);
  assert.equal(isUnderlyingQuiet(undefined, T), false);
  assert.equal(isUnderlyingQuiet({ ...quietSig, rvol: undefined }, T), false);
  assert.equal(isUnderlyingQuiet({ ...quietSig, day_change_pct: 'x' }, T), false);
});

const THRESH = { nearStopPct: -10, nearTargetPct: 30, vwap: 1.5, rvol: 2.0, rngAtr: 1.5, dayPct: 4.0 };
const sig = (o = {}) => ({ dist_from_vwap_pct: 0.2, rvol: 1.0, range_over_atr: 0.7, day_change_pct: 0.5, ...o });
const base = {
  positions: [{ symbol: 'TSLA260529C00442500', underlying: 'TSLA', pnlPct: 5 }],
  signalsByUnderlying: { TSLA: sig() },
  sinceLastExitEvalMs: 60_000,
  maxStalenessMs: 360_000,
  econBlackout: false,
  thresholds: THRESH,
};

test('decideHoldingSkip: interior + quiet + fresh + no blackout → skip', () => {
  const d = decideHoldingSkip(base);
  assert.equal(d.skip, true);
  assert.equal(d.gate, null);
});

test('decideHoldingSkip: empty positions → run (explicit guard, not vacuous every)', () => {
  const d = decideHoldingSkip({ ...base, positions: [] });
  assert.equal(d.skip, false);
  assert.equal(d.gate, null);
});

test('decideHoldingSkip: econ blackout → run', () => {
  const d = decideHoldingSkip({ ...base, econBlackout: true });
  assert.equal(d.skip, false);
  assert.equal(d.gate, 'econ_blackout');
});

test('decideHoldingSkip: staleness cap reached → run', () => {
  const d = decideHoldingSkip({ ...base, sinceLastExitEvalMs: 360_000 });
  assert.equal(d.skip, false);
  assert.equal(d.gate, 'staleness');
});

test('decideHoldingSkip: NaN staleness → run (fail toward running)', () => {
  const d = decideHoldingSkip({ ...base, sinceLastExitEvalMs: NaN });
  assert.equal(d.skip, false);
  assert.equal(d.gate, 'staleness');
});

test('decideHoldingSkip: a near_stop position → run', () => {
  const d = decideHoldingSkip({ ...base, positions: [{ symbol: 'X', underlying: 'X', pnlPct: -12 }] });
  assert.equal(d.skip, false);
  assert.equal(d.gate, 'near_stop');
});

test('decideHoldingSkip: a near_target position → run', () => {
  const d = decideHoldingSkip({ ...base, positions: [{ symbol: 'X', underlying: 'X', pnlPct: 35 }] });
  assert.equal(d.skip, false);
  assert.equal(d.gate, 'near_target');
});

test('decideHoldingSkip: an active (not quiet) underlying → run', () => {
  const d = decideHoldingSkip({ ...base, signalsByUnderlying: { TSLA: sig({ rvol: 3.0 }) } });
  assert.equal(d.skip, false);
  assert.equal(d.gate, 'not_quiet');
});

test('decideHoldingSkip: missing signal for a held name → run (not quiet)', () => {
  const d = decideHoldingSkip({ ...base, signalsByUnderlying: {} });
  assert.equal(d.skip, false);
  assert.equal(d.gate, 'not_quiet');
});

test('loadSkipConfig: defaults when env unset', () => {
  const c = loadSkipConfig({});
  assert.equal(c.enabled, false);                 // default OFF
  assert.equal(c.maxStalenessMs, 6 * 60 * 1000);
  assert.deepEqual(c.thresholds, { nearStopPct: -10, nearTargetPct: 30, vwap: 1.5, rvol: 2.0, rngAtr: 1.5, dayPct: 4.0 });
});

test('loadSkipConfig: env overrides parse', () => {
  const c = loadSkipConfig({
    PROPHET_HOLDING_SKIP_ENABLED: 'true',
    PROPHET_SKIP_MAX_STALENESS_MIN: '4',
    PROPHET_SKIP_NEAR_STOP_PCT: '-8',
    PROPHET_SKIP_QUIET_RVOL: '2.5',
  });
  assert.equal(c.enabled, true);
  assert.equal(c.maxStalenessMs, 4 * 60 * 1000);
  assert.equal(c.thresholds.nearStopPct, -8);
  assert.equal(c.thresholds.rvol, 2.5);
});

test('loadSkipConfig: non-numeric env falls back to default', () => {
  const c = loadSkipConfig({ PROPHET_SKIP_MAX_STALENESS_MIN: 'abc' });
  assert.equal(c.maxStalenessMs, 6 * 60 * 1000);
});

test('loadSkipConfig: only exact "true" enables', () => {
  assert.equal(loadSkipConfig({ PROPHET_HOLDING_SKIP_ENABLED: 'TRUE' }).enabled, false);
  assert.equal(loadSkipConfig({ PROPHET_HOLDING_SKIP_ENABLED: '1' }).enabled, false);
});
