# Drift Continuation Expectancy Replay — Design

**Created:** 2026-05-30
**Status:** Approved (design) — revised after spec review; ready for implementation plan
**Agent:** Drift (`drift` / strategy `earnings-drift`)
**Builds on:** `docs/superpowers/specs/2026-05-29-drift-continuation-entry-path-design.md`

**Revised after external spec review (2026-05-30):** the exit model now mirrors the
*full* live exit (4 legs incl. MA50-break, time stop in **trading** days) by reusing
`computeDriftMA50`; the `SimulateExit` bar-ordering is gap-priority; a base-gates-only
**control cohort** isolates continuation's marginal edge; the anti-chase metric is a
continuous correlation (buckets demoted to descriptive); bar-adjustment mode and
survivorship/pessimism bias direction are stated explicitly. See the inline notes
tagged **[review]**.

---

## Problem

The Drift continuation entry path (`computeDriftContinuation`, shipped 2026-05-29,
flag `ENABLE_DRIFT_CONTINUATION`, currently in shadow) has **unit tests proving the
boolean computes correctly, but no evidence it predicts money.** Its presence in
the original spec is not evidence of edge — it was a dropped feature, never
validated.

The intended rollout is shadow → enable. But live shadow telemetry accrues at
~1 candidate scan per trading day over a small universe and a narrow (~14 calendar
day) post-earnings window, and is further thinned by the cross-agent 429 storm
(`memory/cross-agent-429-storm-project`). Waiting for a statistically meaningful
live shadow sample would take many weeks and still be noisy.

We need a faster, denser, 429-immune way to answer the question that actually
gates `ENABLE_DRIFT_CONTINUATION=true`: **does the continuation rule have positive
expectancy after realistic friction, does it add edge over the base gates alone,
and where (if anywhere) does chasing extended entries erode that edge?**

## Goal

A one-shot, offline Go CLI that replays the **exact deployed entry and exit rules**
over ~3 years of historical earnings gaps in Drift's universe, simulates each
resulting trade under conservative daily-bar fills, and reports gross +
friction-adjusted expectancy, a base-gates-only control comparison, and the
`extension_pct`↔return relationship. Deliverables:

1. **A go/no-go expectancy read** to calibrate the enable decision before risking
   (paper) capital.
2. **A marginal-edge read** — the deployed (continuation) cohort vs. a base-gates-only
   control cohort — so the verdict distinguishes "the filter works" from
   "continuation works."
3. **The `extension_pct`↔return relationship** (continuous) to size a future
   anti-chase guard (the live shadow logs already record `extension_pct` at entry;
   this gives the distribution to calibrate a cap against).

### Why Go-native (rejected alternatives)

The replay's entire value is that it exercises the **exact compiled rule** that
will trade. A Node reimplementation (matching the `build-regime-history.mjs` /
`rank-floor-movers.mjs` convention) would re-derive the rule's subtleties — AMC
gap-bar indexing, the day-1 identity, grade weights/thresholds, MA200/MA50,
**and the MA50-break exit** — in a second language, and a green verdict would then
validate a *copy* that can silently drift from Go. A Go/Node hybrid (Go dumps
signals to JSON, Node simulates) keeps signal fidelity but re-implements the exit
and splits the simulator from the bars it should be tested against. Go-native
reuses `ComputeDriftSignal` and `computeDriftMA50` verbatim, gets the
`SharedBarCache` + rate limiter + FMP earnings fetch for free, and keeps signal,
exit, and simulator testable against the same bars. The only cost is more ceremony
for report formatting, which is minor.

---

## Non-goals (explicit YAGNI)

- **Threshold tuning / parameter sweep.** This validates the *deployed* rule on a
  single fixed ruleset. Varying parameters to find a "better" configuration shifts
  the project from validation to tuning and risks overfitting (the same hazard the
  2026-05-17 walk-forward spec warns about). The base-gates-only control cohort is
  *not* a sweep — it is the single, fixed control group for the marginal-edge
  question.
