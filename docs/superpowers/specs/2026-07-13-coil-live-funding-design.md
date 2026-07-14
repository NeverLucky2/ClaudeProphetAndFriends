# Coil → Live Funding: Design Spec

**Date:** 2026-07-13
**Status:** Design — approved, pending spec review
**Scope:** Move Coil (`mean-rev`) from the shared paper sandbox to a dedicated, real-money Alpaca account, staged $5k → $10k.

---

## Motivation

Coil's paper record over 2026-05-20 → 2026-07-13 is 26 closed round-trips: 84.6% win rate,
profit factor 9.9, **+$4,289 realized**, average hold 4.5 days. Only ~$240 of that is
attributable to passive market drift, so the "it was just long a rising market" null is dead.
A friction stress test (baseline vs 2× slippage, per `config/friction.json` /
`config/friction-stress.json`) costs the strategy **$88 across 26 trades — ~2% of gross P&L,
with 0 of 26 trades flipping winner→loser**. Fills are not the constraint.

The operator is funding a real account to trade this mechanically.

## What this record does NOT establish

Recorded here because the design deliberately accepts these risks rather than mitigating them.

1. **Sample is 26 trades in one regime.** Seven weeks of a grinding-up tape, which is the regime
   RSI(2) dip-buying is built for. This is the least informative evidence available about the risk.
2. **The left tail is entirely unsampled.** There has never been a losing stop-out. The single
   `STOPPED_OUT` position (COST) closed *positive* on a trailing stop. The −7% stop path has never
   been exercised in anger.
3. **The payoff shape is short-volatility** — many small wins, tiny losses, one fat winner. This
   shape persists until it doesn't.
4. **The paper deployment level is an artifact and will not carry over.** See "The capacity trap".

## The capacity trap (the central finding)

`TRADING_RULES_MEANREV.md:201` lets Coil deploy until **total account deployment reaches 85%**,
where "total" means *all strategies combined*. Line 208 states the rationale: all five agents share
one Alpaca account, so Coil opportunistically borrows capital that Prophet/Turtle/Drift leave idle,
and the 15% buffer is *"reserved for strategies that beat after Coil (Turtle/Drift at 17:00 ET)."*

**In a Coil-only account every one of those premises is false.** There are no other strategies, so
`total_deployed_pct` *is* Coil's own deployment — and an 85% ceiling designed as a *shared-account
courtesy limit* silently becomes Coil's personal license to run 85% long.

Worse, line 208 says capacity expansion is *"most relevant in broad selloffs, when many names hit
RSI(2) < 5 at once."* So the rule, as written, makes Coil **go maximally long in correlated
large-cap longs precisely when the market is falling**, adding fresh capital on each leg down
because each leg down prints more oversold names.

Coil's observed ~12% average paper deployment was caused by (a) four other agents consuming the
shared account's capital and (b) a calm tape. **Both disappear in a dedicated account.** The paper
record therefore does not characterize the risk of the live configuration.

The bear-regime gate does not cover this: it keys off SPY closing below its **200-day SMA**, a slow
signal. A fast 10% drawdown does not break the 200-SMA for weeks, so Coil would max-deploy through
the entire first leg down before the gate engaged.

### Decision

The operator **elects to keep the 85% ceiling** and sample this tail live, at bounded size. Rationale:
the max-long-into-a-selloff scenario is the exact unsampled tail, and a $5k stage behind a −15% halt
is the cheapest available way to observe it (bounded worst case ≈ −$750, ≈ −$1,200 with gap
overshoot). This is an informed risk acceptance, not an oversight.

The rule is **rewritten, not re-numbered**: same 85%, honest provenance. The false "buffer reserved
for Turtle/Drift" rationale is removed and replaced with an explicit statement that Coil may deploy
to 85% of its own equity, accepting max-long-into-selloff behavior as a deliberate sampling choice.

---

## Design

### 1. Account & wiring

- New **Alpaca live account**; credentials added to `data/accounts-secrets.json` (already keyed by
  `accountId` — no schema change).
- New sandbox `sbx_mean_rev_live`, `activeAgentId: 'mean-rev'`, `paper: false` →
  `baseUrl: https://api.alpaca.markets`.
- **Margin account, zero leverage.** Margin exists *solely* for T+1 settlement relief: Coil rotates
  capital every ~4.5 days, and in a cash account reusing unsettled proceeds triggers good-faith
  violations (3 in 12 months → 90-day restriction). Coil never borrows. Since Coil holds ~4.5 days
  it never day-trades, so the sub-$25k PDT rule does not bind.
- Existing multi-account plumbing already supports this (`config-store.js:949`,
  `orchestrator.js:184`). No structural work required.
- **Paper `sbx_mean_rev` is retired.** It is currently flat (0 open positions), so shutdown strands
  nothing. It is not kept as a control: live Coil runs different rules, so it could only have
  isolated fill quality, which the friction test already showed is worth ~2% of P&L.
- **The operator stops hand-mirroring Coil in Merrill.** Running both would take the same signal
  twice with real money, doubling exposure and making both books unmeasurable. Open Merrill mirror
  positions get a deliberate exit decision under the existing rule (judgment on winners, mechanics
  on losers; discretion never overrides a stop).

### 2. BLOCKING PREREQUISITE — make the paper flag real

**This ships before a single dollar is funded.**

