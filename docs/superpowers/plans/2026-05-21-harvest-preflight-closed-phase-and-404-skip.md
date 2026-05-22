# Harvest Preflight: Closed-Phase Guard + 404 = Skip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `harvestPreflight` from spawning the LLM during closed-market hours and when the expirations endpoint 404s (no qualifying DTE window).

**Architecture:** Two independent changes to `harvestPreflight` in `agent/preflight.js`. Task 1 is a required prerequisite: existing harvest tests don't freeze time, so adding a closed-phase guard would make them non-deterministic at night — wrap them in `ET_OPEN` first. Tasks 2 and 3 then follow TDD order: failing tests → implementation → passing tests → commit.

**Tech Stack:** Node.js `node:test`, ES modules, existing `makeRuntime` / `withFrozenTime` / `harvestState` helpers from `agent/preflight.test.mjs`.

---

### Task 1: Make existing harvest tests time-deterministic

**Files:**
- Modify: `agent/preflight.test.mjs` (harvest integration section, lines ~372–536)

Existing harvest tests that read `harvestState(0, ...)` or `harvestState(N, ..., true)` (monitor enabled) will reach the new closed-phase guard if run after 8 PM ET. Wrap all of them in `withFrozenTime(ET_OPEN, ...)` now, before any implementation change. `ET_OPEN` is already defined at line 237 as `Date.UTC(2026, 4, 21, 18, 30, 0)` (Thu 14:30 ET — midday, open phase).

The pattern is: replace `await resolvePreflight(...)` with `await withFrozenTime(ET_OPEN, () => resolvePreflight(...))`. Tests whose harvest state has `openCondors > 0` AND `monitor_enabled !== true` return at the existing guard before any phase check — they are safe without wrapping, but wrap them anyway for consistency.

- [ ] **Step 1: Run the test suite to establish a baseline**

```
node --test agent/preflight.test.mjs
```

Expected: all tests pass. Note the total count.

- [ ] **Step 2: Wrap the 9 affected harvest tests in ET_OPEN**

In `agent/preflight.test.mjs`, apply the following changes. Each change wraps the inner `resolvePreflight` call in `withFrozenTime(ET_OPEN, () => ...)`:

**Test: "harvest: no condors + econ blackout (non-FOMC) → skip"** (line ~379)
```js
const r = await withFrozenTime(ET_OPEN, () => resolvePreflight('harvest', rt, {}));
```

**Test: "harvest: open condor + econ blackout → run (exits must happen)"** (line ~390)
```js
const r = await withFrozenTime(ET_OPEN, () => resolvePreflight('harvest', rt, {}));
```

**Test: "harvest: existing 24h FOMC blackout still skips"** (line ~400)
```js
const r = await withFrozenTime(ET_OPEN, () => resolvePreflight('harvest', rt, {}));
```

**Test: "harvest: IV > RV → run"** (line ~430)
```js
const r = await withFrozenTime(ET_OPEN, () => resolvePreflight('harvest', rt, {}));
```

**Test: "harvest: IV ≤ RV with positive RV → skip"** (line ~443)
```js
const r = await withFrozenTime(ET_OPEN, () => resolvePreflight('harvest', rt, {}));
```

**Test: "harvest: IV = RV exactly → skip"** (line ~457)
```js
const r = await withFrozenTime(ET_OPEN, () => resolvePreflight('harvest', rt, {}));
```

**Test: "harvest: RV = 0 (no signal) → fall through, do not skip"** (line ~470)
```js
const r = await withFrozenTime(ET_OPEN, () => resolvePreflight('harvest', rt, {}));
```

**Test: "harvest: IV endpoint errors → fall through (soft-fail)"** (line ~484)
```js
const r = await withFrozenTime(ET_OPEN, () => resolvePreflight('harvest', rt, {}));
```

**Test: "harvest: open condor + IV ≤ RV → run"** (line ~496)
```js
const r = await withFrozenTime(ET_OPEN, () => resolvePreflight('harvest', rt, {}));
```

**Test: "harvest: monitor_enabled + open condors but otherwise no entries → skip"** (line ~518)
```js
const r = await withFrozenTime(ET_OPEN, () => resolvePreflight('harvest', rt, {}));
```

**Test: "harvest: monitor_enabled + open condors + entries available → run"** (line ~533)
```js
const r = await withFrozenTime(ET_OPEN, () => resolvePreflight('harvest', rt, {}));
```

- [ ] **Step 3: Run the test suite to verify no regressions**

```
node --test agent/preflight.test.mjs
```

Expected: same number of tests, all pass. No behavior changed — only wrapping.

- [ ] **Step 4: Commit**

```bash
git add agent/preflight.test.mjs
git commit -m "test(preflight): freeze harvest tests at ET_OPEN for closed-phase guard"
```

---

### Task 2: Closed-phase guard — write failing tests, implement, verify

**Files:**
- Modify: `agent/preflight.test.mjs` (add 5 new tests after the monitor_enabled block)
- Modify: `agent/preflight.js` (`harvestPreflight` function, after line 442)

