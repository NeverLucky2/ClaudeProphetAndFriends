# Defensive Prophet — Triggered QQQ Put-Spread Hedge

> **Execution model:** This strategy is executed **entirely by a deterministic Go
> scheduler** (enabled via `ENABLE_PROPHET_DEFENSIVE=true`), exactly like the
> Turtle/TrendProphet Go scheduler. **The LLM agent takes NO actions** — its
> preflight skips every beat. This document is the human-readable spec of what
> the scheduler does; it is not a procedure for the LLM to follow.
>
> Full design + decisions: `docs/superpowers/specs/2026-06-01-defensive-prophet-design.md`.

## Purpose

A flag-gated, defined-risk **QQQ put-debit-spread** hedge — uncorrelated ballast
against a concentrated mega-cap-tech book. Graded on **tail contribution** (P&L
conditional on a QQQ drawdown) via Foundation B's BALLAST track, **not** standalone
P&L. The edge is *defense-timing* (when to buy protection), not directional alpha.

## Universe

**QQQ only.** Defined-risk put debit spreads (long higher-strike put, short
lower-strike put; max loss = net debit).

## Arm / disarm (mechanical trigger)

- Reuses the existing daily regime signal (`data/reports/regime_gate.json`, 0–100,
  low = bad regime) — the *inverse* of Turtle's gate.
- **Arm** (open new spreads) when regime `Score < 50` **and** the tier is valid
  (`Tier != UNKNOWN`) **and** not stale. A missing/stale regime file never arms
  (fail-safe — a missing file reads Score 0, which must not arm on blind data).
  *(Live-money value is pre-registered tighter at `< 35`.)*
- **Disarm** (`Score ≥ 50`): stop opening new spreads; open spreads keep running
  their own management rules.

## Structure (v1, fixed)

- Long put **~5% OTM**, short put **~15% OTM**, nearest monthly in **45–60 DTE**.
- Tail-targeted: convex payoff across a 5–15% correction; **caps at the 15% level**
  (a capped *correction* hedge, not deep-tail insurance — a deliberate cheap-carry
  choice; deep-tail convexity is a deferred long-vol sleeve).
- Placed as a **marketable limit** (mid + a width-buffer, capped at intrinsic) so it
  fills in a fast move; combos are **atomic** (fill whole or not at all).

## Sizing (paper phase)

- Net debit **≤ 1% of account per spread**, **max 3 concurrent** (≤ ~3% at risk).
  *(Live-money: 0.5% / max 2.)*
- If one contract exceeds the cap, the beat records an explicit "armed but
  unaffordable" skip — never a silent no-op.

## Lifecycle (per open spread, each daily beat)

| Condition | Action |
|---|---|
| current value ≥ ~60% of max payoff | **harvest** (bank the spike) |
| short leg ITM near expiry (DTE ≤ ~7 & QQQ ≤ short strike) | **close** (assignment defense) |
| DTE ≤ ~21 **and** armed | **roll** (close + reopen) |
| DTE ≤ ~21 **and** disarmed | **let expire** |
| else | hold |

Max loss is the net debit (defined by construction); no separate catastrophe stop.

## Cadence & safety

- Daily beat at **17:00 ET** on trading days (holiday-gated).
- Routed through the options through-guard (spread/liquidity gate) under the
  `prophet-defensive` agent.
- **Additive only** — does not touch the discretionary long-call Prophet ("Prophet-toy").
- Flag-gated `ENABLE_PROPHET_DEFENSIVE`, **default OFF**; the scheduler only runs in
  the defensive-prophet sandbox's bot when the flag is set.

## Measurement

Daily mark-to-market `DBSegmentPnL` rows under strategy `prophet-defensive` feed
Foundation B's ballast grading (realized P&L on close; synthetic stress-payoff for
calm quarters). Full grading consumption accrues over ~a quarter.
