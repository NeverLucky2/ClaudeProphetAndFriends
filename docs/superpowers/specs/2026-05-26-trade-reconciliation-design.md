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
  real symbol (buys/sells/options). **This is an asymmetry with teeth:** the
  feature catches phantom *opens* but is blind to phantom *closes* — a logged
  close that didn't execute leaves a live position the operator believes is flat,
  which is arguably more dangerous than a phantom open. It is scoped out because
  matching closes needs a different mechanism (position-state reconciliation, not
  order matching) — making it the **top future extension**, not a permanent gap.
  The report/banner states the scope explicitly (see §3) so the limitation is
  visible at the point of reading.
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
goAxios GET /orders?status=all&after=<ETdayStart> ─┘        │ { mismatches, counts }
   (equity + options, status + strategy tag; day-scoped)    │
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
`buy`/`sell` map to broker `buy`/`sell`. Each broker order is bucketed by status
into exactly one of three states — **only terminal states drive a mismatch
verdict**, so a still-in-flight order can never produce a confident-but-wrong
flag:

- **took** (terminal-success): `filled`, `partially_filled`, or `done_for_day`
  with `filledQty > 0`.
- **terminal-reject**: `rejected`, `canceled`, `cancelled`, `expired`.
- **unresolved** (non-terminal): `new`, `accepted`, `pending_new`,
  `pending_cancel`, `pending_replace`, `done_for_day` with `filledQty = 0`, or any
  other status. These are **excluded from classification** and only counted in an
  informational `unresolved` tally — never flagged. A logged `failed` sitting
  against an unresolved order is deferred (it may still resolve to a reject,
  which would vindicate the log), not called a false failure.

Then per group, counting only `took` and `terminal-reject` orders:
- logged-`success` count > 0 and the group has **no** `took`/`terminal-reject`
  order at all → **phantom success**.
