# EMA-Pullback Pre-Registered Backtest — Design Spec

**Date:** 2026-06-06
**Status:** Approved (brainstorm) + revised after external review, pending implementation plan
**Type:** Lab study only (no deployment). Mirrors the Coil RSI-threshold / exit-timeout studies.

## Motivation

A "PB EMA" (pullback-to-EMA trend-continuation) strategy is circulating on social media,
including a free, non-guru write-up on r/FuturesTrading that claims a ~68% win rate over 2
years across many tickers/timeframes (400tick → 1day). A separate paid influencer product
("PlayBit Trading Bots", Whop, $399/mo, ILM+ORB models, 890 self-hosted reviews, **no
third-party-verified track record**) is a *different* strategy and is **not** the subject of
this study — it is referenced only as the prompt that triggered the investigation.

We test a **daily mechanical adaptation** of the Reddit EMA-pullback strategy, the same
pre-registered way Coil studies were run, to decide whether it deserves a slot in the fleet.
The author's ~68% claim spans down to 400-tick; a daily bar erases intraday momentum
microstructure where such an edge most likely concentrates. This study therefore answers
"**does a daily mechanical EMA-pullback earn a fleet slot**" (the fleet runs daily) — a daily
REJECT is **not** a debunking of the author's intraday claim, and RESULTS.md must say so.

## Success criterion (decided + revised)

**Alpha first, then ballast.** (Revised from "raw friction-net edge first" — see §5 rationale.)
- PRIMARY (decision-gating): positive **beta-adjusted** (market-neutralized) edge on the
  chronological holdout. Raw friction-net is reported but is **not** the gate.
- SECONDARY (informational, computed only if the alpha gate passes): conditional/downside beta
  to the user's tech book (QQQ) and overlap with existing lanes.

**Why the change:** Coil's RSI(2) mean-reversion is near-market-neutral, so raw friction-net
return ≈ alpha. EMA-pullback trend-continuation is structurally long-beta on the long side, and
the chronological split puts the bull-dominated 2017–2026 (2020–21 melt-up, 2023–25 AI surge)
entirely in the holdout. A raw-return gate could therefore graduate **harvested market beta
dressed as edge** — i.e. "lever up QQQ on pullbacks," the exact accidentally-long-beta
correlated sleeve the fleet pivot exists to kill. The edge must survive beta-adjustment before
anything else.

## Scope & non-goals

- **In scope:** offline backtest → KEEP-CANDIDATE / REJECT / UNDERPOWERED verdict.
- **Out of scope (deferred, gated on KEEP):** building a deployable fleet agent. We never
  scaffold the agent before the edge is proven.
- **Out of scope (explicitly):** the author's intraday/tick edge. Daily bars only; a daily
  REJECT does not debunk the intraday claim.
