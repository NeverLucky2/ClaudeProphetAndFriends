# No-op Pre-Market Beat Reduction — Design

**Date:** 2026-05-26
**Status:** Approved (design, revised after external review); implementation pending
**Scope:** Two independent, low-risk changes that stop guaranteed-no-op LLM beats — one in Harvest (code), one in Prophet (docs).

## Problem

Two agents burn LLM tokens on beats that cannot possibly do anything:

### Harvest — guaranteed no-op every beat during IV warm-up

Observed 2026-05-26 (two consecutive beats, ~$0.22–0.26 and 200–270K tokens each):

```
get_harvest_ivr {"symbol":"SPY",...} -> { "ivr": 0, "days_of_history": 2, ... }
... all 5 underlyings: IVR = 0 (< 30 threshold). Only 2 days of history —
insufficient for a meaningful 52-week range, producing a floor IVR of 0.
No condors opened this beat.
```

Root cause is structural, not transient:
- `calcIVR` (`services/harvest_ivr_service.go:166`) computes `(current - low)/(high - low)`. With only `days_of_history: 2`, the "52-week" low/high spans two days; current IV sits below it, so IVR floors at 0.
- Harvest's entry rule hard-gates at `IVR ≥ 30` (`TRADING_RULES_HARVEST.md:100`).
- Therefore **every** underlying is un-tradable until IV history accrues — and the daily collector adds ~1 day at a time, so this persists for **weeks**.
- `harvestPreflight` (`agent/preflight.js`) currently has no IVR/history gate, so it runs the full LLM beat (~20 tool calls) every time only to rediscover "no entries possible."

### Prophet — redundant pre-market self-tightening

Observed 2026-05-26: Prophet repeatedly called `set_heartbeat` to shrink its pre-market interval (240s → 180s), reasoning it wanted to "land cleanly in market_open phase." Across the pre-market window this produced several `"No change. Holding."` beats (~$0.04–0.21 each).

This tightening is **redundant**: the harness already fires a beat at every phase boundary via the phase-boundary snap in `_scheduleNext` (`agent/harness.js:773` — when the next boundary is closer than the scheduled interval, it schedules a beat *at* the boundary). So Prophet is **guaranteed** a fresh-context beat at the 09:30 ET open regardless of its heartbeat interval. It pays for the extra beats to chase a wake it already gets for free, because nothing tells it the snap exists.

## Goals

- Stop Harvest's guaranteed warm-up no-op beats without risking a missed real entry.
- Stop Prophet's redundant pre-market self-tightening while preserving a fresh-context setup beat at the open.
- Zero new external/broker API calls.

## Non-goals (explicitly out of scope)

- **Harness cadence floor** (a hard per-phase minimum interval clamping `set_heartbeat`). Considered and declined; revisit only if the Prophet rules nudge proves insufficient in observation.
- **Open-timing investigation** (the "first acting beat at 09:32 rather than 09:30"). The boundary snap means Prophet *is* woken at the open; the ~2-min lag is most likely `market_open`'s 120s default cadence and is not addressed here.
- **Steady-state Harvest skip** (all 5 underlyings genuinely `IVR < 30` with full history). This cannot be gated safely on a single-symbol probe (per-underlying IVR diverges in steady state), so only the warm-up case is addressed.

## Part A — Harvest "insufficient IV history" preflight skip (code)

### Location
`harvestPreflight` in `agent/preflight.js`, inside the `/api/v1/iv/SPY` block it **already fetches** for the IV-RV premium-edge gate (currently reads only `realized_vol_20d` / `iv_minus_rv`).

`GET /api/v1/iv/:symbol` (`controllers/iv_controller.go` → `services.IVRData`) already returns `days_of_history` in the same payload, so this is a **zero-extra-call** change — one additional field read.

### Logic
Add a named constant alongside the existing module constants:

```js
const MIN_IV_HISTORY_DAYS = 20;
```

Inside the existing `try` block that fetches `/api/v1/iv/SPY`, **before** the IV-RV spread check, add:

```js
const daysHist = Number(ivResp.data?.days_of_history);
if (Number.isFinite(daysHist) && daysHist < MIN_IV_HISTORY_DAYS) {
  return {
    skip: true,
    reason: `insufficient IV history (SPY ${daysHist}d < ${MIN_IV_HISTORY_DAYS}) — IVR floored at 0, no condor entries possible`,
  };
}
```

Fetch failure still falls into the existing `catch` and fails **open** (runs the LLM), unchanged.

### Why this is safe and correct
- **Zero new API calls** — reuses a response already in hand.
- **Only ever fires during warm-up.** Once `days_of_history ≥ 20`, the gate is silent permanently; it can never skip a real steady-state opportunity.
- **SPY as universe proxy is correct by construction for this gate's active window** — not because counts are uniform (the collector `continue`s past any symbol whose chain fetch fails or returns `atmIV <= 0` at `cmd/bot/main.go:830-836`, so per-symbol divergence *is* possible), but because:
  - `days_of_history` counts trailing-52-week snapshots, so it is **monotonically non-decreasing for the first year** — and the entire warm-up window lives inside that year.
  - This gate fires only while `SPY < 20`, i.e. the first ~20 trading days of IV collection ever. All five Harvest underlyings enter the collector loop together from day 0 (`cmd/bot/main.go:817-841`), so during that window none can run ~18 days *ahead* of SPY, and SPY (the most liquid name) is the least likely to be the one repeatedly failing its chain fetch. A harmful false skip would require SPY to lag a genuinely-tradable sibling by ~18 days during initial warm-up — implausible given the shared start.
  - Once any underlying crosses 20 days, SPY (collected since day 0) has crossed it too, so the gate goes **permanently silent**. The drift scenarios that could break uniformity — a sixth underlying added later, or a symbol failing in steady state — all occur *after* that point, when SPY is already ≥ 20 and the gate is inactive (the LLM runs and evaluates every underlying), so they cannot cause a false skip.
  - Net: correctness rests on **monotonic growth + shared collection start**, both enforced by the code, not on an unenforced uniformity invariant.
