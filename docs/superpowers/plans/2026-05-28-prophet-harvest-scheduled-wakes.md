# Prophet & Harvest pre-market scheduled wakes — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce Prophet (~22/day) and Harvest (~5/day) pre-market LLM beats to exactly 2/day each (09:15 ET scheduled wake + 09:30 ET phase-snap), by introducing two reusable harness features.

**Architecture:** Two independent, composable opt-in config fields wired into the existing `_scheduleNext` clamping logic. (1) `scheduledBeats.exclusive: false` activates a new "additive mode" that clamps the next-wake calculation to a scheduled time if it lands sooner than the phase cadence. (2) `suppressPhaseSnaps: ['phaseName']` opts an agent out of the phase-boundary snap that enters the listed phase(s). Existing exclusive-mode users (Coil, Drift, Trend) and non-scheduledBeats users (Penny, Mean-rev) are untouched because both paths are gated on explicit config presence. Full design at `docs/superpowers/specs/2026-05-28-prophet-harvest-scheduled-wakes-design.md`.

**Tech Stack:** Node.js, `node:test` framework, plain ESM. No new dependencies. All changes in `agent/harness.js` (logic), `agent/config-store.js` (agent configs), `TRADING_RULES_V2.md` (rules prose), with parallel test files `agent/harness.test.mjs` and `agent/config-store.test.mjs`.

---

## File Structure

**Modified files:**

- `agent/harness.js` — Add one new top-level pure export (`nextPhaseBoundary`) mirroring the existing `secondsToNextPhaseBoundary` but returning `{seconds, phase}`. Add one new instance method (`_getNextPhaseBoundary`). Modify `_scheduleNext` with two new conditional blocks (suppression check + additive scheduledBeats clamp).
- `agent/config-store.js` — Add `heartbeatOverrides.pre_market: 86400`, `scheduledBeats`, and `suppressPhaseSnaps` to Prophet (`id: 'default'`) and Harvest (`id: 'harvest'`) config records.
- `TRADING_RULES_V2.md` — Rewrite the `## Heartbeat Cadence` section.

**Modified test files:**

- `agent/harness.test.mjs` — 7 new test cases covering: pure `nextPhaseBoundary` helper, `suppressPhaseSnaps` suppression, `suppressPhaseSnaps` scoping, additive scheduledBeats clamp, additive when scheduled is later (regression), exclusive mode preserved (regression), no-config behavior preserved (regression).
- `agent/config-store.test.mjs` — 3 sanity assertions on the Prophet and Harvest config shapes.

**No new files.**

Boundaries: `nextPhaseBoundary` lives next to `secondsToNextPhaseBoundary` at `harness.js:49-82` because they share lookup data (`PHASE_DEFAULTS` ranges, 8-day weekend/holiday skip). `_getNextPhaseBoundary` is the instance-method wrapper, parallel to the existing `_getSecondsToNextPhaseBoundary` at `harness.js:760-762`. The two new `_scheduleNext` blocks go between the existing boundary-clamp at `harness.js:847-856` and the timer-set at `harness.js:857-860`.

---

## Task 1: Add `nextPhaseBoundary(now)` pure helper

**Files:**
- Modify: `agent/harness.js` (add export after the existing `secondsToNextPhaseBoundary` function at line 82)
- Test: `agent/harness.test.mjs` (add 3 test cases at top of file, after the existing `secondsToNextPhaseBoundary` tests at line ~31)

- [ ] **Step 1: Write the failing tests**

Add to `agent/harness.test.mjs` after the existing `secondsToNextPhaseBoundary` tests:

