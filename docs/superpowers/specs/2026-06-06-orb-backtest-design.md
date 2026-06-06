# ORB (Opening Range Breakout) Pre-Registered Backtest — Design Spec

**Date:** 2026-06-06
**Status:** Approved (brainstorm) + revised after external review, pending implementation plan
**Type:** Lab study only (no deployment). Sibling of the EMA-pullback study; reuses its harness.

## Motivation

The paid influencer behind the `pb.ema` brand sells an automated product running **ILM
(Inverted Liquidity Model) + ORB (Opening Range Breakout)** on Whop ($399/mo, self-hosted
reviews, no third-party-verified track record). ILM is an ICT-style liquidity-sweep / inverted
fair-value-gap method — discretionary, definition-dependent, and not mechanizable from outside.
**ORB is the testable half**: a real, documented intraday archetype (cf. Zarattini & Aziz 2023).

This study tests a **generic mechanical ORB** on the operator's own data to answer "does ORB
carry edge for me," NOT "is the seller legit" (a backtest of our reconstruction cannot convict
or exonerate his unknown config + undefinable ILM; the decisive test for the seller remains the
verified live track record he does not provide). ORB is off the fleet's uncorrelated-ballast
thesis (it is a directional intraday breakout); this is an explicit curiosity/completeness probe,
run with full pre-registered rigor because ORB's seductive published result makes it
overfitting-bait.

## Success criterion (decided)

**Both friction-net AND market-relative edge must be positive** on the holdout, measured in
**R-multiples** (see §5). ORB is same-day-flat, so it does not harvest the secular overnight
drift the EMA swing strategy did — but a directional intraday breakout still captures intraday
market beta on trending days, so we require the edge to survive a **per-name** intraday SPY
hedge as well as costs.

## Scope & non-goals

- **In scope:** offline ORB backtest → KEEP-CANDIDATE / REJECT / UNDERPOWERED verdict, decided
  on the **ETF cut only**.
- **Out of scope:** the ILM half (un-mechanizable); the seller's exact parameters (unknown); a
  fleet-deployment decision (ORB is off-thesis — even a pass is a curiosity result).
- **Honest prior: genuinely uncertain.** ORB has mixed but real published support; we are not
  pre-committed to REJECT, nor cheerleading a pass. The locked gates decide.

## §1 Data & feed choice

- **5-min RTH bars (09:30–16:00 ET) from Alpaca, IEX feed, `adjustment=all`**, via the existing
  `stage1_backfill_bars.mjs` pattern (creds `ALPACA_PUBLIC_KEY`/`ALPACA_SECRET_KEY`, endpoint
  `data.alpaca.markets/v2/stocks/{sym}/bars`, paginated via `page_token`, `timeframe=5Min`),
  written to an isolated lab cache `data/lab/orb-bar-cache/`. Depth ~2016→present.
- **Feed = IEX (free), not SIP (paid).** Two known IEX distortions, handled explicitly:
  - *Volume:* IEX ≈ 2-3% of consolidated volume → the volume filter is **dropped** (see §2).
  - *Opening-range extrema (inward bias):* because `OR_high`/`OR_low` are **extrema**, a thin
    feed biases them toward the interior (IEX can miss a brief consolidated spike), making the
    OR narrower → breakouts **easier and earlier**, admitting false breakouts a true-OR level
    would reject. This is distinct from and larger than the VWAP ratio distortion. It
    **flatters ORB**, so it makes a KEEP suspect but a REJECT more robust. Bounded by the
    breakout-buffer ablation (§6); any KEEP must be re-confirmed on the SIP feed before trust.
- FMP intraday is unusable for deep history (~6 trading days per request).

## §2 Mechanized ORB signal (primary, locked)

- **Opening range:** first 15 min (09:30–09:45 ET = exactly three 5-min bars) → `OR_high`,
  `OR_low`.
- **Breakout trigger:** the first 5-min bar after 09:45 whose *close* breaks the range — above
  `OR_high` (long) or below `OR_low` (short) — AND is VWAP-aligned (close > session VWAP for
  long, < for short). One trade per instrument per day (first valid breakout only; no-trade days
  allowed). Entry **fill** is the *next* bar's open (§3), not this bar's close.
- **Stop:** opposite side of the opening range (long → `OR_low`, short → `OR_high`); initial
  risk `R = |entry_fill − stop|` (in price; the per-trade metric is R-multiples, §5).
- **Exit:** end-of-day at the session's last RTH bar close if the stop was not hit first. Primary
  has **no profit target** (classic stop-or-EOD ORB). Always flat overnight.
- **Dropped:** the "above-average volume" filter (IEX volume unreliable); available only as a
  grid ablation.
