# Engine Trades View — Design

**Date:** 2026-06-01
**Status:** Approved (pending spec review)
**Area:** `agent/` (Node dashboard server + frontend)

## Context

The dashboard's **Trades tab** is fed by the harness trade log (`agent/trades-store.js`,
appended only when an LLM agent calls a `place_*` MCP tool, served at
`agent/server.js` `GET /api/trades`). Agents that run in the **Go scheduler** place
orders directly through the Go executor's `PlaceOrder` and never touch that log, so
their trades are invisible in the Trades tab.

Two agents do this today:
- **Turtle** (`TURTLE_SCHEDULER_ENABLED=true`) — `services/turtle_executor.go`, orders
  tagged `Strategy: "trend"`. Records to its own `trend_ledger_entries` table, not the
  `orders` table and not the trade log.
- **DefensiveProphet hedge** — `services/prophet_hedge_executor.go`, orders tagged
  `Strategy: "prophet-defensive"` (`hedgeStrategyTag`, `prophet_hedge_constants.go`).

Confirmed instance (2026-06-01): Turtle held **EEM (59 sh, entered 2026-05-26)** and
**DBB (163 sh, today)** — real broker positions with no Trades-tab row, which is what
prompted this work. The operator wants a single place to see **every** trade the
program makes, including the Go-scheduler ones, and to be able to follow along.

## Goals

- Surface every trade that bypasses the LLM trade log (Turtle, DefensiveProphet, and
  any future Go-scheduler agent) in the dashboard.
- Use **broker truth** as the source so the view is complete and shows real fill
  status/price (not "logged success on acceptance").
- Read-only. No new trading behavior; no change to how orders are placed.
- Don't disturb or double-count the existing LLM Trades tab.

## Non-Goals

- Per-agent **current positions** view (this surfaces trade/order *events*, which is
  what resolves the "EEM has no trade record" confusion). Positions-by-agent is a
  possible future add.
- Rich per-strategy detail (entry ATR / Donchian stop / exit reason for Turtle; spread
  legs for the hedge). We chose broker-truth/order-level; the per-strategy ledgers stay
  where they are.
- Merging Go trades into the existing LLM Trades tab, or rebuilding that tab from broker
  truth.
- Alerts / export / "auto-follow into a real account." The broker-truth source makes
  these straightforward to add later, but they are out of scope here.

## Design

### Data flow

A new read-only **"Engine Trades"** section in the dashboard:

1. The frontend requests `GET /api/engine-trades`.
2. The Node server fetches the shared account's full broker order history from the Go
   bot: `GET /api/v1/orders?status=all` (the exact source the reconciliation feature
   uses, via the existing `goAxios` client). Because all sandboxes share one broker
   account, a single fetch covers every engine.
3. The server normalizes each order and **filters to the Go-agent strategy tags**,
   mapping each to its agent display name.
4. It returns `{ trades }` (newest-first). The frontend renders them in the Engine
   Trades section.

Fetch happens on tab load / refresh — timely enough to "follow along."

### Components

**`agent/engine-trades.js`** (new) — pure logic, no I/O:
- `ENGINE_AGENTS` — the strategy-tag → display-name map:
  ```
  { 'trend': 'Turtle', 'prophet-defensive': 'DefensiveProphet' }
  ```
  Adding a future Go agent is a one-line entry here.
- `filterEngineTrades(brokerOrders)` → array of normalized engine-trade rows:
  `{ symbol, side, qty, type, limitPrice, stopPrice, status, filledQty,
  filledAvgPrice, submittedAt, strategy, agentName }`, including only orders whose
  strategy is a key of `ENGINE_AGENTS`, sorted by `submittedAt` descending.
- Reuses `normalizeBrokerOrder` from `agent/trade-reconciliation.js` (exported there)
  to map the Go `interfaces.Order` JSON shape; extend the imported normalizer or add a
  thin local mapper only for fields it omits (`limitPrice`, `stopPrice`, `type`,
  `filledAvgPrice`).

**`agent/server.js`** (modify) — new route `GET /api/engine-trades`:
- Fetch `GET /api/v1/orders?status=all` via the existing `goAxios` (5s timeout).
- `filterEngineTrades(normalized)` → `res.json({ trades })`.
- Soft-fail: on fetch error / non-200, return `{ trades: [], unavailable: true }` so
  the dashboard never breaks (mirrors `runReconciliationForSandbox`'s soft-fail).

**`agent/public/index.html`** (modify) — new "Engine Trades" section:
- Fetches `/api/engine-trades`, renders rows in the existing trades-card style:
  time · agent · symbol · side · qty · type · price · **true status**
  (filled / canceled / rejected / …) · filledQty.
- Header note: *"Trades placed directly by Go-scheduler engines (Turtle,
  DefensiveProphet) — these don't appear in the LLM Trades tab."*
- If `unavailable`, show "Engine trades unavailable (bot offline)."

### Attribution

Strategy tag is the key. Both Go executors already tag their orders
(`trend` / `prophet-defensive`, verified in `turtle_executor.go` and
`prophet_hedge_executor.go`), so the broker's `client_order_id` carries the tag and the
order history is attributable. The include-list (`ENGINE_AGENTS`) keeps the view to Go
agents only, so it never double-counts the LLM Trades tab.

### Error handling

- Go bot unreachable / non-200 / timeout → soft-fail to `{ trades: [], unavailable: true }`;
  the section renders an "unavailable" note. Never throws, never blocks the page.
- Orders with an unknown/missing strategy tag are simply excluded (not Go agents).
- Missing optional fields (no limit/stop price, null filledAvgPrice) render blank.

## Testing

`agent/engine-trades.test.mjs` (node:test):
- includes `trend` and `prophet-defensive` orders;
- **excludes** LLM-agent tags (`mean-rev`, `default`/`v2-options`, `drift`,
  `penny-momentum`, `harvest`) — guards against double-counting the LLM tab;
- maps each included order to the correct `agentName`;
- sorts newest-first by `submittedAt`;
- tolerates missing optional fields without throwing.

Endpoint wiring (`/api/engine-trades`) and frontend rendering are verified by manual
eyeball against the live dashboard.

## Rollout

Read-only and additive; no flag needed. Takes effect on the next dashboard
(Node server) restart. The Go bot must be reachable for the section to populate;
otherwise it shows the unavailable note.
