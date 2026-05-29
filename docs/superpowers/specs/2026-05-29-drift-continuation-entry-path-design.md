# Drift Continuation Entry Path — Design

**Created:** 2026-05-29
**Status:** Approved — ready for implementation plan
**Agent:** Drift (`drift` / strategy `earnings-drift`)

---

## Problem

Drift has never entered a trade since it was created (2026-05-20). Investigation
of its activity logs and the Go signal pipeline found a **structural bug**: the
candidate-enumeration window and the PEAD entry-stage gate are mutually
unsatisfiable.

- **Enumeration window (backend):** `DriftCandidatesService.compute` only
  surfaces names whose earnings landed within the last ~14 calendar days
  (`EarningsCalendarService.FetchRecentReports(ctx, now, 5)` uses a `days*2+4`
  calendar-day window).
- **Entry gate (agent rule):** `TRADING_RULES_DRIFT.md` makes
  `pead.stage ∈ {SIGNAL_READY, BREAKOUT}` a **mandatory** entry condition
  (Entry signal list + Pre-Trade Checklist).
- **How that stage is produced (`analyzeDriftPEAD` / `findDriftRedCandle`):** it
  requires a **red weekly candle sitting strictly between the earnings ISO-week
  and the current ISO-week** — i.e. `weeksSinceEarnings ≥ 2`.

For `weeksSinceEarnings ≤ 1` (earnings ≤ ~8 trading days ago — the bulk of the
14-day window), `findDriftRedCandle`'s loop (`for i := len-2; i > earningsIdx; i--`)
has **zero iterations**, so the stage is structurally stuck at `MONITORING`
regardless of price action. The pattern only becomes reachable at the oldest
sliver of the window (≈10–14 calendar days post-earnings) and only if a red
pullback week happens to land there. By the time a real PEAD breakout forms
(weeks 2–5, which is why `driftPEADWatchWeeks = 5`), the name has already aged
out of the candidate list.

**Net effect:** the entry condition is essentially never satisfiable while a name
is in the candidate list. Drift passes on every candidate, every beat → zero
trades, by construction.

### Evidence

- Activity logs (`data/sandboxes/sbx_59580b7b/activity_logs/`): on the beats that
  actually ran, the lone candidate (CSCO) was rejected every time with
  `pead.stage=MONITORING, fails entry condition (requires SIGNAL_READY or
  BREAKOUT)` (2026-05-22) and `PASS CSCO — pead.stage MONITORING` (2026-05-27).
  Zero entries across all beat-days.
- Reproduction against the pure Go functions: earnings 1/2/3/4/5/6/8/10 trading
  days ago all yield `pead.stage=MONITORING`; for 1–8 days ago it is impossible
  to be otherwise.

### Root cause is a dropped spec feature

`docs/agent-meanrev-and-drift-spec.md` specified **two** entry triggers:

> "Day after gap, on close > previous day's high (continuation) **OR**
> pead-screener red-candle pullback breakout"

Only the second (slow, weekly) path was implemented. The fast **continuation
path** — the one that fires within days of a gap — was never built, leaving the
slow path alone, which is incompatible with the short candidate window.

---

## Goal

Implement the missing continuation entry path so Drift *can* act within days of a
qualifying post-earnings gap, while preserving the PEAD weekly-breakout path as
an alternative. Ship it **behind a default-OFF flag in shadow mode** so the new,
unvalidated rule logs would-be entries (and near-miss / universe-coverage
telemetry) without trading, until the operator consciously enables it. Keep the
deterministic-Go / dumb-LLM-executor architecture.

### This change does two separable things

1. **Structural fix (unambiguously correct):** make the enumeration window and
   the entry gate mutually satisfiable by adding a fast entry path that can fire
   inside the ~14-day window.
2. **New, unvalidated rule (expectancy unknown):** the higher-high continuation
   confirm. Its presence in the original spec is *not* evidence it is profitable
   — it was dropped and never validated. Shipping it in shadow mode first is how
   we keep #1's correctness from being entangled with #2's uncertainty.

### Half-restored is intentional, not an oversight

This change does **not** widen the enumeration window, so the PEAD weekly-breakout
path stays effectively stranded (it needs `weeksSinceEarnings ≥ 2`, by which
point names have aged out). Therefore `continuation OR pead-ready` resolves to
**continuation in nearly every case** — continuation becomes the de facto sole
operative path. The original design wanted two complementary patterns (fast
momentum continuation + pullback-then-resume PEAD); we are deliberately shipping
only the first. Restoring the PEAD path is a known **companion follow-up**
(widening / extending the enumeration window for names under PEAD-watch), tracked
separately and **out of scope here**.

