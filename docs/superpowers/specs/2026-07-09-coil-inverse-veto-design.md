# Coil Inverse-Veto — Design

**Date:** 2026-07-09
**Status:** Approved design (revised after review) → pending implementation plan
**Owner:** operator (lab + ledger; never touches live Coil)

---

## Purpose

The [Coil Veto Ledger](2026-07-07-coil-veto-ledger-design.md) measures the operator's decision to
**decline** a Coil fire. This is its mirror: measure the operator's decision that Coil **should have
fired but didn't** — and test the hypothesis behind that decision.

Coil enters only on RSI(2) < 5. A name can fall toward that threshold, sit in the WATCH band, and
bounce before crossing. Coil never fires; the move is missed by design. The operator's hypothesis:

> **The front-run thesis.** AI-assisted mean-reversion screening is now widespread. Enough
> participants buy the dip *before* it reaches the classic oversold threshold that the threshold is
> increasingly front-run.

---

## Findings that reshaped the original scope

Verified before design; each materially narrows what is worth building.

**1. Three of the four motivating names are outside Coil's reach.**
`services/meanrev_signal_service.go:84-93` defines the 80-name `MEANREV_UNIVERSE`. It contains
**AMAT**; it does **not** contain KLAC, LRCX, or MU. Coil never monitored them and could never have
fired on them. AMAT is a genuine instance: on WATCH `2026-07-07`, absent by `2026-07-08`.

**2. The "simulate every near-miss" arm already exists, and its verdict is KEEP.**
`scripts/coil-threshold-exitsim.mjs` already implements the faithful simulator: `entryFiresAt(closes,
idx, rsiMax)` (relaxes *only* the RSI bound) and `simulateTrade()` with all four real exits, gap-honest
intraday −7% stop included. The pre-registered study `08a17a3` scored it. Its own motivating example is
this exact scenario ("a WATCH near-miss, KO at RSI(2) 8.29, bounced +2.6% the next day").

Holdout, from `docs/lab/coil-rsi-threshold-RESULTS.md`:

| bucket | n | win | meanNet | PF |
|---|---|---|---|---|
| **[0,5)** — Coil fires | 242 | 66.53% | **+0.59%** | 1.56 |
| [5,8) | 353 | 60.91% | +0.02% | 1.01 |
| [8,10) | 367 | 67.30% | +0.29% | 1.31 |
| [10,15) | 1037 | 62.49% | −0.01% | 0.99 |

The WATCH band *is* those three shallow buckets (`scripts/coil-preview.mjs:13-14`, `WATCH_RSI_MAX =
15`). Weighting the published bucket means by n, the near-miss population nets **≈ +0.06%/trade**
against **+0.59%** for the band Coil actually trades. Marginal trades a loosening admits: n=220, mean
**−0.19%**, CI [−0.65%, +0.25%]. **On 2021–2026, waiting for Coil was right.** Non-monotonic buckets
([8,10) strong, both neighbours dead) with train diff-CIs straddling zero read as noise.

**Consequence:** rebuilding a systematic near-miss return simulator would reproduce a settled KEEP.
We do not.

**3. The `coil-preview` snapshots cannot serve as a measurement series.**
One file per date, last run wins (`scripts/coil-preview.mjs:293`); 12 days across five weeks; preview
times spanning 11:16→17:17 ET, so RSI is sampled at wildly different points in the session; WATCH
capped at 10 names; the tree is gitignored (`.gitignore:38`). They are an operator convenience and a
**contemporaneous record** — not a series. Everything measured here is recomputed from `data/bar-cache/`.

---

## The reframe: two rival stories, one shared prediction

The thesis has two separable claims, with wildly different testability.

- **C1 — the mechanism.** Near-misses increasingly *fail to convert* into fires. This is a **count**
  statistic over ~640 episodes/year. It has real power.
- **C2 — the economics.** The near-miss band is becoming *profitable to enter*. This is a **return**
  statistic with per-trade σ ≈ 4–5%. It has almost no power (see *Power*, below), and `08a17a3` is a
  strong prior against it.