- **PEAD-path replay.** The enforce-mode filter is `(continuation OR pead-ready)`;
  the replay includes the `pead-ready` OR term for fidelity and reports
  `n_pead_entries`, but as the continuation spec established, `pead.stage ∈
  {SIGNAL_READY, BREAKOUT}` is ~never reachable inside the 14-day window.
  Continuation is the operative path; a dedicated PEAD replay is not built.
- **Portfolio-path simulation.** Each earnings event is an independent single-position
  outcome. The 4% / max-3 / 12% concurrency caps, the regime gate, and the capital
  path are *not* modeled — they dilute the per-trade edge signal we are validating.
- **Intraday bars.** Daily OHLC only, matching Drift's daily-bar signal architecture.
- **Live forward-outcome tracking.** Offline historical replay only; no changes to
  the running service.
- **Building the anti-chase guard.** The replay only *calibrates* it. Implementing
  a guard is a separate follow-up.
- **No changes** to the trading rule, `cmd/bot`, agent rules, or any live behavior.

---

## Design

### Pipeline (data flow)

```
cmd/driftreplay --years 3 [--from YYYY-MM-DD --to YYYY-MM-DD] [--out data/reports/]
  1. Enumerate earnings events   FMP /stable/earnings-calendar over [now-3y, now],
                                 filter to DriftUniverse → (ticker, earningsDate, timing)
  2. Per symbol: fetch ONE window  GetHistoricalBars via SharedBarCache + rate limiter:
                                 [earliest_event - 365d .. latest_event + 120d], "1Day",
                                 Adjustment=All (split/div adjusted), IEX feed
  3. Per event: find entries     deployed cohort  = first day base gates AND (cont OR pead)
                                 control cohort   = first day base gates (cont/pead ignored)
                                 (both over trading days in (earningsDate, earningsDate+14cal])
  4. Per entry: simulate exit    entry = open[entryIdx]; SimulateExit reuses computeDriftMA50
  5. Aggregate + report          expectancy (gross + friction), deployed-vs-control,
                                 extension_pct↔return correlation → .md + .json
```

The signal is computed by the existing pure function `ComputeDriftSignal(symbol,
bars, earningsDate, timing)` fed a **point-in-time bar slice** `bars[:idxD+1]`
(bars on or before evaluation day D). Forward bars (after D) feed *only* the exit
simulator. The replay must **not** call `DriftSignalService.GetSignal`, which
fetches its own fixed `now-365d..now` window and would leak future bars.

### Component 1 — historical earnings enumeration

Refactor `EarningsCalendarService.FetchRecentReports` to delegate to a new exported
method:

```go
// FetchReportsInRange does a one-off (uncached) FMP /stable/earnings-calendar
// fetch over [from, to] and returns parsed RecentReport entries (timing
// normalized to "bmo"/"amc"/""). FetchRecentReports computes its from/to window
// and calls this.
func (s *EarningsCalendarService) FetchReportsInRange(ctx context.Context, from, to time.Time) ([]RecentReport, error)
```

`FetchRecentReports` keeps its current behavior (computes `from = now-(days*2+4)`,
`to = now`, then delegates; existing `TestFetchRecentReports_*` tests must still
pass). The replay calls `FetchReportsInRange(ctx, now.AddDate(-3,0,0), now)` and
filters to `DriftUniverse`. FMP starter-tier history may not reach a full 3 years;
the replay reports the **actual** date range achieved.

**[review] Timing field:** record the `bmo`/`amc`/`""` fill-rate over the window
and surface it in the report. Empty/unknown timing uses the **AMC gap-bar
convention** (`gapBarIdx = earningsIdx+1`), matching `computeDriftGap` /
`computeDriftContinuation`. A thin historical timing field would shift some entries
by a day, so the fill-rate is a data-quality signal worth seeing next to the verdict.

### Component 2 — per-symbol bar fetch

