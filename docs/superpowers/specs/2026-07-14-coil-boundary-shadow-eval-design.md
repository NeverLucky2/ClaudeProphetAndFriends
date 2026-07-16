# Coil Boundary Shadow Eval (`coil-shadow`) — Design

> Revised after an adversarial multi-lens review (2026-07-15). The review found no
> fatal flaw in the *concept* but several real methodology holes — dependence-blind
> standard errors, an under-specified power calc, incomplete confound control, a
> corporate-action scoring bug, and a same-day information leak. All are addressed
> below. Read the review's net effect honestly: this is now a real build (one Go
> endpoint + three scripts + a proper clustered/fixed-effects regression), and for
> any *realistic* LLM edge the most likely verdicts are REJECT or INCONCLUSIVE, not
> KEEP. That is the honest cost of an un-foolable test.

## Problem

Coil's entry trigger is a hard cliff: `RSI(2) < 5`. A name at `RSI(2) = 5.2` is
economically almost identical to one at `4.8`, yet the mechanical rule treats the
first as a no-buy and the second as a buy. The operator wants to know whether an
LLM's discretionary judgment — "this near-miss will bounce, fire early" — adds
real edge at that boundary, or whether it merely dilutes the strategy's edge with
lower-expectancy entries.

This cannot be answered by a normal backtest. An LLM discretionary overlay is
non-deterministic and, run over historical data, is contaminated by look-ahead
(the model knows how the past resolved). So the question must be answered
**forward, live, and without trading** — a shadow evaluation that logs what the
LLM *would* have done and scores it after the fact against Coil's own machinery.

The eval is **falsifiable and pre-registered**: the decision statistic, its
standard-error method, the effect-size floor, the significance level, the horizon,
and every exclusion rule are fixed before it starts, and the outcome is a KEEP /
REJECT / INCONCLUSIVE verdict for the lab-studies ledger. Nothing is deployed. A
KEEP is the *precondition* for later considering a hybrid agent — not this
project's deliverable.

### The decision the eval must inform

The real-world alternative to "LLM fires early" is **not** "do nothing" — it is
"loosen the mechanical threshold" (take the WATCH names nearest the cliff, or the
lowest-RSI ones). An LLM agent is only worth building if the brain beats that cheap
mechanical loosening. Because "loosen the threshold" is, in the limit, a rule on
the continuous signals themselves, the decider is a regression coefficient that
**controls for every signal the LLM is shown** (RSI, distance-to-5-day,
distance-to-200-day). β then measures the edge the LLM adds *beyond* any mechanical
re-weighting of those signals. The intuitive same-rate benchmark **M** (below) is
reported as the plain-language analog and a robustness check — it is not the
primary statistic, and the earlier draft's phrasing calling it "the primary
comparison" was imprecise.

### Why existing tools don't suffice

- `coil-preview` classifies WATCH (near-miss) names daily, but it is a read-only
  scouting report — no LLM tag, no forward scoring.
- The reasoning digest renders Go-computed explanations; no prediction, no ledger.
- A historical backtest cannot evaluate a live LLM judgment without look-ahead
  contamination. **Identity/date masking does not rescue it:** (i) the model's
  oversold-large-cap-bounce prior is calibrated on the same era's *realized*
  outcomes, so aggregate-era leakage survives even with tickers and dates stripped;
  and (ii) the signal inputs that carry era/identity fingerprints — absolute
  `last_close`, the multi-day price-path shape — cannot be removed without changing
  the test the forward eval runs. Only a forward, out-of-time sample is clean.

## Architecture decision: reuse Coil's own computation where it exists

The eval calls the **same Go endpoints** `coil-preview` uses
(`/api/v1/meanrev/universe`, `/candidates`, `/signal/:symbol`) and reuses
`coil-preview.mjs`'s exported `classifyWatch`, `computeMargins`, `resolveLiveBase`,
and constants (`RSI_ENTRY_MAX` 5, `WATCH_RSI_MAX` 15, `WATCH_SMA5_BAND` 0.005,
`STOP_PCT` 0.07). It does **not** reuse `WATCH_MAX_NAMES` or `assembleReport` (those
are a rendering cap — see Population).