**C1 does not imply C2.** Two rival stories both predict C1:

| | shallow-band edge (C2) | deep-band edge (C3) | implication |
|---|---|---|---|
| **Operator's story** — crowd front-runs; ride with them | ↑ | flat | enter earlier |
| **Adverse selection** — crowd takes the good dips; only toxic ones reach RSI<5 | flat | ↓ | Coil's edge decays; do **not** enter earlier |
| **Mechanism-only** — front-running happens, edge already competed away | flat | flat | change nothing |

If the crowd truly buys at RSI 6–10, then buying at RSI 6–10 means buying *alongside* them, into a
weaker signal, and `08a17a3` says that trade nets ~0 after 20 bps. **Confirming front-running would
not license loosening the threshold. It might argue for the opposite.**

So the diagnostic must measure **C1, C2, and C3 separately** — the trends in shallow *and* deep
returns are what discriminate the stories. This is the analytical payoff, and it is why the work is
worth doing even though C2's verdict is already KEEP.

---

## Non-goals (YAGNI)

- **No change to Coil.** Not the RSI threshold, not the universe, not the exits. Any live change
  requires its own pre-registered study with a fresh holdout. A SUPPORTED C1 verdict licenses exactly
  one thing: proposing such a study.
- **No new exit simulator.** `coil-threshold-exitsim.mjs` is reused verbatim.
- **No new bootstrap code.** `coil-threshold-metrics.mjs` already exports `bootstrapMeanCI` and
  `bootstrapDiffCI` over `{date, net}` rows.
- **No edits to any tested module.** Everything is additive.
- **No LLM / agent.** Pure local computation. Zero token cost.
- **No universe expansion.** KLAC/LRCX/MU are out of scope; that is a separate study.
- **Phase 3 UI deferred**, as with the veto ledger.

---

## Shared engine — near-miss episode enumeration

**`scripts/coil-nearmiss-enum.mjs`** (new, pure, TDD). Used by all three parts.

Recomputed from `data/bar-cache/` via `loadBars(projectRoot, ticker)` + `indexByDate(bars)`
(`coil-eventstudy-bars.mjs`), across `MEANREV_UNIVERSE` (`coil-eventstudy-build.mjs:15`). RSI(2) and
SMAs come from `wilderRSI` / `sma` in `coil-meanrev-signal.mjs`.

**Gates** are `entryFiresAt`'s strict gates — `close > SMA200` and `close < SMA5` — *not* the preview's
0.5%-relaxed WATCH band, so everything stays comparable to `08a17a3`.

**States** on a gated bar: `FIRE` if `rsi2 < 5`; `NEAR_MISS` if `rsi2 ∈ [5,15)`.

**Episode enumeration (fresh-signal, mirroring `08a17a3`).** RSI(2) is heavily autocorrelated: a single
dip produces several consecutive in-band days. Counting *days* would measure episode length, not
episode count, and would inflate `n` while biasing toward persistently-oversold names. So:

- An **episode starts** on the first `NEAR_MISS` bar after a bar that was neither `NEAR_MISS` nor `FIRE`.
- From the start bar `d`, scan forward `k = 1..10`; **first trigger wins**, precedence within a bar:
  1. **`FIRE`** — `rsi2 < 5` with the gates still holding → **converted**.
  2. **`BOUNCE`** — `close > SMA5` → the pullback condition is broken. This is Coil's *own* gate, not
     an arbitrary RSI level, and it is the literal statement of "it jumped before it hit the threshold."
  3. **`REGIME_EXIT`** — `close < SMA200` → left the tradeable regime.
- If none by `k = 10`: **`UNRESOLVED`**. Counted and reported; excluded from the conversion rate.
- **No lookahead:** every check at `d+k` uses only bars through `d+k`.

`conversionRate = converted / (converted + bounced)`. `REGIME_EXIT` and `UNRESOLVED` are reported
separately and excluded from the denominator.

