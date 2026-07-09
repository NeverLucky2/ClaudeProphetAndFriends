# Coil Inverse-Veto — Design

**Date:** 2026-07-09
**Status:** Approved design → pending implementation plan
**Owner:** operator (lab + ledger; never touches live Coil)

---

## Purpose

The [Coil Veto Ledger](2026-07-07-coil-veto-ledger-design.md) measures the operator's decision to
**decline** a Coil fire. This is its mirror: measure the operator's decision that Coil **should have
fired but didn't**.

Coil enters only on RSI(2) < 5. A name can fall toward that threshold, sit in the WATCH band, and
bounce before crossing — Coil never fires, and the move is missed by design. The operator's
hypothesis:

> **The front-run thesis.** AI-assisted mean-reversion screening is now widespread. Enough
> participants buy the dip *before* it reaches the classic oversold threshold that the threshold is
> increasingly front-run. If true, the shallow (near-miss) band should be getting *better* over
> time, and Coil's fire-rate per near-miss should be *falling*.

This design tests that thesis honestly, and builds the ledger that records the operator's
near-miss judgment.

---

## Findings that reshaped the original scope

Three facts, verified before design, materially narrow what is worth building.

**1. Three of the four motivating names are outside Coil's reach.**
`services/meanrev_signal_service.go:84-93` defines the 80-name `MEANREV_UNIVERSE`. It contains
**AMAT**; it does **not** contain KLAC, LRCX, or MU. Coil never monitored them and could never have
fired on them. AMAT is a genuine instance: on WATCH `2026-07-07`, absent by `2026-07-08` — the
approach-then-jump pattern exactly.

**2. The "measure every near-miss" arm already exists, and its verdict is KEEP.**
`scripts/coil-threshold-exitsim.mjs` already implements the faithful simulator: `entryFiresAt(closes,
idx, rsiMax)` (relaxes *only* the RSI bound) and `simulateTrade()` with all four real exits, including
the gap-honest intraday −7% stop. The pre-registered study `08a17a3` scored it. Its own motivating
example is this exact scenario ("a WATCH near-miss, KO at RSI(2) 8.29, bounced +2.6% the next day").

Holdout, from `docs/lab/coil-rsi-threshold-RESULTS.md`:

| bucket | n | win | meanNet | PF |
|---|---|---|---|---|
| **[0,5)** — Coil fires | 242 | 66.53% | **+0.59%** | 1.56 |
| [5,8) | 353 | 60.91% | +0.02% | 1.01 |
| [8,10) | 367 | 67.30% | +0.29% | 1.31 |
| [10,15) | 1037 | 62.49% | −0.01% | 0.99 |

The WATCH band *is* those three shallow buckets (`scripts/coil-preview.mjs:13-14`, `WATCH_RSI_MAX =
15`). Weighting the published bucket means by n, the whole near-miss population nets **≈ +0.06%/trade**
against **+0.59%** for the band Coil actually trades. The marginal trades a loosening admits: n=220,
mean **−0.19%**, CI [−0.65%, +0.25%]. On 2021–2026, **waiting for Coil was right.** The non-monotonic
bucket pattern ([8,10) strong, both neighbours dead) with train diff-CIs all straddling zero reads as
noise, not signal.

**Consequence:** rebuilding a systematic near-miss simulator would reproduce a settled KEEP. We do not.

**3. The `coil-preview` snapshots cannot serve as a measurement series.**
One file per date, last run of the day wins (`scripts/coil-preview.mjs:293`); 12 days across five
weeks; preview times ranging 11:16→17:17 ET, so RSI is sampled at wildly different points in the
session; WATCH capped at 10 names (`WATCH_MAX_NAMES`); the whole tree is gitignored (`.gitignore:38`,
`data/**`). They are an operator convenience and a *contemporaneous record* — not a series.

### What survives

The `08a17a3` study pools 2021–2026 and asks *"is the shallow band profitable on average?"* The
front-run thesis is a different claim: *"the shallow band is getting better over time."* A pooled
six-year mean would completely mask a recent trend. **That question is unanswered.**