### Non-goals (out of scope for this change)

- Widening the enumeration window to make the PEAD path reachable (the companion
  follow-up above).
- The `ENABLE_DRIFT_WARMER` orchestrator wiring (the flag is intentionally
  `false` today; the cold-cache → preflight-fail-open path is accepted).
- The cross-agent HTTP 429 storm that drops some universe tickers from scoring.
- Any change to sizing, risk caps, or exit rules.
- Any anti-chase / large-gap extension guard (deferred; we only *instrument* its
  future inputs here — see Observability).
- A forward-outcome tracking subsystem in the service. Shadow logging records
  enough per-event fields that forward outcomes can be reconstructed offline; we
  do not build live forward-PnL tracking into the Go service.

---

## Design

### Architecture (unchanged)

Keep the split: deterministic Go backend computes signals; the LLM is a pure rule
executor that reads booleans and applies the documented entry/exit rules. The
continuation signal is computed in Go and surfaced in the `DriftSignal` payload,
mirroring how `pead` is handled. No agent-side arithmetic.

### Feature flag & rollout (shadow → enforce)

`ENABLE_DRIFT_CONTINUATION` env var, read in `cmd/bot/main.go` and passed to
`DriftCandidatesService` (mirrors the existing `ENABLE_*` flag plumbing). Default
**OFF (shadow)**. The flag gates the **backend**, not the agent's rule text — the
agent never reads env vars (same pattern as `PENNY_DILUTION_FILTER_MODE`: the mode
controls what the backend returns; the rule describes the enforced behavior).

