# Trade-Log ↔ Broker Reconciliation — design

**Date:** 2026-05-26
**Status:** Approved (design); pending implementation plan
**Scope:** A once-daily (after market close) job that compares each sandbox's
trade-history log against the broker's actual orders for the day, classifies
discrepancies into three buckets, writes a per-sandbox report, and surfaces a
day-level "possible mismatches" banner in the dashboard Trades tab.

## Problem

The submission-time failed-trade indicator
(`2026-05-26-failed-trade-indicator-design.md`) flags orders that error or are
rejected *at the moment the tool returns*. It cannot catch what happens after:
an order the harness recorded as `success` that never actually reached the
broker (the agent "thinks" it traded but nothing did), an order the harness
recorded as `failed` that the broker actually accepted/filled (a position you
believe doesn't exist), or an order accepted-then-rejected/canceled by the
broker. The broker is the source of truth for what really happened; the trade
log is only a record of what the agent attempted.

A periodic reconciliation against the broker closes that gap. The operator
asked for a once-or-twice-daily check (chosen cadence: **once, after close**)
that flags mismatches — surfaced in the Trades tab, where the operator already
looks.

## Goals

- Once per ET trading day (after close), per sandbox, compare the day's logged
  trades against the broker's orders and classify discrepancies into:
  1. **Phantom success** — logged `success`, but no matching accepted broker order.
  2. **False failure** — logged `failed`, but a matching broker order was accepted/filled.
  3. **Status divergence** — logged `success`, but the matching broker order shows
     rejected / canceled / expired.
- Write a per-sandbox report (`data/reconciliation/<sandboxId>/YYYY-MM-DD.json`
  plus a human `.md`).
- Surface a dismissible day-level banner at the top of the Trades feed when the
  current ET day has > 0 mismatches; silent when clean.
- Soft-fail everywhere; never produce a *wrong* banner (a fetch/attribution
  failure yields no banner, not a false one).

## Non-goals

- **No orphan-broker-order detection.** "Broker order with no logged trade" is
  out of scope (it is mostly legitimate — bracket child orders, the options
  auto-stop monitor, the Turtle Go scheduler place orders outside the LLM log,
  and the silent-fill summary already surfaces broker-side *fills*). All three
  in-scope classes start from "a logged trade exists," so the matcher only walks
  from logged trades to broker orders.
- **No `close_managed_position` reconciliation in v1.** Close-type log rows store
  a `position_id` in the `symbol` field, not a tradable symbol, so they cannot be
  matched to broker orders by symbol. v1 reconciles order *placements* with a
  real symbol (buys/sells/options). Documented limitation.
- **No auto-correction.** The job never edits the trade log or cancels/places
  orders. It reports; the operator reviews. (Mirrors the shared-account spec's
  "log + operator decides, never auto-pause" stance.)
- **No per-card verdicts on the Trades tab.** Because the log carries no broker
  order ID, 1:1 attribution is not always possible; the banner is day-level and
  links to grouped detail rather than stamping individual cards.
- **Not the Go-ledger reconciliation.** `docs/shared-account-backend-spec.md`
  Phase 3 reconciles the Go *DB ledger* vs broker. This feature reconciles the
  Node *NDJSON trade log* vs broker. Different artifact, different home (Node).

## Architecture

Everything lives in Node, where the trade log is owned and the broker-fetch
pattern already exists (`agent/fills-summary.js`). A pure matcher, a scheduler
job that does the I/O, a report writer, a read API, and the Trades-tab banner.

```
readTrades(PROJECT_ROOT,{from,to,sandboxId})  ─┐   [agent/trades-store.js, existing]
                                               ├─▶ reconcileTrades(logged, broker)  [pure, new]
goAxios GET /api/v1/orders?status=all  ────────┘            │ { mismatches, counts }
   (equity + options, status + strategy tag)                │
                                                writeReconciliationReport(...)  [fs, new]
                                                  data/reconciliation/<sandboxId>/<ymd>.json + .md
                                                            │
   analysis-scheduler.js  ── trade_reconciliation job (after close, idempotent/day)
                                                            │
   GET /api/reconciliation?date=&sandboxId=  ──▶ reads report JSON  [agent/server.js, new route]
                                                            │
   Trades tab onload ──▶ fetch summary ──▶ day-level banner when count>0  [index.html]
```

## Components

### 1. `reconcileTrades(loggedTrades, brokerOrders)` — pure matcher

New module `agent/trade-reconciliation.js`, exported for unit testing. No I/O.

**Inputs (already normalized by the caller):**
- `loggedTrades`: order-placement rows for one sandbox/day — `{ symbol, side,
  quantity, price, status, timestamp }`. Close-type rows and rows without a real
  symbol are filtered out by the caller (v1 non-goal).
- `brokerOrders`: `{ id, symbol, side, status, filledQty, submittedAt }` for the
  same sandbox's strategy (caller pre-filters by strategy tag and ET day).

**Algorithm:** group both sides by `(symbol, side)`. Side normalization: logged
`buy`/`sell` map to broker `buy`/`sell`. Within each group, an order is
"accepted by the broker" when its status ∈ {`filled`, `partially_filled`,
`accepted`, `new`, `pending_new`, `done_for_day`}; "rejected" when status ∈
{`rejected`, `canceled`, `cancelled`, `expired`}. Then per group:
- logged-`success` count > broker-accepted count, and broker has rejected orders
  → **status divergence** (the success rows whose order didn't take).
- logged-`success` count > 0 and broker has **no** matching order at all →
  **phantom success**.
- logged-`failed` count > 0 and broker-accepted count > 0 → **false failure**.
- otherwise → matched/OK.

Reporting is **group-level** when counts are ambiguous (e.g. "QQQ buy: 3 logged
success, broker 1 filled + 2 rejected → 2 status-divergences"), per-trade when a
group is unambiguous (1 logged ↔ 1 order). Each mismatch carries `class`,
`symbol`, `side`, the contributing logged rows, and the contributing broker
orders, so the report shows the evidence rather than a bare verdict.

**Output:** `{ mismatches: [ {class, symbol, side, loggedTrades:[…], brokerOrders:[…], note} ], counts: { phantomSuccess, falseFailure, statusDivergence, matched, total } }`.

### 2. Scheduler job — `trade_reconciliation`

Added to `agent/analysis-scheduler.js` alongside the existing daily jobs (same
`triggerJob` + `_checkSchedule` time-gating + per-ET-day idempotency). Runs once
after close (≈4:45 PM ET, after fills settle). For each sandbox with a
**resolvable, non-empty `strategyId`**:
1. Resolve the strategy tag (`resolvedAgent.strategyId`).
2. `readTrades` for the ET day filtered to that `sandboxId`; keep order
   placements with a real symbol.
3. Fetch broker orders via `goAxios` `GET /api/v1/orders?status=all`; keep those
   whose parsed `Strategy` equals the sandbox's tag and whose `SubmittedAt` is on
   the ET day.
4. `reconcileTrades(...)`; `writeReconciliationReport(...)`.

Untagged agents (empty `strategyId`) are skipped with a logged note — their
orders carry no tag, so attribution would be ambiguous when more than one
untagged agent shares the account. Soft-fail per sandbox: one sandbox's fetch
error never aborts the others, and a failure writes no report (so the banner
stays silent rather than wrong).

### 3. Report writer — `writeReconciliationReport(...)`

In the reconciliation module (fs injected for tests). Writes
`data/reconciliation/<sandboxId>/<ymd>.json` (machine-readable: date, sandboxId,
agentName, strategy, generatedAt, counts, mismatches) and a `<ymd>.md` human
summary. `utf-8` encoding (reports may carry symbols).

### 4. Read API — `GET /api/reconciliation?date=&sandboxId=`

New route in `agent/server.js`. Reads the report JSON for the date (one sandbox,
or aggregates across sandboxes when `sandboxId` is omitted) and returns
`{ date, mismatchCount, items: [...] }`. Returns `{ mismatchCount: 0, items: [] }`
when no report exists (silent-when-clean). Validates `date` as `YYYY-MM-DD`.

### 5. Trades-tab banner (`agent/public/index.html`)

On Trades-tab load (next to `seedTodayTrades`), fetch today's reconciliation
summary. When `mismatchCount > 0`, render a dismissible banner above
`#trades-feed`: "⚠ N possible broker mismatch(es) on <date> — details", expandable
to the grouped items (class, symbol/side, logged vs broker counts). Zero
mismatches → no banner. The banner is informational and never alters trade cards.

## Data flow & matching example

This morning's QQQ retries illustrate the value: the log has three
`QQQ260717C00730000` buys recorded `success`. If the broker shows one filled and
two rejected, reconciliation reports "QQQ buy — 3 logged success / broker 1
filled + 2 rejected → 2 status-divergences," and the banner reads "2 possible
broker mismatches today." No guess about *which* of the three log rows is the
real fill — the group-level report shows the operator the evidence.

## Error handling

- Soft-fail throughout (job, fetch, parse, write). Any failure logs and leaves
  no report for that sandbox/day → banner silent, not false.
- Attribution: only sandboxes with a resolvable non-empty `strategyId` are
  reconciled; others are skipped with a logged note.
- Idempotent per ET day; a retry overwrites the day's report.

## Testing

- **Unit — `reconcileTrades`** (pure, `node:test`): phantom success; false
  failure; status divergence; clean/all-matched; the ambiguous 3-logged-vs-2-broker
  group; empty inputs (no throw, zero counts); side/symbol grouping correctness;
  partial_filled and accepted treated as "accepted."
- **Unit — `writeReconciliationReport`** with injected `fs`: correct path, JSON
  shape, and that a clean day still writes a zero-count report (so the API can
  distinguish "clean" from "not yet run").
- **Unit — API route** (or a thin handler test): returns aggregated count;
  `YYYY-MM-DD` validation; missing report → zero.
- **Manual** — Trades-tab banner rendered via a synthetic report file (no jsdom;
  consistent with the failed-trade-indicator feature): confirm banner appears
  with count > 0, expands to items, and is absent at count 0.

## Implementation notes (resolved, not open)

- **Broker data source:** reuse `GET /api/v1/orders?status=all`
  (`HandleGetOrders` → `ListOrders(ctx,"all")`, `Limit 500`). Returns equity +
  options orders (OCC symbol in `symbol`) with `status`, `filledQty`,
  `submittedAt`, and `strategy` parsed from `client_order_id`. No Go change
  anticipated; the 500-order recent window comfortably covers one sandbox-day. If
  it ever proves insufficient, a thin Go `after=` param is the fallback.
- **Strategy attribution:** `agentConfig.strategyId` (the value the harness puts
  in `OPENPROPHET_STRATEGY`, encoded as `"{strategy}:{uuid}"` in
  `client_order_id`). Reconcile within tag.
- **Config flag:** a single env/config toggle gates the job
  (default ON), matching the project's feature-flag convention.

## Files

- Create: `agent/trade-reconciliation.js` (pure matcher + report writer),
  `agent/trade-reconciliation.test.mjs`.
- Modify: `agent/analysis-scheduler.js` (register `trade_reconciliation` job +
  schedule gate), `agent/server.js` (read route), `agent/public/index.html`
  (banner).
- No changes to `agent/trades-store.js` or the Go backend (anticipated).