And testing a time-trend on `data/lab/coil-threshold-instances.json` means re-reading data whose
holdout was already spent on a different question — exploratory, not confirmatory, by this project's
own lab discipline. **The clean, forward, out-of-sample test of a time-varying edge is a
live-accruing ledger.** So the inverse veto is not redundant; it is the right instrument, with a
sharper purpose than originally framed.

---

## Non-goals (YAGNI)

- **No change to Coil.** Not the RSI threshold, not the universe, not the exits. Any live change
  requires a separate pre-registered study with a fresh holdout.
- **No new exit simulator.** `coil-threshold-exitsim.mjs` is reused verbatim.
- **No edits to `veto-store.js` / `veto-log.js`.** The tested veto ledger is untouched.
- **No LLM / agent.** Pure local computation. Zero token cost.
- **No universe expansion.** KLAC/LRCX/MU are out of scope; that is a separate study.
- **Phase 3 UI deferred**, as with the veto ledger.

---

## Part 1 — Front-run diagnostic (exploratory)

**`scripts/coil-frontrun-diag.mjs`** → **`docs/lab/coil-frontrun-diag-RESULTS.md`**

Three metrics, all from data already on disk.

### M1 — Is the shallow-band edge rising?

Source: `data/lab/coil-threshold-instances.json` (3,998 trades, 2021–2026; each carries `ticker`,
`date`, `rsi2`, `bucket`, `grossReturn`, `censored`, `split`).

Per calendar year, compute the mean friction-net return (gross − 20 bps, the study's representative
friction) of the shallow band `[5,15)` **minus** the deep band `[0,5)`. Report `n` per cell
prominently. Trend statistic: Spearman rank correlation of year vs. diff, plus a per-year date-block
bootstrap 95% CI on the diff (reuse the `mulberry32` + date-block idiom from
`coil-eventstudy-score.mjs`, block length 15 sessions).

> Thesis predicts: the diff trends **upward**.

Yearly deep-bucket `n` will be small (order 10², thinner in some years). CIs will be wide. This is a
prior, not a verdict — the report must say so per-cell.

### M2 — Is Coil's fire-rate per near-miss falling?

Source: `data/bar-cache/` across `MEANREV_UNIVERSE` (imported from `coil-eventstudy-build.mjs:15`).

The gates are **`entryFiresAt`'s strict gates** — `close > SMA200` and `close < SMA5` — *not* the
preview's relaxed `close < SMA5 × 1.005` WATCH band, so the diagnostic stays comparable to `08a17a3`.
The **earnings filter is applied** exactly as the study applies it (exclude a day when an earnings date
falls within the next 5 trading bars), reusing `data/lab/coil-earnings-dates.json`.

Per year, over all ticker-days where those gates hold:

- `nearMiss` = days with `rsi2 ∈ [5,15)`
- `fire` = days with `rsi2 < 5`
- `ratio = fire / nearMiss`

> Thesis predicts: the ratio **declines** — dips get bought before they reach RSI<5.

**The confound, and the control.** Low-volatility years produce fewer deep-oversold events regardless
of any crowding. Without a control this metric is close to worthless. So M2 additionally reports
**SPY realized volatility per year**, and gives the ratio **both raw and as the residual of a
`ratio ~ vol` regression**. *If the decline vanishes after volatility adjustment, the thesis is
unsupported.*

### M2b — Conversion rate (the sharpest statement of the thesis)

The ratio in M2 is sensitive to *how many* near-misses a year happens to produce. The conversion rate
is not, and it states the thesis directly: **"it jumps before it hits the threshold."**

For each near-miss day `d` (gates hold, `rsi2 ∈ [5,15)`), scan forward `k = 1..5` bars:

- **converted** if `rsi2 < 5` with the gates still holding at some `d+k`, before
- **bounced away** if `rsi2` first rises above 30.

`conversionRate(year) = converted / (converted + bouncedAway)`; days resolving as neither within 5
bars are counted and excluded. Same volatility control as M2.

> Thesis predicts: conversion rate **declines** — near-misses increasingly bounce instead of firing.

No lookahead: each check at `d+k` uses only bars through `d+k`.

### Output and standing

`docs/lab/coil-frontrun-diag-RESULTS.md` opens with a mandatory banner:

> **EXPLORATORY.** This sample's holdout was already spent on the RSI-threshold study (`08a17a3`).
> These results set a prior. They are **not** a confirmatory test and **must not** drive a live Coil
> change. The confirmatory test is the forward ledger in Part 2.

Its purpose is to decide whether the forward ledger is worth the wait. Flat trend on all three
metrics after volatility adjustment ⇒ the thesis is likely dead, and the ledger's remaining value is
the operator-discretion scorecard alone.

---

## Part 2 — The inverse-veto ledger (forward, confirmatory)

### Architecture

A **separate store**, not an extension of `veto-store.js`: different outcome source (simulated trade
vs. bot paper trade), different reason vocabulary, different lifecycle. This is the same reasoning the
veto design used to separate itself from the tips store, and it means **zero edits to tested code**.

- **`agent/inverse-veto-store.js`** — cloned from `veto-store.js`: JSON array, atomic tmp-rename
  writes, in-process write serialization, input validation. Owns
  `data/coil-inverse-vetoes/inverse-vetoes.json`.
- **`agent/inverse-veto-log.js`** — CLI, mirroring `veto-log.js`.
- **`agent/inverse-veto-scorer.js`** — reconciliation + scorecard. Buildable immediately, because the
  simulator already exists.
- **`Claudes Notes/coil-inverse-veto-usage.md`** — operator usage note, mirroring the veto ledger's.

### Data model

Operator-supplied (or snapshot-derived) at flag time:

| Field | Example | Notes |
|---|---|---|
| `id` | `iveto_1752019200000_AMAT_a1b2` | `iveto_{ts}_{ticker}_{rand}` |
| `date` | `2026-07-07` | ET trading date of the WATCH snapshot |
| `ticker` | `AMAT` | **validated against `MEANREV_UNIVERSE`** |
| `watchEntryRef` | `552.30` | provisional midday price from the snapshot |
| `watchRsi2` | `8.29` | the near-miss RSI — selects the baseline bucket |
| `reason` | `crowd_frontrun` | **the only accepted value** |
| `notes` | free text | optional |
| `loggedAt` | ISO timestamp | |
| `loggedSameDay` | `true` | ET date of `loggedAt` === `date` |
| `hindsight` | `false` | `!loggedSameDay` |
| `snapshotBacked` | `true` | fields came from the contemporaneous preview snapshot |
| `reconciled` | `false` | |

Reconciliation-filled: `simEntryClose`, `simExit`, `simExitReason`, `simDaysHeld`, `simGrossReturn`,
`simNetReturn`, `simNetReturnFromRef`, `censored`, `reconciledAt`.

### The three guardrails

These do the real work — they are what make a flag falsifiable rather than a feeling.

**1. Universe validation.** `ticker` must be in `MEANREV_UNIVERSE` (one-line import from
`coil-eventstudy-build.mjs:15`). This rejects KLAC / LRCX / MU at the door. If Coil could not have
fired on it, you cannot claim it should have.

**2. Snapshot-backing.** At log time, read `data/coil-preview/<date>.json`, auto-populate
`watchEntryRef` and `watchRsi2` from that date's WATCH list, and **reject if the ticker is not in
it**. The flag then anchors to a contemporaneous artifact rather than to operator-typed numbers.
Soft-fail: if no snapshot exists for that date (the preview was not run), require explicit `--ref`
and `--rsi2`, set `snapshotBacked: false`, and report those flags separately — never in the headline.
This uses the snapshots for what they *are* good for (a contemporaneous record) rather than as the
series they cannot be.

**3. Timestamp discipline.** `loggedSameDay` is computed, not supplied. Late flags are accepted — the
record has value — but marked `hindsight: true` and **excluded from the headline discretion test**.
Without this, flagging AMAT after watching it bounce would confirm the thesis by construction.

### The single reason

`crowd_frontrun` — *"this will bounce before it reaches RSI(2)<5, because others are buying the dip
early."*

Any other value is rejected. This mirrors the veto ledger's guardrail (*"if a fire matches neither
reason, you do not get to veto it — you take it"*) as: **if you cannot claim front-run, you respect
Coil's pass.** A subjective second reason (`quality_oversold`) was considered and rejected as an
escape hatch — the exact failure mode the veto's fixed list exists to prevent. The veto ledger already
records the other direction of judgment.