**Earnings filter — deliberately NOT applied to the conversion metric.** Conversion is a question about
*price dynamics* (does the market bid the dip before RSI crosses 5?), not about Coil's tradeable set.
Omitting it also frees the confirmatory arm from any FMP dependency. The **return** metrics do apply the
earnings filter, because they mirror what Coil could actually trade. The two populations therefore
differ; this is disclosed in both reports.

> **Note.** Conversion measures *signal* conversion, not Coil fills. Coil's ≤4-position cap means not
> every fire becomes a trade. That is intentional: the thesis is about the market, not about capacity.

**Volatility control.** Low-volatility years produce fewer deep-oversold events regardless of any
crowding — without a control these metrics are close to worthless. Each episode's start date is
assigned a **SPY trailing-20-session realized-volatility tercile**, with tercile boundaries computed
once over the **full historical sample** and then frozen (so the forward window is scored against fixed
boundaries, not re-fit ones). Every conversion statistic is reported pooled **and** within tercile.

*(Verified: SPY bars are present in `data/bar-cache/` — `SPY_1Day_2015-12-31_2026-05-26.json` plus daily
increments through `2026-07-09` — so `loadBars(root, 'SPY')` yields a decade of warmup for the 20-session
window.)*

---

## Part 1 — Historical diagnostic (EXPLORATORY)

**`scripts/coil-frontrun-diag.mjs`** → **`docs/lab/coil-frontrun-diag-RESULTS.md`**

**C1 — conversion rate by year** (primary; from the shared enumerator over 2021–2026). Per year and per
vol-tercile: `converted`, `bounced`, `conversionRate`, with a `bootstrapMeanCI` on the binary outcome
(`{date: episodeStart, net: converted ? 1 : 0}`; block = 15 sessions, ≫ the 10-bar cap).
→ *Thesis predicts the rate declines.*

**C2 / C3 — shallow and deep return edge by year** (secondary; from `data/lab/coil-threshold-instances.json`,
3,998 trades, each carrying `ticker`/`date`/`rsi2`/`bucket`/`grossReturn`/`censored`/`split`). Per year:
mean friction-net (`applyFriction(gross, 20)`) for shallow `[5,15)` and deep `[0,5)` separately, plus
the gap, each with `bootstrapDiffCI`.
→ *Operator's story predicts C2 ↑. Adverse selection predicts C3 ↓. Discriminating the two is the point.*

**Standing.** The results doc opens with a mandatory banner:

> **EXPLORATORY.** This sample's holdout was already spent on the RSI-threshold study (`08a17a3`).
> These results set a prior. They are **not** a confirmatory test and **must not** drive a live Coil
> change. The confirmatory test is the forward monitor in Part 2.

Per-cell `n` is reported prominently. Yearly deep-bucket `n` is ~80; those CIs will be wide, and the
report must say so per-cell rather than inviting the reader to over-read a point estimate.

---

## Part 2 — Forward monitor (CONFIRMATORY, pre-registered)

**`scripts/coil-frontrun-monitor.mjs`** → **`docs/lab/coil-frontrun-monitor-RESULTS.md`**

Same enumerator, run on the **forward window** beginning the day the pre-registration is committed.
**Requires no operator input** — this is the arm with real power, and it accrues automatically.

**Pre-registration:** `data/lab/coil-frontrun-prereg.json`, committed with `git add -f` (the tracked
siblings `coil-prereg.json`, `coil-stop-prereg.json`, `coil-timeout-prereg.json` establish this
convention; `data/**` in `.gitignore:38` is bypassed exactly this way). Hash-verified by a
`verifyFrontrunPrereg` mirroring `verifyThresholdPrereg`, reusing `sha256short` from
`coil-eventstudy-prereg.mjs`. The monitor **refuses to emit a verdict on hash mismatch**.

The prereg freezes: the near-miss band `[5,15)`, the fire threshold `5`, the bounce definition
(`close > SMA5`), the 10-bar resolution cap, the vol-tercile boundaries, block length 15, bootstrap
iterations and seed, the forward-window start date, the minimum-n gate, and the decision rule below.