Retrospective scoring needs each name's per-day signal *history* over its hold
window. This is the one new Go surface: a read-only
`GET /api/v1/meanrev/signal-series/:symbol?days=N`. Honestly scoped: this is
**new (small) code**, not free reuse — `MeanRevSignalService` today computes only
the *latest* day (`ComputeMeanRevSignal` reads `closes[L-1]` and stamps `AsOf` from
the last bar alone). The endpoint must iterate the bar array, recompute as-of each
day by re-slicing into the *same* `ComputeMeanRevSignal` (so the RSI/SMA formulas
are reused, not re-derived), and stamp each bar's own date. Two edge cases to pin,
because `meanRevSMA` silently returns `0` for prefixes shorter than its window:
`sma_200` must be returned as `null`/omitted (never `0`) for any day lacking a full
200-bar prefix, and `days=N` must be bounded to what the ~320-day fetch validly
supports. Note the scorer only consumes `close`, `rsi_2`, and `sma_5`; `sma_200` is
used only by `classifyWatch` at episode *open*, which the daily job takes from the
live `/signal` call — so the series' `sma_200` is informational. Blast radius is
zero (read-only, no order path).

## Core honesty constraints

1. **No trading, ever.** No orders, no broker. Reads endpoints; writes its own logs.
2. **No look-ahead — information frozen at Coil's decision time.** The daily job
   runs after the close (~16:55 ET), but the LLM's inputs (price context *and* any
   headlines) are restricted to information available at Coil's actual 15:45 ET
   beat. No headline timestamped after ~15:45 may enter the tag, even though the
   job executes at 16:55 — otherwise the eval's LLM sees post-close news a real
   deployed agent never could, biasing the measured edge toward KEEP.
3. **Reproducible scoring, single adjustment basis.** Entry and exit prices are
   read from the *same* freshly-fetched, split+dividend-adjusted series at scoring
   time; the snapshot-time price is kept only for audit. (Alpaca back-adjusts the
   whole series by one uniform factor, so RSI/SMA and the return ratio are
   scale-invariant — re-scoring is stable *as long as entry and exit share one
   basis*, which this guarantees.) Given the logged tags, re-running the scorer
   yields identical outcomes, independent of which days the machine was online.
4. **Control for every signal the LLM sees.** The decision statistic controls for
   all three continuous signals fed to the LLM — RSI(2) (modeled flexibly, not
   linearly), distance-to-5-day, and distance-to-200-day — so the LLM is never
   credited for merely re-reading a mechanical gradient (linear *or* curved).
5. **Pre-registered before start.** Decision statistic, SE method, effect-size
   floor, significance level, horizon, and every exclusion rule are fixed here. One
   terminal analysis; no peeking-and-stopping.
6. **Gaps reduce N and may shift the regime mixture — never fabricate.** Days the
   bot is unreachable are logged as gaps; that day's WATCH names are simply never
   sampled. Because operator-offline days may correlate with market regime, gaps
   can shift the *mix* of regimes in the sample (a generalizability caveat), not
   just N. As a pre-registered validity check, the concurrent SPY/VIX regime is
   logged on every gap day and the rollup reports the regime distribution of
   sampled vs gapped days, flagging material skew rather than asserting MCAR.

## Scope

**In scope:** one read-only Go endpoint (`signal-series`); a minimal daily
snapshot+tag job; a retrospective reproducible scorer; a rollup that fits the
pre-registered regression (with clustered/fixed-effects SEs) and emits the verdict.

**Out of scope (deferred):** any hybrid *trading* agent; universe expansion beyond
the fixed 80; the mechanical-execution lever and `coil-explain`; names outside
WATCH that bounced (different setups; would confound the boundary test).

## Behavior

### Population

