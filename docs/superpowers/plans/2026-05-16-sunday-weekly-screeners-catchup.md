# Sunday weekly_screeners startup catch-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `weekly_screeners` self-heal on startup when the bot was offline at Sunday 18:00 ET — mirroring the existing catch-up blocks for `daily_briefing` and `regime_gate_compute`.

**Architecture:** Extract the pure date/day-of-week gate into a named export `shouldTriggerWeeklyScreenerOnStartup({ dayOfWeek, isoDate, lastWeeklyScreenDate })` so it can be tested without booting the scheduler. Add a new section 1.6 catch-up block inside `runStartupChecks()` that calls the helper, then performs the async lock check + trigger using the same log strings as the regime_gate_compute block. Tick-based trigger at line 957 is left untouched as the primary path.

**Tech Stack:** Node.js, `node:test`, existing `agent/analysis-scheduler.js` module.

---

## Files

- Modify: `agent/analysis-scheduler.js`
  - Add named export `shouldTriggerWeeklyScreenerOnStartup` near the other top-level helpers (after `buildBubbleSkillAppendix`, line ~131, before the `AnalysisScheduler` class).
  - Inside `runStartupChecks()`, insert a new block (section "1.6 Weekly screeners catch-up") between the regime_gate_compute block (ends line 409) and the scenario_analysis block (starts line 411).
- Modify: `agent/analysis-scheduler.test.mjs`
  - Import the new helper and add a test group covering the three branches.

No changes to TRADING_RULES, no changes to persistence (`_lastWeeklyScreenDate` already exists at line 160 and is set+saved by `_runWeeklyScreeners`).

---

### Task 1: Add the pure helper + tests

**Files:**
- Modify: `agent/analysis-scheduler.js` (insert after line ~140, before `export class AnalysisScheduler`)
- Modify: `agent/analysis-scheduler.test.mjs` (add import + tests at end of file)

- [ ] **Step 1: Write the failing tests**

Append to `agent/analysis-scheduler.test.mjs`:

```js
test('shouldTriggerWeeklyScreenerOnStartup: true on Sunday when not yet run today', () => {
  assert.equal(
    shouldTriggerWeeklyScreenerOnStartup({
      dayOfWeek: 0,
      isoDate: '2026-05-17',
      lastWeeklyScreenDate: '2026-05-10',
    }),
    true,
  );
});

test('shouldTriggerWeeklyScreenerOnStartup: true on Sunday when state is null (fresh install)', () => {
  // Cold start with no persisted state must still trigger.
  assert.equal(
    shouldTriggerWeeklyScreenerOnStartup({
      dayOfWeek: 0,
      isoDate: '2026-05-17',
      lastWeeklyScreenDate: null,
    }),
    true,
  );
});

test('shouldTriggerWeeklyScreenerOnStartup: false on Sunday when already run today', () => {
  // Idempotency guard — running twice on the same Sunday would double-fire.
  assert.equal(
    shouldTriggerWeeklyScreenerOnStartup({
      dayOfWeek: 0,
      isoDate: '2026-05-17',
      lastWeeklyScreenDate: '2026-05-17',
    }),
    false,
  );
});

test('shouldTriggerWeeklyScreenerOnStartup: false on non-Sunday regardless of state', () => {
  // Verify the day gate dominates: even with stale state, weekdays/Saturday skip.
  for (const dayOfWeek of [1, 2, 3, 4, 5, 6]) {
    assert.equal(
      shouldTriggerWeeklyScreenerOnStartup({
        dayOfWeek,
        isoDate: '2026-05-16',
        lastWeeklyScreenDate: '2026-05-10',
      }),
      false,
      `dayOfWeek=${dayOfWeek} must not trigger`,
    );
  }
});
```

And update the top import to add `shouldTriggerWeeklyScreenerOnStartup`:

```js
import {
  buildRegimeComputeArgv,
  buildMacroRegimeArgv,
  buildBreadthSkillAppendix,
  buildMarketTopSkillAppendix,
  buildBubbleSkillAppendix,
  shouldTriggerWeeklyScreenerOnStartup,
  AnalysisScheduler,
} from './analysis-scheduler.js';
```

- [ ] **Step 2: Run tests, confirm they fail**

Run: `npm test`
Expected: the four new tests fail with `SyntaxError: ... does not provide an export named 'shouldTriggerWeeklyScreenerOnStartup'` (or equivalent). All pre-existing tests still pass.

- [ ] **Step 3: Implement the helper**

Insert into `agent/analysis-scheduler.js` between `buildBubbleSkillAppendix` (ends around line 140) and `export class AnalysisScheduler` (line 142):

```js
// Pure gate for the Sunday weekly_screeners startup catch-up. Returns true
// when the bot is starting up on a Sunday and weekly_screeners hasn't run yet
// that Sunday. No hour cap — Sunday 18:00 is the primary trigger; this catch-up
// must fire at any hour on Sunday if the primary was missed (including after
// 18:00, when the bot came back online late).
export function shouldTriggerWeeklyScreenerOnStartup({ dayOfWeek, isoDate, lastWeeklyScreenDate }) {
  return dayOfWeek === 0 && lastWeeklyScreenDate !== isoDate;
}
```

- [ ] **Step 4: Run tests, confirm they pass**