- [ ] **Step 1: Write the 5 failing tests**

Add these tests to `agent/preflight.test.mjs` after the last `harvest: monitor_enabled` test:

```js
// ── harvestPreflight closed-phase guard ────────────────────────────
//
// During closed-market hours (8pm-4am ET weekdays + full weekends) the broker
// is shut. With monitor_enabled=true the Go service owns exits — the LLM has
// nothing to do regardless of condor count. Without the monitor, if condors=0
// there is also nothing to do. The case of condors>0 + monitor=false is handled
// by the existing guard (returns skip:false before reaching the phase check).

test('harvest: closed phase + monitor_enabled=false + 0 condors → skip', async () => {
  const rt = makeRuntime([
    ['/api/v1/harvest/state', () => harvestState(0, 0, false)],
    ['/api/v1/harvest/fomc', () => fomcStatus(false)],
    // The fomc fetch is in the initial Promise.all so it IS mocked above.
    // Regime, econ, and chain-probe routes (everything after the phase check)
    // must not be consulted — leave them unmocked. Any unmocked call would
    // throw "unmocked URL" and land as fail-open skip:false, falsifying the
    // skip:true assertion below.
  ]);
  const r = await withFrozenTime(ET_CLOSED, () => resolvePreflight('harvest', rt, {}));
  assert.equal(r.skip, true);
  assert.match(r.reason, /closed phase/);
});

test('harvest: closed phase + monitor_enabled=true + 0 condors → skip', async () => {
  const rt = makeRuntime([
    ['/api/v1/harvest/state', () => harvestState(0, 0, true)],
    ['/api/v1/harvest/fomc', () => fomcStatus(false)],
  ]);
  const r = await withFrozenTime(ET_CLOSED, () => resolvePreflight('harvest', rt, {}));
  assert.equal(r.skip, true);
  assert.match(r.reason, /closed phase/);
});

test('harvest: closed phase + monitor_enabled=true + open condors → skip (monitor owns exits)', async () => {
  // The new case: condors>0 but monitor owns exits; LLM can't enter either.
  // Existing guard only fires when monitor=false, so this falls through to
  // our new closed-phase check.
  const rt = makeRuntime([
    ['/api/v1/harvest/state', () => harvestState(2, 5.0, true)],
    ['/api/v1/harvest/fomc', () => fomcStatus(false)],
  ]);
  const r = await withFrozenTime(ET_CLOSED, () => resolvePreflight('harvest', rt, {}));
  assert.equal(r.skip, true);
  assert.match(r.reason, /closed phase/);
});

test('harvest: closed phase + monitor_enabled=false + open condors → run (existing guard fires first)', async () => {
  // The existing guard (condors>0 + monitor=false) returns before the new guard.
  // This test proves the existing path is not changed by the new guard.
  const rt = makeRuntime([
    ['/api/v1/harvest/state', () => harvestState(2, 5.0, false)],
    ['/api/v1/harvest/fomc', () => fomcStatus(false)],
  ]);
  const r = await withFrozenTime(ET_CLOSED, () => resolvePreflight('harvest', rt, {}));
  assert.equal(r.skip, false);
  assert.match(r.reason, /open condor/);
});

test('harvest: open phase + monitor_enabled=true + 0 condors → closed-phase guard does not fire', async () => {
  // Guard must be a no-op during open phase; execution continues to FOMC/chain checks.
  const rt = makeRuntime([
    ['/api/v1/harvest/state', () => harvestState(0, 0, true)],
    ['/api/v1/harvest/fomc', () => fomcStatus(false)],
    ['/api/v1/regime-gate/status', () => regimeAllow()],
    ['/api/v1/econ/blackout', () => blackoutOff()],
    ['/api/v1/harvest/expirations/SPY', () => harvestExpiration()],
    [/^\/api\/v1\/options\/chain\/SPY/, () => chainNonEmpty()],
    ['/api/v1/iv/SPY', () => ivSpread(0.15, 0.04)],
  ]);
  const r = await withFrozenTime(ET_OPEN, () => resolvePreflight('harvest', rt, {}));
  assert.equal(r.skip, false);
  assert.doesNotMatch(r.reason, /closed phase/);
});
```

- [ ] **Step 2: Run tests to confirm the 3 new skip tests fail**

```
node --test agent/preflight.test.mjs
```

Expected: 3 tests fail (`closed phase + monitor=false + 0 condors`, `monitor=true + 0 condors`, `monitor=true + open condors`). The 2 non-skip tests pass (existing guard already handles them).

- [ ] **Step 3: Implement the closed-phase guard in `agent/preflight.js`**

In `harvestPreflight`, find the existing open-condors/monitor guard (the `if (openCondors > 0 && state.monitor_enabled !== true)` block). Insert the closed-phase guard immediately after its closing brace, before the `if (fomc.is_blackout)` check:

```js
  if (openCondors > 0 && state.monitor_enabled !== true) {
    return { skip: false, reason: `${openCondors} open condor(s) to evaluate` };
  }

  const phase = isClosedPhase(new Date());
  if (phase.closed) {
    return { skip: true, reason: `closed phase (${phase.reason}), harvest LLM not needed` };
  }

  if (fomc.is_blackout) {
```

