# Coil dynamic capital borrow — design

**Date:** 2026-07-08
**Status:** approved (operator), pending implementation
**Type:** rules-prose config change (no code) + non-blocking backtest validation

---

## Goal

Let **Coil** (the daily RSI(2) mean-reversion sleeve) opportunistically use account
capital that the other strategies are leaving idle, instead of being hard-capped at its
static 42% segment lane. Coil fires far more often than the rest of the fleet (roughly
every other day vs. rarely), so on the days it has many valid signals it should be able
to surface a **longer list of fully-managed entries** rather than stopping at 7.

This is a *capital-utilization / mirror-list* decision, deliberately **independent of
recent win rate**. Its value is operational: it gives the operator a bigger set of
screened, lifecycle-managed candidates to mirror by hand in the Merrill account
(see the "Coil screens, I'm PM" operating model).

## Purpose reframe — it's about the list, not the paper capital

The knob the operator chose is **more positions at a fixed 6% each** (not bigger
positions). Rationale: the operator mirrors Coil's trades in a separate real account and
makes the final call himself. More concurrent 6% names = a longer, equal-weighted,
directly-comparable list to choose from — each new name carries the same per-trade risk
as the others (6% × −7% hard stop ≈ 0.42% of portfolio), so the list stays apples-to-apples.

Because the entry filter (RSI(2) < 5) is strict, on a normal day Coil finds only a few
candidates and the extra capacity sits unused. The added room realistically fills **only
in broad selloffs**, when many names hit deep-oversold at once. Known trade-off: that is
exactly when (a) tail-correlation of a mean-rev basket to the operator's tech book is
highest, and (b) the lender most likely to want its capital is Turtle (crisis-alpha
TLT/GLD/UUP breakouts). The design accepts this for the paper phase and guards it with a
buffer, the existing entry brakes, and a validation backtest (below).

## Key facts that make this cheap and safe

1. **One shared Alpaca account.** All five sandboxes point at `accountId 6e4f26af`. The
   "lanes" (Coil 42 / Turtle 30 / Prophet 16 / Drift 12) are *notional prose partitions*
   of a single buying-power pool — not separate accounts. So "borrowing" is not a
   transfer; it is just letting Coil's deployed-% cap flex upward when others are flat.