**Pre-registered decision rule.** C1 is **SUPPORTED** only if *all* hold:

1. `n ≥ 200` resolved forward episodes, **and**
2. the pooled `bootstrapDiffCI(historicalEpisodes, forwardEpisodes)` on the binary conversion outcome
   has `hi < 0` (forward conversion is significantly *lower*), **and**
3. the same diff has `hi < 0` in **at least 2 of the 3 vol terciles** — so the effect cannot be an
   artifact of a shift in the volatility regime.

If (1) fails: **UNDERPOWERED** — explicitly distinct from a null. Otherwise: **NOT SUPPORTED.**

**Expected outcome (the null): NOT SUPPORTED.**

**Secondary, never decision-gating:** forward rate vs. the trailing-12-month historical rate (rather than
the pooled rate); and the forward C2/C3 return trends. Reported for story-discrimination only.

**Benchmark caveat, disclosed in the report.** The historical rate is a fact about already-seen data,
chosen as the benchmark after seeing it. That is legitimate — the *forward* data is what is unseen — but
if the yearly series in Part 1 already shows a decline, then "forward < pooled historical" can be
satisfied by mere continuation of a pre-existing trend, which need not have anything to do with AI
adoption. The Part 1 yearly series is therefore reproduced in the monitor's report so this is visible,
and the trailing-12-month comparison is reported alongside.

---

## Part 3 — The inverse-veto ledger (operational + descriptive)

The operator's record, and the literal answer to *"did I make the right call?"* — available five trading
days after each flag.

### Architecture

A **separate store**, not an extension of `veto-store.js`: different outcome source (simulated trade vs.
bot paper trade), different reason vocabulary, different lifecycle. Same reasoning the veto design used
to separate itself from the tips store; **zero edits to tested code**.

- **`agent/inverse-veto-store.js`** — cloned from `veto-store.js`: JSON array, atomic tmp-rename writes,
  in-process write serialization, validation. Owns `data/coil-inverse-vetoes/inverse-vetoes.json`
  (gitignored, as `vetoes.json` is).
- **`agent/inverse-veto-log.js`** — CLI, mirroring `veto-log.js`.
- **`agent/inverse-veto-scorer.js`** — reconciliation + scorecard.
- **`Claudes Notes/coil-inverse-veto-usage.md`** — operator usage note.

### Data model

| Field | Example | Notes |
|---|---|---|
| `id` | `iveto_1752019200000_AMAT_a1b2` | `iveto_{ts}_{ticker}_{rand}` |
| `date` | `2026-07-07` | ET trading date of the WATCH snapshot |
| `ticker` | `AMAT` | **validated against `MEANREV_UNIVERSE`** |
| `watchEntryRef` | `552.30` | provisional midday price from the snapshot |
| `watchRsi2` | `8.29` | the near-miss RSI — selects the baseline bucket |
| `snapshotPreviewTimeEt` | `14:02` | copied from the snapshot; survives its overwrite |
| `reason` | `crowd_frontrun` | **the only accepted value** |
| `notes` | free text | optional |
| `loggedAt` | ISO timestamp | |
| `preBeat` | `true` | `loggedAt` < 15:45 ET on `date` |
| `hindsight` | `false` | `!preBeat` |
| `snapshotBacked` | `true` | fields came from the contemporaneous preview snapshot |
| `reconciled` | `false` | |

Reconciliation-filled: `simEntryClose`, `simExit`, `simExitReason`, `simDaysHeld`, `simGrossReturn`,
`simNetReturn`, `simNetReturnFromRef`, `censored`, `reconciledAt`.

### The three guardrails

**1. Universe validation.** `ticker` must be in `MEANREV_UNIVERSE`. Rejects KLAC/LRCX/MU at the door. If
Coil could not have fired on it, you cannot claim it should have.