`isClosedPhase` is already exported and defined in the same file — no import needed.

- [ ] **Step 4: Run tests to confirm all pass**

```
node --test agent/preflight.test.mjs
```

Expected: all tests pass including the 3 new skip tests.

- [ ] **Step 5: Commit**

```bash
git add agent/preflight.js agent/preflight.test.mjs
git commit -m "feat(preflight): skip harvest LLM beat during closed-market phase"
```

---

### Task 3: 404 = skip — write failing tests, implement, verify

**Files:**
- Modify: `agent/preflight.test.mjs` (add 3 new tests after the closed-phase guard block)
- Modify: `agent/preflight.js` (`harvestPreflight` catch block, lines ~483–485)

- [ ] **Step 1: Write the 3 failing tests**

Add these tests to `agent/preflight.test.mjs` after the closed-phase guard block:

```js
// ── harvestPreflight: expirations 404 = skip ───────────────────────
//
// GET /api/v1/harvest/expirations/:symbol returns HTTP 404 when
// GetNextMonthlyExpiration finds no qualifying contract in [35,55] DTE.
// This is a semantic "not found", identical in meaning to the !exp branch
// (expiration_date: null) which already returns skip:true. The catch block
// must distinguish 404 (skip) from transient errors like 500 or ECONNREFUSED
// (fail open — let the LLM investigate).

test('harvest: expirations endpoint 404 → skip (no qualifying DTE window)', async () => {
  const rt = makeRuntime([
    ['/api/v1/harvest/state', () => harvestState(0)],
    ['/api/v1/harvest/fomc', () => fomcStatus(false)],
    ['/api/v1/regime-gate/status', () => regimeAllow()],
    ['/api/v1/econ/blackout', () => blackoutOff()],
    ['/api/v1/harvest/expirations/SPY', () => {
      const e = new Error('Request failed with status code 404');
      e.response = { status: 404 };
      throw e;
    }],
  ]);
  const r = await withFrozenTime(ET_OPEN, () => resolvePreflight('harvest', rt, {}));
  assert.equal(r.skip, true);
  assert.match(r.reason, /404/);
});

test('harvest: expirations endpoint 500 → run (fail open on non-404 error)', async () => {
  const rt = makeRuntime([
    ['/api/v1/harvest/state', () => harvestState(0)],
    ['/api/v1/harvest/fomc', () => fomcStatus(false)],
    ['/api/v1/regime-gate/status', () => regimeAllow()],
    ['/api/v1/econ/blackout', () => blackoutOff()],
    ['/api/v1/harvest/expirations/SPY', () => {
      const e = new Error('Internal server error');
      e.response = { status: 500 };
      throw e;
    }],
  ]);
  const r = await withFrozenTime(ET_OPEN, () => resolvePreflight('harvest', rt, {}));
  assert.equal(r.skip, false);
  assert.match(r.reason, /harvest chain probe error/);
});

test('harvest: expirations network error (no response object) → run (fail open)', async () => {
  // ECONNREFUSED / timeout throws an Error with no .response property.
  // Must not be treated as 404 — the endpoint may be temporarily unreachable.
  const rt = makeRuntime([
    ['/api/v1/harvest/state', () => harvestState(0)],
    ['/api/v1/harvest/fomc', () => fomcStatus(false)],
    ['/api/v1/regime-gate/status', () => regimeAllow()],
    ['/api/v1/econ/blackout', () => blackoutOff()],
    ['/api/v1/harvest/expirations/SPY', () => {
      throw new Error('ECONNREFUSED');
    }],
  ]);
  const r = await withFrozenTime(ET_OPEN, () => resolvePreflight('harvest', rt, {}));
  assert.equal(r.skip, false);
  assert.match(r.reason, /harvest chain probe error/);
});
```

- [ ] **Step 2: Run tests to confirm the 404 skip test fails**

```
node --test agent/preflight.test.mjs
```

Expected: the `expirations endpoint 404 → skip` test fails. The 500 and ECONNREFUSED tests already pass (existing catch block returns skip:false for all errors).

- [ ] **Step 3: Implement the 404 check in the catch block in `agent/preflight.js`**

Find the chain probe catch block in `harvestPreflight` (currently reads `return { skip: false, reason: \`harvest chain probe error: ${err.message}\` }`). Replace it:

```js
  } catch (err) {
    if (err.response?.status === 404) {
      return { skip: true, reason: 'no qualifying monthly expiration in [35,55] DTE for SPY (404)' };
    }
    return { skip: false, reason: `harvest chain probe error: ${err.message}` };
  }
```

- [ ] **Step 4: Run the full test suite to confirm all pass**

```
node --test agent/preflight.test.mjs
```

Expected: all tests pass including `expirations endpoint 404 → skip`.

- [ ] **Step 5: Run npm test for full suite coverage**

```
npm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add agent/preflight.js agent/preflight.test.mjs
git commit -m "feat(preflight): treat expirations 404 as skip in harvest chain probe"
```