- **Removed:** all human discretion ("enter near support/resistance", "sometimes skip on
  price action"). A bot has none; the mechanical version is the honest floor for deployment.

## §1 Mechanized signal (deterministic, episode-welded, lookahead-free)

Literal reading of the author's short setup, mirrored for long. **Long trigger on day `t`:**
1. **Trend intact:** `EMA_fast(t) > EMA_slow(t)`.
2. **Pullback below both (as-of-bar):** there exists a bar `d` in `[t-W, t-1]` whose close was
   below `min(EMA_fast(d), EMA_slow(d))` — i.e. the historical close is compared to the EMA
   values **as of bar `d`**, never as of `t` (comparing an old close to today's EMA is a subtle
   lookahead).
3. **Coherent reclaim (welded to the dip):** `t` is the **first** bar to close above
   `EMA_fast(t)` since the most-recent qualifying sub-both close, with **no intervening close
   above `EMA_fast`** between that dip and `t`, and `EMA_fast(t) > EMA_slow(t)` still holds.
   This prevents a stale dip on `t-9` from pairing with an unrelated reclaim today.

Short = exact mirror (downtrend; pullback *above* both EMAs; first close back *below* fast EMA
with no intervening close below). One open trade per ticker at a time (fresh-signal
enumeration, Coil convention). The implementation reports the **stale-pair reject count** as a
sanity check on the welding.

## §2 Locked primary config + sensitivity grid

| Knob | Primary (locked, decision) | Grid (train-only, exploratory) |
|---|---|---|
| EMA pair | **25 / 75** (author-literal) | 10/30, 20/50, 50/150 |
| Pullback window `W` | **10 bars** | 5, 20 |
| Exit stop | **1.5 × ATR(14)** | 1.0, 2.0 |
| Exit target | **1.5 × ATR(14)** (1:1 R:R) | 1.0×, 3.0× |
| Max-hold time stop | **10 bars** | 5, 20 |
| Width filter ("nice and wide") | **OFF** | ON (EMA gap ≥ 0.5×ATR) |
| CCI divergence | **OFF (primary)** | ON (key ablation) |

- Full grid runs on **train only** (robustness picture); the **locked primary cell is the only
  thing graded on holdout** — the forking-paths firewall. (Note: the primary cell is the
  author's *advertised* config, so it survived the author's own unknown selection; our prereg
  protects our forking paths, not his — handled by the trailing-window scoring in §5.)
- **Long and short sides are reported separately**, each both raw and beta-adjusted. The blend
  averages a drift-flattered long side with a drift-punished, under-costed short side, hiding
  the real picture; beta-adjustment (§5) plus the split exposes it. Shorts also carry a
  borrow-cost line (§3).
- **CCI is an ablation, not the headline.** The verdict must not hinge on our imperfect
  divergence proxy. If the bare core has no edge, a fragile CCI filter "rescuing" it is itself
  a red flag; if the core has edge, CCI-on is reported as upside.
- **CCI mechanization (ablation only):** CCI(20). Bullish divergence over window `W` =
  `price_low2 < price_low1` AND `cci@low2 > cci@low1` over the two most recent close-lows; the
  swing-low identification rule is pinned in the implementation plan (ablation-only, off the
  verdict).

## §3 Fill, exits, friction

- **Entry fill:** signal-day close (Coil `signal_day_close` convention; mild optimism, flagged
  in limitations).
- **ATR:** ATR(14) Wilder, computed **as-of `t`** (the bar has closed → no lookahead). Caveat:
  the reclaim day's own range can inflate ATR and thus widen the brackets; a `t-1` ATR variant
  is run as a robustness check.
- **Exit gap model (asymmetric — this matters):**
  - **Stop = market exit.** Bar low ≤ stop → fill at stop; if the bar gapped through (open
    below stop for a long) → fill at the **open** (worse). Gaps hurt.
  - **Target = limit exit.** Bar high ≥ target → fill at the **target price**, never credited
    the better gapped-open. This is a deliberately **conservative convention**: a resting limit
    can occasionally get opening price improvement in reality, but modeling that hands the
    strategy favorable slippage a limit can't be relied on to get. Gaps don't help.
  - **Same-bar both-touched → booked as loss** (stop-priority; conservative). On a 1:1 ATR
    strategy this tie-break shapes the win rate heavily, so the implementation **reports the
    fraction of exits resolved this way** — the operator sees that number, not just the headline
    win rate.
  - Max-hold time stop exits at close.
- **Friction (round-trip bps):** optimistic **10** / representative **20** / stress **30**
  (identical to Coil for comparability; conservative for these liquid names). **Decision metric
  = friction-net at 20 bps.** Short trades additionally net a **borrow cost**
  (`borrow_bps_annual` × holding_days / 252): pre-registered ~50 bps/yr for the ETF universe
  (mostly easy-to-borrow), ~200 bps/yr for the large-cap cut.
- **Reporting:** win rate **plus average win and average loss magnitudes** for every cell, so we
  can tell whether any edge is win-rate vs magnitude (and catch a mishandled target inflating
  the magnitude side).

## §4 Universe & data

- **Primary universe (low survivorship):** Turtle's 15 decorrelation-selected multi-driver ETFs
  + index ETFs (SPY/QQQ/IWM; **DIA optional** — near-redundant with SPY). ETFs carry no
  survivorship bias.
- **Secondary cut:** Coil's liquid large-cap list (reused from existing universe files);
  flagged for survivorship.
- **Window:** effective **2008-01-01 → present** (~18y, multiple regimes), **chronological 50/50
  split** (~2008–2017 train / 2017–2026 holdout). Data fetched from **~2006-06** and the first
  ~250 trading bars discarded as **EMA warmup** so the 75/150-period EMAs are stable before any
  2008 signal fires; EMAs **seeded** with the SMA of the first `period` bars, then iterated.
- **Effective sample size:** because trend signals fire simultaneously across correlated names,
  the implementation **reports the distinct-entry-date count** alongside the raw trade count.
- **Data source:** FMP `historical-price-eod/full` (adjusted; the migrated working endpoint per
  the screener-migration notes; `.env` key must be sourced). Alpaca daily bars as fallback.

## §5 Pre-registration: gates → verdict (revised)

Hash-locked JSON `data/lab/ema-pullback-prereg.json`, self-hash idiom from
`coil-threshold-prereg.mjs`, written before results.

**Beta-adjustment (the core revision).** Per instrument `i`, estimate `βᵢ` by OLS of daily
returns vs benchmark over the **train window only**, frozen (no holdout leakage). Per-trade
market-neutralized residual:

```
residual = trade_net_ret − (direction · βᵢ · benchmark_ret_over_holding_window)
```

where `direction = +1` long / `−1` short (so the hedge sign is correct for shorts),
`trade_net_ret` is already net of 20bps friction (+ short borrow), and the holding-window
benchmark return spans the trade's exact entry→exit calendar dates. Residuals are computed
**twice — hedged against SPY and against QQQ separately** — and the gate must pass against
**both** (so a pass can't be an artifact of benchmark choice, and the "lever up QQQ" sleeve is
excluded by construction).

**Bootstrap:** date-block, ≈15 sessions (≫ the ≤20-bar hold), 10 000 iterations, fixed seed,
CI [2.5, 97.5]. Verified that `coil-threshold-metrics.mjs::blocksByDate` resamples **whole
calendar blocks of distinct dates**, so same-date cross-sectional trades move together and the
CI is not the per-trade-too-narrow kind. This module is reused.

- **`gate_alpha` (PRIMARY):** holdout **beta-adjusted residual** mean/trade, 95% date-block CI
  **low > 0**, against **both** SPY and QQQ.
- **`gate_robust` (secondary):** the same **beta-adjusted residual** is net-positive on
  **train** (alpha sign-consistency train↔holdout — not raw return).
- **Power floor:** holdout trades **≥ 100** AND distinct entry dates **≥ 40**, else
  `UNDERPOWERED`.
- **Verdict:** `KEEP-CANDIDATE` iff `gate_alpha AND gate_robust`; else `REJECT`.
- **Expected outcome (honest prior): REJECT / marginal.** A generic mechanical trend-pullback,
  once stripped of equity beta, has little reason to carry alpha on daily liquid names net of
  costs. We are **not** cheerleading a positive — same discipline as the Coil and two-stage
  studies.

**Author-window decontamination.** The author's "~2 years" is most likely ~2024-06→2026-06,
inside our holdout — contaminating the most recent slice with the author's own (possibly
cherry-picked) in-sample. The trailing ~24 months is scored as a **separate labeled slice**;
the holdout alpha is reported **with and without** it. A pass concentrated in that window is
read as "reproduces the author's own backtest," not independent confirmation. (We score
separately rather than hard-carve: the boundary is a guess and carving discards data.)