2. **No per-lender detection needed.** `get_account` (already rendered in Coil's Beat
   Context snapshot as `Portfolio | Cash | Buying Power`) exposes *total* account
   deployment. Capital a lender is holding shows up as not-free; capital an idle lender
   isn't using shows up as free. `total_deployed_pct = (portfolio_value − cash) /
   portfolio_value` therefore already reflects which lanes are flat, in aggregate.
3. **Coil beats at 15:45 ET, before Turtle/Drift (17:00).** The leftover buffer Coil
   leaves is literally what's reserved for whoever wakes after it that day.
4. **Coil's holds are ≤ 5 trading days.** Borrowed capital self-liquidates fast; Coil
   never has to force-close to give capital back.
5. **All caps are LLM-prose.** The Go signal service only ranks candidates by RSI(2)
   ascending — it enforces no count / deployed-% / sizing. Editing
   `TRADING_RULES_MEANREV.md` **is** the entire deploy (no Go rebuild, no `.env`, no
   restart) — same as the 2026-06-24 42% bump (commit `f27b041`).

## The narrow isolation exception (a deliberate reversal)

The current rules make Coil intentionally blind to the rest of the fleet:
- L31 (You do not): "Look at Prophet or Turtle positions when making decisions"
- L208 (operator note): "Coil does not coordinate capital with other agents at runtime"
- L369 (What You Do Not Do): "No coordination with Prophet or Turtle"

This design relaxes that **narrowly**: Coil may read **one aggregate number** (total
account deployment) to size its own capacity. It still never inspects which symbols other
strategies hold, or why. Its actual entries remain 100% RSI(2)-driven — same names, same
most-oversold-first order — so mechanical purity and Foundation-B per-segment measurement
are unaffected. **Only the capacity cap becomes dynamic.**

## Agreed parameters

| Knob | Was | New |
|---|---|---|
| Max open Coil positions | 7 | **14** (≈ 85% ÷ 6%; also an arithmetic-error backstop) |
| Deployment cap | Coil segment ≤ 42% | **Total account deployment ≤ 85%** |
| Per-position size | 6% equal-weight | **6% (unchanged)**; 3% in bear-halfsize; × regime multiplier |
| Buffer left for later-beating strategies | n/a | **~15%** of portfolio (always) |

Base entitlement is unchanged: Coil holds its ~42% (7 × 6%) as of right and expands
toward 14 / 85% only when other strategies leave account capital idle.

## Behavior across regimes and brakes

Expansion is **on in all regimes** (operator's choice; fits the paper-phase
"more risk now, backstops not throttles" stance). It is not a free-for-all — every
existing entry gate still fires *before* any expansion:

- Coil-segment **−2% daily circuit breaker** (halts new entries) — unchanged.
- **Bear-halt** mode (`MEANREV_BEAR_MODE=halt`) blocks all entries — unchanged.
- **Bear-halfsize** (default) shrinks positions to 3%, so the 14-count cap yields at
  most ~42% deployed — the count binds, not the 85% ceiling.
- **Regime-gate RED** block (currently `ENABLE_REGIME_GATE=false`, so inert) — unchanged.
- **Econ blackout** skips entries — unchanged.

So in a genuine crash the circuit breaker / bear-halt short-circuit expansion regardless
of free capital. (A bull-regime-only gate was considered and rejected in favor of
all-regimes; revisit if the validation backtest shows a bad tail.)

## Exact edits — `TRADING_RULES_MEANREV.md`

| Line | Current | New |
|---|---|---|
| 3 | `**Updated:** 2026-06-24` | `**Updated:** 2026-07-08` |
| 31 | `- Look at Prophet or Turtle positions when making decisions` | `- Look at Prophet or Turtle *positions or theses* when making entry/exit decisions (you MAY read the single aggregate total-account-deployment number to size your own capacity — see Risk Management — but you never inspect which symbols other strategies hold or why)` |
| 196 | `Maximum 7 open Coil positions simultaneously` | `Maximum 14 open Coil positions simultaneously` |
| 197 | `6% per position × 7 positions = 42% theoretical max; the 42% segment lane below now equals this binding cap …` | `6% per position × up to 14 positions ≈ 85% theoretical max. The binding cap is no longer a fixed Coil segment lane — it is **total account deployment ≤ 85%** (dynamic-capacity rule below). Coil holds its base 7 (~42%) as of right and expands toward 14 only when other strategies leave account capital idle.` |
| 199 | `Maximum 6% of portfolio per single Coil position (hard cap …)` | **unchanged** (per-position size stays 6%) |
| 201–202 | `Maximum 42% of portfolio deployed in Coil positions …` / `Position notional × count cannot exceed this. If a new entry would breach, skip and log.` | `**Dynamic capacity:** Coil may deploy until **total account deployment reaches 85%** of portfolio_value (all strategies combined, not just Coil).` / `Compute total_deployed_pct = (portfolio_value − cash) / portfolio_value × 100 from the Beat Context account snapshot (Portfolio / Cash line; fall back to get_account). If adding this entry's 6% would push total_deployed_pct above 85%, skip and log. The ~15% buffer is reserved for strategies that beat after Coil (Turtle/Drift at 17:00 ET).` |
| 208 | operator note (static 42% lane paragraph) | Rewrite → dynamic model (text below) |
| 221 | halfsize note: `… max ~21% deployed` | `… With the 14-position cap this is up to ~42% deployed.` |
| 277 | `Read `deployed_percent` from the same response. If ≥ 40.0, skip Step 3 (entries).` | `Compute total account deployment from the Beat Context snapshot: total_deployed_pct = (portfolio_value − cash) / portfolio_value × 100. If ≥ 85.0, skip Step 3 (entries). This is TOTAL account deployment across all strategies — not the Coil-segment `deployed_percent` — so Coil expands only into capital other strategies leave idle. (Step 1.4 still reads get_segment_pnl for the −2% circuit breaker.)` |
| 301 | `coil_open_position_count ≥ 7` | `coil_open_position_count ≥ 14` |
| 302 | `coil_deployed_pct ≥ 42.0` | `total_deployed_pct ≥ 85.0 (total account, per Step 1.5)` |
| 312 | `Skip if total open Coil positions would exceed 7 after this entry` | `Skip if total open Coil positions would exceed 14 after this entry` |
| 313 | `Skip if total Coil deployed % would exceed 42% after this entry` | `Skip if **total account deployment** would exceed 85% after adding this entry's 6% (track your own just-placed entries within the beat: effective total = snapshot total + 6% × entries placed this beat)` |
| 329 | `Stop after the first 7 entries — even if more candidates qualify, the position cap binds.` | `Stop once 14 positions are open, or once adding another 6% would cross 85% total account deployment — whichever binds first — even if more candidates qualify.` |
| 350 | `Total open Coil positions < 7?` | `Total open Coil positions < 14?` |
| 351 | `Total Coil-deployed capital < 42%?` | `Total account deployment < 85%?` |
| 369 | `No coordination with Prophet or Turtle (segment caps are enforced per-strategy)` | `No coordination with Prophet or Turtle on signals or theses. The only cross-strategy input is the aggregate total-account-deployment number used to size Coil's own capacity (see Risk Management); Coil never reacts to which symbols other strategies hold.` |