- **Session VWAP (locked computation):** cumulative `Σ(typical_price·vol) / Σ(vol)` from the RTH
  open, typical price `(H+L+C)/3` per 5-min bar, IEX volume. Computed ourselves (not Alpaca
  `vw`). Kept despite dropping the volume *filter*: a VWAP is a volume-weighted *ratio* over a
  roughly-proportional sample, far more robust to IEX undersampling than an absolute volume
  threshold. Its marginal value is bounded by the VWAP-off ablation (§6).

## §3 Fill, exits, friction

- **Entry fill (PRIMARY = next-bar open).** The breakout is *confirmed* at the triggering bar's
  close; the realistic fill is the **open of the following 5-min bar**, plus slippage. Filling
  at the triggering bar's own close would credit the strategy the very continuation it seeks
  (the breakout population is continuation-tilted, so the next-bar open is systematically worse
  for the entry direction) — that optimism could be the entire apparent edge, so it is **not**
  used. If the triggering bar is the session's last bar (no next bar), the signal is skipped; if
  the next bar is missing (halt), fill at the next available bar's open.
- **Stop:** checked gap-honest within subsequent 5-min bars, **market exit** — bar low ≤ stop
  (long) fills at the stop, or at the bar open if it gapped through (worse). Same asymmetric
  convention as `ema-exitsim`.
- **EOD exit:** the session's actual last RTH bar close (handles early-close/half-days; never
  references a fixed 15:55 bar that may not exist).
- **Friction (round-trip bps):**
  - ETF cut: **1 / 2 / 5** (optimistic / representative / stress); **decision = 2 (representative)**.
  - Large-cap cut: **5 / 10 / 20**; **decision = 10 (central, not floor)** — ORB transacts on the
    breakout bar, when spreads widen and liquidity thins, so steady-state friction understates
    cost. This stacks with (not instead of) the next-bar-open fill: we assume neither the better
    price nor the smaller cost.

## §4 Universe & split

- **ETF cut (sole gated/decision universe):** SPY, QQQ, IWM, DIA. No selection-on-behavior; the
  clean read.