**Regime visibility.** Holdout beta-adjusted edge is also reported **by year/regime** so a
bull-concentrated alpha is visible rather than assumed. (The holdout is bull-*dominated* but not
uniformly favorable — it contains 2018-Q4, the 2020 crash, and the 2022 bear, all
trend-hostile.)

## §6 Secondary ballast lens (only if `gate_alpha` passes)

Per "alpha first, then ballast" — computed only if there's alpha to diversify:
- **Conditional/downside beta**, not full-sample Pearson: trend strategies are low-correlation
  on average but high-correlation in the tails (trends break together). Report beta to **QQQ in
  QQQ's worst-decile weeks** and crisis-window behavior (2018-Q4, 2020-Q1, 2022).
- Full-sample corr/beta to QQQ and SPY reported too, for context.
- Overlap read vs existing lanes (directional bias, deploy timing).
- **Informational flag** `BALLAST-OK` if **downside** beta to QQQ is near-zero/negative. Feeds
  the fleet-fit recommendation; does **not** gate the alpha verdict.

## §7 Build plan & conventions

- Node `.mjs` scripts under `scripts/ema-*.mjs`, **TDD with `node:test`** (workflow pref).
- Reuse `coil-threshold-metrics.mjs` (friction, bootstrap, PF, win rate) rather than
  re-implementing.
- `RESULTS.md` in `docs/lab/ema-pullback-RESULTS.md` (terse verdict line + tables +
  limitations, Coil idiom). Framed as a **daily-adaptation** verdict, not a debunking.
- Hash-locked prereg JSON committed before scoring.
- One squashed commit per backlog item; feature branch `ema-pullback-backtest`; merge to local
  main on completion.

## §8 Limitations (pre-stated)

- Signal-day-close fill optimism.
- Large-cap survivorship flatters trend-continuation longs → **discount any KEEP** on that cut.
- Daily bars only; the author's intraday/tick regime is out of scope (a daily REJECT ≠ debunk).
- Simplified CCI-divergence proxy (ablation only, never the decision basis).
- Frozen train-estimated betas; ETF betas are fairly stable, large-cap betas less so.
- Short borrow modeled as a flat annualized assumption, not name/time-specific.
- No regime sizing; flat per-trade sizing for edge measurement.

## Brainstorm + review decisions (traceability)

1. Success bar = **alpha first (beta-adjusted), then ballast** (revised from raw-edge-first
   after external review — the blocker fix).
2. Universe/TF = **daily, liquid ETF + large-cap** (reusing fleet universe files).
3. Param policy = **fixed primary + train-only sensitivity grid**; discretion dropped; CCI as
   on/off ablation.
4. Approach = **lab study only**; agent build deferred and gated on KEEP.
5. Review-driven additions: episode-welded + lookahead-free signal (§1); long/short split +
   short borrow (§2/§3); asymmetric target/stop gap model + tie-break & magnitude reporting
   (§3); EMA warmup/seeding + effective-N (§4); beta-adjusted dual-benchmark gates +
   author-window decontamination + regime visibility (§5); downside-beta ballast lens (§6).