### New line 208 operator note

> **Cross-strategy coordination — operator note:** Coil's capital model is now *dynamic*
> (2026-07-08). Its base entitlement is still ~42% (7 × 6%) — its lane in the reconciled
> 100% model: V2 (16%), COIL (42%), TREND (30%), DRIFT (12%). But because all strategies
> share one Alpaca account, Coil may **opportunistically use idle capital** left by
> strategies that are currently flat: it adds 6% names until *total* account deployment
> reaches 85%, up to 14 positions. This surfaces a longer list of fully-managed entries
> for the operator to mirror — most relevant in broad selloffs, when many names hit
> RSI(2) < 5 at once. Coil never force-closes to return capital: its ≤5-day holds
> self-liquidate, and the ~15% buffer is reserved for strategies that beat after it
> (Turtle/Drift at 17:00 ET). Coil reads only the aggregate deployment number — it does
> not inspect or react to other strategies' specific positions.

## Validation — non-blocking max-positions sweep

Raising the count does not change *which* trades Coil takes (still RSI(2) < 5, ranked
most-oversold-first) — only how many concurrent slots it can hold. The real concern is
**drawdown-clustering / tail-correlation**: 14 mean-rev names concurrently is precisely
the broad-selloff concentration scenario.

**Plan:** reuse the existing Coil backtest harness (behind the RSI-threshold `08a17a3`,
exit-timeout `5916d29`, stop-tighten `0c0d455`, and June-24 max-pos `6e6e3e5` studies).
Extend the sweep to **7 vs 10 vs 14** on the holdout. Report net/trade, maxDD, and a
drawdown-clustering read plus tail-correlation to a tech proxy (QQQ) in the high-concurrency
scenario. Runs **in parallel** with the deploy (paper money, ceiling-only change). If 14
materially worsens the tail vs 7, dial the count cap back. This is the disciplined nod to
the fleet rule that Coil changes are backtest-gated; because it's a ceiling (not a signal)
change on paper, we deploy now rather than block on it.

## Measurement note (Foundation B)

When Coil borrows and a later-beating strategy is starved of buying power, that strategy
can "miss" a signal on *capital* rather than *signal*. With the ~15% buffer plus those
strategies rarely firing, this is minor — but Foundation-B per-segment attribution should
treat a capital-starved miss as distinct from a signal miss. Monitor via the segment
ledger; no code action now.

## Out of scope

- Go code, new endpoints, `.env`, `MAX_DEPLOYED_PCT` (stays 100%), regime gate (stays OFF).
- RSI(2) entry threshold, exit rules, −7% stop, earnings filter, **per-position 6% size** — all unchanged.
- Other strategies borrowing (only Coil expands).
- DefensiveProphet's ballast capital — it sits outside the 100% four-lane model, is not
  borrowable, and arms exactly in the selloffs when Coil would expand.
- Bull-regime-only gating (considered, rejected in favor of all-regimes).

## Closeout

- Update `memory/capital-allocation-reconciled.md`: Coil's cap is now dynamic — base 42%,
  expands to ≤ 85% total / 14 × 6% when other strategies are flat; refresh the `MEMORY.md` hook.
- Optional cosmetic: the Coil strategy `description` in `data/agent-config.json`
  (`"5% per position; max 5 concurrent"`) is stale (pre-dates even the 42% bump) — refresh
  to match, or leave (not load-bearing; Coil reads the `.md`).
- One squashed commit for the rules edits (per workflow preference); backtest artifact separate.