| | Shadow (default, OFF) | Enforce (ON) |
|---|---|---|
| Continuation computed | Yes (always) | Yes |
| `continuation.is_continuation` **in payload** | forced `false` (agent can't act on it) | truthful |
| Candidate filter | base gates only — unchanged from today; non-actionable in-window names (e.g. CSCO/MONITORING) still surface | tightened: base gates **AND** (`is_continuation` OR pead-ready) |
| Would-be continuation entries | logged at service level only | become real (paper) entries |
| External agent behavior | identical to today (pead-only ⇒ ≈ no entries) + shadow logs | enters on continuation |

Rationale: in shadow mode the candidate list is intentionally left untightened so
the existing near-miss visibility (the "CSCO rejected, MONITORING" agent lines)
is preserved — that is the signal that distinguishes "fix works, no setups yet"
from "fix didn't land." Tightening (which removes those lines) only takes effect
once continuation is actually doing the work.

### Component 1 — `computeDriftContinuation` (Go, pure function)

New function and struct in `services/drift_signal_service.go`. Bars are
oldest-first (package convention). **Always computes the true value, independent
of the flag** — flag gating happens only in the candidates service.

```go
type DriftContinuation struct {
    IsContinuation bool    `json:"is_continuation"`
    GapBarHigh     float64 `json:"gap_bar_high"`
    LatestClose    float64 `json:"latest_close"`
    PriorHigh      float64 `json:"prior_high"`
    DaysAfterGap   int     `json:"days_after_gap"`
    ExtensionPct   float64 `json:"extension_pct"` // latest_close / gap_bar_high - 1, in %
    Warning        string  `json:"warning,omitempty"`
}
```

Logic:

- Find `earningsIdx = findBarIndexByDate(bars, earningsDate)`. If `< 0`, return
  `{Warning: "earnings_date not in bars"}` (IsContinuation=false).
- Determine the **gap bar** — the bar the gap is measured on, matching
  `computeDriftGap`:
  - BMO: `gapBarIdx = earningsIdx`
  - AMC / unknown: `gapBarIdx = earningsIdx + 1` (if `earningsIdx+1 >= len(bars)`,
    return `{Warning: "no gap bar yet for AMC"}`).
- `L = len(bars)`, `latestIdx = L-1`.
- `DaysAfterGap = latestIdx - gapBarIdx`.
- `GapBarHigh = bars[gapBarIdx].High`, `LatestClose = bars[L-1].Close`,
  `PriorHigh = bars[L-2].High` (guard `L >= 2`; given `driftMinBars = 210` this is
  always satisfied, so it is defensive).
- `ExtensionPct = roundTo2((LatestClose/GapBarHigh - 1) * 100)` when `GapBarHigh > 0`.
- `IsContinuation = DaysAfterGap >= 1 AND LatestClose > GapBarHigh AND LatestClose > PriorHigh`.

Rationale (decision: **robust higher-high confirm**):
- `DaysAfterGap >= 1` — never enter on the gap bar itself; wait for at least one
  day of follow-through. Tolerant of a missed day-after beat (still valid on a
  later in-window beat).
- `LatestClose > GapBarHigh` — the move has cleared the earnings reaction high
  (genuine continuation, not a fade).
- `LatestClose > PriorHigh` — a fresh higher-high close confirms the advance is
  still active on the evaluation day, filtering names that ran once and stalled.

**Day-1 identity (documented, not a bug):** when `DaysAfterGap == 1`,
`gapBarIdx == L-2`, so `GapBarHigh == PriorHigh` and the two `LatestClose > …`
tests are the same comparison — the higher-high confirm only adds independent
filtering from day 2 on. This matches the original spec's day-1 phrasing
("close > previous day's high"). A test documents this so a future reader does
not "simplify" the apparent redundancy.

### Component 2 — wire into `ComputeDriftSignal`

Add `Continuation DriftContinuation` to the `DriftSignal` struct (json key
`continuation`) and populate it in `ComputeDriftSignal` alongside `gap`, `pead`,
etc. **`ComputeDriftSignal` stays pure — it always emits the truthful
continuation value.** The shadow/enforce gating (forcing `is_continuation=false`
in shadow) is applied later in `DriftCandidatesService.compute`, so the pure
function and the `/signal/:symbol` endpoint are unaffected and easy to test.
Signal version stays `v1` (additive field).

### Component 3 — candidate filter + flag gating (`DriftCandidatesService.compute`)

The service gains a `continuationEnabled bool` field (set from the env flag in
`main.go`). Per qualifying ticker, after the existing gap / MA / grade checks:

```go
peadReady := sig.PEAD.Stage == "SIGNAL_READY" || sig.PEAD.Stage == "BREAKOUT"
cont := sig.Continuation.IsContinuation // truthful computed value

// Shadow telemetry is emitted in BOTH modes (see Observability).
if cont {
    s.logger.WithFields(...).Info("drift: would-be continuation entry")
}

if s.continuationEnabled {
    // ENFORCE: tighten to actionable names; leave is_continuation truthful.
    if !cont && !peadReady {
        continue
    }
} else {
    // SHADOW: keep today's base-gates-only filter (non-actionable names still
    // surface for near-miss visibility); zero the field so the agent, applying
    // "enter on continuation OR pead-ready", cannot act on it.
    sig.Continuation.IsContinuation = false
}
resp.Candidates = append(resp.Candidates, *sig)
```

Result: with the flag OFF, `count` and the candidate list are exactly as today
(near-miss visibility preserved); with the flag ON, `count` reflects only truly
entry-eligible names, so `driftPreflight` skips dead days and only wakes the LLM
when there is real work.

### Component 4 — rules (`TRADING_RULES_DRIFT.md`)

- **Entry signal:** replace the mandatory
  `pead.stage ∈ {SIGNAL_READY, BREAKOUT}` line with an OR condition: base gates
  (gap.gap_pct ≥ +3.0, ma200_position.above_ma, ma50_position.above_ma,
  composite.grade ∈ {A,B}) **AND**
  (`continuation.is_continuation == true` **OR** `pead.stage ∈ {SIGNAL_READY, BREAKOUT}`).
- **Operator note** (mirrors the penny dilution-filter mode note): continuation
  entries are gated by `ENABLE_DRIFT_CONTINUATION` (default OFF = shadow: the
  backend reports `is_continuation=false` and logs would-be entries; no
  continuation trades occur until the operator enables it). The pead.stage path
  is always active but rarely reachable in the current window.
- **Ranking preference:** BREAKOUT → SIGNAL_READY → continuation, then composite
  score descending.
- **Entry logging:** when an entry fires on continuation, the `log_decision`
  payload records `gap.gap_pct` and `continuation.extension_pct` (the close's
  extension above the gap-bar high) so the future anti-chase guard starts from a
  real distribution.
- **Pre-Trade Checklist:** replace the single `pead.stage` checkbox with a
  combined checkbox: "continuation.is_continuation OR pead.stage ∈ {SIGNAL_READY,
  BREAKOUT}".
- **Signal Definitions / payload block:** add the `continuation` object to the
  documented `get_earnings_drift_candidates` shape and define each sub-field.