- **Fires even with open condors when the Go exit-monitor is on** — identical to the existing FOMC-blackout (`preflight.js:481`) and empty-chain (`preflight.js:514`) skips: the monitor handles exits, the LLM beat is only needed for new entries, and no entry is possible. When the monitor is **off** and condors are open, the function already returned at `preflight.js:472`, so exit beats still run.

### Threshold rationale
`20` matches the established project convention: `days_of_history < 20` = "low-confidence" IV reading, already used by Prophet's options-entry gate (`TRADING_RULES_V2.md:214`) and documented in `controllers/iv_controller.go:38`. Using the same number keeps the two IV gates consistent.

### Expected behavior over time
With `days_of_history` currently at ~2, Harvest's LLM beats stay skipped until ~20 trading days of IV collection accrue (≈ late June 2026), then resume automatically. This is the same warm-up that newly-added Prophet symbols already undergo; it is intended, not a regression.

### Tests (`agent/preflight.test.mjs`, node:test)
- Skips when `days_of_history < 20` and no open condors (mock `/api/v1/iv/SPY` → `{ days_of_history: 2, ... }`); assert `{ skip: true }` with the history reason.
- Runs (does not skip on this gate) when `days_of_history ≥ 20`, falling through to the existing IV-RV / `skip:false` paths.
- Fails open when `/api/v1/iv/SPY` errors (existing soft-fail behavior preserved).
- Fails open when `days_of_history` is **present but non-numeric** (e.g. `"abc"`) or **missing**: `Number(...)` → `NaN`, `Number.isFinite` is false, so the gate does not skip and the beat runs. (Coercion note: `Number(null)` is `0`, which *would* skip — but the Go endpoint serializes `days_of_history` as a plain `int` (`services/harvest_ivr_service.go`), so it is always an integer in practice; `0` correctly represents zero history and tripping the warm-up skip is the intended behavior. The non-numeric-string case is a defensive guard for an input the endpoint cannot actually emit.) Distinct code path from the fetch-error soft-fail above; gets its own case.
- Existing open-condor / FOMC / chain-probe cases continue to pass unchanged.

### Known limitation — warm-up relief only
This gate addresses the **warm-up** no-op only. Once `days_of_history ≥ 20` (≈ late June 2026) it goes permanently silent and Harvest resumes full LLM beats. In a calm, low-vol regime where the whole universe genuinely sits below `IVR ≥ 30` *with* full history, those beats are again no-ops — but that case recurs indefinitely and **cannot** be gated on a single-symbol probe (per-underlying IVR diverges in steady state, so SPY's IVR doesn't represent the floor). The natural permanent fix is a **server-side aggregate** — e.g. a count of Harvest underlyings whose latest stored `IVR ≥ 30`, computed over all five and surfaced as one field — which the preflight could gate on with zero per-symbol fetches and which would also moot Part A's proxy question entirely. Recorded as future work; out of scope here. Measure Part A as a few-weeks reduction in warm-up burn, **not** a permanent Harvest token fix.

## Part B — Prophet pre-market cadence nudge (docs only)

### Location
`TRADING_RULES_V2.md`, in the operational / heartbeat-guidance area (near the existing per-heartbeat operational rules). No code, no test.

### Content (prose to add)

> **Pre-market heartbeat cadence.** The harness automatically fires a beat at every phase boundary, including the 09:30 ET market open — that wake is guaranteed regardless of your current heartbeat interval. Do **not** tighten your heartbeat during pre-market to "land cleanly at the open"; you will be woken at the open for free. When you are flat pre-market with no actionable catalyst, hold the default pre-market cadence (~15 min). Tighten only when you are managing an open position or reacting to a live, time-sensitive catalyst.

### Rationale & risk
- **This is an information failure, not a judgment failure.** Prophet tightened because nothing told it the boundary snap exists — it reasoned correctly from incomplete knowledge. Documentation is the right layer precisely because it closes the information gap directly.
- Directly removes the redundant self-tightening while preserving the open setup beat (delivered by the boundary snap).
- **Soft constraint:** prose in a rules file is a weaker guarantee than a structural fix — the model must (a) retain the rule in context and (b) apply it under every pre-market state. Starting soft is cheap, reversible, and preserves judgment; the structural escalation path (harness cadence floor) remains the declined non-goal above.
- **Concrete escalation trigger:** if Prophet tightens its pre-market heartbeat below the default on **more than 2 trading days within the first 10 trading days** of observation, ship the cadence floor. (A bounded trigger — not the open-ended "if it keeps happening," which never quite trips.)

## Verification

- `node --test agent/preflight.test.mjs` passes (new + existing cases).
- Post-merge observation: confirm Harvest emits `beat_skip` with the "insufficient IV history" reason instead of running full LLM beats, and that Prophet no longer ratchets its pre-market interval below the default when flat.