```javascript
// nextPhaseBoundary returns both seconds and the phase the boundary enters.
// Reuses the same 8-day ET lookahead + weekend/holiday skip as secondsToNextPhaseBoundary.

import { nextPhaseBoundary } from './harness.js';

test('nextPhaseBoundary: weekday before a later boundary returns {seconds, phase}', () => {
  // Thu 2026-05-21 13:00Z = 09:00 ET. Next boundary 09:30 = market_open. 30 min.
  const result = nextPhaseBoundary(new Date('2026-05-21T13:00:00Z'));
  assert.deepEqual(result, { seconds: 30 * 60, phase: 'market_open' });
});

test('nextPhaseBoundary: weekday after the last boundary looks ahead to next day pre_market', () => {
  // Thu 2026-05-21 21:00Z = 17:00 ET. Next boundary = Fri 04:00 = pre_market. 11h.
  const result = nextPhaseBoundary(new Date('2026-05-21T21:00:00Z'));
  assert.deepEqual(result, { seconds: 11 * 3600, phase: 'pre_market' });
});

test('nextPhaseBoundary: weekend looks ahead to Monday 04:00 pre_market', () => {
  // Sun 2026-05-17 23:00Z = 19:00 ET. Next boundary = Mon 04:00 ET = pre_market. 9h.
  const result = nextPhaseBoundary(new Date('2026-05-17T23:00:00Z'));
  assert.deepEqual(result, { seconds: 9 * 3600, phase: 'pre_market' });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test agent/harness.test.mjs`
Expected: 3 new tests fail with `SyntaxError: The requested module './harness.js' does not provide an export named 'nextPhaseBoundary'`. (Existing tests still pass.)

- [ ] **Step 3: Implement the helper**

Add to `agent/harness.js` immediately after `secondsToNextPhaseBoundary` (line 82, before `// buildGuardrailBlock` at line 84):

```javascript
// nextPhaseBoundary returns the next phase boundary as `{seconds, phase}`,
// where `phase` is the phase that boundary ENTERS. Parallels
// secondsToNextPhaseBoundary's logic (8-day lookahead, weekend + holiday skip)
// but pairs each boundary with its target phase so suppressPhaseSnaps can be
// applied selectively. Pure (takes `now`) for testability.
export function nextPhaseBoundary(now) {
  const dayName = now.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long' });
  const dayMap = { Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6, Sunday: 7 };
  const nowDow = dayMap[dayName] || 1;
  const etStr = now.toLocaleTimeString('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const [h, m, s] = etStr.split(':').map(Number);
  const nowSecs = h * 3600 + m * 60 + s;

  // [{phase, startSec}], sorted by startSec ascending
  const boundaries = Object.entries(PHASE_DEFAULTS)
    .filter(([, cfg]) => cfg.range)
    .map(([phase, cfg]) => ({ phase, startSec: cfg.range[0] * 60 }))
    .sort((a, b) => a.startSec - b.startSec);

  for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
    const dow = ((nowDow - 1 + dayOffset) % 7) + 1;
    if (dow === 6 || dow === 7) continue;
    if (isMarketHoliday(new Date(now.getTime() + dayOffset * 86400 * 1000))) continue;
    for (const { phase, startSec } of boundaries) {
      const offset = dayOffset * 86400 + startSec - nowSecs;
      if (offset > 0) return { seconds: offset, phase };
    }
  }
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test agent/harness.test.mjs`
Expected: All tests pass (including the 3 new ones + every prior test).

- [ ] **Step 5: Commit**

```bash
git add agent/harness.js agent/harness.test.mjs
git commit -m "feat(harness): add nextPhaseBoundary helper returning {seconds, phase}"
```

---

## Task 2: Add `_getNextPhaseBoundary` instance method

**Files:**
- Modify: `agent/harness.js` (add method next to existing `_getSecondsToNextPhaseBoundary` at line 760-762)

- [ ] **Step 1: No test needed for this thin wrapper**

This is a one-line pass-through to the pure helper, identical in shape to the existing `_getSecondsToNextPhaseBoundary` at line 760-762. The pure helper is already covered by Task 1's tests. The wrapper exists so `_scheduleNext` can be tested by monkey-patching the method (the pattern used elsewhere in the test file).

- [ ] **Step 2: Implement the wrapper**

Insert into `agent/harness.js` immediately after `_getSecondsToNextPhaseBoundary` at line 762:

```javascript
  _getNextPhaseBoundary() {
    return nextPhaseBoundary(new Date());
  }
```

- [ ] **Step 3: Verify existing tests still pass**

Run: `node --test agent/harness.test.mjs`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add agent/harness.js
git commit -m "feat(harness): add _getNextPhaseBoundary instance wrapper"
```

---

## Task 3: Wire `suppressPhaseSnaps` into `_scheduleNext`

**Files:**
- Modify: `agent/harness.js` (`_scheduleNext` at line 825-861)
- Test: `agent/harness.test.mjs` (add 2 test cases at end of file)

- [ ] **Step 1: Write the failing tests**

Add to `agent/harness.test.mjs` at end of file:

```javascript
// _scheduleNext: suppressPhaseSnaps opts an agent out of the phase-boundary
// snap into the listed phases, letting the next wake fall on cadence (or a
// later scheduled time) instead.

