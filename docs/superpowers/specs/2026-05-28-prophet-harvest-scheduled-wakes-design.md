# Prophet & Harvest pre-market scheduled wakes — design

**Status:** Draft, awaiting implementation plan
**Date:** 2026-05-28
**Author:** Claude (paired with operator)
**Related:** [PR #66 no-op pre-market beat reduction](../../../memory/noop-premarket-beat-reduction-project.md), [opencode 5-min cache TTL](../../../memory/opencode-cache-ttl-hardcoded.md), [token-cost discipline pattern](../../../memory/architectural-patterns.md)

---

## Problem

Prophet currently fires ~22 LLM beats during pre-market (04:00–09:30 ET) at a 15-min cadence. Audit of a typical pre-market beat (5:29 AM ET, flat book, no actionable catalyst) shows: ~$0.26 API-equivalent cost, 231k tokens, output is a one-paragraph context summary the agent re-derives almost identically on every subsequent beat. Most of these beats are pure overhead — the agent reads the same overnight news, summarizes the same posture, and sleeps.

Harvest has a similar pattern at 1-hour cadence (~5 pre-market beats), but with an additional structural constraint: **Harvest physically cannot execute trades pre-market** (options market opens 09:30 ET), and its IV-based entry signals are computed from daily closes — they don't change intraday. Every Harvest pre-market beat is "look but can't act."

PR #66 shipped a soft prose constraint ("don't tighten heartbeat pre-market") to prevent the agent from making this worse. That worked — Prophet now reliably holds the 15-min default — but the default itself is too dense for the actual information density of early pre-market.

## Goals

1. Reduce Prophet pre-market wakes from ~22/day to **2/day** (09:15 + 09:30 phase-snap).
2. Reduce Harvest pre-market wakes from ~5/day to **2/day** (09:15 + 09:30 phase-snap) once IV-history warms up.
3. Cluster all pre-market context absorption into the high-information-density window (last 15 minutes before open: futures settled, European close digested, last analyst notes).
4. Introduce the mechanism as a **reusable harness feature**, not a Prophet-specific hack, so Penny / Drift / future agents can adopt the same pattern for pre-open or post-close context wakes.

## Non-goals

- Don't change `DEFAULT_HEARTBEAT.pre_market` (system-wide default stays 900s for any agent that doesn't opt in).
- Don't touch Penny, Coil, Trend, Drift, Mean-rev configs — each has its own deliberate cadence.
- Don't change market_open / midday / market_close cadences for any agent.
- Don't add multi-window support per agent (single `times[]` entry covers the current need; defer until a second use case emerges).
- Don't auto-derive `suppressPhaseSnaps` from `scheduledBeats` configuration — keep the two fields independent so a hypothetical future agent can have additive scheduled wakes AND keep its phase-snaps.

## Approach

The harness already has the `scheduledBeats` mechanism with helpers `_getSecondsToNextScheduledBeat()` and `_isWithinScheduledWindow()`. Today it only works in **`exclusive: true` mode** (Coil-style: scheduled times REPLACE phase cadence entirely, ignoring phase-boundary snaps).

The natural extension is **non-exclusive ("additive") mode**: scheduled wakes are added on top of phase cadence, clamping the next wake if a scheduled time arrives sooner than the cadence interval.

Combined with two other pieces, this gives Prophet and Harvest exactly the schedule we want:

1. **`scheduledBeats.exclusive: false`** — opt into additive scheduled wakes.
2. **`heartbeatOverrides.pre_market: 86400`** — silence intra-phase cadence ticks during pre-market.
3. **`suppressPhaseSnaps: ['pre_market']`** — opt out of the 04:00 pre_market phase-boundary snap.

All three are independent and composable. The mechanism is purely opt-in; no current agent's behavior changes unless we explicitly configure it.

### Resulting beat schedule (Prophet & Harvest)

| ET time | Source | Beat? |
|---|---|---|
| 04:00 | pre_market phase-snap | ❌ suppressed by `suppressPhaseSnaps` |
| ~04:00 (cadence-overflow) | `closed`-phase cadence (28800s) from Sunday-evening boundary | ✅ (preflight may still skip on holidays) |
| 04:00–09:14 | pre_market cadence = 86400 | — |
| **09:15** | **scheduled wake (additive)** | ✅ first beat of day, triggers `sessionMode: 'daily'` reset |
| 09:30 | market_open phase-snap | ✅ |
| 09:30+ | market_open cadence | normal |