**2. Snapshot-backing.** At log time, read `data/coil-preview/<date>.json`, auto-populate `watchEntryRef`,
`watchRsi2`, and `snapshotPreviewTimeEt` from that date's WATCH list, and **reject if the ticker is not in
it**. The flag anchors to a contemporaneous artifact rather than to operator-typed numbers, and the copied
fields survive the snapshot's same-day overwrite. Soft-fail: if no snapshot exists, require explicit
`--ref`/`--rsi2`, set `snapshotBacked: false`, and report those flags separately — never in the headline.

**3. Pre-beat timestamp discipline.** `preBeat` is computed, not supplied: `loggedAt` must fall **before
Coil's 15:45 ET beat on `date`**. Same-day is *not* sufficient — a flag logged at 23:00 ET already knows
the close, and the phenomenon being claimed is precisely "it jumped." Late flags are accepted (the record
has value) but marked `hindsight: true` and **excluded from the headline**. Note this correctly quarantines
any flag derived from a post-close preview run, such as `2026-07-08`'s 17:17 ET snapshot.

### The single reason

`crowd_frontrun` — *"this will bounce before it reaches RSI(2)<5, because others are buying the dip early."*

Any other value is rejected. This mirrors the veto ledger's guardrail (*"if a fire matches neither reason,
you do not get to veto it — you take it"*) as: **if you cannot claim front-run, you respect Coil's pass.**
A subjective second reason (`quality_oversold`) was considered and rejected as an escape hatch — the exact
failure mode the veto's fixed list exists to prevent.

### Scoring

Reuses `simulateTrade` from `coil-threshold-exitsim.mjs`. **No new simulator.** Load bars with `loadBars`,
locate the bar for `date` via `indexByDate`, call `simulateTrade(bars, entryIdx)`. Net = gross − 20 bps —
the same friction constant as the study.

> **Inverse-veto value = +`simNetReturn`** — the mirror of the veto ledger's `−botReturn`.
> Positive → flagging was right; Coil's strictness cost you that.
> Negative → waiting for Coil was right.

**Entry convention — report both, never conflate:**

- **Primary: fill at the signal-day close** `close[d]`. Identical to the study's convention, therefore
  comparable to the baseline.
- **Secondary: fill at `watchEntryRef`** (`simNetReturnFromRef`) — what the operator would actually have
  paid at the midday price they saw.

A flag becomes scorable ~5 trading days after `date` (the time stop forces an exit). Until then it stays
unreconciled and `censored`.

### The comparison that matters — and its confound

Not *"did the flag make money"* but ***"did the operator's discretion beat taking every near-miss?"***

The comparator is the **contemporaneous** near-miss population — *not* the historical bucket means. This
matters: if the band's edge is genuinely time-varying (the whole thesis), then comparing forward flags
against a 2021–2026 baseline cannot distinguish *"your picks are good"* from *"the whole band improved."*

So the scorer enumerates every near-miss episode over the ledger's own window (shared enumerator, with the
**earnings filter applied** here — WATCH already excludes `earnings_within_5d`, so flags are always
earnings-eligible and the baseline must be too), simulates each with `simulateTrade`, and forms the
bucket-matched contemporaneous baseline `B_now`.