For each universe symbol with ≥1 in-range event, fetch **one** daily-bar window
spanning `[earliest_event - 365 calendar days, latest_event + 120 calendar days]`
via `GetHistoricalBars(ctx, sym, start, end, "1Day")` through the existing
`SharedBarCache` + rate limiter. The −365d lower bound guarantees ≥210 trading
bars before the earliest gap (for MA200 + the 20-day trend lookback). **[review]**
The +120d upper bound covers the 14-cal-day entry window plus a **60-*trading*-day**
hold (≈84 calendar days) plus the next-session-open fill of an EOD exit plus
holiday margin — the original +75d was sized for a calendar-day time stop and is
too tight. Per-event evaluation slices this in-memory window — one fetch per symbol,
not per event.

**[review] Bar adjustment:** `GetHistoricalBars` requests `Adjustment:
marketdata.All` (`alpaca_data.go:107`), so bars are split- and dividend-adjusted.
`SimulateExit` therefore never sees a raw split discontinuity, and reproducibility
of the price series is pinned by Alpaca's adjustment, not by us. **Feed:**
`marketdata.IEX` (free feed) — historical depth can be sparse on older bars, which
is handled by per-name soft-fail (below), not assumed away.

### Component 3 — entry model (mirrors live exactly) + control cohort

Per earnings event, scan trading days in `(earningsDate, earningsDate + 14 calendar
days]` — the same window the live `FetchRecentReports(now, 5)` (`days*2+4` = 14
calendar days) surfaces a name as a candidate. On each day D:

```go
sig := ComputeDriftSignal(sym, bars[:idxD+1], earningsDate, timing)
baseGates := sig.Gap.GapPct >= 3.0 && sig.MA200.AboveMA && sig.MA50.AboveMA &&
             (sig.Composite.Grade == "A" || sig.Composite.Grade == "B")
peadReady := sig.PEAD.Stage == "SIGNAL_READY" || sig.PEAD.Stage == "BREAKOUT"
```

- **Deployed cohort** (the rule under test): entry on the **first** day where
  `baseGates && (sig.Continuation.IsContinuation || peadReady)`.
- **[review] Control cohort** (base-gates-only): entry on the **first** day where
  `baseGates` holds, ignoring continuation/pead. Same exit logic.

The first qualifying day is the entry (faithful to once-daily 17:00 beats: Drift
enters one position per name on the first beat that passes). Record at entry:
`extension_pct`, `gap_pct`, `days_after_gap`, `composite_score`, `grade`,
`pead.stage`, `entry_reason` (`continuation` / `pead_breakout` / `base_only`).

**[review] Last-bar guard:** if the qualifying day D is the last bar in the window
(no `open[D+1]` to fill against), the event is a **non-entry/drop** (counted), not a
crash. Events with no qualifying day → non-entries (feed selectivity coverage, not
expectancy).

The deployed vs. control comparison isolates continuation's marginal edge: among
events where both cohorts enter, paired outcome differences; plus each cohort's
overall expectancy. `n_pead_entries` is reported separately (expected ≈ 0 over the
window, which would empirically confirm the PEAD reachability claim).

### Component 4 — exit model (the *full* live exit, conservative daily-bar)

**[review] The live exit has four legs** (`TRADING_RULES_DRIFT.md` "Exit signals"):
+20% target and −10% stop (broker bracket, fire **intraday**); a **60-trading-day**
time stop; and an **MA50-break** (close when `ma50_position.above_ma` goes false on
the most recent close). The time/MA50 exits are agent decisions at the 17:00 EOD
beat, so they **fill at the next session's open**. The simulator models all four
and reuses `computeDriftMA50` so MA50-break uses the identical computation as the
live signal.

`SimulateExit(bars []*interfaces.Bar, entryIdx int, cfg ExitConfig) ExitResult`,
pure and the most heavily tested unit. `entry = bars[entryIdx].Open`,
`stop = entry × (1 − cfg.StopPct)`, `target = entry × (1 + cfg.TargetPct)`. Walk
`i` from `entryIdx` forward:

**Intraday bracket check on bar `i` (gap-priority, then tie-break):**