- **Glossary:** add a "Continuation" row (latest close above both the gap-bar
  high and the prior day's high, ≥1 day after the gap).

No change to Position Sizing, Risk Management, Regime Gate, Heartbeat Schedule,
or Exit rules.

### Data flow

```
17:00 ET beat
  → preflight driftPreflight → GET /api/v1/drift/candidates
      → DriftCandidatesService.compute
          → FetchRecentReports(now, 5)            (≤14 cal-day earnings window)
          → per ticker: GetSignal → ComputeDriftSignal
              → gap, trend, vol, ma200, ma50, composite, pead, CONTINUATION (new)
          → log coverage summary + per would-be-continuation (BOTH modes)
          → filter:
              shadow  → base gates only (unchanged); is_continuation forced false
              enforce → base gates AND (is_continuation OR pead-ready)
      → count → preflight runs the beat iff count>0
  → LLM reads candidates, applies entry rule (continuation OR pead-ready),
    ranks, sizes (unchanged), place_managed_position(stop 10 / target 20)
```

---

## Observability (shadow instrumentation)

All emitted via the service `logger` (logrus), **kept out of the LLM payload** to
respect the token-cost discipline. Present in BOTH shadow and enforce modes.

1. **Per-scan coverage summary** — one line per `compute` run:
   `reports_in_window`, `in_universe`, `scored_ok`, `dropped_gap`,
   `dropped_ma`, `dropped_grade`, `dropped_not_actionable` (enforce only),
   `fetch_errors` (429s etc.), `actionable_count`. This is the line that
   distinguishes "fix works, no setups yet" from "fix didn't land", and it
   surfaces the 429-starvation confound (a low `in_universe`/high `fetch_errors`
   line means the universe was thinned before scoring — check this before tuning
   continuation thresholds).
2. **Per would-be-continuation event** — for every ticker where the truthful
   `is_continuation == true` (logged regardless of flag): `ticker`,
   `earnings_date`, `timing`, `last_close` (entry reference), `gap_pct`,
   `extension_pct`, `days_after_gap`, `composite_score`, `grade`, `pead.stage`.
   These fields are sufficient to reconstruct forward outcomes offline (join
   against bar history) without building forward tracking into the service.

---

## Testing

Go unit tests in `services/drift_signal_service_test.go`:

- `computeDriftContinuation` BMO: day-after bar closes a higher high above the
  gap-bar high → `IsContinuation == true`, `DaysAfterGap == 1`,
  `ExtensionPct > 0`.
- AMC variant: gap bar is `earningsIdx+1`; continuation measured against that
  bar's high.
- Gap is the latest bar (`DaysAfterGap == 0`) → false.
- Closed above gap-bar high but latest close ≤ prior day's high (stalled / down
  day, `DaysAfterGap ≥ 2`) → false.
- **Day-1 identity test:** with `DaysAfterGap == 1`, document that the gap-bar
  high equals the prior-day high (the confirm is a single comparison on day 1).
- `earnings_date` not in bars → false with warning.
- AMC with no gap bar yet (`earningsIdx+1` out of range) → false with warning.

Candidates-filter / flag tests (drive `compute` via the existing
`RecentReporterFetcher` + `BarFetcher` test seams, mirroring existing drift
candidate tests):

- **Enforce mode:** a fresh post-earnings name showing continuation (MONITORING
  stage) appears in `candidates` with `is_continuation == true` and contributes
  to `count`; a MONITORING name with no continuation does **not** appear.
- **Shadow mode (default):** the same continuation name still appears (base-gates
  filter unchanged) but with `is_continuation == false` in the payload; the
  would-be-continuation log event is emitted.
- A SIGNAL_READY/BREAKOUT name still appears in both modes (PEAD path preserved).

Full regression: `go test ./services/ -count=1`.

---

## Rollout / risk

- **Ships OFF (shadow).** Day-one external behavior is identical to today (no
  continuation trades), plus shadow telemetry. Enabling is a separate, conscious
  `ENABLE_DRIFT_CONTINUATION=true` step after reviewing the shadow logs (or after
  the optional offline expectancy replay).
- Going-forward only; no backfill.
- When enabled, bounded risk: entries use `place_managed_position` with the
  unchanged −10% stop / +20% target / 60-day time stop and the existing
  4% · max-3 · 12% caps. Worst case of a bad continuation entry is a −10%
  bracketed loss on a 4% position.
- Reversible: flip the flag back to OFF to return to the prior (no-entry)
  behavior; no data migration.
- **Reading results:** if, once enabled, trade frequency is low, check the
  per-scan coverage log (point 1) for `fetch_errors`/thin `in_universe`
  (429-starvation) *before* concluding the continuation thresholds are too
  strict.
