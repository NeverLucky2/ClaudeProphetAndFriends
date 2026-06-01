# Turtle-v2 — Broadened Multi-Driver Basket + Correlation-Cluster Caps

**Status:** Draft for operator review
**Created:** 2026-05-31
**Parent:** the uncorrelated-ballast fleet pivot (memory `fleet-uncorrelated-ballast-pivot`)
**Component type:** mechanical Go strategy change (no LLM path). Build is a follow-up effort (handed off).

---

## 1. Purpose & scope

Turtle is the fleet's cheap, slow **ballast pillar**: a mechanical Donchian/ATR trend system on a multi-asset ETF basket whose value is *regime rotation* — in any regime something tends to be trending (bonds/gold/yen in risk-off; commodities/energy in inflation; intl equity in risk-on), giving returns uncorrelated to the user's mega-cap tech book.

Turtle-v2 does two things and nothing else:
1. **Broaden the basket** from the current 6 ETFs to **15** spanning 6 genuinely different macro drivers (more uncorrelated bets → better risk-adjusted, less single-driver concentration).
2. **Add correlation diversification** so the system can't load up on several co-moving breakouts and quietly become a concentrated bet — a **two-layer** control (static driver-cluster caps + a dynamic rolling-correlation guard).

All existing mechanics are **kept unchanged**. This is a diversification *broadening* of a live mechanical system, not a parameter tune.

## 2. Grounded findings (verified 2026-05-31)

