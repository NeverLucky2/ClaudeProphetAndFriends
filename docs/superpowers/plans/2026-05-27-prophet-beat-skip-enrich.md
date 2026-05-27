# Prophet bounded-staleness beat skip + beat-context enrichment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Skip Prophet's no-op holding-beats during the 2-min hot phases when every position is mid-band on P&L, its underlying is quiet, and we're within a staleness cap — and annotate beat-context positions with their P&L band so woken beats spend fewer tool rounds.

**Architecture:** One pure Node module (`agent/prophet-beat-decision.js`) holds all derived logic (OCC→underlying, band classification, quiet thresholding, the skip decision). It's consumed by `prophetPreflight` (the skip gate, flag-gated default OFF) and `renderBeatContextBlock` (band labels). Raw data comes from existing Go endpoints (`/api/v1/positions`, `/api/v1/intraday/signals`) plus the existing `isEconomicBlackout`. Every gate fails *toward running the beat*.

**Tech Stack:** Node ESM, `node:test` + `node:assert/strict` (mock-based, no live backend), existing `agent/preflight.js` registry + `agent/harness.js` beat loop.

**Spec:** `docs/superpowers/specs/2026-05-27-prophet-beat-skip-enrich-design.md`

---

## File Structure

- **Create** `agent/prophet-beat-decision.js` — pure functions + env config loader. One responsibility: decide/describe holding-beat skippability. No I/O.
- **Create** `agent/prophet-beat-decision.test.mjs` — unit tests for the pure functions.
- **Modify** `agent/preflight.js` — extend `prophetPreflight` open-phase holding branch; thread `gate` through `resolvePreflight`; accept an `opts` arg carrying `sinceLastExitEvalMs`.
- **Modify** `agent/preflight.test.mjs` — integration tests with a stubbed `goAxios`.
- **Modify** `agent/harness.js` — track `_lastExitEvalBeatAt`; pass staleness into `resolvePreflight`; emit `gate` on `beat_skip`.
- **Modify** `agent/beat-context.js` — add band label per position line in `renderBeatContextBlock`.
- **Modify** `agent/beat-context.test.mjs` — assert band labels.
- **Modify** `.env.example` — document the new env vars.

**Deferred (not in this plan):** merging off-watchlist held names into the intraday block (spec §Beat-context enrichment). Integration cost (a second intraday fetch + reorder in the hot beat path) outweighs value since `PROPHET_INTRADAY_WATCHLIST` already covers the tradable names. Revisit as a standalone follow-up if observation shows held names routinely missing from the block.

---

## Task 1: `occUnderlying` — OCC option symbol → underlying

**Files:**
- Create: `agent/prophet-beat-decision.js`
- Test: `agent/prophet-beat-decision.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// agent/prophet-beat-decision.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { occUnderlying } from './prophet-beat-decision.js';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test agent/prophet-beat-decision.test.mjs`
Expected: FAIL — `occUnderlying` is not exported (module/file does not exist yet).

- [ ] **Step 3: Write minimal implementation**

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test agent/prophet-beat-decision.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add agent/prophet-beat-decision.js agent/prophet-beat-decision.test.mjs
git commit -m "feat(prophet-skip): occUnderlying OCC→underlying helper

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: `normalizePnlPct` + `classifyBand` — P&L band classification

**Files:**
- Modify: `agent/prophet-beat-decision.js`
- Test: `agent/prophet-beat-decision.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// add to agent/prophet-beat-decision.test.mjs
import { classifyBand, normalizePnlPct } from './prophet-beat-decision.js';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test agent/prophet-beat-decision.test.mjs`
Expected: FAIL — `classifyBand` / `normalizePnlPct` not exported.

- [ ] **Step 3: Write minimal implementation**

```js
// add to agent/prophet-beat-decision.js

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test agent/prophet-beat-decision.test.mjs`
Expected: PASS (all Task 1 + Task 2 tests).

- [ ] **Step 5: Commit**

