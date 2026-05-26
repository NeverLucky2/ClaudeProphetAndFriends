# No-op Pre-Market Beat Reduction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop two classes of guaranteed-no-op LLM beats — Harvest's IV warm-up beats (code) and Prophet's redundant pre-market heartbeat tightening (docs).

**Architecture:** Part A adds one early-return gate to the existing `harvestPreflight` predicate in `agent/preflight.js`, reading a `days_of_history` field from the `/api/v1/iv/SPY` response the predicate *already* fetches (zero new API calls). Part B adds a `## Heartbeat Cadence` section to `TRADING_RULES_V2.md` telling Prophet the harness already wakes it at the open. Full design + rationale: `docs/superpowers/specs/2026-05-26-noop-premarket-beat-reduction-design.md`.

**Tech Stack:** Node.js ESM, `node:test` + `node:assert` (existing `agent/preflight.test.mjs` harness with `makeRuntime` / `withFrozenTime` mock helpers). No new dependencies.

---

## File Structure

- `agent/preflight.js` — add `MIN_IV_HISTORY_DAYS` constant + one early-return in `harvestPreflight`'s existing `/api/v1/iv/SPY` block. (Modify)
- `agent/preflight.test.mjs` — add a "harvest IV-history warm-up gate" test group. (Modify)
- `TRADING_RULES_V2.md` — add a `## Heartbeat Cadence` section. (Modify, docs only)

---

## Task 1: Harvest "insufficient IV history" preflight skip

**Files:**
- Modify: `agent/preflight.js` (constant near line 446; gate inside the `/api/v1/iv/SPY` block, currently `agent/preflight.js:537-549`)
- Test: `agent/preflight.test.mjs` (add after the existing harvest IV/RV gate tests)

### Context the implementer needs

`harvestPreflight` already fetches `/api/v1/iv/SPY` near the end of the function for an IV-vs-RV "premium edge" gate. The current block looks exactly like this:

```js
  try {
    const ivResp = await goAxios.get('/api/v1/iv/SPY');
    const rv = Number(ivResp.data?.realized_vol_20d);
    const spread = Number(ivResp.data?.iv_minus_rv);
    if (rv > 0 && Number.isFinite(spread) && spread <= 0) {
      return {
        skip: true,
        reason: `no open condors and SPY IV ≤ RV (spread ${spread.toFixed(4)}, RV ${rv.toFixed(4)}) — no premium-selling edge`,
      };
    }
  } catch (_err) {
    // Soft-fail; do not block on IV endpoint outage.
  }
```

The same `/api/v1/iv/SPY` response (`services.IVRData`) also carries `days_of_history`. We add a check for it **before** the IV-RV check. When `days_of_history < 20`, IVR floors at 0 for every underlying, so no condor can clear the `IVR ≥ 30` entry gate — the beat is a guaranteed no-op.

The test file already has these helpers (do not redefine them): `makeRuntime(routes)`, `withFrozenTime(ET_OPEN, fn)`, `resolvePreflight`, `harvestState(openCondors, deployedPct=0, monitorEnabled=false)`, `fomcStatus(bool)`, `blackoutOff()`, `harvestExpiration()`, `chainNonEmpty()`. `ET_OPEN` is a frozen timestamp inside the `market_open` (non-closed) phase.

- [ ] **Step 1: Write the failing tests**

Add this block to `agent/preflight.test.mjs` immediately after the existing harvest IV/RV gate tests (after the `'harvest: IV endpoint errors → fall through (soft-fail)'` test):