- **Universe is duplicated:** `controllers.TrendUniverse` (`controllers/trend_controller.go:18`) and `services.turtleUniverse` (`services/turtle_executor.go:19`) are two hand-synced copies of `[]string{"TLT","GLD","USO","DBC","UUP","EEM"}`. Drift risk.
- **Entry** (`turtle_executor.go` `runEntries`/`evaluateEntry`): Donchian-100 breakout (`last_close > donchian_100_high`), 0.5% ATR/price volatility floor, cold-start proximity filter (don't chase >1 ATR above the breakout), ATR-20 position sizing (`computePositionDollars` with optional regime multiplier), 2×ATR initial stop, a **2.5% aggregate-risk cap** (`wouldExceedAggregateRiskCap`, `turtleAggRiskCapPct`), and a position-count cap.
- **Exit** (`runExits`): Donchian-50 / stop rules per open ledger row.
- **No correlation logic exists today.** Mechanical Go (beats in the Go scheduler when `TURTLE_SCHEDULER_ENABLED=true`; LLM logs empty by design).
- Ledger rows: `DBTrendLedgerEntry` (has `Ticker`, `ATRAtEntry`, `Shares`, `EntryPrice`, `Donchian100HighAtEntry`, …). The exit loop already fetches per-open-row daily bars/signals; the entry loop fetches per-candidate bars — so daily bars for both candidates and open positions are available within a run for the correlation guard (reuse them; do not add a data path).

## 3. The broadened basket (15 ETFs, 6 driver clusters)

All **liquid, unleveraged, non-inverse** (leverage/inverse decay destroys trend systems), and deliberately **non-equity-beta except the intl cluster**.

| Cluster | ETFs | Driver |
|---|---|---|
| `rates` | TLT, IEF, TIP | Treasury duration (long + mid curve) + inflation-linked real rates |
| `metals` | GLD, SLV | Precious metals |
| `energy` | USO, UNG | Oil, natural gas |
| `commodity` | DBC, DBA, DBB | Broad commodity, agriculture, base metals |
| `fx` | UUP, FXE, FXY | US dollar, euro, yen (yen = risk-off ballast) |
| `intl_equity` | EEM, EFA | EM + developed-ex-US (the only equity-beta cluster) |

Notes: the 0.5% vol floor already auto-excludes anything too quiet (e.g. short-duration bonds). UUP vs FXE/FXY are anti-correlated by construction — fine; the cluster cap (§4) keeps at most one FX position and the correlation guard only blocks *positive* correlation. **A per-ETF liquidity + Alpaca-history check at build** must gate the thinner names (UNG, DBB, DBA, FXE, FXY): if an ETF lacks ≥100 daily bars (Donchian-100 needs them) or is too illiquid, it is dropped from the active universe with a logged skip — never failing the whole run.

## 4. Two-layer diversification

**Layer 1 — static cluster cap (primary, always on).** At most **`maxPositionsPerCluster` (=1)** open positions per driver cluster. With 6 clusters → ≤ 6 concurrent positions, one per driver = forced breadth; the strongest-trending ETF wins the cluster's slot. Because the cap is uniform at 1, the `intl_equity` cluster is already held to ≤ 1 position — the tightest possible — satisfying the "cap the equity cluster tightest" intent without a special case.

**Layer 2 — dynamic correlation guard (secondary).** Before placing an entry, compute the **`corrWindow` (=60) trading-day daily-return correlation** between the candidate and each currently-open position; **skip the entry if correlation > `corrThreshold` (=0.7) with any open position**. **Positive correlation only** — the goal is to block *redundant* concentration (two things moving together); a negatively-correlated position is *diversifying* and stays allowed. This catches cross-cluster co-trending the static clusters miss (e.g. EEM + DBC in a commodity-driven EM rally). Returns are computed from the daily bars already fetched for Donchian-100/ATR-20 (the 100-bar window ⊇ 60 returns); if a candidate or open position has < `corrWindow`+1 bars, treat as "cannot assess → allow" (the static cap + agg-risk cap still bound it) and log.

## 5. Kept unchanged (per the pivot)

Donchian-100 entry / Donchian-50 exit / ATR-20 sizing / 2×ATR initial stop / 2.5% aggregate-risk cap / position-count cap / cold-start proximity filter / 0.5% volatility floor / optional regime sizing multiplier / the Go scheduler and beat cadence.

## 6. Implementation shape (Go — for the build effort)

- **Centralize the universe** as one cluster-annotated source of truth, e.g. `type TrendInstrument struct { Ticker, Cluster string }` and `var TrendUniverse = []TrendInstrument{…}` in `controllers/trend_controller.go`; delete the `services.turtleUniverse` copy and reference the centralized list (a `[]string` tickers helper + a `ClusterOf(ticker)` lookup keep call sites simple). This removes the drift risk and gives each candidate its cluster for free. `inTrendUniverse` validates off the centralized list.
- **Two new pure gate functions** beside `wouldExceedAggregateRiskCap`:
  - `clusterSlotTaken(openRows, candidateCluster, max) bool` — counts open rows whose ticker's cluster == candidate's; true if ≥ max.
  - `tooCorrelated(candidateReturns []float64, openReturnsByTicker map[string][]float64, threshold) bool` — true if any pairwise Pearson correlation over the aligned window exceeds threshold (positive). A small `pearson(a, b []float64) (float64, ok bool)` helper (ok=false when n < window).
- **Wire both into the entry loop** in `runEntries`, evaluated **after** the existing gates (vol floor, cold-start, Donchian breakout, aggregate-risk, position-count) so the cheap deterministic checks run first; record a `Skip` with a clear reason when either fires.
- Verify the existing position-count cap is **≥ 6** so the per-cluster caps bind first (raise it if needed; keep the 2.5% aggregate-risk cap).

## 7. Pinned parameters (a-priori, set now)

Pre-registered before any v2 data exists (the honest moment):
- **`maxPositionsPerCluster` = 1** — forces one-position-per-driver breadth, the core ballast property.
- **`corrThreshold` = 0.70 (positive)** — a high bar so the guard only blocks genuinely redundant pairs, letting the static cluster caps do most of the work.
- **`corrWindow` = 60 trading days** — ~3 months, long enough to be stable, short enough to reflect the current regime.
- **Aggregate-risk cap = 2.5%** and the 2×ATR stop, ATR-20, Donchian-100/50 — unchanged.

## 8. Decisions

- **D-T1 — broaden to a fixed 15-ETF, 6-cluster basket** (no SPY/equity-sector beta; intl-equity is the only equity cluster, held to ≤ 1).
- **D-T2 — unleveraged/non-inverse only** (decay kills trend systems); thin names gated by a build-time liquidity/history check, dropped-not-fatal.
- **D-T3 — two-layer diversification** (static cluster cap primary + dynamic positive-correlation guard secondary), reusing already-fetched bars.
- **D-T4 — centralize the universe** as a cluster-annotated single source of truth, removing the controllers/services duplication.
- **D-T5 — keep all existing mechanics + cadence**; this is a diversification broadening, not a parameter tune.
- **D-T6 — validate observe-then-tune on paper**, not a backtest gate (broadening a live mechanical system lowers concentration risk; contrast Coil, whose parameter changes are backtest-gated). A full historical backtest of the broadened basket is an optional later check, not a graduation prerequisite.

## 9. Testing (Go, TDD — for the build)

- `ClusterOf` / centralized universe: every ticker resolves to exactly one cluster; `inTrendUniverse` matches.
- `clusterSlotTaken`: empty open → false; one open in cluster, max 1 → true; open in a *different* cluster → false; max 2 honored.
- `pearson`: known series (perfect +1, perfect −1, ~0); n < window → ok=false.
- `tooCorrelated`: candidate highly +correlated with an open → true; highly **−**correlated → **false** (allowed); uncorrelated → false; insufficient bars → false (allow + log).
- Entry-loop integration (existing mocks, `turtle_executor_test.go` patterns): a second same-cluster breakout is skipped (cluster cap); a cross-cluster but +0.8-correlated breakout is skipped (corr guard); an anti-correlated breakout is allowed; ordering — existing gates still short-circuit first.
- Universe de-duplication: no second hard-coded ticker slice remains (guard test/grep).

## 10. Out of scope

- Scheduler timing / beat cadence, regime-gate internals, any LLM path.
- The Donchian/ATR/stop parameter values themselves (unchanged).
- A full historical backtest harness (optional later; not gating).
- Holiday-gating of the Turtle Go scheduler (tracked separately in the holiday-aware-phase work).