```bash
git add agent/prophet-beat-decision.js agent/prophet-beat-decision.test.mjs
git commit -m "feat(prophet-skip): classifyBand + normalizePnlPct (percent units)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: `isUnderlyingQuiet` — intraday quiet proxy

**Files:**
- Modify: `agent/prophet-beat-decision.js`
- Test: `agent/prophet-beat-decision.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// add to agent/prophet-beat-decision.test.mjs
import { isUnderlyingQuiet } from './prophet-beat-decision.js';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test agent/prophet-beat-decision.test.mjs`
Expected: FAIL — `isUnderlyingQuiet` not exported.

- [ ] **Step 3: Write minimal implementation**

```js
// add to agent/prophet-beat-decision.js

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test agent/prophet-beat-decision.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/prophet-beat-decision.js agent/prophet-beat-decision.test.mjs
git commit -m "feat(prophet-skip): isUnderlyingQuiet intraday proxy

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: `decideHoldingSkip` — the gated decision + `gate` enum

**Files:**
- Modify: `agent/prophet-beat-decision.js`
- Test: `agent/prophet-beat-decision.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// add to agent/prophet-beat-decision.test.mjs
import { decideHoldingSkip } from './prophet-beat-decision.js';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test agent/prophet-beat-decision.test.mjs`
Expected: FAIL — `decideHoldingSkip` not exported.

- [ ] **Step 3: Write minimal implementation**

```js
// add to agent/prophet-beat-decision.js

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
  if (econBlackout === true) {
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test agent/prophet-beat-decision.test.mjs`
Expected: PASS (all 9 decide cases + earlier tasks).

- [ ] **Step 5: Commit**

```bash
git add agent/prophet-beat-decision.js agent/prophet-beat-decision.test.mjs
git commit -m "feat(prophet-skip): decideHoldingSkip gated decision + gate enum

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: `loadSkipConfig` — env-tunable thresholds + enable flag

**Files:**
- Modify: `agent/prophet-beat-decision.js`
- Test: `agent/prophet-beat-decision.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// add to agent/prophet-beat-decision.test.mjs
import { loadSkipConfig } from './prophet-beat-decision.js';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test agent/prophet-beat-decision.test.mjs`
Expected: FAIL — `loadSkipConfig` not exported.

- [ ] **Step 3: Write minimal implementation**

```js
// add to agent/prophet-beat-decision.js