- logged-`success` count > `took` count, and the group has `terminal-reject`
  orders → **status divergence** (the success rows whose order didn't take).
- logged-`failed` count > 0 and `took` count > 0 → **false failure**.
- otherwise → matched/OK.

Reporting is **group-level** when counts are ambiguous (e.g. "QQQ buy: 3 logged
success, broker 1 filled + 2 rejected → 2 status-divergences"), per-trade when a
group is unambiguous (1 logged ↔ 1 order). Each mismatch carries `class`,
`symbol`, `side`, the contributing logged rows, and the contributing broker
orders, so the report shows the evidence rather than a bare verdict.

`(symbol, side)` grouping is intentional and v1-sufficient: when an agent
legitimately trades the same `(symbol, side)` twice in a day (a morning buy and an
afternoon add), the count arithmetic still flags the correct *number* of
mismatches and the evidence list still surfaces the offending broker orders — it
only loses which-of-the-two precision, it does not mask a mismatch. If grouping
noise shows up in practice, adding a coarse time-bucket to the key is the
refinement; out of scope for v1.

**Output:** `{ mismatches: [ {class, symbol, side, loggedTrades:[…], brokerOrders:[…], note} ], counts: { phantomSuccess, falseFailure, statusDivergence, unresolved, matched, total } }`.

### 2. Scheduler job — `trade_reconciliation`

Added to `agent/analysis-scheduler.js` alongside the existing daily jobs (same
`triggerJob` + `_checkSchedule` time-gating + per-ET-day idempotency). Runs once
after close (≈4:45 PM ET, after fills settle). For each sandbox with a
**resolvable, non-empty `strategyId`**:
1. Resolve the strategy tag (`resolvedAgent.strategyId`).
2. `readTrades` for the ET day filtered to that `sandboxId`; keep order
   placements with a real symbol.
3. Fetch broker orders via `goAxios` `GET /api/v1/orders?status=all&after=<ET-day-start-ISO>`
   (see §Day windowing and the `after` note in Implementation notes). Keep those
   whose parsed `Strategy` equals the sandbox's tag and whose `SubmittedAt`
   converts to the ET day. **Coverage guard:** if the fetch returns ≥ the server
   limit (500) *and* the oldest returned `SubmittedAt` is after the ET-day start,
   the window did not cover the whole day — declare incomplete coverage, write no
   report for that sandbox/day, and log. (With the `after` scope this is a
   belt-and-suspenders that effectively never trips, but it keeps the job honest
   rather than emitting phantom-success false positives from a truncated list.)
4. `reconcileTrades(...)`; `writeReconciliationReport(...)`.

### Day windowing (date math)

Both sides bucket to an ET **calendar** day using the same
`America/New_York` `Intl.DateTimeFormat` conversion `trades-store._etDate`
already uses for the logged side — **never** a UTC date slice. This matters for
after-hours orders: a 20:00 ET order is `00:xx` UTC the next calendar day, so a
UTC slice would misattribute it and turn a real order into a phantom success.
Real orders never occur near ET midnight (the session spans ~04:00–20:00 ET), so
beyond the after-hours/UTC seam there is no midnight edge case to enumerate. The
`after` fetch bound is the ET-day-start instant computed the same way
(`fills-summary.js` already has `startOfEtTradingDayIso` for exactly this).

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

The `.md` (and the banner's expanded view) must carry an explicit **scope line**
so a clean result is not misread as "my positions match the broker": *"Covers
order placements (opens/adds). Does NOT verify closes/exits or live position
state — a logged-success close that didn't execute will not be caught here."*
This is the asymmetry of the v1 non-goal below, stated where the operator reads
the result.

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
- **Incomplete broker coverage** (the §2 coverage guard) is treated as a
  soft-fail: no report rather than a phantom-success-laden one. Silence is
  correct here — a partial fetch cannot be reconciled honestly.
- **Non-terminal orders never drive a verdict.** They are counted as `unresolved`
  and left for the next day's run to resolve once the broker reaches a terminal
  state. This is the core defense of the "never a wrong banner" north star.
- Attribution: only sandboxes with a resolvable non-empty `strategyId` are
  reconciled; others are skipped with a logged note.
- Idempotent per ET day; a retry overwrites the day's report.

## Testing

- **Unit — `reconcileTrades`** (pure, `node:test`): phantom success; false
  failure; status divergence; clean/all-matched; the ambiguous 3-logged-vs-2-broker
  group; empty inputs (no throw, zero counts); side/symbol grouping correctness;
  `filled`/`partially_filled`/`done_for_day`(filled>0) treated as "took";
  `rejected`/`canceled`/`expired` treated as terminal-reject.
- **Unit — non-terminal handling:** a `pending_new`/`new`/`accepted` order is
  counted as `unresolved` and never produces a phantom/false/divergence flag —
  specifically, a logged `failed` against a `pending_new` order yields zero
  mismatches (deferred). Pins the Point-2 decision.
- **Unit — day windowing:** an order with `SubmittedAt` at 20:00 ET (which is the
  next UTC calendar day) attributes to the correct ET day and matches its logged
  trade — the test that would fail under a naive UTC slice.
- **Unit — coverage guard:** a fetch at the 500 limit whose oldest `SubmittedAt`
  is after ET-day-start yields "incomplete coverage / no report," not a
  phantom-success report.
- **Unit — `writeReconciliationReport`** with injected `fs`: correct path, JSON
  shape, and that a clean day still writes a zero-count report (so the API can
  distinguish "clean" from "not yet run").
- **Unit — API route** (or a thin handler test): returns aggregated count;
  `YYYY-MM-DD` validation; missing report → zero.
- **Manual** — Trades-tab banner rendered via a synthetic report file (no jsdom;
  consistent with the failed-trade-indicator feature): confirm banner appears
  with count > 0, expands to items, and is absent at count 0.

## Implementation notes (resolved, not open)

- **Broker data source:** `GET /api/v1/orders?status=all` (`HandleGetOrders` →
  `ListOrders`, `Limit 500`) returns equity + options orders (OCC symbol in
  `symbol`) with `status`, `filledQty`, `submittedAt`, and `strategy` parsed from
  `client_order_id`. **One small Go addition:** support an `after` query param
  scoping the Alpaca `GetOrdersRequest.After` to the ET-day start, so the fetch
  returns only the day's orders deterministically rather than the 500
  most-recent-ever (which can silently truncate before covering the day on a busy
  multi-sandbox account, turning a starved sandbox's logged successes into
  phantom-success false positives). The plan pins the exact plumbing (new
  `after`-aware method vs. signature change, given `ListOrders` is shared with the
  options stop monitor and fills summary). The coverage guard (§2) remains as a
  safety net.
- **Day attribution:** broker `SubmittedAt` → ET calendar day via the same
  `America/New_York` `Intl` conversion as `trades-store._etDate`; `after` bound via
  `fills-summary.startOfEtTradingDayIso`. Never UTC date slicing (after-hours
  orders cross the UTC midnight boundary).
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
- One small Go change: an `after`-scoped orders fetch on the bot's orders
  endpoint (see Implementation notes) — plumbing pinned in the plan.
- No changes to `agent/trades-store.js`.