### Scoring

Reuses `simulateTrade` from `scripts/coil-threshold-exitsim.mjs`. **No new simulator.**

Load the ticker's bars from `data/bar-cache/` (refreshed daily; AMAT files run through `2026-07-09`),
locate the bar index for `date`, and call `simulateTrade(bars, entryIdx)`. Net = gross − 20 bps, the
same friction constant as the study, so the numbers are directly comparable.

> **Inverse-veto value = +`simNetReturn`** — the mirror of the veto ledger's `−botReturn`.
> Positive → flagging was right; Coil's strictness cost you that.
> Negative → waiting for Coil was right.

**Entry convention — report both, never conflate:**

- **Primary: fill at the signal-day close** `close[d]`. Identical to the study's convention, therefore
  directly comparable to the bucket baseline.
- **Secondary: fill at `watchEntryRef`** (`simNetReturnFromRef`). What the operator would actually
  have paid at the midday price they saw.

These can differ materially. Conflating them would either flatter or damn the flag unfairly.

A flag becomes scorable ~5 trading days after `date` (the time stop forces an exit). Until then it
stays unreconciled and `censored` — mirroring the veto ledger waiting for a bot trade to close.

### The comparison that matters

Not *"did the flag make money"* but ***"did the operator's discretion beat taking every near-miss in
that band?"***

For each flag, look up the baseline mean net of **its own RSI bucket** from the `08a17a3` holdout
table (`[5,8)`: +0.02% · `[8,10)`: +0.29% · `[10,15)`: −0.01%). The comparator is the **bucket-matched
expected value** — the n-weighted baseline mean across the flags' own buckets. This isolates
discretion from bucket mix: an operator who only ever flags `[8,10)` names should not get credit for
that bucket's higher unconditional mean.

**Δ = flagged mean net − bucket-matched baseline mean**, where "flagged mean net" uses the **primary
(signal-day-close) entry convention** — the only one comparable to the baseline. The `watchEntryRef`
convention is reported alongside but never feeds Δ.

**Flag-rate diagnostic (guards against "flag everything").** Report
`flags / WATCH-name-days observed`. If the operator flags every WATCH name, Δ → 0 by construction and
the ledger tests nothing. A selective flag rate is what gives Δ meaning.

### Scorecard

- **Headline:** Δ, with a date-block bootstrap 95% CI. Non-hindsight, snapshot-backed flags only.
- Σ `simNetReturn`; count; hit-rate (flags with positive value).
- Both entry conventions reported side by side.
- Hindsight and non-snapshot-backed flags: reported separately, never pooled into the headline.
- Flag rate.
- Σ `inverseVetoValueUsd` at a fixed `ASSUMED_NOTIONAL_PER_TRADE`, as the veto ledger does. The
  primary metric is **%**; the $ figure is the constant-notional projection.

### Pre-registration

Because the ledger *is* the confirmatory test, its decision rule is fixed **before** flags accrue.
Committed to **`docs/lab/coil-inverse-veto-prereg.json`** — under `docs/`, not `data/lab/`, because
`.gitignore:38` (`data/**`) would otherwise leave the pre-registration untracked and its hash
guarantee hollow. (This is a real, if minor, defect in the existing `data/lab/coil-threshold-prereg.json`
convention; not fixed here.) The scorer refuses to emit a headline verdict on a prereg-hash mismatch,
reusing `verifyPrereg` from `coil-eventstudy-prereg.mjs`.

**Pre-registered decision rule.** The front-run thesis is **SUPPORTED** only if *all* hold:

1. `n ≥ 30` non-hindsight, snapshot-backed, reconciled flags, **and**
2. ≥ 12 months elapsed since the first flag, **and**
3. the date-block bootstrap 95% CI on **Δ** lies entirely above 0.

If (1) or (2) fails: **UNDERPOWERED** — explicitly distinct from a null. Otherwise: **NOT SUPPORTED.**

**Expected outcome (the null): NOT SUPPORTED**, consistent with `08a17a3`'s KEEP.

**No live Coil change follows from any outcome.** A SUPPORTED verdict licenses one thing: proposing a
separate, pre-registered threshold study with a fresh holdout.