// Read the skip config from env (defaults below). Enable flag is exact-"true"
// only (matches FILLS_SUMMARY_ENABLED / BEAT_CONTEXT_ENABLED convention).
export function loadSkipConfig(env = process.env) {
  const num = (v, d) => {
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test agent/prophet-beat-decision.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/prophet-beat-decision.js agent/prophet-beat-decision.test.mjs
git commit -m "feat(prophet-skip): loadSkipConfig env loader (default OFF)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 6: Wire the holding skip into `prophetPreflight` (flag-gated)

**Files:**
- Modify: `agent/preflight.js` — imports; `prophetPreflight` open-phase tail (currently `agent/preflight.js:281-313`); `resolvePreflight` (`agent/preflight.js:664-683`).
- Test: `agent/preflight.test.mjs`

> **BLOCKING — verify the P&L unit first.** `/api/v1/positions` returns raw
> `interfaces.Position` with PascalCase keys; `UnrealizedPLPC` is mapped from
> Alpaca's `UnrealizedIntradayPLPC`. Before trusting the band thresholds, confirm
> whether that value is a percent (12) or a fraction (0.12). With the agent
> running and at least one open v2-options position:
> `curl -s localhost:3737/api/v1/positions?strategy=v2-options` (adjust port) and
> read `UnrealizedPLPC` against the same position's P&L shown in the beat-context
> block. If it is a fraction, change `normalizePnlPct` (Task 2) to
> `return raw * 100;`. Do not proceed to Step 5 until this is confirmed.

- [ ] **Step 1: Write the failing tests**

```js
// add to agent/preflight.test.mjs
import { resolvePreflight } from './preflight.js';

// Minimal goAxios stub: resolves URL → payload; supports timeout arg.
function makeRuntime({ positions, signals, blackout = { is_blackout: false }, sinceLastExitEvalMs }) {
  return {
    sinceLastExitEvalMs,
    goAxios: {
      get: async (url) => {
        if (url.startsWith('/api/v1/positions')) return { data: positions };
        if (url.startsWith('/api/v1/intraday/signals')) {
          if (signals instanceof Error) throw signals;
          return { data: { signals } };
        }
        if (url.startsWith('/api/v1/econ/blackout')) return { data: blackout };
        if (url.startsWith('/api/v1/regime-gate/status')) return { data: { block_new_entries: false } };
        throw new Error(`unexpected url ${url}`);
      },
    },
  };
}
const cfg = { strategyId: 'v2-options' };
const HELD = [{ Symbol: 'TSLA260529C00442500', UnrealizedPLPC: 5 }];
const quiet = [{ symbol: 'TSLA', dist_from_vwap_pct: 0.2, rvol: 1.0, range_over_atr: 0.7, day_change_pct: 0.5 }];

test('prophetPreflight holding: enabled + interior + quiet + fresh → skip', async () => {
  process.env.PROPHET_HOLDING_SKIP_ENABLED = 'true';
  const rt = makeRuntime({ positions: HELD, signals: quiet, sinceLastExitEvalMs: 60_000 });
  const r = await resolvePreflight('v2-options', rt, cfg, { sinceLastExitEvalMs: 60_000 });
  assert.equal(r.skip, true);
  delete process.env.PROPHET_HOLDING_SKIP_ENABLED;
});

test('prophetPreflight holding: flag OFF → always runs (today behavior)', async () => {
  delete process.env.PROPHET_HOLDING_SKIP_ENABLED;
  const rt = makeRuntime({ positions: HELD, signals: quiet, sinceLastExitEvalMs: 60_000 });
  const r = await resolvePreflight('v2-options', rt, cfg, { sinceLastExitEvalMs: 60_000 });
  assert.equal(r.skip, false);
});

test('prophetPreflight holding: enabled but position near boundary → run', async () => {
  process.env.PROPHET_HOLDING_SKIP_ENABLED = 'true';
  const rt = makeRuntime({ positions: [{ Symbol: 'TSLA260529C00442500', UnrealizedPLPC: -12 }], signals: quiet, sinceLastExitEvalMs: 60_000 });
  const r = await resolvePreflight('v2-options', rt, cfg, { sinceLastExitEvalMs: 60_000 });
  assert.equal(r.skip, false);
  assert.equal(r.gate, 'near_stop');
  delete process.env.PROPHET_HOLDING_SKIP_ENABLED;
});

test('prophetPreflight holding: enabled but econ blackout → run', async () => {
  process.env.PROPHET_HOLDING_SKIP_ENABLED = 'true';
  const rt = makeRuntime({ positions: HELD, signals: quiet, blackout: { is_blackout: true, reason: 'CPI' }, sinceLastExitEvalMs: 60_000 });
  const r = await resolvePreflight('v2-options', rt, cfg, { sinceLastExitEvalMs: 60_000 });
  assert.equal(r.skip, false);
  assert.equal(r.gate, 'econ_blackout');
  delete process.env.PROPHET_HOLDING_SKIP_ENABLED;
});

test('prophetPreflight holding: enabled, intraday fetch throws → run (fail toward run)', async () => {
  process.env.PROPHET_HOLDING_SKIP_ENABLED = 'true';
  const rt = makeRuntime({ positions: HELD, signals: new Error('timeout'), sinceLastExitEvalMs: 60_000 });
  const r = await resolvePreflight('v2-options', rt, cfg, { sinceLastExitEvalMs: 60_000 });
  assert.equal(r.skip, false);
  delete process.env.PROPHET_HOLDING_SKIP_ENABLED;
});

test('prophetPreflight flat (no positions) → existing flat path (skip false here, regime ok)', async () => {
  process.env.PROPHET_HOLDING_SKIP_ENABLED = 'true';
  const rt = makeRuntime({ positions: [], signals: [], sinceLastExitEvalMs: 60_000 });
  const r = await resolvePreflight('v2-options', rt, cfg, { sinceLastExitEvalMs: 60_000 });
  assert.equal(r.skip, false); // no regime block / no blackout → runs
  delete process.env.PROPHET_HOLDING_SKIP_ENABLED;
});
```

> Note: these tests run during the open phase. `prophetPreflight` calls
> `isClosedPhase(new Date())` first; if the suite runs during ET closed hours the
> closed branch is taken instead. Guard by stubbing time if needed, or run the
> existing `preflight.test.mjs` time-control helper if present. If neither, accept
> that the holding tests are open-phase-only and skip them when `isClosedPhase`
> reports closed (assert the closed reason instead). Confirm against the existing
> test file's conventions before writing.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test agent/preflight.test.mjs`
Expected: FAIL — `resolvePreflight` ignores the 4th `opts` arg and the holding branch always returns `skip:false`, so the "→ skip" and gate-assertion tests fail.

- [ ] **Step 3: Implement — imports**

Add to the import block at the top of `agent/preflight.js` (alongside `import { isMarketHoliday } from './market-calendar.js';`):

```js
import {
  occUnderlying, normalizePnlPct, decideHoldingSkip, loadSkipConfig,
} from './prophet-beat-decision.js';
```

- [ ] **Step 4: Implement — `resolvePreflight` accepts + threads `opts` and `gate`**

Replace `agent/preflight.js:664-683` (the `resolvePreflight` body through the try/catch) with:

```js
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
```

- [ ] **Step 5: Implement — `prophetPreflight` holding branch**

Replace the open-phase tail of `prophetPreflight` (`agent/preflight.js:300-313`, from the `// Open phase` comment through the final `return`) with:

```js
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
    || Boolean(econSettled.value?.error);

  const decision = decideHoldingSkip({
    positions,
    signalsByUnderlying,
    sinceLastExitEvalMs: Number.isFinite(opts?.sinceLastExitEvalMs) ? opts.sinceLastExitEvalMs : Infinity,
    maxStalenessMs: cfg.maxStalenessMs,
    econBlackout,
    thresholds: cfg.thresholds,
  });
  return { skip: decision.skip, reason: decision.reason, gate: decision.gate };
```

Also update the `prophetPreflight` signature line (`agent/preflight.js:281`) from
`async function prophetPreflight(runtime, agentConfig) {` to
`async function prophetPreflight(runtime, agentConfig, opts = {}) {`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test agent/preflight.test.mjs`
Expected: PASS (new holding tests + existing preflight regressions).

- [ ] **Step 7: Commit**

```bash
git add agent/preflight.js agent/preflight.test.mjs
git commit -m "feat(prophet-skip): bounded-staleness holding skip in prophetPreflight (default OFF)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 7: Harness `_lastExitEvalBeatAt` tracking + thread staleness + emit gate

**Files:**
- Modify: `agent/harness.js` — constructor (`~agent/harness.js:277`), `start()` (`~:387`), `_beat()` preflight call (`~:930`), `beat_skip` emit (`~:936`), the run-commit point after the preflight block (`~:955`), daily-reset block (`~:905`).
- Test: covered indirectly; add a focused unit test in `agent/harness.test.mjs` if the existing harness test harness supports constructing a harness (check first — if too heavy, rely on the preflight integration tests for the decision logic and verify wiring by reading).

- [ ] **Step 1: Add the field (constructor)**

In the constructor, near `this._lastBeatPhase = null;` (`agent/harness.js:278`), add:

```js
    // Wall-clock of the last beat that EVALUATED position exits (heartbeat or
    // emergency — NOT message beats). Feeds the bounded-staleness skip cap.
    // 0 = "long ago" so the first beat after start/daily-reset always runs.
    this._lastExitEvalBeatAt = 0;
```

- [ ] **Step 2: Reset on start**

In `start()` (after `this.state.activeModel = ...` / before the first scheduled beat, `~agent/harness.js:387`), add:

```js
    this._lastExitEvalBeatAt = 0;
```

- [ ] **Step 3: Reset on daily session reset**

Inside the `sessionMode==='daily'` reset block in `_beat()` (`~agent/harness.js:905`, where `this._sessionId = null;`), add:

```js
      this._lastExitEvalBeatAt = 0;
```

- [ ] **Step 4: Thread staleness into the preflight call**

Change the `resolvePreflight` call in `_beat()` (`agent/harness.js:930`) from:

```js
      const preflight = await resolvePreflight(strategyId, runtime, this._agentConfig);
```

to:

```js
      const preflight = await resolvePreflight(strategyId, runtime, this._agentConfig, {
        sinceLastExitEvalMs: this._lastExitEvalBeatAt ? (Date.now() - this._lastExitEvalBeatAt) : Infinity,
      });
```

- [ ] **Step 5: Emit `gate` on the skip event**

In the `if (preflight.skip)` block (`agent/harness.js:936`), change the `beat_skip` emit to include the gate:

```js
        this.state.emit('beat_skip', { beat: beatNum, phase, reason: preflight.reason, gate: preflight.gate ?? null });
```

- [ ] **Step 6: Stamp the exit-eval time when a beat actually runs**

Immediately after the `if (!isEmergency) { ... }` preflight block closes (`~agent/harness.js:955`, before the `// Guardrails are baked...` comment), add:

```js
    // A heartbeat (or emergency) beat is now committed to run the LLM — it WILL
    // evaluate position exits. Stamp the staleness clock. Message beats use a
    // separate path (_adHocBeat) and intentionally do not stamp this.
    this._lastExitEvalBeatAt = Date.now();
```

- [ ] **Step 7: Verify nothing regressed**

Run: `node --test agent/harness.test.mjs`
Expected: PASS (existing harness tests unaffected; the new field defaults preserve behavior — with the flag OFF, preflight never skips holding beats).

- [ ] **Step 8: Commit**

```bash
git add agent/harness.js
git commit -m "feat(prophet-skip): track _lastExitEvalBeatAt + thread staleness + emit skip gate

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 8: Beat-context band-label enrichment

**Files:**
- Modify: `agent/beat-context.js` — `renderBeatContextBlock` position loop (`agent/beat-context.js:22-30`).
- Test: `agent/beat-context.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// add to agent/beat-context.test.mjs
import { renderBeatContextBlock } from './beat-context.js';

test('renderBeatContextBlock: annotates each position with its P&L band', () => {
  const ctx = {
    segment_pnl: { strategy: 'v2-options', unrealized_pnl_percent: 1, deployed_percent: 5 },
    positions: [
      { symbol: 'TSLA260529C00442500', qty: 6, unrealized_pnl_pct: 12.0, unrealized_pnl: 720 },
      { symbol: 'NVDA260619C00130000', qty: 4, unrealized_pnl_pct: -11.0, unrealized_pnl: -300 },
      { symbol: 'AAPL260529C00190000', qty: 2, unrealized_pnl_pct: 3.0, unrealized_pnl: 50 },
    ],
  };
  const block = renderBeatContextBlock(ctx);
  assert.match(block, /TSLA260529C00442500: 6 sh, P&L \+12\.0% \(\$720\.00\) \[interior\]/);
  assert.match(block, /NVDA260619C00130000: 4 sh, P&L -11\.0% \(\$-300\.00\) \[near_stop\]/);
  assert.match(block, /AAPL260529C00190000: 2 sh, P&L \+3\.0% \(\$50\.00\) \[interior\]/);
});
```

> Uses the default band edges (−10 / +30) imported by the renderer. −11% → `near_stop`, +12% / +3% → `interior`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test agent/beat-context.test.mjs`
Expected: FAIL — no `[band]` suffix on the position lines.

- [ ] **Step 3: Implement**

Add to the top of `agent/beat-context.js`:

```js
import { classifyBand, normalizePnlPct, loadSkipConfig } from './prophet-beat-decision.js';
```

Replace the position-line loop body (`agent/beat-context.js:24-27`) — the `for (const p of ctx.positions)` block — with:

```js
    const { thresholds } = loadSkipConfig();
    for (const p of ctx.positions) {
      const sign = p.unrealized_pnl_pct >= 0 ? '+' : '';
      const band = classifyBand(normalizePnlPct(Number(p.unrealized_pnl_pct)), thresholds);
      lines.push(`  - ${p.symbol}: ${p.qty} sh, P&L ${sign}${(p.unrealized_pnl_pct ?? 0).toFixed(1)}% ($${(p.unrealized_pnl ?? 0).toFixed(2)}) [${band}]`);
    }
```

> The band label is read-only context (ships regardless of the skip flag — it's
> useful even when skipping is off). It reuses the same `classifyBand` /
> `normalizePnlPct` as the skip path, so the LLM's "near_stop" matches the gate's.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test agent/beat-context.test.mjs`
Expected: PASS (new test + existing beat-context tests).

- [ ] **Step 5: Commit**

```bash
git add agent/beat-context.js agent/beat-context.test.mjs
git commit -m "feat(prophet-skip): annotate beat-context positions with P&L band

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 9: Document env vars + full-suite verification

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Add env documentation**

Append to `.env.example` (near the other Prophet flags):

```bash
# Prophet bounded-staleness holding-beat skip — default OFF (observe-then-enable).
# When "true", Prophet skips a market-hours heartbeat while holding positions ONLY
# when every position is mid-band on P&L, its underlying is quiet, and the last
# exit-evaluating beat was within the staleness cap. Fails toward running. The
# 6-min cap auto-scopes the skip to the 2-min open/close phases (midday/pre-market
# always run). Watch the `skipped (preflight): ...` reason + gate logs before
# enabling. See docs/superpowers/specs/2026-05-27-prophet-beat-skip-enrich-design.md.
PROPHET_HOLDING_SKIP_ENABLED=false
PROPHET_SKIP_MAX_STALENESS_MIN=6
PROPHET_SKIP_NEAR_STOP_PCT=-10
PROPHET_SKIP_NEAR_TARGET_PCT=30
PROPHET_SKIP_QUIET_VWAP_PCT=1.5
PROPHET_SKIP_QUIET_RVOL=2.0
PROPHET_SKIP_QUIET_RNG_ATR=1.5
PROPHET_SKIP_QUIET_DAY_PCT=4.0
```

- [ ] **Step 2: Run the full affected test suite**

Run: `node --test agent/prophet-beat-decision.test.mjs agent/preflight.test.mjs agent/beat-context.test.mjs agent/harness.test.mjs`
Expected: PASS — all green, zero failures.

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "docs(prophet-skip): document PROPHET_HOLDING_SKIP_* env vars

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Skip decision (econ→staleness→band→quiet, fail toward run) → Tasks 4, 6 ✓
- Pure module / two consumers → Tasks 1–5 (module), 6 (preflight), 8 (renderer) ✓
- `gate` enum on `beat_skip` for observe phase → Tasks 4, 6, 7 ✓
- Staleness keyed to exit-evaluating beats (not message) → Task 7 ✓
- Econ fails toward run → Task 6 ✓
- Default-OFF flag + env params → Tasks 5, 6, 9 ✓
- Band-label enrichment → Task 8 ✓
- Held-name intraday merge → **deferred** (documented in File Structure; raise with user) — the one spec item intentionally not implemented here.
- Fail-toward-run error handling → Tasks 2/3/4 (non-finite/missing → actionable) + 6 (fetch failures) ✓

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `decideHoldingSkip` consumes `{symbol, underlying, pnlPct}` position objects built identically in Task 6 and the test in Task 4; `thresholds` shape (`nearStopPct/nearTargetPct/vwap/rvol/rngAtr/dayPct`) is identical across `loadSkipConfig` (Task 5), `classifyBand` (Task 2), `isUnderlyingQuiet` (Task 3), and the Task 4/6 callers. `gate` enum values match across module, preflight, and harness emit.

**Open risk flagged in-plan:** the `normalizePnlPct` unit (percent vs fraction) — Task 6 has a blocking verification step. Getting it wrong silently disables the band gates.