| Condition (in order) | Exit price | Reason | Note |
|---|---|---|---|
| `open[i] ≤ stop` | `open[i]` | `stop_gap` | gapped through stop |
| `open[i] ≥ target` | `open[i]` | `target_gap` | gapped through target (favorable fill) |
| `stop < open[i] < target` AND `Low[i] ≤ stop` AND `High[i] ≥ target` | `stop` | `stop` | **stop-first** intraday tie-break (pessimistic) |
| `Low[i] ≤ stop` | `stop` | `stop` | |
| `High[i] ≥ target` | `target` | `target` | |

(On the entry bar `i == entryIdx`, `open == entry`, so neither gap branch can fire —
correct, you just filled at the open.)

**EOD check on bar `i` (only if no bracket exit fired), evaluated at the close,
filling at `open[i+1]`:**

1. **Time stop** (checked first, for reason precedence): if `i − entryIdx ≥
   cfg.TimeStopDays` (60 trading days) → reason `time`, exit `open[i+1]`.
2. **MA50 break:** `ma50 := computeDriftMA50(bars[:i+1])`; if
   `!ma50.AboveMA` (close `i` below its 50-day MA) → reason `ma50_break`, exit
   `open[i+1]`.
3. If an EOD exit triggers but `bars[i+1]` does not exist → reason `data_end`, exit
   `bars[i].Close` (no next open available).

If `i` runs off the end with no exit → reason `data_end`, exit last close.

`ExitConfig{StopPct: 0.10, TargetPct: 0.20, TimeStopDays: 60}`. `ExitResult`
carries `ExitPrice`, `ExitIdx`, `Reason`, `HoldingDays` (`ExitIdx − entryIdx`,
trading days), `RawReturnPct`.

**[review] On the time-stop unit:** `TRADING_RULES_DRIFT.md` says "60 trading days"
in the philosophy and boundary sections but the glossary says "calendar trading
days" (an oxymoron). We model **60 trading bars** since that is the dominant
phrasing and the agent beats once per trading day. The glossary wording is a
minor rules-doc inconsistency, noted but not fixed here.

### Component 5 — friction

Reuse `config/friction.json`'s `stocks` profile as the single source of truth
(`per_share_slippage_usd` 0.02, `stop_gap_through_pct` 0.003,
`regulatory_fee_per_share` 0.0001, `commission_per_share` 0.0). A minimal Go loader
reads just the `stocks` block (fail loud if missing/malformed). Haircut deducted
from raw P&L:

```
haircut_per_share = (per_share_slippage_usd + regulatory_fee_per_share) * 2   // entry + exit
if reason == "stop":  haircut_per_share += stop_gap_through_pct * entry_price   // [review] stop ONLY
friction_adjusted_pl_per_share = (exit_price - entry_price) - haircut_per_share
```

**[review]** The gap-through slippage is added only on the `stop` reason (an
intraday fill assumed at exactly the stop price, where real stop-market orders slip
beyond). It is **not** added on `stop_gap`, because that exit already fills at the
gapped-down open, which embeds the adverse move — adding it would double-count.

**[review] Friction is small here.** For a long-stock strategy with $0 commissions
and 2¢ slippage, a +20% winner loses ~4¢/share to friction and only `stop` exits
carry the 0.3% gap-through; friction-adjusted expectancy will track gross closely
(unlike the options agents). Both are reported so the (small) haircut is visible.
Expectancy is reported in **% return** (sizing is a fixed 4%, identical across
trades); a notional dollar figure on a 4% position is shown for readability. The
report records the friction `version` and an 8-char hash of `config/friction.json`,
mirroring `apply-friction.mjs`'s `friction_meta`.

### Component 6 — aggregation + output

`Aggregate(outcomes []TradeOutcome) ReplaySummary` (pure) computes, for both gross
and friction-adjusted, **per cohort (deployed / control):**

- `n_entries`, win rate, avg win %, avg loss %, profit factor, **expectancy %/trade**,
  avg holding days (trading), exit-reason distribution (target / stop / stop_gap /
  target_gap / time / ma50_break / data_end).