### Honest power caveat

Per-trade σ is ~4–5%. Detecting a +0.5%/trade discretion edge needs *n* in the hundreds. At a few
flags a month, this ledger is **descriptive and directional for a long time — not statistically
conclusive.** The veto ledger carries the same limitation. Its near-term value is discipline, a
record, and a forward *uncontaminated* series, which the historical data can no longer provide. The
`n ≥ 30` / 12-month gate exists precisely to stop a verdict being declared after five lucky flags.

---

## Phasing

1. **Part 1 diagnostic** — build, run, read. It is cheap and it calibrates everything downstream.
2. **Part 2 store + CLI + tests** — start flagging immediately. AMAT `2026-07-07` *can* be logged and
   *should* be, but it will be marked `hindsight: true` (it is being flagged after the bounce was
   observed) and so is quarantined from the headline. That is the guardrail working as designed, on
   the very case that motivated the feature.
3. **Part 2 scorer + prereg** — small, because `exitsim` exists. Build alongside (2).
4. **Phase 3 UI** — deferred, as with the veto ledger.

---

## Testing (TDD, `node:test`, temp-dir project root)

Mirrors `agent/veto-store.test.mjs`. Side-effecting functions get mock / temp-dir tests before
"done" — test the executor, not just the predicate.

**Store:**
- universe validation rejects `KLAC`; accepts `AMAT`
- reason validation rejects anything but `crowd_frontrun`
- bad ticker / bad date / non-positive ref rejected
- snapshot auto-populate fills `watchEntryRef` + `watchRsi2` from a fixture snapshot
- snapshot present but ticker absent from its WATCH list → **rejected**
- snapshot missing → requires explicit `--ref`/`--rsi2`, sets `snapshotBacked: false`
- `loggedSameDay` / `hindsight` computed correctly **across the ET midnight boundary**
- atomic write; concurrent `createInverseVeto` calls serialize without clobbering
- read-empty-when-missing

**Scorer:**
- joins `date` → correct bar index; calls `simulateTrade`; sign convention (`+simNetReturn`)
- a simulated loser yields a **negative** inverse-veto value (waiting was right)
- censored (fewer than 5 forward bars) stays unreconciled
- both entry conventions computed; `simNetReturnFromRef` differs from close-based when ref ≠ close
- hindsight and non-snapshot-backed flags excluded from the headline aggregate
- bucket-matched baseline: a flag set drawn only from `[8,10)` is compared against `[8,10)`'s mean
- prereg hash verify passes on match; scorer refuses the headline verdict on mismatch
- flag-rate computation

**Diagnostic:**
- M1 yearly bucketing and net-of-friction arithmetic on a synthetic fixture
- M2 gate application; ratio arithmetic; vol residual on a synthetic fixture
- M2b conversion / bounce / unresolved classification; no-lookahead
- bootstrap determinism under fixed seed

---

## Known limitations (disclosed in both reports)

- **Universe ceiling.** The ledger covers only the 80 `MEANREV_UNIVERSE` names, whatever the operator
  is watching elsewhere.
- **Survivorship** in the historical diagnostic — today's large-caps. Direction is conservative for
  the expected null, as in `08a17a3`.
- **Daily-close fills** in the simulator; the idealization is identical across flags and baseline, so
  it cannot bias Δ.
- **The diagnostic is exploratory** — its sample's holdout is spent.
- **Selection is non-random by design** in the ledger. That *is* the discretion test; it is not a bug,
  but it means Δ measures the operator, not the market, and only the flag-rate diagnostic keeps that
  honest.
- **Snapshot coverage is sparse.** A near-miss on a day the operator did not run `coil-preview` cannot
  be snapshot-backed. Those flags exist but are quarantined from the headline.

---

## Open questions (for the implementation plan)

- Exact `data/bar-cache/` accessor and file-selection rule (filenames encode requested ranges, e.g.
  `AMAT_1Day_2020-08-19_2026-09-11.json`; several overlap — pick the widest covering `date + 5` bars).
- Whether `coil-eventstudy-score.mjs`'s bootstrap helpers are importable as-is or need a small extract.
- SPY realized-vol window for the M2/M2b control (20-day vs 60-day; state and fix before running).
