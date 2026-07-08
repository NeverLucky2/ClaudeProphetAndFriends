# Coil Veto Ledger — Design

**Date:** 2026-07-07
**Status:** Approved design → pending implementation plan

## Purpose

Measure how much money the operator's discretionary **veto** saves or costs over time
when mirroring the Coil (mean-reversion) agent in a real account.

The Coil paper bot stays **100% mechanical** — it takes *every* fire on paper regardless
of whether the operator vetoes it. That makes the bot's realized paper P&L on a vetoed
trade a **free, unbiased counterfactual**: exactly the outcome the operator avoided.

> **Veto value = −(bot's realized P&L on the trade the operator skipped)**
> Bot's paper trade *lost* → the veto **saved** that money.
> Bot's paper trade *won* → the veto **cost** that money.

## Goals

- Capture each veto at the moment it's made (ticker, date, Coil entry reference, reason).
- Later reconcile each veto against the bot's **closed** paper trade to compute saved/lost.
- Produce a scorecard: net $ saved/lost, veto hit-rate, and taken-vs-vetoed comparison.
- Keep the veto **falsifiable** via a tiny fixed reason list — guarding against
  "veto everything scary," the failure mode that quietly kills a mean-reversion edge.

## Non-Goals (YAGNI)

- **No change to the Coil bot.** It keeps taking every fire on paper — that IS the counterfactual.
- **No LLM / agent.** Pure local logging + deterministic reconciliation. Zero token cost —
  explicitly avoiding what got the options agent deprecated.
- **No change to the existing tips store/scorer** (the Influence Ledger). This is a *separate*
  store cloned from that proven pattern.
- Phase 2 reconciliation and the optional UI are deferred until a handful of vetoes exist.

## Architecture (Option B — clone the pattern, isolate the concern)

- **`agent/veto-store.js`** — cloned from `agent/tips-store.js`: JSON-array file, atomic
  tmp-rename writes, in-process write serialization, input validation. Owns
  `data/coil-vetoes/vetoes.json`.
- **`agent/veto-scorer.js`** (Phase 2) — reads unreconciled vetoes, joins to the bot's closed
  Coil paper trades, computes veto value, emits the scorecard.
- **Optional (Phase 3):** render the scorecard in the now-idle options-tips UI panel — reuse of
  display real estate, not data.

**Why a separate store rather than extending `tips.json`:** a *tip* is a positive recommendation
from a source (self/dad/news) scored on "did buying it work"; a *veto* is declining Coil's signal,
scored against the bot's specific paper trade. Different schema, lifecycle, and outcome source.
Merging would force the existing (tested) scorer to branch on record type — destabilizing a
working feature. A separate file is also the truest "non-destructive": zero edits to the existing store.

## Data model — veto record

Operator-supplied at log time:

| Field | Example | Notes |
|---|---|---|
| `id` | `veto_1751889600000_AMAT_a1b2` | `veto_{ts}_{ticker}_{rand}` |
| `date` | `2026-07-07` | ET trading date of the Coil fire |
| `ticker` | `AMAT` | validated, upper-cased |
| `coilEntryRef` | `552.30` | Coil's `last_close` reference (from coil-preview) |
| `reason` | `catalyst_driven` | **one of** `catalyst_driven` \| `market_dislocation`; any other value rejected |
| `notes` | "Meta excess-capacity, semi capex thesis crack" | optional free text |

Reconciliation-filled (Phase 2): `botTradeId`, `botEntryPrice`, `botExitPrice`, `botReturnPct`,
`botExitReason` (`rsi_mean_cross`\|`sma5_cross`\|`time_stop`\|`hard_stop`), `daysHeld`, `reconciledAt`.

Computed: `vetoValuePct` = −`botReturnPct`; `vetoValueUsd` = −`botReturnPct` × assumed notional.

**Sizing:** apply a fixed `ASSUMED_NOTIONAL_PER_TRADE` (config constant) at scoring time rather than
per-record sizing, so the $ figure stays consistent and comparable. Primary metric is **%**; the $ is
the constant-notional projection. An optional per-record `notionalOverride` is allowed but not required.

## The two veto reasons (the discipline guardrail)

1. **`catalyst_driven`** — the drop is a live, stock-specific fundamental event, not just technical
   oversold (the AMAT / Meta-excess-capacity case). The "the mean may be resetting lower" veto.
2. **`market_dislocation`** — the whole market is in a waterfall, so even a clean signal is
   knife-catching into systemic selling.

If a fire matches neither, the operator does **not** get to veto it — they take it. That keeps the
judgment testable. (Validation rejects any other `reason`, mirroring `tips-store`'s source validation.)

## Reconciliation (Phase 2)

- **Counterfactual source:** the bot's **closed** Coil paper trades (Go managed-positions / trades
  records; `data/prophet_trader.db` / `agent/trades-store.js`). Exact accessor is an
  implementation-plan detail.
- **Join key:** `(ticker, entryDate ≈ veto.date)`. Coil's "one open position per ticker, no same-day
  re-entry" rule makes this unambiguous — at most one Coil position per ticker at a time.
- A veto reconciles only once its matching paper trade has **closed** (an exit fired). Unreconciled
  vetoes (position still open, or no matching trade found) are carried forward and flagged.

## Scorecard

- **Headline:** net $ saved (+) / lost (−) = Σ `vetoValueUsd`.
- Σ `vetoValuePct`; count of vetoes.
- **Veto hit-rate:** # justified (bot-loser) vs. # cost-you (bot-winner).
- Breakdown by `reason` — is one reason carrying its weight and the other not?
- **Bonus (optional):** avg return of trades *taken* vs. trades *vetoed* — the real test of whether
  the operator's selection beats the mechanical baseline.

## Phasing

- **Phase 1 (now):** `veto-store.js` + logging + tests. The only piece requiring the operator.
  Start logging immediately (the AMAT veto = entry #1).
- **Phase 2 (after ~5–10 vetoes):** `veto-scorer.js` reconciliation + scorecard. No point building
  until there's data to reconcile.
- **Phase 3 (optional):** surface the scorecard in the idle options-tips panel.

## Testing

- `agent/veto-store.test.mjs` with `node:test`, using a temp-dir project root (mirrors
  `tips-store.test.mjs`). Cover: create/validate (reject bad ticker, reject non-listed reason),
  atomic write, concurrent-write serialization, read-empty-when-missing.
- Side-effecting functions get mock / temp-dir tests before "done" — test the executor, not just the predicate.

## Open questions

- Exact accessor/query for the bot's closed Coil paper trades (deferred to the implementation plan; Phase 2).