- **Large-cap cut (EXPLORATORY appendix — reported, NEVER gates the verdict):** AAPL, NVDA, TSLA,
  AMD, META. These are **selected on the dependent variable** — chosen because they are today's
  high-ADV momentum names, i.e. for the exact intraday-trending property ORB exploits (worse than
  ordinary survivorship: a name that was sleepy in 2017 and trended only from 2023 still sits in
  the cut for the years it didn't behave that way, and never-momentum names are absent). So they
  flatter ORB by construction and cannot be trusted to decide anything.
- **Benchmark:** SPY (intraday market-relative hedge).
- **Window:** 2016-01-01 → present (~10y; includes 2018-Q4, 2020, 2022). **Chronological 50/50**
  train/holdout. The RESULTS must disclose which major-vol episodes fell in train vs holdout
  (the verdict is more hostage to the split here than in any prior study).

## §5 Pre-registration: gates → verdict

Hash-locked `data/lab/orb-prereg.json` (same self-hash idiom as `ema-prereg.mjs`). Date-block
bootstrap (each day = one session; same-date cross-instrument trades grouped), block ≈ 15
sessions, 10 000 iters, seed 1234, CI [2.5, 97.5].

- **Per-trade metric = R-multiple** `= (exit − entry_fill) · direction / |entry_fill − stop|`.
  This is the gated unit: it normalizes for the OR-width stop so wide-OR (high-vol, trending)
  days don't dominate the mean, and it matches what fixed-fractional sizing realizes. Raw
  %-return is **reported alongside** (it is the fatter-tailed series).
- **Friction in R:** subtract `friction% / R%` per trade (friction costs more, in risk units, on
  narrow-OR trades — correct).
- **Per-name intraday β (frozen):** OLS of each name's train 5-min RTH returns on SPY's, frozen
  (reuses `ema-beta.olsBeta`). A universal β=1 would under-hedge high-β large-caps and leak
  systematically-positive residual beta on the up-days longs fire — defeating the gate.
- **Market-relative return (R units, sign-aware):**
  `(name_window_ret − direction · β_name · SPY_window_ret − friction%) / R%`, `SPY_window_ret`
  spanning the trade's exact entry→exit timestamps. Reuses `ema-beta.residual`.
- **`gate_net` (PRIMARY):** holdout friction-net **R-multiple** mean/trade 95% CI lo > 0, over
  the **ETF cut** (SPY/QQQ/IWM/DIA).
- **`gate_mktrel` (PRIMARY):** holdout market-relative **R-multiple** mean/trade 95% CI lo > 0,
  over the **ETF cut excluding SPY** (QQQ/IWM/DIA — SPY-hedged-against-SPY is ≈0 by construction
  and would only pad n). This is explicitly a relative-momentum-vs-SPY read.
- **`gate_robust`:** both `gate_net` and `gate_mktrel` net-positive on **train** (sign-consistency).
- **Power floor:** holdout trades ≥ 200 AND distinct entry dates ≥ 100, else `UNDERPOWERED`.
- **Verdict:** `KEEP-CANDIDATE` iff `gate_net ∧ gate_mktrel ∧ gate_robust`; else `REJECT`.
- **Robustness (reported, decision-informing):** does the holdout edge survive **dropping the top
  ~5 days** (R is right-skewed toward trend-day winners)? **Entry-time-of-day distribution +
  edge-by-hour** (an all-early-breakout edge is a different, more capacity-constrained strategy).

## §6 Sensitivity grid (train-only, exploratory)

One-knob-at-a-time off the primary; reported, never decision-gating:
- OR window {5, 30 min}; profit target {none, 1R, 2R}; 21-EMA-alignment filter {on}; VWAP filter
  {off} (ablate it); **breakout buffer {require close to clear OR by ~0.05·OR-width}** (bounds
  the IEX inward-OR bias).

## §7 Build plan & conventions

- Node `.mjs` under `scripts/orb-*.mjs`, **TDD with `node:test`**.
- Reuse: `coil-threshold-metrics.mjs` (friction, date-block bootstrap), `ema-beta.mjs`
  (`olsBeta`, `residual`), the `ema-prereg.mjs` hashing idiom, the `stage1_backfill_bars.mjs`
  Alpaca fetch.
- New: session-aware intraday loader (`orb-bars`), OR + session-VWAP computation, ORB signal,
  intraday/EOD exit sim, build/enumeration, prereg, score (+RESULTS render).
- **Loader/convention tests are mandatory** (off-by-one here silently corrupts every signal):
  exactly three OR bars (09:30/09:35/09:40 close at 09:45); first eligible entry-trigger bar is
  the 09:45–09:50 bar; entry *fills* on the following bar's open; timestamps labeled
  consistently (bar key = its close time, pinned by test); half-day sessions resolve EOD to the
  real last bar; missing/halt bars tolerated.
- `RESULTS.md` in `docs/lab/orb-RESULTS.md`. Hash-locked prereg committed before scoring. Feature
  branch `orb-backtest`; squash-merge to local main on completion. Lab-only, no flags, no deploy.

## §8 Limitations (pre-stated)

- **Next-bar-open fill** is the realistic primary (not the breakout-bar close); residual slippage
  beyond the bps tiers is unmodeled.
- **IEX feed:** volume filter dropped; session VWAP inherits IEX-volume imperfection (small, a
  ratio); **opening-range extrema biased inward** → flatters ORB (KEEP suspect, REJECT robust);
  any KEEP needs SIP re-confirmation. IEX-only prices otherwise track liquid names in RTH.
- **5-min granularity** makes intrabar stop fills approximate (no tick path within a bar).
- **Large-cap cut is selected on the tested behavior** (momentum) — exploratory only, never gated.
- **R-multiple** mean is right-skewed by trend-day winners (hence the drop-top-N check); %-return
  is fatter-tailed still.
- ~2016+ window — fewer regimes/shorter than the EMA 2006 set; verdict sensitive to the
  train/holdout placement of 2018-Q4/2020/2022 (disclosed).
- Capacity / market-impact ignored (per-trade returns, flat sizing).

## Brainstorm + review decisions (traceability)

1. Rigor = **full pre-registered study** (ORB is overfitting-bait → locked gates).
2. Success bar = **both friction-net AND market-relative**, in **R-multiples**, CI>0 + train
   sign-consistency.
3. Data = **Alpaca IEX 5-min**; FMP intraday rejected.
4. Primary = 15-min OR, VWAP-aligned close-break, **next-bar-open fill**, OR-opposite stop, EOD
   exit, no target; volume filter dropped.
5. Review-driven (false-pass fixes first): **next-bar-open** primary fill (§3); **per-name
   intraday β** not β=1 (§5); **R-multiple** gating not %-return (§5); **ETF-only decision
   universe**, large-cap demoted to exploratory for selection-on-DV (§4); **raised large-cap
   friction** to central-10 for breakout-moment spreads (§3); **SPY dropped from `gate_mktrel`**
   (§5); **IEX inward-OR bias** flagged + breakout-buffer ablation + SIP-if-KEEP (§1/§6);
   loader-convention tests + half-day/halt handling (§7); drop-top-N + edge-by-hour + regime-split
   reporting (§4/§5).