An eval **candidate** on a trading day is a WATCH name per `classifyWatch`, with
one eval-specific tightening: **`last_close < SMA(5)` strictly** (drop the ≤0.5%
*above*-the-5-day sliver that `WATCH_SMA5_BAND` admits). Rationale: Coil's real
entry requires close below the 5-day, so an above-5-day name is not a pullback Coil
would ever enter early; including it also creates a degenerate "close > SMA5" exit
at entry. So an eval candidate is: from the 80-name `MeanRevUniverse`, `RSI(2) ∈
[5,15)`, `last_close > SMA(200)`, `last_close < SMA(5)`, no earnings within 5
trading days — i.e. every Coil entry condition met *except* `RSI(2) < 5`. The job
evaluates `classifyWatch` over all 80 names; **no `WATCH_MAX_NAMES` cap** (that cap
lives only in `coil-preview`'s renderer).

### Episode lifecycle

Same-name persistence is grouped into **episodes** so autocorrelation cannot
inflate the sample (episode-ing handles within-run persistence; same-day and
same-name correlation are handled by the standard-error method, below):

- An **episode opens** the first trading day a name qualifies (after an *observed*
  off-WATCH prior day, or after the prior episode's full window elapsed).
- **Minimum-gap reopen:** the same name cannot open a new episode until its prior
  episode's full 5-day window has elapsed, preventing overlapping correlated
  episodes from a name flickering around the boundary.
- **Under a gap day:** an unobserved (gap) day never counts as an observed
  off-WATCH day; a name is treated as continuing its open episode while that
  episode's window has not elapsed.
- **Entry reference** = the opening day's `last_close` (re-read from the scoring
  series for the return calc — constraint 3). Entry is modeled at that close; the
  LLM's *information*, however, is frozen at ~15:45 (constraint 2).
- **Episode tag** = the LLM's fire-early verdict on the opening day only.
- **`later_fired` is a descriptor, not an exit:** if `RSI(2)` dips below 5 during
  the hold, record it, but the episode still runs to its own Coil exit.

### Scoring — Coil's exit rule (retrospective, reproducible, gap-robust)

Once an episode's window has elapsed, the scorer fetches the name's signal-series
and replays Coil's rules as if Coil had entered at the entry reference. **The exit
replay begins the first trading day *after* the entry day** (faithful to Coil,
whose exits are evaluated on subsequent heartbeats with `days_held` starting at 0 —
never on the entry bar). Each subsequent day, in order:

1. **Stop** — if daily close `≤ entry_ref × (1 − 0.07)` → exit at that close.
2. **Profit target** — else if `RSI(2) > 70` **or** daily close `> SMA(5)` → exit
   at that close.
3. Otherwise carry forward.
4. **Timeout** — if no exit by the 5th trading day after entry, exit at that close.

`return = (exit_close − entry_ref) / entry_ref`. **Outcome = "bounce"** iff
`return > 0`, else "no-bounce", defined purely by realized return. Stop and target
use the daily **close** (the series exposes closes, not intraday lows), stated for
determinism. **Exclusions:** an episode is `unscorable` (dropped from all groups)
if the series is missing an in-window day, **or if a split/dividend adjustment
factor ≠ 1 falls inside the window** (a split would otherwise inject a ~−90%
outlier; a dividend would bias the return by the yield).

### Groups

- **A — LLM fire-early:** episodes the LLM tagged fire-early.
- **B — LLM declined:** WATCH episodes tagged not-fire-early.
- **M — mechanical benchmark (robustness):** each day, the `k` lowest-`RSI(2)`
  candidates, `k` = how many the LLM tagged that day. "Just loosen the threshold,"
  same rate. Reported, not the decider (see below).
- **C — all successfully-tagged candidates** (A ∪ B; base rate). `unknown`-tag
  episodes (LLM call failed) are logged but excluded from every group.

### Decision statistic (primary) and verdict

**Primary decider:** β in a linear regression of episode return on `fire_early`,
plus controls for **all three signals the LLM sees** — RSI(2) as bucketed dummies
over [5,15) (not a single linear term, since the LLM's edge is hypothesized to sit
at higher-RSI names where a linear fit extrapolates worst), `sma5_gap`, and
`sma200_gap` — plus **entry-day fixed effects**, with **standard errors clustered
by name**. Entry-day fixed effects absorb the common market shock that co-triggers
WATCH names on down days (fixing the dependence that would otherwise make naive SEs
too tight) and identify β purely from *within-day* fire-vs-decline contrasts — the
cleanest form of the operator's question. Name-clustering handles the residual
same-name recurrence. The honest cost: days where `fire_early` is constant (all
names tagged, or none) carry no within-day contrast and drop out of identification.

**Robustness (reported, non-deciding):** (a) the pooled regression without
fixed-effects, with **two-way SEs clustered by day and name**; (b) the within-day
**A-vs-M** paired return difference (the plain-language "beat mechanical loosening"
read). These should agree with the primary in sign. **A material A-vs-M sign
disagreement does not auto-credit the LLM; it triggers a pre-registered nonlinear
diagnostic** (inspect the RSI partial-residual / refit with a finer RSI basis)
*before* any KEEP is filed.

**Verdict (single terminal analysis at horizon):**
- **KEEP** — the one-sided 90% CI lower bound on β (clustered SE) `> 0` **and**
  `β ≥ +1.0%` per episode.
- **REJECT** — CI upper bound `< +1.0%` (a worthwhile edge is ruled out). *Under
  the null (no LLM edge), this is the expected outcome — a clean, actionable
  "don't build it," not a non-answer.*
- **INCONCLUSIVE** — neither of the above: the CI is too wide to both clear
  significance and rule out a worthwhile edge. Honest and legitimate — likely
  whenever the true edge sits in the ambiguous ~0.3–1.0% band the study is
  underpowered to resolve.

## Statistical power (computed for the actual decider β, honestly)

Two forces move β's standard error away from the naive two-sample figure (~0.6% at
N≈100) the earlier draft wrongly cited. **Collinearity inflates it:** RSI(2) is fed
to the LLM, so `fire_early` correlates with the RSI controls, and the
variance-inflation factor `1/(1−R²)` widens SE(β) by ~1.25–1.7×. **Entry-day fixed
effects deflate it:** absorbing the common market shock strips a large share of
between-day return variance from the residual, the "within-day paired" gain. Net,
over the full A∪B sample (~200–400 episodes across 26 weeks, larger than N_A
alone), SE(β) lands roughly **0.7–1.1%**, and the minimum *reliably* detectable
edge is roughly **+1.2–1.8% per trade** — above the +1.0% KEEP floor. So this is
frankly a **large-edge detector**: it will confirm only a big, obvious edge; for a
realistic modest edge it returns INCONCLUSIVE, and under a genuinely absent edge it
returns a clean REJECT. A ~+1%/trade net edge on a 5-day large-cap mean-reversion
boundary is a low-prior event, so KEEP is the least likely of the three outcomes —
the operator should go in expecting REJECT-or-INCONCLUSIVE and treat KEEP as a
genuine surprise worth a confirmatory out-of-sample run.