Run: `npm test`
Expected: all tests pass, including the four new ones.

---

### Task 2: Wire the helper into `runStartupChecks()`

**Files:**
- Modify: `agent/analysis-scheduler.js:409-411` (insert new block between the regime_gate_compute catch-up and the scenario_analysis catch-up)

- [ ] **Step 1: Add the catch-up block**

After the existing regime_gate_compute block (line 409, just before `// 2. Scenario analysis (state-based)`), insert:

```js
    // 1.6 Weekly screeners catch-up (state-based, Sunday-only) — catches the
    // case where the bot was offline at the Sunday 18:00 ET tick-trigger. No
    // hour cap on purpose: the user wants this to fire at any time on Sunday
    // if it hasn't run yet, including after 18:00.
    if (shouldTriggerWeeklyScreenerOnStartup({ dayOfWeek, isoDate, lastWeeklyScreenDate: this._lastWeeklyScreenDate })) {
      if (await this._isLocked(this._getLockKey('weekly_screeners', isoDate))) {
        this._log('Weekly screeners already running in another process — skipping startup trigger.', 'info');
      } else {
        this._log('No weekly_screeners for today — triggering now...', 'info');
        await this.triggerJob('weekly_screeners').catch(() => {});
      }
    }
```

- [ ] **Step 2: Run tests, confirm everything still passes**

Run: `npm test`
Expected: all tests pass. The helper-level tests already cover the gate; the integration wiring is small enough to verify by inspection.

- [ ] **Step 3: Manual sanity check**

Run: `node -e "const s = require('./agent/analysis-scheduler.js'); console.log(typeof s.shouldTriggerWeeklyScreenerOnStartup);"`
(If the file is ESM-only, skip — the test pass already proves the export works.)

---

### Task 3: Commit + push (after explicit user approval)

- [ ] **Step 1: Confirm we are on a fresh branch off main**

Run:
```bash
git status
git switch -c feat-sunday-weekly-screeners-catchup main
```
(Current branch is `plan-doc-item2-complete-and-env-docs`. Branch off `main` per workflow preference.)

- [ ] **Step 2: Stage + commit (one squashed commit)**

Run:
```bash
git add agent/analysis-scheduler.js agent/analysis-scheduler.test.mjs docs/superpowers/plans/2026-05-16-sunday-weekly-screeners-catchup.md
git commit -m "$(cat <<'EOF'
feat(scheduler): Sunday startup catch-up for weekly_screeners

weekly_screeners only fires on the exact Sunday-18:00-ET tick. If the
bot was offline at that minute, it silently waited a full week. Other
scheduler jobs (daily_briefing, regime_gate_compute, the four upstream
regime skills) already have startup catch-up blocks for this exact
reason — weekly_screeners was the asymmetric outlier.

Add a section 1.6 catch-up in runStartupChecks() that fires when
dayOfWeek === 0 and _lastWeeklyScreenDate !== isoDate. No hour cap —
also heals the case where the bot comes back online after 18:00 ET.
The lock check + log strings mirror the regime_gate_compute block.

The pure date gate is extracted as
shouldTriggerWeeklyScreenerOnStartup({ dayOfWeek, isoDate,
lastWeeklyScreenDate }) so it can be unit-tested without booting the
scheduler. Tests cover: Sunday with stale state, Sunday with null
state, Sunday already-ran (skip), and all six non-Sunday days (skip).

The existing tick-based trigger at line 957 is the primary path and is
unchanged.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: Wait for explicit user "push" approval before pushing**

Per workflow: do NOT push without confirmation.

---

## Edge cases

- **State is `null`** (fresh install / first-ever startup on Sunday): `null !== isoDate`, so the helper returns true. Covered by test 2.
- **Already triggered earlier today** (`_lastWeeklyScreenDate === isoDate`): returns false. Silent skip — matches the daily_briefing pattern, which only logs on the trigger or lock-collision paths. Covered by test 3.
- **Lock held by another process**: logs "already running in another process — skipping startup trigger." and does not call `triggerJob`. Same pattern as regime_gate_compute. (Lock check is async, lives in the scheduler block, not in the pure helper.)
- **Late Sunday restart (e.g. 22:00 ET)**: no hour cap, so it still fires. This is the bug we're fixing — explicitly tested by the fact that the helper does not reference hour.
- **Non-Sunday** (any weekday or Saturday): gate returns false. Covered by test 4.
- **Persistence after trigger**: `_runWeeklyScreeners` already sets `_lastWeeklyScreenDate = date` and calls `_saveState()` (no changes needed) — so the same Sunday won't double-fire even across restarts.

## Self-review

- **Spec coverage**: gate (`dayOfWeek === 0` ∧ state stale) ✓; lock check before trigger ✓; both log strings ✓; no hour cap ✓; tick-based trigger at 957 untouched ✓; test in `analysis-scheduler.test.mjs` ✓; pure helper preferred over integration ✓; branch off `main`, one squashed commit ✓; confirm before push ✓; no TRADING_RULES change ✓.
- **Placeholder scan**: none — every step has the actual code or command.
- **Type consistency**: helper name `shouldTriggerWeeklyScreenerOnStartup` is used identically in the export, the test import, and the scheduler call site.