- **[review] Marginal edge:** deployed-minus-control expectancy, both overall and on
  the paired subset (events both cohorts entered).
- **[review] Anti-chase (continuous primary):** Spearman ρ and an OLS slope of
  entry `extension_pct` vs friction-adjusted return across all deployed entries,
  with n. Buckets (`[0,1) [1,2) [2,4) [4,7) [7+]`) are reported **only as a
  descriptive aid**, each with count, mean return, and a win-rate confidence
  interval — explicitly labeled low-power, not a cap signal on their own.
- **[review] Universe price distribution:** min / median / max `last_close` across
  entered names (confirms friction homogeneity).
- **Coverage / soft-fail:** events enumerated, in-universe, bars-ok, dropped (with
  reasons: missing bars, earnings date not in bars, insufficient history, last-bar
  non-entry), entries, non-entries, `n_pead_entries`, timing fill-rate, actual date
  range achieved.

Output: `data/reports/drift-continuation-replay-<rundate>.md` (human report) +
`drift-continuation-replay-<rundate>.json` (machine-readable sidecar). UTF-8.

---

## Lookahead-bias guards (must hold)

1. Signal computed only on `bars[:idxD+1]` — no bar after evaluation day D reaches
   `ComputeDriftSignal`.
2. **[review]** MA50-break in the exit uses `computeDriftMA50(bars[:i+1])` — only
   bars up to the evaluation day `i`; no forward leak.
3. Entry fills at `open[entryIdx]` (the next session after the signal day); EOD
   exits fill at `open[i+1]` — never the same-bar close they were decided on.
4. `earningsDate` must resolve inside the bar slice (`findBarIndexByDate ≥ 0`);
   otherwise the event is soft-failed and counted, never silently treated as flat.

---

## Files

**New:**
```
cmd/driftreplay/main.go                 CLI: flags, wiring, orchestration, report writing
services/drift_replay.go                SimulateExit, findEntries (deployed+control),
                                        Aggregate, friction loader
services/drift_replay_test.go           TDD (below)
docs/superpowers/specs/2026-05-30-drift-continuation-expectancy-replay-design.md  (this file)
```

**Modified:**
```
services/penny_earnings_service.go      extract FetchReportsInRange; FetchRecentReports delegates
```

No new third-party dependencies. No changes to the rule, the bot, or agent rules.

---

## Testing

Go (`go test ./services/ -run TestDriftReplay`), per workflow preference.

**`SimulateExit` (pure, the critical unit):**
- target hit intraday → `target`, correct return.
- stop hit intraday → `stop`.
- both pierced, `stop < open < target` → `stop` (stop-first tie-break).
- **[review]** gap-up bar `open ≥ target` whose low also pierces stop → `target_gap`
  at the open (NOT misattributed as a stop — the bug the review caught).
- gap-down `open ≤ stop` → `stop_gap` at the open.
- **[review]** time stop: no bracket/MA50 hit within 60 trading bars → reason `time`,
  fill at `open[entryIdx+60+1]`, `HoldingDays == 60`.
- **[review]** MA50 break: a forward close below its 50-day MA before any other exit
  → reason `ma50_break`, fill at the next open; assert it uses `computeDriftMA50`
  semantics (drive bars so above_ma flips exactly on the target day).
- **[review]** time stop and MA50 break true on the same EOD → reason `time`
  (precedence), price identical.
- EOD exit on the last available bar (no `bars[i+1]`) → `data_end` at that close.
- bars exhausted with no exit → `data_end` at last close.

**`findEntries`:**
- deployed: first qualifying day selected (not a later one); qualifies day 2, fails
  day 3 → entry day 2; no day qualifies in 14-cal window → non-entry.
- **[review]** control: enters on first base-gates day even when continuation never
  fires; an event where only control enters is in control, absent from deployed.