`ALPACA_PAPER` is currently decorative. `config/config.go:127` reads it into `cfg.AlpacaPaper`,
`cmd/bot/main.go:64` passes it to `NewAlpacaTradingService`, and `services/alpaca_trading.go:91`
accepts it as `isPaper` — **then never stores or uses it.** It is not a struct field. The Alpaca
client is constructed from `baseURL` alone.

Consequently **only `ALPACA_BASE_URL` decides real-money vs paper**, and `config-store.js:972`
permits an explicit `baseUrl` to diverge from the `paper` boolean with no consistency check. A
misconfiguration would trade **real money while every log line and UI badge reported "paper"** — a
false-comfort failure.

Fix (fails closed):
- `NewAlpacaTradingService` asserts `isPaper` is consistent with `baseURL`; on mismatch it returns
  an error and **refuses to start** rather than trading.
- `config-store` rejects any account whose `baseUrl` contradicts its `paper` flag.
- Startup logs the resolved mode loudly, derived from the **URL**, not the flag.

Today this bug is inert because every account is paper. It becomes live-fire on day one of this
project.

### 3. Rules changes

Live Coil gets its own **strategy entry** (`mean-rev-rsi2-live`) with
`rulesFile: TRADING_RULES_MEANREV_LIVE.md`, following the existing pattern in
`config-store.js:380`. The paper `TRADING_RULES_MEANREV.md` is not modified, so the retired paper
sandbox and any future paper work are unaffected.

*(Note: `config-store.js:383` currently describes `mean-rev-rsi2` as "5% per position" while
`TRADING_RULES_MEANREV.md:183` says 6%. The rules file is authoritative and the description is
stale. Fix the description in passing; do not let the live variant inherit the discrepancy.)*

| Rule | Paper (current) | Live |
|---|---|---|
| Per position | 6% | **12%** |
| Max concurrent | 14 | **7** (85% ÷ 12%) |
| Total deploy ceiling | 85% (shared-account artifact) | **85%** — restated as a deliberate own-account choice |
| Bear mode (`MEANREV_BEAR_MODE`) | `halfsize` | **`halt`** |
| Daily circuit breaker | −2% segment P&L, resets daily | unchanged |
| Hard stop | −7% at broker | unchanged |
| Time stop | 5 trading days | unchanged |
| Entry | RSI(2)<5 AND close>200-SMA AND no earnings ≤5d | unchanged |

Sizing rationale: at a −7% stop, a 12% position risks ~0.85% of the account per trade — inside the
normal 0.5–2% band. `bear_mode: halt` is a free tightening: it never fires in a calm tape and is the
only rail that addresses the sustained-bear case the strategy is known to degrade in.

**Margin guard:** deployment is computed as `(portfolio_value − cash) / portfolio_value`, which caps
naturally at 100% of equity. The rules assert Coil never borrows.

**Known gap (accepted, not fixed in v1):** the −2% circuit breaker resets daily, so a multi-day
slide grants Coil a fresh −2% of entry capacity each morning. A rolling 5-day variant was considered
and **deliberately deferred** — it is the rail most likely to misfire, and the −15% halt plus the $5k
stage already bound the dollar loss.

### 4. Rails & operations

- **−15% high-water halt.** Blocks new entries; open positions continue to be managed and exited.
  Requires manual re-arm. This is the backstop that bounds the tail being sampled.

  **This must be CODE-ENFORCED, not rules-prose.** Every existing Coil cap (6%/name, 14 positions,
  85% deploy) is prose in a markdown file that the LLM is trusted to self-police. That is acceptable
  on paper. It is not acceptable as the sole backstop on the one rail that bounds real-money loss —
  an agent that misreads its own halt condition is precisely the failure this rail exists to catch.
  The halt is enforced in Go, at the order-placement seam, where it cannot be reasoned around.
  Tracking high-water portfolio value and refusing entry orders below the threshold is new work;
  it is a hard prerequisite for funding, alongside §2.
- **Stuck-exit / failed-close detection.** The operator's primary objection to Alpaca, and the one
  risk that is actually engineerable. Daily reconciliation of bot DB against live broker state
  (prior art in `data/reconciliation/`), alerting on any mismatch. **The broker is truth; the bot DB
  is not.**
- **Measurement.** The Foundation B segment-P&L / trade-ledger layer is built but its data clock
  requires the Go rebuild. The rebuild is already required for the live account, so live Coil is
  graded from trade one.

### 5. Ramp & success criteria

- **Fund $5k.** At 12%/name this yields ~$600 positions — the exact notional the 26-trade record was
  generated at, with half the dollars exposed and $5k held outside the broker entirely.
- **Scale to $10k** when Coil reaches ~50 total trades **or** survives a genuine drawdown, whichever
  comes first.
- **Bounded worst case on the stage:** ≈ −$750, ≈ −$1,200 with gap overshoot.
- **Success is not "it made money."** In this regime it is *expected* to make money. Success is:
  the live trade ledger shows positive expectancy on its own (long-term holds excluded), the
  stuck-exit path is proven to work, and the drawdown behavior is finally *observed* rather than
  assumed.

---

## Open risks accepted

| Risk | Status |
|---|---|
| 26-trade sample, one regime | Accepted — bounded by $5k stage |
| Max-long-into-selloff at 85% deploy | **Accepted deliberately** — this is the tail being sampled |
| −2% breaker resets daily | Accepted — deferred to v2 |
| Bear gate keys off slow 200-SMA | Accepted — mitigated by `halt` mode, not eliminated |
| Live Alpaca path never exercised | Mitigated by the fail-closed paper-flag fix + reconciliation |