**Net pre-market wakes: 3/day** (down from ~22 for Prophet, ~5 for Harvest).

> **Caveat — the unavoidable 04:00 wake.** The `suppressPhaseSnaps` field only
> kills the *phase-boundary snap* into pre_market. The previous evening's
> `closed`-phase cadence (28800s = 8h) still arrives at Monday/Tu/W/Th/Fri 04:00
> ET as a regular cadence wake, and that wake is not suppressed. Eliminating it
> would require either (a) bumping `heartbeatOverrides.closed` to ≥86400 for
> Prophet/Harvest (changes weekend wake behavior too) or (b) a new
> `suppressCadenceWakesInPhase` mechanism. Both are out of scope. The 04:00 beat
> hits preflight before the LLM call — on holidays it's skipped; on regular
> trading days it fires a low-context "is the world still here" beat. Acceptable
> noise for the savings we get.

### Why 09:15 and not 09:00 or 09:30

- **09:15** is 15 min before the open: late enough that European close (10:30 GMT / 06:30 ET → 11:30 GMT / 07:30 ET) and S&P futures direction are settled, but early enough that the agent has time to read the brief, scan positions, and plan entries before the 09:30 phase-snap.
- **09:00** would be too early — futures are still in flux, last analyst notes may not be in.
- **09:30** would be redundant with the existing phase-snap.

### Why suppress the 04:00 phase-snap

The 04:00 wake today does one of two things: (a) gets skipped by the holiday-aware preflight on non-trading days, or (b) fires an LLM beat that reads overnight news and writes a context summary that's mostly re-derived at every subsequent beat anyway. The 09:15 wake hits the same holiday preflight (so holidays are still caught) and reads the same news but with 5+ more hours of European session digested. Suppressing 04:00 loses nothing material.

## Detailed design

### Schema additions

**Field 1 — `scheduledBeats.exclusive: false`**

Existing field, new permitted value. Current behavior is gated on `sb?.exclusive && sb.times?.length` at `agent/harness.js:411,834`, so `scheduledBeats` without `exclusive: true` is currently a no-op. The new additive path is gated on `!sb.exclusive && sb.times?.length`, so adding it does not change behavior for any current user.

> **Note for future contributors:** under the new code, omitting `exclusive` entirely (`scheduledBeats: { times: ['...'] }`) maps to additive mode, not the previous no-op. All current agents with `scheduledBeats` set `exclusive: true` explicitly, so this is not a regression — but new agents should set `exclusive` to either `true` or `false` deliberately, not omit it.

```typescript
scheduledBeats: {
  times: string[]              // ET wall-clock 'HH:MM' values
  weekdaysOnly: boolean        // default true; skip weekends
  exclusive: boolean           // true=replace cadence (existing); false=additive (NEW)
  windowMinutes?: number       // (exclusive mode only) startup-skip window; ignored in additive
}
```

**Field 2 — `suppressPhaseSnaps: string[]`**

New top-level agent config field. List of phase names whose entry phase-boundary snap should be suppressed for this agent. Default empty / unset.

```typescript
suppressPhaseSnaps?: string[]   // e.g., ['pre_market'] — suppress the snap that enters this phase
```

### Harness change — new helper

`_getNextPhaseBoundary()` returns `{ seconds, phase }` so the scheduler knows *which phase* the next boundary leads into (current `secondsToNextPhaseBoundary` returns only seconds). ~15 LOC, mirrors the existing helper's logic.

```js
_getNextPhaseBoundary() {
  // Mirror secondsToNextPhaseBoundary, but also identify which phase
  // the next boundary enters so suppressPhaseSnaps can be checked.
  // Returns { seconds, phase } or null if no upcoming boundary in 8-day lookahead.
}
```

### Harness change — `_scheduleNext`

Two modifications around the existing boundary-clamp block at `agent/harness.js:847-856`:

```js
let seconds = this._getHeartbeatSeconds();

// Phase-boundary snap, with opt-in suppression
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

// NEW: additive scheduledBeats — clamp to next scheduled wake if sooner
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

The existing exclusive-mode early-return at `harness.js:834-842` runs before this block, so Coil/Drift/Trend (exclusive mode) never reach the new code.

### Config change — Prophet (`agent/config-store.js:180-190`)

```diff
     {
       id: 'default',
       name: 'Prophet',
       description: 'Aggressive discretionary options trader with scalping overlay',
       systemPromptTemplate: 'default',
       strategyId: 'v2-options',
       model: 'anthropic/claude-sonnet-4-6',
-      heartbeatOverrides: {},
+      heartbeatOverrides: { pre_market: 86400 },
+      scheduledBeats: {
+        times: ['09:15'],
+        weekdaysOnly: true,
+        exclusive: false,
+      },
+      suppressPhaseSnaps: ['pre_market'],
       customSystemPrompt: '',
       createdAt: new Date().toISOString(),
     },
```

### Config change — Harvest (`agent/config-store.js:192-215`)

```diff
     {
       id: 'harvest',
       name: 'Harvest',
       ...
       model: 'anthropic/claude-sonnet-4-6',
       heartbeatOverrides: {
-        pre_market: 3600,
+        pre_market: 86400,
         market_open: 900,
         midday: 900,
         market_close: 900,
         after_hours: 7200,
         closed: 28800,
       },
+      scheduledBeats: {
+        times: ['09:15'],
+        weekdaysOnly: true,
+        exclusive: false,
+      },
+      suppressPhaseSnaps: ['pre_market'],
       createdAt: new Date().toISOString(),
     },
```

### Rule prose — `TRADING_RULES_V2.md` `## Heartbeat Cadence`

```diff
-The harness automatically fires a beat at every phase boundary, including the
-09:30 ET market open — that wake is guaranteed regardless of your current
-heartbeat interval. Do **not** tighten your heartbeat during pre-market to
-"land cleanly at the open"; you will be woken at the open for free. When you
-are flat pre-market with no actionable catalyst, hold the default pre-market
-cadence (~15 min). Tighten only when you are managing an open position or
-reacting to a live, time-sensitive catalyst.
+Pre-market has two wakes, both harness-scheduled: 09:15 ET (the pre-open
+context beat — futures settled, European close digested, last analyst notes)
+and 09:30 ET (market open). The 04:00 ET pre-market phase boundary is
+suppressed — your day starts at 09:15.
+
+`set_heartbeat` calls during pre-market have no effect on these scheduled
+wakes. Do not attempt to tighten heartbeat in pre-market.
+
+Use the 09:15 wake as your pre-open thesis lock. Tighten heartbeat only after
+the open, when managing a position or reacting to a live, time-sensitive
+catalyst.
```

No `TRADING_RULES_HARVEST.md` change needed — it doesn't reference specific cadence numbers.

## Backward compatibility

Verified for every existing agent:

| Agent | Current config | Behavior change? |
|---|---|---|
| Prophet (id=default) | `heartbeatOverrides: {}`, no `scheduledBeats` | ✅ intended — opts into new mode |
| Harvest | `heartbeatOverrides.pre_market: 3600`, no `scheduledBeats` | ✅ intended — opts into new mode |
| Penny | `heartbeatOverrides.pre_market: 900`, no `scheduledBeats` | ❌ none — neither new field applies |
| Coil | `scheduledBeats: { exclusive: true, ... }` | ❌ none — exclusive path early-returns at `harness.js:840` |
| Drift | `scheduledBeats: { exclusive: true, ... }` | ❌ none — same as Coil |
| Trend | `scheduledBeats: { exclusive: true, ... }` | ❌ none — same as Coil |
| Mean-rev | `heartbeatOverrides.pre_market: 86400`, no `scheduledBeats` | ❌ none — neither new field applies |

## Session-reset interaction (verified)

`harness.js:902-914` resets the LLM session when `sessionMode === 'daily'` AND `phase === 'pre_market'` AND `_lastBeatPhase !== 'pre_market'`. With the new schedule:

- At 09:15 wake: `phase` = pre_market (09:15 < 09:30 boundary at PHASE_TIME_RANGES.pre_market.end = 570 min) ✓
- `_lastBeatPhase` = closed/after_hours (from previous trading day's last beat) ✓
- Reset triggers at 09:15 → session starts fresh, same 24h growth-bound window as before, just shifted 5 hours later

## Tests

### `agent/harness.test.mjs` — 6 new test cases

1. **Additive mode clamping** — `exclusive: false` + scheduled time sooner than phase cadence → next wake = scheduled time
2. **Additive mode, scheduled time later** — phase cadence wins
3. **Phase-snap suppression** — agent with `suppressPhaseSnaps: ['pre_market']` doesn't snap at 04:00; next wake skips to whatever comes after
4. **Suppression scoped to listed phases** — `suppressPhaseSnaps: ['pre_market']` does NOT suppress the 09:30 (market_open) snap
5. **Backward-compat — exclusive mode preserved** — `exclusive: true` still replaces phases entirely (Coil behavior preserved)
6. **Backward-compat — no new fields** — agents with neither `scheduledBeats` nor `suppressPhaseSnaps` get phase cadence + phase-boundary snaps as before

### `agent/config-store.test.mjs` — 3 sanity assertions

- Prophet config has `scheduledBeats.times === ['09:15']`, `exclusive === false`, `suppressPhaseSnaps === ['pre_market']`
- Harvest config has the same three fields
- Penny config unchanged: no `scheduledBeats`, no `suppressPhaseSnaps`

## Observation criteria (10 trading days post-merge)

| Metric | Pass |
|---|---|
| Prophet pre-market beats/day | 3 (04:00 cadence-overflow, 09:15, 09:30) |
| Harvest pre-market beats/day | 3 once IV history warms (~late June 2026); until then IV-preflight skip drops the 09:15 beat and possibly the 04:00 beat |
| 09:15 wake fires every trading day | Yes, no missed days |
| Daily session reset triggers at 09:15 | Verified via agent_log (`[session] Daily reset` message timestamp) |
| No regression in Coil/Drift/Trend exclusive-mode agents | Beat times unchanged (compare against pre-merge logs) |
| Open-trade quality at 09:30 | Subjective check via `/review-performance`, `/agent-health` — no degradation in first-15-min entries |

If Prophet's open-trade quality degrades (subjective, but detectable via win-rate on first-15-min entries), the response is **not** to revert the structural change but to add a second scheduled wake (e.g., `times: ['08:30', '09:15']`) — the mechanism supports it without further code changes.

## Risks and mitigations

- **Holiday handling regression** — With 04:00 suppressed, no pre-market beat runs the holiday preflight skip before 09:15. Mitigation: the 09:15 wake hits the same holiday-aware preflight that landed in PRs #64/#65 (`agent/preflight.js` `isMarketHoliday()` check); holidays are still caught, just 5 hours later. No trade attempted because Prophet/Harvest can't fire orders before 09:30 anyway.
- **Daily session reset shifted** — Sessions reset at 09:15 instead of 04:00; the 24h continuous-context window is shifted, not lengthened. Same upper bound.
- **`_getNextPhaseBoundary` correctness** — New helper needs to handle DST and 8-day lookahead. Mirrors the existing `secondsToNextPhaseBoundary` logic line-for-line; risk is low.
- **Forgetting `weekdaysOnly: true`** — `scheduledBeats` default for `weekdaysOnly` is implicitly true per `harness.js:788` (`sb.weekdaysOnly !== false`). Explicit `true` in our configs is belt-and-suspenders against future default flips.
- **Dual-fire collision** — 09:15 scheduled wake and 09:30 phase-snap are 15 min apart, well above the `> 10s` floor used in both clamps. No collision possible.
- **Agent confusion if it calls `set_heartbeat`** — Soft mitigation via rule prose. Worst case the call is a no-op against the scheduled wake; not destructive.

## Scope

| File | LOC | Purpose |
|---|---|---|
| `agent/harness.js` | ~45 | New `_getNextPhaseBoundary` helper + suppression check + additive scheduledBeats block in `_scheduleNext` |
| `agent/config-store.js` | ~20 | Prophet + Harvest config field additions |
| `agent/harness.test.mjs` | ~120 | 6 new test cases for additive mode + suppression + backward-compat |
| `agent/config-store.test.mjs` | ~15 | 3 sanity assertions |
| `TRADING_RULES_V2.md` | ~20 | Rewrite `## Heartbeat Cadence` section |
| **Total** | **~220** | |

One PR, no migrations, no flag (the structural change is the feature; opt-in via config alone). Reversible by reverting the config field additions; the harness mechanism can stay (no-op for any agent that doesn't use it).

## Rollout plan

1. Land as single PR against `main`.
2. Default ON immediately — there is no flag because the mechanism is opt-in via config; agents not configured see no change.
3. Observe for 10 trading days per criteria above.
4. If the open-trade-quality criterion fails, add a second scheduled wake (e.g., `times: ['08:30', '09:15']`) as a follow-up commit — no code changes required.