To avoid optional-stopping, horizon and extension are pre-committed: **one terminal
analysis at 26 weeks; if N_A < 60 then, extend once to 52 weeks and analyze once
more** over the full accumulated set (episodes whose full window has elapsed;
later-opened episodes carry into the extension).

**Staged early-abandon gate (~8 weeks).** A single pre-registered checkpoint caps
the calendar downside if the experiment is clearly going nowhere. It may do only
two things: (a) **early REJECT** — if the one-sided 90% CI upper bound on β is
already `< +1.0%`, a worthwhile edge is already ruled out; stop and file REJECT.
(b) **operational abort** — if the machinery is broken, or N_A is far below the
trajectory needed to reach ~60 by 52 weeks, stop on documented operational grounds.
Otherwise continue to the terminal analysis. **The gate can never emit KEEP**, so
it adds no optional-stopping bias toward a false positive — it is a pure
futility/health stop. This is the only interim look at the outcome; the terminal
analysis remains the sole place a KEEP, an INCONCLUSIVE, or a non-early REJECT is
decided. The 8-week read also doubles as the machinery health check (data
accumulating? tags sane? scorer clean?).

## Pre-registered parameters

| Parameter | Value |
|---|---|
| Universe | fixed 80-name `MeanRevUniverse`; all `classifyWatch` passers, no cap |
| Candidate | `RSI(2)∈[5,15)`, `close>SMA200`, `close<SMA5` (strict), no earnings ≤5d |
| Entry reference | opening day's `last_close`, re-read from the scoring series |
| LLM info cutoff | ≤ 15:45 ET (Coil's beat), though the job runs ~16:55 |
| Exit replay | starts the first trading day **after** entry; stop → target → 5-day timeout |
| Adjustment | entry & exit from one freshly-fetched adjusted series; split/div-in-window ⇒ `unscorable` |
| **Decision statistic** | β in `return ~ fire_early + RSI-buckets + sma5_gap + sma200_gap + day-FE` |
| **SE method** | clustered by name (primary); two-way day+name (robustness, no-FE) |
| **Effect floor** | β ≥ +1.0% per episode |
| **Significance** | one-sided 90% CI lower bound on β > 0 |
| Robustness checks | within-day A-vs-M paired difference; pooled two-way-clustered β |
| Minimum-gap reopen | same name reopens only after its prior episode's 5-day window elapses |
| Horizon | 26 weeks, one analysis; pre-committed extend to 52 weeks if N_A < 60 |
| Staged gate (~8 wk) | early REJECT if one-sided 90% CI upper on β < +1.0%, or operational abort; never KEEP |
| Bear-regime days | no new episodes when Coil is halted (`banner.halt`); open episodes still scored |
| Missing tag / gap-in-window / split-in-window | logged, excluded from all groups |

## Mechanics

### Files

- `scripts/coil-shadow.mjs` — **minimal daily job**, idempotent per ET day: resolve
  the live base; if bear-halted, log and stop; snapshot candidates (`classifyWatch`
  over all 80, strict `close<SMA5`); open new episodes honoring the minimum-gap
  reopen rule; make **one** LLM tagging call over the new candidates (below);
  persist. It does **not** score.
- `scripts/coil-shadow-score.mjs` — retrospective scorer: for each episode whose
  window has elapsed and is unscored, fetch the signal-series, replay the exit rule
  (starting the day after entry, single adjustment basis), record outcome or mark
  `unscorable`. Reproducible and re-runnable.
- `scripts/coil-shadow-rollup.mjs` — fits the day-FE / clustered regression, the
  robustness specs, group metrics, and prints the verdict.
- `data/coil-shadow/daily/<ET-date>.json` — **authoritative** write-once per-day
  record: candidates, full LLM request+response, gap flag, concurrent SPY/VIX
  regime. Written atomically (temp-then-rename).
- `data/coil-shadow/episodes.json` — a convenience index **rebuildable** from the
  daily files; a corrupt or lost write is recoverable by replaying them.

The daily job is scheduler-triggered (slot alongside the 16:55 digest, after Coil's
15:45 beat), self-gated by `COIL_SHADOW_ENABLED` (default-OFF). Because the machine
can be offline at run time, gaps are expected (they cost N; server-side scheduling
is the eventual mitigation, shared with the mechanical-lever project).

### LLM tagging contract

Mechanism: a direct `@anthropic-ai/sdk` `messages.create` call (the SDK is already
a project dependency; key via `CLAUDE_API_KEY || ANTHROPIC_API_KEY`, the in-repo
pattern), requesting strict JSON `{ per_name: [{ ticker, fire_early: boolean,
reason: string }] }`. Input per candidate: its Coil signal stats (`rsi_2`, `% vs
5-day`, `% vs 200-day`, `last_close`) plus optional point-in-time context with a
hard ≤15:45-ET cutoff (constraint 2). The full raw request and response are
persisted for audit; a failed call retries once, then the day's candidates are
tagged `unknown`. Small (3–10 names) — pennies/day, ~130 calls over the base run.
The tag is non-reproducible (that is the thing under test); scoring given the
logged tag is fully reproducible.

### Idempotency & safety

Re-running the daily job on the same ET day must not double-open or double-tag
(guard on the per-day file). Blast radius zero: no order endpoints; writes only
under `data/coil-shadow/` plus the one read-only Go endpoint.

## Testing

- **Pure-function core** — episode open / reopen-after-observed-gap /
  minimum-gap-reopen / persistence; exit replay **starting the day after entry**
  (stop; RSI>70 target; close>SMA5 target; flat timeout; stop-and-target-same-day
  precedence; `later_fired` runs to natural exit); the strict `close<SMA5`
  population filter excluding an above-5-day name; group assignment; the M `k`-
  lowest-RSI selection with ties; the day-FE / name-clustered regression and its
  one-sided CI; the verdict mapping. Synthetic signal-series fixtures.
- **Standard errors** — a clustered fixture (many correlated same-day/same-name
  episodes) must yield a wider CI than the naive i.i.d. computation; assert the SE
  method is the clustered one, not OLS-homoskedastic.
- **Adjustment basis** — an in-window dividend/split marks the episode `unscorable`;
  entry and exit are read from one fetch so a later re-score is identical.
- **Reproducibility** — scoring the same logged episodes twice is identical.
- **Population cap** — a synthetic >10-candidate day retains every qualifier (no
  `WATCH_MAX_NAMES` truncation).
- **Verdict boundaries** — β and its clustered CI at the KEEP / REJECT /
  INCONCLUSIVE seams land on the correct side.
- **Go `signal-series`** — parity with `/signal` on the latest date; correct
  per-day ordering/length over a range; `sma_200` is `null` (not `0`) for a day
  lacking a 200-bar prefix.
- **Mocked I/O** — endpoint client and LLM tagger injected; tests never hit the
  network.

## Open questions / future

- If KEEP: design the hybrid agent (separate spec) and a real out-of-sample
  confirmation before any capital — one 26-week KEEP is a screen, not proof.
- If REJECT or INCONCLUSIVE: file the verdict in the lab-studies ledger; the
  mechanical boundary stands.
- Universe expansion and the mechanical-execution lever remain separate, downstream.