**Δ = flagged mean net − `B_now`**, bucket-matched (n-weighted across the flags' own RSI buckets, so an
operator who only flags `[8,10)` names gets no credit for that bucket's higher unconditional mean), using
the **primary (signal-day-close) convention** only. CI via `bootstrapDiffCI`.

**Flag-rate diagnostic.** Report `flags / near-miss episodes observed`. If the operator flags everything,
Δ → 0 by construction and the ledger tests nothing. A selective flag rate is what gives Δ meaning.

### No verdict on discretion — and why

Δ carries **no SUPPORTED/NOT-SUPPORTED verdict**, at any n, in this design.

Per-trade σ ≈ 4–5%, so `SE(Δ) ≈ σ/√n`. At n=30, SE ≈ 0.9% and a 95% CI clears zero only for Δ ≳ **1.8%
per trade** — an implausibly large discretion edge. A verdict gate at n=30 would therefore be theatre: it
could only ever fire on noise or on a miracle. The scorer instead reports Δ, its CI, `n`, and the
**minimum detectable effect at the achieved n**, and labels the whole section *descriptive*.

The immediate, honest value is per-flag: five trading days after you flag AMAT, you learn whether that
specific call was right. That is what was asked for. The aggregate is a slow-burn record, not a test.

---

## Power — stated plainly

| arm | statistic | ~n per year | MDE (95%, 1yr) | verdict? |
|---|---|---|---|---|
| **C1 conversion** (Part 2) | proportion, p≈0.15 | ~640 episodes | **≈ 4–5 pp** | **yes** — pre-registered |
| C2/C3 returns (Parts 1–2) | mean, σ≈4.5% | ~640 / ~86 | ≈ 1.6–2.0% per trade | no — context only |
| Δ discretion (Part 3) | mean, σ≈4.5% | ~10–40 flags | ≳ 1.8% per trade | no — descriptive only |

The historical shallow−deep gap is only **−0.53%**. A return-based test needing a 1.6–2.0% shift to
resolve will read UNDERPOWERED for years. **The conversion rate is the only arm that can actually answer
anything on a one-year horizon** — which is why it, and not the return series, carries the pre-registered
verdict.

*Both columns are estimates.* MDEs assume date-block correlation inflates naive SE by ~1.5×, and the
episode counts are extrapolated from `coil-threshold-instances.json` rather than measured (see *Open
questions*). The monitor recomputes and reports the **realized** MDE rather than trusting either figure,
and the `n ≥ 200` gate must be sanity-checked against the enumerator's first run before the prereg is frozen.

---

## Phasing

1. **Shared enumerator** (`coil-nearmiss-enum.mjs`) + tests. Everything depends on it.
2. **Part 2 pre-registration** — committed *first*, before Part 1 is run, so the forward window starts
   clean and the historical benchmark cannot be tuned after the fact.
3. **Part 1 diagnostic** — build, run, read. Calibrates expectations; discriminates the rival stories.
4. **Part 3 store + CLI + scorer + tests** — start flagging immediately. AMAT `2026-07-07` *can* and
   *should* be logged, but it will be marked `hindsight: true` (it is being flagged after the bounce was
   observed) and quarantined from the headline. That is the guardrail working as designed, on the very
   case that motivated the feature.
5. **Part 2 monitor** — run monthly; it emits `UNDERPOWERED` until `n ≥ 200`.
6. **Phase 3 UI** — deferred, as with the veto ledger.

Ordering note: (2) before (3) is not cosmetic. Running the diagnostic first and *then* writing the prereg
would let the historical benchmark be chosen to flatter the forward test.

---

## Reuse map (nothing here is rewritten)

| Need | Existing | Source |
|---|---|---|
| exit simulation | `simulateTrade` | `coil-threshold-exitsim.mjs:30` |
| entry predicate | `entryFiresAt` | `coil-threshold-exitsim.mjs:13` |
| RSI / SMA | `wilderRSI`, `sma` | `coil-meanrev-signal.mjs` |
| bars (multi-file merge, newest `written_at` wins) | `loadBars`, `indexByDate` | `coil-eventstudy-bars.mjs:28,46` |
| universe | `MEANREV_UNIVERSE` | `coil-eventstudy-build.mjs:15` |
| friction, mean, win-rate, PF | `applyFriction`, `mean`, … | `coil-threshold-metrics.mjs` |
| block-bootstrap CI (mean) | `bootstrapMeanCI` | `coil-threshold-metrics.mjs:50` |
| block-bootstrap CI (difference) | `bootstrapDiffCI` | `coil-threshold-metrics.mjs:67` |
| prereg hashing / verify | `sha256short`, `verifyPrereg` | `coil-eventstudy-prereg.mjs:10,53` |

`bootstrapMeanCI` takes `{date, net}` rows and simply means `net`, so a **binary** `net ∈ {0,1}` yields a
conversion-rate CI directly. No new statistics code is required anywhere in this design.

---

## Testing (TDD, `node:test`, temp-dir project root)

Side-effecting functions get mock / temp-dir tests before "done" — test the executor, not just the predicate.

**Enumerator:**
- episode starts only after a non-in-band bar (consecutive in-band days ⇒ exactly one episode)
- `FIRE` / `BOUNCE` / `REGIME_EXIT` precedence within a bar; `FIRE` wins over `BOUNCE`
- `UNRESOLVED` at the 10-bar cap; excluded from the rate, counted in the report
- no lookahead: resolution at `d+k` uses only bars through `d+k`
- vol-tercile assignment uses frozen boundaries, not re-fit ones

**Store:**
- universe validation rejects `KLAC`; accepts `AMAT`
- reason validation rejects anything but `crowd_frontrun`
- snapshot auto-populate fills ref/rsi2/previewTime from a fixture; ticker absent from that WATCH list ⇒ **rejected**; snapshot missing ⇒ explicit `--ref`/`--rsi2`, `snapshotBacked: false`
- `preBeat` boundary: 15:44 ET ⇒ true; 15:46 ET ⇒ false; **and across the ET midnight/DST boundary**
- atomic write; concurrent `createInverseVeto` calls serialize without clobbering
- read-empty-when-missing

**Scorer:**
- joins `date` → correct bar index; sign convention (`+simNetReturn`); a simulated **loser** yields a **negative** inverse-veto value (waiting was right)
- censored (< 5 forward bars) stays unreconciled
- `simNetReturnFromRef` differs from close-based when `ref ≠ close`
- hindsight / non-snapshot-backed flags excluded from the headline aggregate
- bucket-matched `B_now`: a flag set drawn only from `[8,10)` is compared against contemporaneous `[8,10)` episodes
- flag-rate and MDE computation

**Monitor:**
- prereg hash verify passes on match; **refuses a verdict on mismatch**
- `UNDERPOWERED` below the n-gate regardless of the CI
- the 2-of-3-tercile rule: a pooled effect confined to one tercile does **not** yield SUPPORTED
- bootstrap determinism under fixed seed

---

## Known limitations (disclosed in every report)

- **Universe ceiling.** Only the 80 `MEANREV_UNIVERSE` names.
- **Survivorship** — today's large-caps. Direction is conservative for the expected null, as in `08a17a3`.
- **Daily-close fills.** The idealization is identical across flags and baseline, so it cannot bias Δ.
- **Part 1 is exploratory** — its sample's holdout is spent.
- **The benchmark is chosen after seeing the past** (see Part 2's caveat); a pre-existing decline weakens
  causal attribution to AI adoption.
- **Conversion and return metrics use different populations** (earnings filter applied to the latter only).
- **Selection is non-random by design** in the ledger. That *is* the discretion test; only the flag-rate
  diagnostic keeps it honest.
- **`data/coil-inverse-vetoes/` is gitignored**, as the veto ledger's store is. The ledger is not backed
  up by git.
- **Conversion ≠ fills.** Coil's ≤4-position cap means a converted signal need not become a Coil trade.

---

## Open questions (for the implementation plan)

- **Forward earnings dates.** Part 3's `B_now` needs the earnings filter over the ledger window, so
  `data/lab/coil-earnings-dates.json` (a one-time FMP fetch, last built 2026-06-05) must be refreshed via
  `scripts/coil-threshold-earnings.mjs`. Part 2's conversion arm deliberately has **no** such dependency.
- **Episode counts are estimates.** The `~640/year` figure is extrapolated from `coil-threshold-instances.json`
  (3,998 fresh-signal entries over ~5.5 years, ~12% of them deep). Episodes are *not* the same population —
  the instances enumerator opens a trade at the first signal and skips subsequent bars, so a near-miss that
  later converts is recorded as a near-miss. The enumerator's first run replaces this estimate, and the
  prereg's `n ≥ 200` gate must be sanity-checked against the realized rate before it is frozen.
- **Separate cleanup, not this work:** `data/lab/coil-threshold-prereg.json` was never force-added in
  `08a17a3`, unlike its three tracked siblings. Its hash guarantee is unverifiable from a fresh clone.