- lookahead guard: a future bar that would flip the signal does not affect day-D.
- `pead-ready` OR branch qualifies the deployed cohort with `is_continuation==false`.
- **[review]** last-bar qualification → non-entry/drop, not a panic.

**friction loader + application:**
- loads `stocks`; missing/malformed `config/friction.json` → fail loud.
- round-trip haircut `(slippage+reg_fee)*2`; **[review]** `stop` adds
  `stop_gap_through_pct*entry`, `stop_gap` does **not** (no double-count).

**`Aggregate`:**
- win rate / avg win / avg loss / profit factor / expectancy hand-calculated.
- **[review]** Spearman ρ + slope on a small fixture with a known monotone relation.
- bucket CIs: empty buckets reported as zero-count, not omitted.
- deployed-minus-control marginal edge computed on the paired subset.
- gross vs friction-adjusted computed independently.

**Regression:** `go test ./services/ -count=1` and `go build ./...` stay green
(the `FetchReportsInRange` refactor preserves `FetchRecentReports` behavior).

The CLI orchestration in `cmd/driftreplay/main.go` is a thin wiring layer; verified
by one real offline run during implementation (reviewing coverage + a sanity-checked
sample trade), not by automated tests.

---

## Error handling / soft-fail

| Scenario | Behavior |
|---|---|
| FMP earnings fetch fails | Fail loud (no events = no replay). |
| FMP returns < 3 years of history | Proceed; report the actual range. |
| Alpaca bars missing/short for a symbol (IEX sparse) | Soft-fail that **symbol**, count in `dropped`, continue. |
| `earningsDate` not in a symbol's bars | Soft-fail that **event**, count in `dropped`. |
| **[review]** Signal qualifies on the last bar (no `open[D+1]`) | **Non-entry/drop**, counted; not a crash. |
| `config/friction.json` missing/malformed | Fail loud, point to the file. |
| Forward bars end before an exit | Exit `data_end` at last close, flagged + tallied. |
| 429 during bar fetch | Existing rate limiter + cache; offline run has no market-hours contention. Persistent failure → soft-fail symbol. |

A name with no data is **dropped and counted**, never treated as a flat (0%) trade.

---

## Risks / honest caveats

1. **Sample size.** ~3 years × ~80 names × (gap≥3% ∩ grade A/B ∩ continuation) may
   yield only tens of entries — a calibration read, not a hypothesis test. n is
   stated explicitly; the extension↔return slope in particular is low-powered, which
   is why it is reported as a continuous correlation with n rather than a
   bucket staircase.
2. **[review] Survivorship vs. pessimism do not cleanly cancel.** Using the *current*
   `DriftUniverse` conditions on names that did not blow up (biases the read
   **up**); the daily-bar stop-first / next-open-EOD-fill rules bias it **down**.
   The two offset by an **unknown** amount — the result is *not* cleanly
   "conservative." The report states both directions rather than implying a net.
3. **Daily-bar fills approximate intraday paths.** Stop-first on genuine same-day
   ties is pessimistic; `target_gap` at the open is a favorable fill. Net direction
   of this approximation alone is mild-pessimistic, but see #2.
4. **Friction is an estimate** and small for this asset class; shown alongside gross.
5. **FMP/Alpaca history depth.** Starter-tier earnings history and the IEX bar feed
   may truncate the window; soft-fail + actual-range reporting prevent a silent
   short sample, but the effective sample could be smaller than hoped.
6. **Marginal edge needs both cohorts to enter.** Where the control cohort enters
   but continuation never fires, those events inform the control's expectancy but
   not the paired delta; the report shows both the overall and paired comparisons.

---

## Rollout

- Pure analysis tool. No flag, no live behavior change, no rule change. Adding a new
  `cmd/` binary and one service file does not affect `cmd/bot`.
- Output is advisory: it informs the human `ENABLE_DRIFT_CONTINUATION=true` decision
  and the future anti-chase guard threshold. It does not auto-enable anything.
- Lands on local main (rebuild-from-main deploy model); the new binary is built on
  demand (`go build ./cmd/driftreplay`) and run offline.
