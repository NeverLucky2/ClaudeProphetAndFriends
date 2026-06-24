# Coil ↑ / Prophet ↓ capital reallocation — design

**Date:** 2026-06-24
**Status:** approved (operator), pending implementation
**Type:** rules-prose config change (no code) + hybrid backtest validation

---

## Goal

Shift capital toward **Coil** (the mean-reversion sleeve the operator runs daily, and
the fleet's best risk-adjusted edge) and away from **Prophet** (the discretionary
options sleeve the operator rarely runs because of per-day token cost). Make the
increase *real* — i.e. raise the constraint that actually binds Coil's deployment, not
just the cosmetic lane number.

Operator's stated targets: **Coil max 7 positions** and **≥ 40% of portfolio** deployable
to Coil, "so I can test the strategy with more capital." Prophet "can have even less."

## Key insight (why this is more than a one-number edit)

Coil's deployment is **not** bound by its 24% lane. It is bound by
`max 4 positions × 5%/position = 20%` — already *below* the lane. So raising the lane
alone deploys nothing. The binding cap must move too. Reconciling the operator's two
targets (max 7 positions, ≥ 40%) forces per-position size up:

- `7 × 5% = 35%` → misses the 40% floor.
- `7 × 6% = 42%` → clears 40%, and makes **binding cap == lane** (no cosmetic gap).

So per-position size goes **5% → 6%**. This is the *only* genuine risk knob that moves;
everything else is a ceiling. Per-trade risk stays tiny: `6% × −7% hard stop ≈ 0.42%` of
portfolio max loss per trade.

## Agreed allocation

| Sleeve | Lane (was → new) | Binding cap (was → new) |
|---|---|---|
| **Coil** (mean-rev) | 24% → **42%** | 4 × 5% = 20% → **7 × 6% = 42%** |
| **Prophet** (V2) | 34% → **16%** | 12%/pos (unchanged) |
| Turtle (trend) | 30% (unchanged) | unchanged |
| Drift (PEAD) | 12% (unchanged) | unchanged |

Sum = 16 + 42 + 30 + 12 = **100%** ✓. Prophet absorbs the entire reduction. At 16%
Prophet holds ≈ one full 12% position plus a sliver — acceptable because it rarely runs.

## Enforcement reality (no code change)

The Go backend (`services/meanrev_signal_service.go`) only *ranks* candidates by RSI(2)
ascending; it enforces no position count, deployed %, or sizing. All Coil caps are
**LLM-prose**, applied by the agent reading the rules. Therefore **editing the markdown
is the entire deploy** — no Go rebuild, no `.env` change, no restart. Confirmed against
`meanrev_signal_service.go` / `meanrev_controller.go` (no `0.05` / `0.24` / `0.18` /
position-count constants) and the `capital-allocation-reconciled` memory ("NO lane is
code-enforced … Editing the markdown IS the implementation").

## Exact edits

### `TRADING_RULES_MEANREV.md` (Coil — the bulk)

| Line | Current | New |
|---|---|---|
| 3 | `Updated: 2026-05-19` | `Updated: 2026-06-24` |
| 183 | `portfolio_value × 0.05` (5% equal-weight) | `× 0.06` (6% equal-weight) |
| 186 | Cap at **5%** of portfolio_value | **6%** |
| 196 | Maximum **4** open Coil positions | **7** |
| 197 | `5% × 4 = 20% … 24% lane … binding cap at 20%` | `6% × 7 = 42% … 42% lane (binding cap == lane)` |
| 199 | Maximum **5%** per single position | **6%** |
| 201 | Maximum **24%** deployed | **42%** |
| 208 | operator note: `Coil's 24% cap … V2(34) COIL(24) TREND(30) DRIFT(12)` | `Coil's 42% cap … V2(16) COIL(42) TREND(30) DRIFT(12)` |
| 221 | halfsize: `2.5%/pos, max ~10% deployed` | `3%/pos, max ~21% deployed` |
| 243 | "before the **5%** hard cap clip" | **6%** |
| 277 | deployed gate: `if ≥ 18.0, skip entries` | `if ≥ 40.0` (allows the 7th 6% entry at 36% deployed; still guards below the 42% cap) |
| 301 | `coil_open_position_count ≥ 4` | `≥ 7` |
| 302 | `coil_deployed_pct ≥ 24.0` | `≥ 42.0` |
| 312 | would exceed **4** positions | **7** |
| 313 | would exceed **24%** | **42%** |
| 314 | "then the **5%** hard cap" | **6%** |
| 329 | Stop after the first **4** entries | **7** |
| 350 | Total open Coil positions < **4**? | < **7** |
| 351 | Total Coil-deployed capital < **24%**? | < **42%** |

### `TRADING_RULES_V2.md` (Prophet)

| Line | Current | New |
|---|---|---|
| 77 | Maximum **34%** deployed in V2 | **16%** |
| 79 | `four lanes are V2 (34%), COIL (24%) … V2 is the largest single lane by design …` | `V2 (16%), COIL (42%), TREND (30%), DRIFT (12%) = 100%.` Rewrite the rationale: V2 cut to 16% because the operator runs Coil daily and Prophet rarely (per-day token cost); **Coil is now the largest lane.** |
| 81 | push V2 above **34%** | **16%** |
| 88 | "The **34%** V2 segment cap … advisory" | **16%** |
| 464 | Stay within the **34%** V2 segment lane | **16%** |
| 466 | "V2's own discipline is the **34%** segment lane" | **16%** |

(Line 359 `+34%` is a P&L example — leave unchanged.)

### `TRADING_RULES_TREND.md` & `TRADING_RULES_DRIFT.md`

Four-lane recital only (TREND L275, DRIFT L206):
`V2 (34%), COIL (24%), TREND (30%), DRIFT (12%)` → `V2 (16%), COIL (42%), TREND (30%), DRIFT (12%)`.

## Hybrid validation — Coil max-positions backtest

Raising the *count* does not change *which* trades Coil takes (still RSI(2) < 5, same
entries, ranked most-oversold-first) — it only lets it hold more concurrent slots. The
one real concern is **drawdown-clustering**: Coil's signals cluster in broad selloffs
(many names hit deep-oversold at once), so more slots could raise tail-correlation to
the operator's tech book — cutting against the fleet's "uncorrelated ballast" purpose.

**Plan:** reuse the existing Coil backtest harness (the one behind the RSI-threshold
`08a17a3` / exit-timeout `5916d29` / stop-tighten `0c0d455` studies) and add a
**max-positions sweep: 4 vs 6 vs 7 vs 8** on the holdout. Report net/trade, maxDD, and a
drawdown-clustering / tail read. This runs **in parallel** with the deploy (paper money,
ceiling-only change). If 7 materially worsens the tail vs 4, dial the count back.

This is the disciplined nod to the fleet rule that Coil changes are backtest-gated — but
because it's a ceiling (not a signal) change on paper, we deploy now rather than block on it.

## Out of scope

- Any change to Turtle (30%) or Drift (12%).
- RSI(2) entry threshold, exit rules, stop %, earnings filter — all previously studied = KEEP.
- Go code, `.env`, MAX_DEPLOYED_PCT (stays 100%), regime gate (stays OFF).
- Expressing Coil via options (previously REJECTed).

## Closeout

- Update `memory/capital-allocation-reconciled.md` to the new lanes + Coil binding cap; refresh `MEMORY.md` hook.
- One squashed commit for the rules edits (per workflow preference); backtest artifact separate.
