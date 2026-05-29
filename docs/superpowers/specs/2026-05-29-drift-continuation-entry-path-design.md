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

Implement the missing continuation entry path so Drift can act within days of a
qualifying post-earnings gap, while preserving the PEAD weekly-breakout path as
an alternative. Keep the deterministic-Go / dumb-LLM-executor architecture.

**Non-goals (out of scope for this change):**

- The `ENABLE_DRIFT_WARMER` orchestrator wiring (the flag is intentionally
  `false` today; the cold-cache → preflight-fail-open path is accepted).
- The cross-agent HTTP 429 storm that drops some universe tickers from scoring.
- Any change to sizing, risk caps, or exit rules.
- Any anti-chase / large-gap extension guard (the higher-high confirm already
  filters stalled names; noted as a future tuning lever).

---

## Design

### Architecture (unchanged)

Keep the split: deterministic Go backend computes signals; the LLM is a pure rule
executor that reads booleans and applies the documented entry/exit rules. The
continuation signal is computed in Go and surfaced in the `DriftSignal` payload,
mirroring how `pead` is handled. No agent-side arithmetic.

### Component 1 — `computeDriftContinuation` (Go, pure function)

New function and struct in `services/drift_signal_service.go`. Bars are
oldest-first (package convention).

```go
type DriftContinuation struct {
    IsContinuation bool    `json:"is_continuation"`
    GapBarHigh     float64 `json:"gap_bar_high"`
    LatestClose    float64 `json:"latest_close"`
    PriorHigh      float64 `json:"prior_high"`
    DaysAfterGap   int     `json:"days_after_gap"`
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
  `PriorHigh = bars[L-2].High` (guard `L >= 2`).
- `IsContinuation = DaysAfterGap >= 1 AND LatestClose > GapBarHigh AND LatestClose > PriorHigh`.

Rationale (decision: **robust higher-high confirm**):
- `DaysAfterGap >= 1` — never enter on the gap bar itself; wait for at least one
  day of follow-through. Tolerant of a missed day-after beat (still valid on a
  later in-window beat).
- `LatestClose > GapBarHigh` — the move has cleared the earnings reaction high
  (genuine continuation, not a fade).
- `LatestClose > PriorHigh` — a fresh higher-high close confirms the advance is
  still active on the evaluation day, filtering names that ran once and stalled.

### Component 2 — wire into `ComputeDriftSignal`

Add `Continuation DriftContinuation` to the `DriftSignal` struct (json key
`continuation`) and populate it in `ComputeDriftSignal` alongside `gap`, `pead`,
etc. Signal version stays `v1` (additive field; no consumer breakage — the agent
reads the new field only where the rules now reference it).

### Component 3 — candidate filter (`DriftCandidatesService.compute`)

Today the per-ticker filter is `gap≥3 ∧ aboveMA200 ∧ aboveMA50 ∧ grade∈{A,B}` and
ignores stage, so non-actionable MONITORING names surface (inflating `count`,
waking the preflight beat). Tighten it to the actionable gate (confirmed
decision A):

```go
peadReady := sig.PEAD.Stage == "SIGNAL_READY" || sig.PEAD.Stage == "BREAKOUT"
if !sig.Continuation.IsContinuation && !peadReady {
    continue
}
```

(Applied after the existing gap / MA / grade checks.) Result: the response
`count` reflects only truly entry-eligible names, so `driftPreflight` skips dead
days correctly and only wakes the LLM when there is real work.

### Component 4 — rules (`TRADING_RULES_DRIFT.md`)

- **Entry signal:** replace the mandatory
  `pead.stage ∈ {SIGNAL_READY, BREAKOUT}` line with an OR condition: base gates
  (gap.gap_pct ≥ +3.0, ma200_position.above_ma, ma50_position.above_ma,
  composite.grade ∈ {A,B}) **AND**
  (`continuation.is_continuation == true` **OR** `pead.stage ∈ {SIGNAL_READY, BREAKOUT}`).
- **Ranking preference:** BREAKOUT → SIGNAL_READY → continuation, then composite
  score descending.
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
          → filter: base gates AND (continuation OR pead-ready)   (CHANGED)
      → count reflects actionable names → preflight runs the beat iff count>0
  → LLM reads candidates, applies entry rule (continuation OR pead-ready),
    ranks, sizes (unchanged), place_managed_position(stop 10 / target 20)
```

---

## Testing

Go unit tests in `services/drift_signal_service_test.go`:

- `computeDriftContinuation` BMO: day-after bar closes a higher high above the
  gap-bar high → `IsContinuation == true`, `DaysAfterGap == 1`.
- AMC variant: gap bar is `earningsIdx+1`; continuation measured against that
  bar's high.
- Gap is the latest bar (`DaysAfterGap == 0`) → false.
- Closed above gap-bar high but latest close ≤ prior day's high (stalled / down
  day) → false.
- `earnings_date` not in bars → false with warning.
- AMC with no gap bar yet (`earningsIdx+1` out of range) → false with warning.

Candidates-filter test (drive `compute` via the existing
`RecentReporterFetcher` + `BarFetcher` test seams, mirroring existing drift
candidate tests):

- A fresh post-earnings name showing continuation (MONITORING stage) now appears
  in `candidates` and contributes to `count`.
- A MONITORING name with no continuation does **not** appear (regression guard
  for the old always-surface behavior).
- A SIGNAL_READY/BREAKOUT name still appears (PEAD path preserved).

Full regression: `go test ./services/ -count=1`.

---

## Rollout / risk

- Going-forward only; no backfill. First effect is the next 17:00 ET beat with a
  qualifying continuation candidate.
- Bounded risk: entries still use `place_managed_position` with the unchanged
  −10% stop / +20% target / 60-day time stop and the existing 4% · max-3 · 12%
  caps. Worst case of a bad continuation entry is a −10% bracketed loss on a 4%
  position.
- Reversible: the filter and rule are the only behavior changes; reverting the
  rule line restores the prior (no-entry) behavior.