```js
// ── harvest IV-history warm-up gate ────────────────────────────────
// During IV warm-up, days_of_history is too low for calcIVR to form a
// meaningful 52-week range, so IVR floors at 0 across the universe and no
// condor can clear IVR ≥ 30. The gate skips that guaranteed no-op beat.
// SPY is the universe proxy (see the design's correct-by-construction note).

// IV response that also carries days_of_history. RV/spread set so the EXISTING
// IV-RV gate would NOT fire (spread > 0), proving any skip comes from the new
// history gate, not the IV-RV gate.
const ivWithHistory = (daysOfHistory) => ({
  data: {
    current_iv: 0.20,
    realized_vol_20d: 0.10,
    iv_minus_rv: 0.10, // spread +0.10 → IV-RV gate does not fire
    days_of_history: daysOfHistory,
  },
});

test('harvest: SPY days_of_history < 20 → skip (IVR floored, no entries possible)', async () => {
  const rt = makeRuntime([
    ['/api/v1/harvest/state', () => harvestState(0)],
    ['/api/v1/harvest/fomc', () => fomcStatus(false)],
    ['/api/v1/econ/blackout', () => blackoutOff()],
    ['/api/v1/harvest/expirations/SPY', () => harvestExpiration()],
    [/^\/api\/v1\/options\/chain\/SPY/, () => chainNonEmpty()],
    ['/api/v1/iv/SPY', () => ivWithHistory(2)],
  ]);
  const r = await withFrozenTime(ET_OPEN, () => resolvePreflight('harvest', rt, {}));
  assert.equal(r.skip, true);
  assert.match(r.reason, /insufficient IV history/i);
});

test('harvest: monitor on + open condor + days_of_history < 20 → skip (entries impossible)', async () => {
  // Monitor handles exits out-of-band, so the LLM beat is only needed for
  // entries — and none are possible during warm-up.
  const rt = makeRuntime([
    ['/api/v1/harvest/state', () => harvestState(2, 0, true)],
    ['/api/v1/harvest/fomc', () => fomcStatus(false)],
    ['/api/v1/econ/blackout', () => blackoutOff()],
    ['/api/v1/harvest/expirations/SPY', () => harvestExpiration()],
    [/^\/api\/v1\/options\/chain\/SPY/, () => chainNonEmpty()],
    ['/api/v1/iv/SPY', () => ivWithHistory(2)],
  ]);
  const r = await withFrozenTime(ET_OPEN, () => resolvePreflight('harvest', rt, {}));
  assert.equal(r.skip, true);
  assert.match(r.reason, /insufficient IV history/i);
});

test('harvest: SPY days_of_history ≥ 20 → does not skip on history gate', async () => {
  const rt = makeRuntime([
    ['/api/v1/harvest/state', () => harvestState(0)],
    ['/api/v1/harvest/fomc', () => fomcStatus(false)],
    ['/api/v1/econ/blackout', () => blackoutOff()],
    ['/api/v1/harvest/expirations/SPY', () => harvestExpiration()],
    [/^\/api\/v1\/options\/chain\/SPY/, () => chainNonEmpty()],
    ['/api/v1/iv/SPY', () => ivWithHistory(60)],
  ]);
  const r = await withFrozenTime(ET_OPEN, () => resolvePreflight('harvest', rt, {}));
  assert.equal(r.skip, false, `expected run, got skip: ${r.reason}`);
});

test('harvest: malformed days_of_history → fall through (does not skip)', async () => {
  // Number('abc') → NaN → Number.isFinite false → gate does not fire (fail open).
  const rt = makeRuntime([
    ['/api/v1/harvest/state', () => harvestState(0)],
    ['/api/v1/harvest/fomc', () => fomcStatus(false)],
    ['/api/v1/econ/blackout', () => blackoutOff()],
    ['/api/v1/harvest/expirations/SPY', () => harvestExpiration()],
    [/^\/api\/v1\/options\/chain\/SPY/, () => chainNonEmpty()],
    ['/api/v1/iv/SPY', () => ({ data: { current_iv: 0.20, realized_vol_20d: 0.10, iv_minus_rv: 0.10, days_of_history: 'abc' } })],
  ]);
  const r = await withFrozenTime(ET_OPEN, () => resolvePreflight('harvest', rt, {}));
  assert.equal(r.skip, false);
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `node --test agent/preflight.test.mjs`
Expected: the two `→ skip` tests FAIL (currently `skip` is `false` — the gate doesn't exist yet; the fall-through reason is "no open condors but chain data available"). The `≥ 20` and `malformed` tests already PASS (they assert the current fall-through behavior).

- [ ] **Step 3: Add the `MIN_IV_HISTORY_DAYS` constant**

In `agent/preflight.js`, immediately before `async function harvestPreflight(runtime, agentConfig) {`, add:

```js
// Minimum days of stored ATM-IV history before IVR is meaningful. Below this,
// calcIVR floors at 0 for every underlying (the trailing-52-week range spans
// too few days), so no condor can clear the IVR ≥ 30 entry gate and the LLM
// beat is a guaranteed no-op. Matches the days_of_history < 20 low-confidence
// convention used by Prophet's IV-rank gate (TRADING_RULES_V2.md).
const MIN_IV_HISTORY_DAYS = 20;
```

- [ ] **Step 4: Add the history gate inside the existing IV block**

In `agent/preflight.js`, replace this exact block:

```js
  try {
    const ivResp = await goAxios.get('/api/v1/iv/SPY');
    const rv = Number(ivResp.data?.realized_vol_20d);
    const spread = Number(ivResp.data?.iv_minus_rv);
```

with:

```js
  try {
    const ivResp = await goAxios.get('/api/v1/iv/SPY');
    // Insufficient IV history → IVR is floored at 0 across the universe, so no
    // condor can clear IVR ≥ 30. Checked before the IV-RV gate because it is the
    // more fundamental blocker. SPY's count is a safe proxy here: this gate is
    // only active during the first ~20 trading days of collection, when all
    // underlyings climb in lockstep from a shared start (see the design doc's
    // correct-by-construction argument). Malformed/missing field → NaN → fail
    // open (run the LLM).
    const daysHist = Number(ivResp.data?.days_of_history);
    if (Number.isFinite(daysHist) && daysHist < MIN_IV_HISTORY_DAYS) {
      return {
        skip: true,
        reason: `insufficient IV history (SPY ${daysHist}d < ${MIN_IV_HISTORY_DAYS}) — IVR floored at 0, no condor entries possible`,
      };
    }
    const rv = Number(ivResp.data?.realized_vol_20d);
    const spread = Number(ivResp.data?.iv_minus_rv);
```

(The rest of the block — the `if (rv > 0 ...)` check and the `catch` — is unchanged.)

- [ ] **Step 5: Run the new tests to verify they pass**

Run: `node --test agent/preflight.test.mjs`
Expected: all four new tests PASS.

- [ ] **Step 6: Run the full preflight suite to verify no regressions**

Run: `node --test agent/preflight.test.mjs`
Expected: entire file PASSES. In particular the existing harvest IV/RV gate tests still pass unchanged — their `/api/v1/iv/SPY` mocks omit `days_of_history`, so `Number(undefined)` → `NaN` → the new gate does not fire and prior behavior is preserved.

- [ ] **Step 7: Commit**

```bash
git add agent/preflight.js agent/preflight.test.mjs
git commit -m "feat(harvest): skip preflight beat during IV warm-up (days_of_history < 20)

When SPY's days_of_history is below 20, calcIVR floors at 0 for the whole
universe, so no condor can clear the IVR >= 30 entry gate — the LLM beat is a
guaranteed no-op. Read days_of_history from the /api/v1/iv/SPY response the
predicate already fetches (zero new API calls) and skip. Self-disables once IV
history warms up. Threshold matches Prophet's existing days_of_history < 20
low-confidence convention.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: Prophet pre-market cadence nudge (docs)

**Files:**
- Modify: `TRADING_RULES_V2.md` (insert a new section after the "Beat Context Block" section, before "## Position Sizing")

No code, no test. Verification is a re-read.

- [ ] **Step 1: Add the `## Heartbeat Cadence` section**

In `TRADING_RULES_V2.md`, replace this exact text:

```
fall back to the corresponding tool call (the rule's existing fail-closed
policy still applies on tool error).

---

## Position Sizing
```

with:

```
fall back to the corresponding tool call (the rule's existing fail-closed
policy still applies on tool error).

---

## Heartbeat Cadence

The harness automatically fires a beat at every phase boundary, including the
09:30 ET market open — that wake is guaranteed regardless of your current
heartbeat interval. Do **not** tighten your heartbeat during pre-market to
"land cleanly at the open"; you will be woken at the open for free. When you are
flat pre-market with no actionable catalyst, hold the default pre-market cadence
(~15 min). Tighten only when you are managing an open position or reacting to a
live, time-sensitive catalyst.

---

## Position Sizing
```

- [ ] **Step 2: Verify the section reads correctly in context**

Run: `node --test agent/preflight.test.mjs` (sanity: confirms nothing else broke — docs-only change, suite stays green)
Then re-read the new section in `TRADING_RULES_V2.md` and confirm it sits cleanly between "## Beat Context Block" and "## Position Sizing" with intact `---` separators on both sides.

- [ ] **Step 3: Commit**

```bash
git add TRADING_RULES_V2.md
git commit -m "docs(rules): tell Prophet the harness wakes it at the open

Prophet was tightening its pre-market heartbeat to 'land cleanly at the open',
but the harness phase-boundary snap already fires a beat at 09:30 ET regardless
of interval — the tightening burned redundant no-op beats. Add a Heartbeat
Cadence section closing that information gap: hold default pre-market cadence
when flat; tighten only for an open position or live catalyst.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Final verification (after both tasks)

- [ ] `node --test agent/preflight.test.mjs` — entire suite green.
- [ ] `git log --oneline -3` — shows the two feature commits on top of the spec commit, branch `noop-premarket-beat-reduction`.
- [ ] Post-merge observation (manual, not part of this branch): Harvest emits `beat_skip` with the "insufficient IV history" reason instead of running full beats; Prophet no longer ratchets its pre-market interval below the default when flat (escalation trigger: >2 tightening days in the first 10 trading days → ship the harness cadence floor).