test('_scheduleNext: suppressPhaseSnaps=["pre_market"] skips a pre_market boundary snap', () => {
  const phaseRef = { phase: 'closed' };
  const h = makeHarness(phaseRef, { closed: 28800, pre_market: 900 });
  h._agentConfig = { suppressPhaseSnaps: ['pre_market'] };
  h.state.running = true;
  // Mock helpers: next boundary is 60s away into pre_market (would normally clamp seconds=60)
  h._getNextPhaseBoundary = () => ({ seconds: 60, phase: 'pre_market' });
  let scheduled;
  h.state.on('schedule', (d) => { scheduled = d; });
  h._scheduleNext();
  clearTimeout(h._timer);
  // Without suppression, seconds would clamp to 60 (the boundary). With suppression
  // we fall through to phase-cadence (closed=28800).
  assert.equal(scheduled.seconds, 28800, 'pre_market boundary snap should be suppressed');
});

test('_scheduleNext: suppressPhaseSnaps=["pre_market"] does NOT suppress market_open boundary', () => {
  const phaseRef = { phase: 'pre_market' };
  const h = makeHarness(phaseRef, { closed: 28800, pre_market: 900, market_open: 120 });
  h._agentConfig = { suppressPhaseSnaps: ['pre_market'] };
  h.state.running = true;
  // Next boundary is 60s away into market_open (NOT in suppressPhaseSnaps list)
  h._getNextPhaseBoundary = () => ({ seconds: 60, phase: 'market_open' });
  let scheduled;
  h.state.on('schedule', (d) => { scheduled = d; });
  h._scheduleNext();
  clearTimeout(h._timer);
  // market_open boundary should still clamp seconds to 60
  assert.equal(scheduled.seconds, 60, 'market_open boundary should still snap');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test agent/harness.test.mjs`
Expected: Both new tests fail. The first fails because the boundary clamp at line 850 ignores `suppressPhaseSnaps`, so `scheduled.seconds === 60` (the boundary clamp) instead of 28800. The second test passes accidentally (no suppression match), but writing it first ensures the suppression we add doesn't over-apply.

- [ ] **Step 3: Implement the suppression logic in `_scheduleNext`**

In `agent/harness.js` find the existing boundary-clamp block inside `_scheduleNext` (line numbers will have shifted after Task 1; grep `let seconds = this._getHeartbeatSeconds` to locate it). Replace this block:

```javascript
    let seconds = this._getHeartbeatSeconds();
    // Fire at phase boundaries so agents always wake at market open, market close, etc.
    const secsToBoundary = this._getSecondsToNextPhaseBoundary();
    if (secsToBoundary !== null && secsToBoundary > 10 && secsToBoundary < seconds) {
      seconds = secsToBoundary;
      this.state.emit('agent_log', {
        message: `Phase transition in ${Math.round(seconds)}s — scheduling early heartbeat.`,
        level: 'info',
      });
    }
```

…with:

```javascript
    let seconds = this._getHeartbeatSeconds();
    // Fire at phase boundaries so agents always wake at market open, market close, etc.
    // `suppressPhaseSnaps` opts an agent out of the snap into specific phases
    // (e.g. Prophet/Harvest skip the 04:00 pre_market boundary because their
    // explicit 09:15 scheduledBeats wake covers pre-open context).
    const nextBoundary = this._getNextPhaseBoundary();
    const suppressed = this._agentConfig?.suppressPhaseSnaps || [];
    const boundarySuppressed = nextBoundary && suppressed.includes(nextBoundary.phase);
    if (!boundarySuppressed && nextBoundary && nextBoundary.seconds > 10 && nextBoundary.seconds < seconds) {
      seconds = nextBoundary.seconds;
      this.state.emit('agent_log', {
        message: `Phase transition in ${Math.round(seconds)}s — scheduling early heartbeat.`,
        level: 'info',
      });
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test agent/harness.test.mjs`
Expected: All tests pass. Specifically the suppression test now sees `scheduled.seconds === 28800` (boundary skipped, cadence wins).

- [ ] **Step 5: Commit**

```bash
git add agent/harness.js agent/harness.test.mjs
git commit -m "feat(harness): suppressPhaseSnaps config opts agents out of selected phase-boundary snaps"
```

---

## Task 4: Wire additive scheduledBeats into `_scheduleNext`

**Files:**
- Modify: `agent/harness.js` (`_scheduleNext` after the boundary-clamp block updated in Task 3)
- Test: `agent/harness.test.mjs` (add 3 test cases at end of file)

- [ ] **Step 1: Write the failing tests**

Add to `agent/harness.test.mjs` at end of file:

```javascript
// _scheduleNext: scheduledBeats with exclusive=false adds wakes on top of phase
// cadence, clamping next wake if a scheduled time arrives sooner. The pre-existing
// exclusive=true mode (Coil/Drift/Trend) replaces phases entirely and runs BEFORE
// this code path.

test('_scheduleNext: additive scheduledBeats clamps to scheduled time when sooner than cadence', () => {
  const phaseRef = { phase: 'pre_market' };
  const h = makeHarness(phaseRef, { pre_market: 86400 });
  h._agentConfig = {
    scheduledBeats: { times: ['09:15'], weekdaysOnly: true, exclusive: false },
  };
  h.state.running = true;
  // Mock helpers: no boundary in play (phase cadence dominates), scheduled wake 900s away
  h._getNextPhaseBoundary = () => null;
  h._getSecondsToNextScheduledBeat = () => 900;
  let scheduled;
  h.state.on('schedule', (d) => { scheduled = d; });
  h._scheduleNext();
  clearTimeout(h._timer);
  // Cadence=86400, scheduled=900, so scheduled wins
  assert.equal(scheduled.seconds, 900, 'additive scheduled wake should clamp the next beat');
});

test('_scheduleNext: additive scheduledBeats does not interfere when scheduled time is later than cadence', () => {
  const phaseRef = { phase: 'market_open' };
  const h = makeHarness(phaseRef, { market_open: 120 });
  h._agentConfig = {
    scheduledBeats: { times: ['09:15'], weekdaysOnly: true, exclusive: false },
  };
  h.state.running = true;
  h._getNextPhaseBoundary = () => null;
  h._getSecondsToNextScheduledBeat = () => 3600;  // Way later than 120s cadence
  let scheduled;
  h.state.on('schedule', (d) => { scheduled = d; });
  h._scheduleNext();
  clearTimeout(h._timer);
  // Cadence=120, scheduled=3600, so cadence wins
  assert.equal(scheduled.seconds, 120, 'phase cadence should win when scheduled time is later');
});

test('_scheduleNext: agent with no scheduledBeats falls through to phase cadence + boundary clamp as before', () => {
  const phaseRef = { phase: 'pre_market' };
  const h = makeHarness(phaseRef, { pre_market: 900 });
  h._agentConfig = {};  // No scheduledBeats, no suppressPhaseSnaps
  h.state.running = true;
  h._getNextPhaseBoundary = () => ({ seconds: 1800, phase: 'market_open' });
  // No _getSecondsToNextScheduledBeat mock — should not be called
  let getScheduledCalls = 0;
  h._getSecondsToNextScheduledBeat = () => { getScheduledCalls++; return null; };
  let scheduled;
  h.state.on('schedule', (d) => { scheduled = d; });
  h._scheduleNext();
  clearTimeout(h._timer);
  // Cadence=900, boundary=1800 → cadence wins (boundary > cadence)
  assert.equal(scheduled.seconds, 900, 'phase cadence wins when boundary is further out');
  assert.equal(getScheduledCalls, 0, 'additive scheduledBeats helper should not be called without config');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test agent/harness.test.mjs`
Expected: First test fails (cadence=86400 returned, no clamping to 900s yet). Second and third pass accidentally (no additive code yet); they encode the regression promise.

- [ ] **Step 3: Implement the additive block in `_scheduleNext`**

In `agent/harness.js`, insert immediately AFTER the (already-modified) boundary clamp block from Task 3, and BEFORE the line `this.state.heartbeatSeconds = seconds;`:

```javascript
    // Additive scheduledBeats (exclusive=false): a scheduled wake adds an extra
    // beat on top of the phase cadence. If the scheduled time lands before the
    // next cadence/boundary wake, clamp to it. Exclusive-mode scheduledBeats
    // (Coil/Drift/Trend) already returned at line ~840 and never reach here.
    const sb = this._agentConfig?.scheduledBeats;
    if (sb && !sb.exclusive && sb.times?.length) {
      const secsToScheduled = this._getSecondsToNextScheduledBeat();
      if (secsToScheduled !== null && secsToScheduled > 10 && secsToScheduled < seconds) {
        seconds = secsToScheduled;
        this.state.emit('agent_log', {
          message: `Scheduled wake in ${Math.round(seconds)}s — clamping next beat.`,
          level: 'info',
        });
      }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test agent/harness.test.mjs`
Expected: All tests pass. The additive clamp test now sees `scheduled.seconds === 900`.

- [ ] **Step 5: Add a regression test for exclusive mode preservation**

Add to `agent/harness.test.mjs` at end of file:

```javascript
test('_scheduleNext: exclusive scheduledBeats still replaces phase cadence entirely (Coil-style)', () => {
  const phaseRef = { phase: 'closed' };
  const h = makeHarness(phaseRef, { closed: 28800 });
  h._agentConfig = {
    scheduledBeats: { times: ['15:45'], weekdaysOnly: true, exclusive: true, windowMinutes: 5 },
  };
  h.state.running = true;
  // The exclusive path uses _getSecondsToNextScheduledBeat directly and returns
  // BEFORE reaching the cadence/boundary logic. Mock it to a known value.
  h._getSecondsToNextScheduledBeat = () => 7200;  // 2h away
  let scheduled;
  h.state.on('schedule', (d) => { scheduled = d; });
  h._scheduleNext();
  clearTimeout(h._timer);
  // Exclusive mode: schedules at the scheduled time, ignoring phase cadence (28800)
  assert.equal(scheduled.seconds, 7200, 'exclusive scheduledBeats should drive the schedule');
});
```

- [ ] **Step 6: Run tests to verify all pass**

Run: `node --test agent/harness.test.mjs`
Expected: All tests pass, including the new exclusive-mode regression check.

- [ ] **Step 7: Commit**

```bash
git add agent/harness.js agent/harness.test.mjs
git commit -m "feat(harness): additive scheduledBeats mode (exclusive=false) adds wakes on top of phase cadence"
```

---

## Task 5: Update Prophet config (id='default')

**Files:**
- Modify: `agent/config-store.js:180-190` (Prophet config record)
- Test: `agent/config-store.test.mjs` (add 1 test case)

- [ ] **Step 1: Write the failing test**

Add to `agent/config-store.test.mjs` at end of file:

```javascript
test('default agent (Prophet) has additive scheduledBeats and suppresses pre_market snap', async () => {
  const cfg = await cfgStore.loadConfig();
  const agents = cfg.agents;
  const prophet = agents.find(a => a.id === 'default');
  assert.ok(prophet, 'Prophet agent (id=default) should exist');
  assert.equal(prophet.heartbeatOverrides?.pre_market, 86400, 'pre_market cadence should be 24h (silenced)');
  assert.deepEqual(prophet.scheduledBeats?.times, ['09:15'], 'should have 09:15 scheduled wake');
  assert.equal(prophet.scheduledBeats?.exclusive, false, 'scheduledBeats should be additive');
  assert.equal(prophet.scheduledBeats?.weekdaysOnly, true, 'scheduledBeats should be weekdays-only');
  assert.deepEqual(prophet.suppressPhaseSnaps, ['pre_market'], 'should suppress 04:00 pre_market snap');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test agent/config-store.test.mjs`
Expected: Test fails at first assertion (`heartbeatOverrides.pre_market` is undefined — Prophet currently has `heartbeatOverrides: {}`).

- [ ] **Step 3: Update Prophet config**

In `agent/config-store.js:180-190`, change:

```javascript
    {
      id: 'default',
      name: 'Prophet',
      description: 'Aggressive discretionary options trader with scalping overlay',
      systemPromptTemplate: 'default',
      strategyId: 'v2-options',
      model: 'anthropic/claude-sonnet-4-6',
      heartbeatOverrides: {},
      customSystemPrompt: '',
      createdAt: new Date().toISOString(),
    },
```

…to:

```javascript
    {
      id: 'default',
      name: 'Prophet',
      description: 'Aggressive discretionary options trader with scalping overlay',
      systemPromptTemplate: 'default',
      strategyId: 'v2-options',
      model: 'anthropic/claude-sonnet-4-6',
      // Pre-market: only fire the 09:15 scheduled wake + 09:30 phase-snap.
      // Cadence 86400 silences intra-phase ticks; suppressPhaseSnaps skips the
      // 04:00 boundary; scheduledBeats adds the 09:15 wake.
      // See docs/superpowers/specs/2026-05-28-prophet-harvest-scheduled-wakes-design.md
      heartbeatOverrides: { pre_market: 86400 },
      scheduledBeats: {
        times: ['09:15'],
        weekdaysOnly: true,
        exclusive: false,
      },
      suppressPhaseSnaps: ['pre_market'],
      customSystemPrompt: '',
      createdAt: new Date().toISOString(),
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test agent/config-store.test.mjs`
Expected: All tests pass, including the new Prophet config assertion.

- [ ] **Step 5: Commit**

```bash
git add agent/config-store.js agent/config-store.test.mjs
git commit -m "config(prophet): pre_market only fires 09:15 scheduled wake + 09:30 snap"
```

---

## Task 6: Update Harvest config

**Files:**
- Modify: `agent/config-store.js:192-215` (Harvest config record)
- Test: `agent/config-store.test.mjs` (add 1 test case)

- [ ] **Step 1: Write the failing test**

Add to `agent/config-store.test.mjs` at end of file:

```javascript
test('harvest agent has additive scheduledBeats and suppresses pre_market snap', async () => {
  const cfg = await cfgStore.loadConfig();
  const agents = cfg.agents;
  const harvest = agents.find(a => a.id === 'harvest');
  assert.ok(harvest, 'Harvest agent should exist');
  assert.equal(harvest.heartbeatOverrides?.pre_market, 86400, 'pre_market cadence should be 24h (silenced)');
  assert.equal(harvest.heartbeatOverrides?.market_open, 900, 'market_open cadence should be unchanged');
  assert.deepEqual(harvest.scheduledBeats?.times, ['09:15'], 'should have 09:15 scheduled wake');
  assert.equal(harvest.scheduledBeats?.exclusive, false, 'scheduledBeats should be additive');
  assert.deepEqual(harvest.suppressPhaseSnaps, ['pre_market'], 'should suppress 04:00 pre_market snap');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test agent/config-store.test.mjs`
Expected: Test fails — Harvest's `pre_market` is currently 3600 (not 86400), and `scheduledBeats`/`suppressPhaseSnaps` don't exist.

- [ ] **Step 3: Update Harvest config**

In `agent/config-store.js:192-215`, change the `heartbeatOverrides` block and add `scheduledBeats` + `suppressPhaseSnaps`:

```javascript
      model: 'anthropic/claude-sonnet-4-6',
      heartbeatOverrides: {
        pre_market: 3600,
        market_open: 900,
        midday: 900,
        market_close: 900,
        after_hours: 7200,
        closed: 28800,
      },
      createdAt: new Date().toISOString(),
    },
```

…to:

```javascript
      model: 'anthropic/claude-sonnet-4-6',
      // Pre-market: only fire the 09:15 scheduled wake + 09:30 phase-snap.
      // Harvest cannot trade pre-market (options market opens 09:30) and its
      // IV-based entry signals are daily-bar, so a single pre-open wake is
      // sufficient. Same pattern as Prophet.
      // See docs/superpowers/specs/2026-05-28-prophet-harvest-scheduled-wakes-design.md
      heartbeatOverrides: {
        pre_market: 86400,
        market_open: 900,
        midday: 900,
        market_close: 900,
        after_hours: 7200,
        closed: 28800,
      },
      scheduledBeats: {
        times: ['09:15'],
        weekdaysOnly: true,
        exclusive: false,
      },
      suppressPhaseSnaps: ['pre_market'],
      createdAt: new Date().toISOString(),
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test agent/config-store.test.mjs`
Expected: All tests pass, including the new Harvest config assertion.

- [ ] **Step 5: Commit**

```bash
git add agent/config-store.js agent/config-store.test.mjs
git commit -m "config(harvest): pre_market only fires 09:15 scheduled wake + 09:30 snap"
```

---

## Task 7: Verify no regression in Penny / Coil / Drift / Trend / Mean-rev configs

**Files:**
- Test: `agent/config-store.test.mjs` (add 1 regression test)

- [ ] **Step 1: Write the regression test**

Add to `agent/config-store.test.mjs` at end of file:

```javascript
test('non-Prophet/Harvest agents do NOT have the new pre-market scheduled-wake fields', async () => {
  const cfg = await cfgStore.loadConfig();
  const agents = cfg.agents;

  // Penny: phase cadence only, no scheduledBeats, no suppressPhaseSnaps
  const penny = agents.find(a => a.id === 'penny-prophet');
  assert.ok(penny, 'PennyProphet should exist');
  assert.equal(penny.scheduledBeats, undefined, 'Penny should have no scheduledBeats');
  assert.equal(penny.suppressPhaseSnaps, undefined, 'Penny should not suppress any phase snaps');
  assert.equal(penny.heartbeatOverrides?.pre_market, 900, 'Penny pre_market cadence unchanged');

  // Coil: exclusive scheduledBeats (15:45) — must NOT flip to non-exclusive
  const coil = agents.find(a => a.id === 'mean-rev');
  assert.ok(coil, 'Coil should exist');
  assert.equal(coil.scheduledBeats?.exclusive, true, 'Coil must remain exclusive-mode');
  assert.equal(coil.suppressPhaseSnaps, undefined, 'Coil should not suppress any phase snaps');
});
```

- [ ] **Step 2: Run test to verify it passes (no implementation change needed)**

Run: `node --test agent/config-store.test.mjs`
Expected: All tests pass. This task purely encodes a "nothing else moved" invariant.

- [ ] **Step 3: Commit**

```bash
git add agent/config-store.test.mjs
git commit -m "test(config): regression — non-Prophet/Harvest agents unchanged"
```

---

## Task 8: Rewrite TRADING_RULES_V2.md Heartbeat Cadence section

**Files:**
- Modify: `TRADING_RULES_V2.md:33-41`

- [ ] **Step 1: No code test — manual prose verification**

Rules-prose updates don't get unit tests in this codebase. Verification is by reading the rendered prose and confirming it matches the new harness behavior.

- [ ] **Step 2: Apply the prose edit**

In `TRADING_RULES_V2.md`, find lines 33-41 (the `## Heartbeat Cadence` section):

```markdown
## Heartbeat Cadence

The harness automatically fires a beat at every phase boundary, including the
09:30 ET market open — that wake is guaranteed regardless of your current
heartbeat interval. Do **not** tighten your heartbeat during pre-market to
"land cleanly at the open"; you will be woken at the open for free. When you are
flat pre-market with no actionable catalyst, hold the default pre-market cadence
(~15 min). Tighten only when you are managing an open position or reacting to a
live, time-sensitive catalyst.
```

Replace with:

```markdown
## Heartbeat Cadence

Pre-market has two wakes, both harness-scheduled: 09:15 ET (the pre-open
context beat — futures settled, European close digested, last analyst notes)
and 09:30 ET (market open). The 04:00 ET pre-market phase boundary is
suppressed — your day starts at 09:15.

`set_heartbeat` calls during pre-market have no effect on these scheduled
wakes. Do not attempt to tighten heartbeat in pre-market.

Use the 09:15 wake as your pre-open thesis lock. Tighten heartbeat only after
the open, when managing a position or reacting to a live, time-sensitive
catalyst.
```

- [ ] **Step 3: Verify by re-reading the section**

Run: `head -50 TRADING_RULES_V2.md`
Expected: The new prose is in place, surrounding sections (`---`, `## Position Sizing`) intact.

- [ ] **Step 4: Commit**

```bash
git add TRADING_RULES_V2.md
git commit -m "docs(v2-rules): rewrite Heartbeat Cadence to match new pre-market wake schedule"
```

---

## Task 9: Full test-suite run + manual end-to-end smoke check

**Files:** No edits — verification only.

- [ ] **Step 1: Run the full project test suite**

Run: `npm test`
Expected: All tests pass. No regressions in agent/preflight, agent/harness, agent/config-store, agent/orchestrator-emergency, or any other test file. (The repo runs `node --test agent/**/*.test.mjs mcp-tools/**/*.test.mjs scripts/**/*.test.mjs` per `package.json:test`.)

- [ ] **Step 2: Confirm git log shows the expected commit sequence**

Run: `git log --oneline main..HEAD`
Expected: 8 commits on the `prophet-harvest-scheduled-wakes` branch, in order:
1. `docs(spec): Prophet/Harvest pre-market scheduled wakes` (from before this plan)
2. `feat(harness): add nextPhaseBoundary helper returning {seconds, phase}`
3. `feat(harness): add _getNextPhaseBoundary instance wrapper`
4. `feat(harness): suppressPhaseSnaps config opts agents out of selected phase-boundary snaps`
5. `feat(harness): additive scheduledBeats mode (exclusive=false) adds wakes on top of phase cadence`
6. `config(prophet): pre_market only fires 09:15 scheduled wake + 09:30 snap`
7. `config(harvest): pre_market only fires 09:15 scheduled wake + 09:30 snap`
8. `test(config): regression — non-Prophet/Harvest agents unchanged`
9. `docs(v2-rules): rewrite Heartbeat Cadence to match new pre-market wake schedule`

- [ ] **Step 3: Verify the final harness.js diff makes sense**

Run: `git diff main..HEAD -- agent/harness.js`
Expected: Three additions — the new `nextPhaseBoundary` export, the `_getNextPhaseBoundary` wrapper method, and the two new conditional blocks in `_scheduleNext`. The existing `_getSecondsToNextPhaseBoundary` method and `secondsToNextPhaseBoundary` export are unchanged.

- [ ] **Step 4: Confirm Prophet/Harvest configs render as expected**

Run: `node -e "import('./agent/config-store.js').then(async m => { m._setPathsForTests({ configPath: '/tmp/test-config.json', secretsPath: '/tmp/test-secrets.json' }); await m.loadConfig(); const agents = await m.listAgents(); const p = agents.find(a => a.id === 'default'); const h = agents.find(a => a.id === 'harvest'); console.log('Prophet:', JSON.stringify({ pre_market: p.heartbeatOverrides?.pre_market, scheduledBeats: p.scheduledBeats, suppressPhaseSnaps: p.suppressPhaseSnaps }, null, 2)); console.log('Harvest:', JSON.stringify({ pre_market: h.heartbeatOverrides?.pre_market, scheduledBeats: h.scheduledBeats, suppressPhaseSnaps: h.suppressPhaseSnaps }, null, 2)); })"`
Expected output:
```
Prophet: {
  "pre_market": 86400,
  "scheduledBeats": {
    "times": ["09:15"],
    "weekdaysOnly": true,
    "exclusive": false
  },
  "suppressPhaseSnaps": ["pre_market"]
}
Harvest: {
  "pre_market": 86400,
  "scheduledBeats": {
    "times": ["09:15"],
    "weekdaysOnly": true,
    "exclusive": false
  },
  "suppressPhaseSnaps": ["pre_market"]
}
```

- [ ] **Step 5: No commit needed — verification only**

If all steps above pass, the implementation is complete and ready to push as a PR to `NeverLucky2/ClaudeProphetAndFriends` against `main`.

---

## Notes for the implementer

- **Don't push until all 9 tasks are complete.** The user deploys by rebuilding from local `main`, so any commit not on `main` (or merged through it) is stranded until the PR lands. Push at the end of Task 9 with `git push -u origin prophet-harvest-scheduled-wakes`, then open the PR.
- **One squashed commit per backlog item** is the user's PR preference — when the PR is approved, squash-merge so all 8 implementation commits become one in `main`.
- **`scheduledBeats.exclusive: undefined` (omitted) now maps to additive mode** under this code. All current `scheduledBeats` users set `exclusive: true` explicitly so there is no regression, but new agents adding `scheduledBeats` should set `exclusive` to either `true` or `false` deliberately. The Task 7 regression test guards Coil and Penny against accidental flips.
- **The `_scheduleNext` modifications run only in non-exclusive paths.** Coil/Drift/Trend hit the exclusive-mode early-return at `agent/harness.js:840` and never reach the new code. Confirmed in the design spec's backward-compat table.
- **Tests use `clearTimeout(h._timer)` after `_scheduleNext()`** to prevent the scheduled callback from firing during the test. Match this pattern in all `_scheduleNext` tests.
