# Prophet bounded-staleness beat skip + beat-context enrichment

**Date:** 2026-05-27
**Status:** Design — awaiting review
**Scope:** Prophet (`v2-options`) only. Other agents' preflight predicates are untouched.

## Motivation

Each Prophet heartbeat spawns an `opencode` (Sonnet) subprocess. The cost
concentrates in the 2-minute `market_open` / `market_close` phases (~60 beats/day
combined). When Prophet is *holding* positions and nothing actionable has changed,
every one of those beats still wakes the LLM to re-confirm "no action" — a no-op
that costs a full beat.

Note the tension to design against: the 2-minute `market_open` / `market_close`
windows are simultaneously where skipping saves the most **and** where adverse
moves are most likely. Savings and risk concentrate in the same window, which
raises the bar on gate correctness — the observe-then-enable rollout (below) is
the deliberate response.

Today `prophetPreflight` only skips when Prophet is **flat** (no `v2-options`
positions), plus the regime-block / econ-blackout no-position cases. While holding,
it always runs. This design adds a *bounded-staleness* skip for the holding case:
skip a holding-beat only when every position is comfortably mid-band on P&L **and**
its underlying is quiet **and** we are within a hard staleness cap — otherwise run.

The same derived signals that justify a skip also enrich the beat-context block
when a beat *does* run, so the LLM spends fewer tool rounds (lever #2). One
computation, two consumers.

### Exit-safety context (why this is the careful part)

Prophet's exits are **discretionary**, not bracketed (`TRADING_RULES_V2.md`):
manual ~−15% mental stop, +40%/+100% profit targets, and technical-breakdown
exits — all decided by the LLM each beat, placed as limit orders. The only
server-side protection is the **−50% catastrophic auto-stop monitor**
(`ENABLE_PROPHET_OPTIONS_STOP=true`), explicitly far below the normal stop.

So skipping a holding-beat means the LLM does not evaluate the normal stop /
targets / technical exits for that interval. Of those triggers, only **P&L
distance** is cheaply computable server-side; **technical breakdown is not**,
but the existing intraday-signal service is a usable proxy.

### Layered safety

- **Fast adverse moves** → caught by the *quiet* gate (VWAP break / rvol spike /
  outsized range / large day move) → run immediately.
- **Slow drifts** → bounded by the *staleness cap* (max minutes since the last
  exit-evaluating beat — see "Harness wiring" for which beats count).
- **Catastrophe** → the −50% auto-stop monitor (already enabled).

## Architecture (Approach A: data in Go, decision in Node)

The raw data already exists server-side — `/api/v1/positions?strategy=v2-options`
and `/api/v1/intraday/signals?symbols=…`. All *derived* logic (OCC→underlying
mapping, P&L band classification, quiet thresholding, the skip decision) lives in
one new pure Node module, consumed by both the skip predicate and the
beat-context renderer. Little or no new Go code, matching the existing
`fills-summary.js` / `beat-context.js` split-for-testability pattern.

```
                         /api/v1/positions (existing)
                         /api/v1/intraday/signals (existing)
                                   │
                                   ▼
   prophet-beat-decision.js  ── pure functions ──┐
                                   │              │
              ┌────────────────────┘              └───────────────────┐
              ▼                                                        ▼
   prophetPreflight (skip?)                          renderBeatContextBlock (enrich)
   agent/preflight.js                                 agent/beat-context.js
```

### New module: `agent/prophet-beat-decision.js` (pure, unit-testable)

- `occUnderlying(symbol)` → underlying ticker.
  `TSLA260529C00442500` → `TSLA`; a plain stock symbol passes through unchanged;
  unparseable input returns the input as-is (caller treats a missing signal as
  not-quiet → run).
- `classifyBand(pnlPct, { nearStopPct, nearTargetPct })` →
  `'interior' | 'near_stop' | 'near_target'`. Boundaries are **inclusive on the
  actionable side**: `pnlPct <= nearStopPct` → `near_stop`;
  `pnlPct >= nearTargetPct` → `near_target`; strictly between → `interior`. So at
  exactly `nearStopPct` (default −10.0) the position is `near_stop` and the beat
  runs. Non-finite `pnlPct` → `near_stop` (fail toward running).
- `isUnderlyingQuiet(signal, thresholds)` → boolean.
  `true` only when all of: `|dist_from_vwap_pct| < vwap`, `rvol < rvol`,
  `range_over_atr < rng`, `|day_change_pct| < day`. **A null/partial signal (any
  required field missing or NaN) ⇒ `false`** (not quiet → run).
- `decideHoldingSkip({ positions, signalsByUnderlying, sinceLastExitEvalMs, maxStalenessMs, econBlackout, thresholds })`
  → `{ skip: boolean, reason: string, gate: Gate|null }` where
  `Gate = 'econ_blackout' | 'staleness' | 'near_stop' | 'near_target' | 'not_quiet'`.
  Pure. **First**, an explicit guard: `positions.length === 0` →
  `{ skip:false, gate:null, reason:'no positions (flat path owns this)' }` — never
  rely on `[].every(...)` vacuously returning `true`, which would wrongly skip a
  flat book if a refactor ever routed one here. Otherwise returns `skip:true`
  **only when all** of:
  0. `econBlackout !== true` (not in/near a US-release window), AND
  1. `sinceLastExitEvalMs < maxStalenessMs` (staleness cap not reached), AND
  2. every position classifies `interior`, AND
  3. every held underlying `isUnderlyingQuiet`.
  Otherwise `skip:false` with `gate` = the first failing gate and a human-readable
  `reason`. The `gate` enum rides the `beat_skip` event so the observe phase can
  aggregate which gate fires how often (to tune thresholds) without regex-parsing
  prose. Note: regime-block is intentionally **not** a gate — a RED regime blocks
  only *new entries* (exits still run), so it is not a reason to wake a
  holding-beat. Econ-blackout *is* a gate because a release can move held options
  violently.

### Skip decision (open phase, holding positions)

`prophetPreflight`'s open-phase branch, when `positionCount > 0`:

1. Map each position → underlying via `occUnderlying`.
2. **Concurrently** (`Promise.allSettled`, sharing the ~2s `resolvePreflight`
   budget) fetch:
   - `/api/v1/intraday/signals?symbols=<distinct held underlyings>` (~800ms timeout)
   - econ-blackout status via the existing `isEconomicBlackout` (~1200ms timeout —
     leaves wall-clock margin under the 2s budget since the two run concurrently)
   On timeout/error: signals → empty (every name not-quiet → run); **econ → treat
   as `econBlackout:true` (fail toward running)** — see Error handling for why the
   econ gate, unlike the others, treats *missing data as the adverse case*.
3. Call `decideHoldingSkip(...)` with
   `sinceLastExitEvalMs = now − _lastExitEvalBeatAt` and the `econBlackout` result.
4. Return its `{skip, reason, gate}`.

The existing flat-only regime-block / econ-blackout skip checks (inside the
`positionCount === 0` branch) are unchanged — they compose ahead of this holding
branch exactly as today.

Example skip log (the prose `reason`; the structured `gate` field rides the same
`beat_skip` event for aggregation):
`Beat #N skipped (preflight): 2 positions interior (−4%, +12%), TSLA/NVDA quiet, last exit-eval 4m ago < 6m cap`

### Beat-context enrichment (lever #2)

`renderBeatContextBlock` annotates each position line with its band label, reusing
`classifyBand`:

```
Positions (your v2-options positions, attributed via order tag):
  - TSLA260529C00442500: 6 ct, P&L +12.0% ($720.00) [interior]
  - NVDA260619C00130000: 4 ct, P&L -11.0% ($-300.00) [near_stop]
```

Additionally, held underlyings that are absent from the fixed
`PROPHET_INTRADAY_WATCHLIST` are merged into the intraday block (we already
fetched them for the skip decision), so the LLM always sees momentum on names it
holds without spending a tool round.

`near_stop` / `near_target` labels let the LLM act without first fetching quotes
and computing distance — fewer tool rounds per woken beat.

### Harness wiring

- Add `_lastExitEvalBeatAt` to the harness — the timestamp of the last beat that
  **evaluated position exits**. Set it (after the preflight skip-check passes) on a
  **heartbeat beat** and on an **emergency beat** (the emergency prompt explicitly
  tells the agent to assess position action). **Message beats do NOT reset it** —
  a user-message beat may answer a query without evaluating stops/targets, so it
  must not silently extend the exit-evaluation window. This is the deliberate
  answer to "is the cap *time since the LLM ran at all* or *time since exits were
  evaluated*?" → the latter. Initialize to "long ago" (epoch 0) on start and on
  the daily session reset so the first beat after any gap always runs.
- Pass `now − _lastExitEvalBeatAt` into `resolvePreflight` → `prophetPreflight`
  (extend the call signature / options object).

## Parameters (env-tunable; defaults below)

| Param | Env var | Default | Rationale |
|---|---|---|---|
| Max staleness | `PROPHET_SKIP_MAX_STALENESS_MIN` | **6** | At 2-min cadence, allows ~2 consecutive skips (cuts hot-phase beats ~⅔). Auto-scopes the optimization to sub-6-min phases — midday (10) / pre-market (15) always run. |
| Near-stop band | `PROPHET_SKIP_NEAR_STOP_PCT` | **−10** | 5% buffer before the −15% rule stop — LLM beats *before* the stop, not after. |
| Near-target band | `PROPHET_SKIP_NEAR_TARGET_PCT` | **+30** | 10% buffer before the +40% first-partial. |
| Quiet: VWAP dist % | `PROPHET_SKIP_QUIET_VWAP_PCT` | **1.5** | coarse "near VWAP" |
| Quiet: rvol | `PROPHET_SKIP_QUIET_RVOL` | **2.0** | no volume spike |
| Quiet: range/ATR | `PROPHET_SKIP_QUIET_RNG_ATR` | **1.5** | no outsized range |
| Quiet: day change % | `PROPHET_SKIP_QUIET_DAY_PCT` | **4.0** | no large intraday move |

## Rollout

- **Enrichment (lever #2)** — band labels + held-name intraday merge — is harmless
  read-only context; ships on, under the existing `BEAT_CONTEXT_ENABLED` gate.
- **Holding skip (lever #1)** is behavior-changing (can delay a discretionary
  exit). Gate behind `PROPHET_HOLDING_SKIP_ENABLED`, **default OFF**, following the
  established observe-then-enable pattern: merge off, watch the
  `skipped (preflight): … interior … quiet … < cap` reason logs against actual
  position behavior for a stretch, then flip on. When OFF, the holding branch
  behaves exactly as today (always runs).

## Error handling

The skip is a pure cost optimization, so **every gate fails toward running the
beat** — "any doubt → run." That is the precise form of the dual-layer policy
here (preflight fails toward action; the rules side fails closed on new entries).

- positions fetch error / unexpected shape → run (current behavior).
- intraday fetch timeout/error → held names not-quiet → run.
- missing/NaN P&L on any position → `near_stop` → run.
- **econ-blackout fetch timeout/error → treated as blackout → run.** This is the
  one gate where "fail toward run" means treating *absence of data as the adverse
  case*. Rationale: for a *skipped* beat the rules-side fail-closed never executes
  (the LLM doesn't run to consult it), so near a real release the only backstop
  would be the −50% floor — too deep for the violent gamma moves short-dated
  options see around CPI/FOMC. The cost of failing this way is a few extra beats
  during econ-source flakiness, which is rare and self-limiting.
- `decideHoldingSkip` returns `skip:true` only when every gate affirmatively
  clears with valid data (and at least one position is held).

## Testing (`node:test`, mock-based — tests the executor)

**Unit (`prophet-beat-decision.test.mjs`):**
- `occUnderlying`: standard OCC option, plain stock symbol, malformed input.
- `classifyBand`: **inclusive boundaries** — exactly −10.0 → `near_stop`, exactly
  +30.0 → `near_target`, −9.99 / +29.99 → `interior` (the off-by-epsilon cases
  where bugs hide); the rule levels −15 / +40 are past the band edges (still
  actionable); non-finite → `near_stop`.
- `isUnderlyingQuiet`: each threshold breached individually; all-quiet; a signal
  missing each required field → `false`.
- `decideHoldingSkip` matrix — assert both `skip` **and** the `gate` enum:
  interior+quiet+fresh+no-blackout → `{skip:true, gate:null}`; one `near_stop` →
  `gate:'near_stop'`; one not-quiet → `gate:'not_quiet'`; `sinceLastExitEvalMs ≥
  cap` → `gate:'staleness'`; `econBlackout:true` → `gate:'econ_blackout'`; empty
  positions → `{skip:false, gate:null}` (explicit guard, not vacuous `every`);
  missing data → run.

**Integration (`preflight.test.mjs` additions):** `prophetPreflight` with a
stubbed `goAxios`:
- holding + interior + quiet + fresh + no blackout → `skip:true`.
- holding + a position near a boundary → `skip:false`.
- holding + interior + quiet but econ-blackout active → `skip:false`.
- intraday fetch rejects/times out → `skip:false` (fail toward run).
- econ fetch rejects/times out → `skip:false` (fail toward run — treated as blackout).
- flat / closed-phase paths unchanged (regression).

**Renderer (`beat-context.test.mjs` additions):** `renderBeatContextBlock` emits
the correct band label per position.

## Out of scope (YAGNI)

- "New signals since last beat" delta injection — needs prior-beat state diffing;
  the band + quiet gates already cover the actionable cases.
- Per-phase Haiku model switching — separately analyzed as low-ROI/high-risk for
  the hot path (busts the cached prefix; safe phases are already infrequent).
- Caching-token instrumentation — tracked as a separate small sub-project.
