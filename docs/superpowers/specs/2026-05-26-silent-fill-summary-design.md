# Silent-Fill Summary — design

**Date:** 2026-05-26
**Status:** Approved (design); pending implementation plan
**Scope:** Surface broker-side order fills that happen between an agent's sparse
LLM beats, as a non-LLM terminal summary shown on agent start and on dashboard open.

## Problem

Coil (mean-rev-rsi2) fires its LLM exactly once per trading day at 15:45 ET via
`scheduledBeats.exclusive`. Its resting limit-order entries and bracket exits fill
at Alpaca *between* beats. The harness only logs what the LLM does during a beat,
so those fills produce **zero terminal feedback** — the operator sees an agent that
"placed 3 trades today" with nothing in the log explaining it. A restart makes it
worse: `harness.start()` resets `state.recentTrades`, wiping even the in-memory
trace of a morning's activity.

This is not a bug in the trading path — it's a visibility gap. The fills are
correct and the LLM-free behavior is desirable (it saves token cost). What's
missing is a cheap, durable-across-restart feedback hook.

The same blind spot applies to every agent that places resting/bracket orders
that fill between sparse beats: Coil, Drift, Turtle (Go scheduler), and Harvest
(options).

## Goals

- Show a concise, **LLM-free** summary of an agent's fills for the current ET
  trading day, attributed by strategy tag.
- Surface it at two moments: when the agent **starts** (covers the restart case)
  and when a **dashboard client connects** (covers opening the dashboard mid-day).
- Work for all silent-fill agents, not just Coil.
- Soft-fail everywhere: a summary fetch must never block startup or an SSE
  connect, and must never throw.

## Non-goals

- **No persistence / reconciliation.** Broker fills are not written to
  trade-history; that remains the separate concern of
  `2026-05-13-trade-history-persistence-design.md`. This feature is display-only.
- **No real-time watcher.** We do not add a polling goroutine that notifies the
  moment a fill happens. Feedback is pull-on-view, by explicit operator choice.
- **No LLM involvement.** The summary is built from broker order data only.
- No position-intent classification beyond BUY/SELL side as an entry/exit hint.

## Architecture

Three pieces: a thin Go summary endpoint, a Node fetch/render module, and two
display triggers (one in the harness, one in the SSE connect handler).

```
Alpaca orders ──ListOrders("closed")──▶ SummarizeFills(orders, strategy, since)  [Go, pure]
                                              │
                          GET /api/v1/fills/summary?strategy=&since=  [Go controller]
                                              │
                    fetchFillsSummary(goAxios, strategy, since)  [Node, soft-fail]
                                              │
                       renderFillsSummaryLine(summary, agentName)  [Node, pure]
                              │                               │
                  harness.start() emit                /api/events connect res.write
                  (broadcast agent_log)               (this client only)
```

### 1. Go — summary endpoint

**Pure function** in `services/fills_summary.go`:

```go
type FillItem struct {
    Symbol   string    `json:"symbol"`
    Side     string    `json:"side"`        // "buy" | "sell"
    Qty      float64   `json:"qty"`         // FilledQty
    AvgPrice float64   `json:"avg_price"`   // FilledAvgPrice (0 if nil)
    FilledAt time.Time `json:"filled_at"`
}
type FillsSummary struct {
    Strategy string     `json:"strategy"`
    Since    time.Time  `json:"since"`
    Count    int        `json:"count"`
    Fills    []FillItem `json:"fills"`
}

// SummarizeFills keeps orders where Status=="filled", FilledAt != nil,
// !FilledAt.Before(since), and ParseStrategyFromClientOrderID(ClientOrderID)
// == strategy (when strategy != ""; empty strategy matches all tagged+untagged).
// Result is sorted ascending by FilledAt.
func SummarizeFills(orders []*interfaces.Order, strategy string, since time.Time) FillsSummary
```

Keeping it pure (slice in, struct out) makes it table-testable without Alpaca,
mirroring `ComputeMeanRevSignal`.

**Endpoint** — a method on the existing `OrderController` (it already holds
`tradingService`, so no new controller wiring in `main.go`):

```
GET /api/v1/fills/summary?strategy=<id>&since=<RFC3339>
```

- Calls `tradingService.ListOrders(ctx, "closed")` (already returns up to 500
  orders with `Status`, `FilledAt`, `FilledQty`, `FilledAvgPrice`, and `Strategy`
  populated), then `SummarizeFills(orders, strategy, since)`.
- `strategy` optional; empty ⇒ no strategy filter.
- `since` optional RFC3339; if absent, default to start-of-current-ET-day
  computed server-side. (Node passes it explicitly anyway — see below — so the
  default is a safety net.)
- On `ListOrders` error: 500 with `{error}`. The Node caller soft-fails.
- Registered next to `GET /orders` in `main.go`'s `api` group.

### 2. Node — `agent/fills-summary.js`

Mirrors `agent/beat-context.js`: split fetch + render, both unit-tested.

- `export async function fetchFillsSummary(goAxios, strategy, since)`
  - GETs `/api/v1/fills/summary` with the params, short timeout (~3000ms).
  - Returns the parsed summary object, or `null` on any error / missing goAxios.
- `export function renderFillsSummaryLine(summary, agentName)`
  - Returns `''` when `summary` is null or `count === 0` (quiet on no-fill days).
  - Otherwise one line:
    `<Agent> — <N> fill(s) today (broker-side, no LLM beat): <side> <qty> <SYM> @ $<px> (<HH:MM> ET) · …`
  - Caps the listed fills at 10, appending ` · +<K> more` when truncated.
  - Times rendered in ET.
- `export function startOfEtTradingDayIso(now = new Date())` — the ET-midnight
  anchor as an ISO string, so the harness and SSE paths compute "since"
  identically. (ET-midnight instant in UTC; pure for testability.)

### 3. Trigger A — on agent start (`agent/harness.js`)

In `start()`, after the existing `Agent "<name>" started …` emit, fire a
non-blocking summary:

```js
// LLM-free fills recap — surfaces broker-side fills (resting limit entries,
// bracket exits) that landed since the day's open. Soft-fails: never blocks start.
if (process.env.FILLS_SUMMARY_ENABLED !== 'false') {
  void this._emitFillsSummary().catch(() => {});
}
```

`_emitFillsSummary()`:
- Resolves `strategy = this._agentConfig?.strategyId`; returns if absent.
- `const goAxios = this.getRuntime?.(this.sandboxId)?.goAxios;` returns if null.
- `const summary = await fetchFillsSummary(goAxios, strategy, startOfEtTradingDayIso());`
- `const line = renderFillsSummaryLine(summary, this._agentConfig?.name);`
- If `line`, `this.state.emit('agent_log', { message: line, level: 'success' })`
  (no `source` tag ⇒ same pane as the "started" line).

The emit is a normal in-memory `agent_log`, so `server.js`'s existing
`agent_log` relay broadcasts it to connected clients.

### 4. Trigger B — on dashboard open (`agent/server.js`, `/api/events`)

After the handler writes the per-client `state` and `config` snapshots and adds
the client to `sseClients`, asynchronously write a fills summary **to the
connecting client only** (not via `broadcast`, so other dashboards aren't
re-spammed each time someone opens the page):

```js
// after sseClients.add(res)
if (process.env.FILLS_SUMMARY_ENABLED !== 'false') {
  void emitConnectFillsSummaries(res).catch(() => {});
}
```

`emitConnectFillsSummaries(res)`:
- Iterates **running** sandboxes (`orchestrator.runtimes` where `harness.state.running`).
- For each, resolves the agent's `strategyId` and that sandbox's `goAxios`.
- `fetchFillsSummary(...)` → `renderFillsSummaryLine(...)`.
- For each non-empty line, if the client is still in `sseClients`, write a single
  `agent_log` event tagged with that `sandboxId` directly to `res`:
  `res.write('event: agent_log\ndata: ' + JSON.stringify({ message, level:'success', sandboxId, timestamp }) + '\n\n')`.
- Each sandbox handled independently; one failure doesn't abort the rest.

## Data flow (Coil, restart at 11:41 ET with 3 morning fills)

1. `harness.start()` emits `Agent "Coil" started …`.
2. `_emitFillsSummary()` fetches `/api/v1/fills/summary?strategy=mean-rev-rsi2&since=<ET-midnight>` from Coil's Go backend.
3. Go `ListOrders("closed")` → `SummarizeFills` keeps the 3 filled, mean-rev-rsi2-tagged orders since midnight ET.
4. Node renders one line; harness emits it as `agent_log` (success).
5. The operator sees, right under "started":
   `Coil — 3 fills today (broker-side, no LLM beat): BUY 12 AAPL @ $184.20 (10:14 ET) · BUY 8 MSFT @ $402.10 (11:02 ET) · SELL 15 NKE @ $96.30 (13:40 ET)`

## Error handling

- Go endpoint: `ListOrders` failure ⇒ 500; otherwise always a valid (possibly
  empty) summary. No panics on nil `FilledAt`/`FilledAvgPrice`.
- Node fetch: any error or missing goAxios ⇒ `null` ⇒ render returns `''` ⇒ no
  line. No throw reaches `start()` or the SSE handler.
- SSE: initial `state`/`config` writes happen first and synchronously; the
  summary write is fire-and-forget and guards that the client is still connected.
- Kill switch: `FILLS_SUMMARY_ENABLED=false` disables both triggers without a
  redeploy (mirrors `BEAT_CONTEXT_ENABLED`).

## Testing

- **Go** `services/fills_summary_test.go` (table tests for `SummarizeFills`):
  status filter (only "filled"), `since` boundary (inclusive), strategy match vs
  mismatch vs empty-strategy-matches-all, untagged orders, nil `FilledAt`
  excluded, nil `FilledAvgPrice` ⇒ 0, ascending `FilledAt` sort, partial fills
  (use `FilledQty`).
- **Node** `agent/fills-summary.test.mjs` (`node:test`):
  - `renderFillsSummaryLine`: null ⇒ '', count 0 ⇒ '', 1 fill, 3 fills, >10 fills
    (`+K more`), ET time formatting, BUY/SELL rendering.
  - `fetchFillsSummary`: stubbed axios returns summary; error ⇒ null; missing
    goAxios ⇒ null.
  - `startOfEtTradingDayIso`: returns ET-midnight for a known instant.
- **Harness** (extend existing harness/preflight test patterns): `start()` emits
  the summary `agent_log` when the stubbed fetch returns count>0, and emits
  nothing when count is 0 or the fetch is disabled.

## Files touched

- `services/fills_summary.go` (new)
- `services/fills_summary_test.go` (new)
- `controllers/order_controller.go` (add `HandleFillsSummary`)
- `cmd/bot/main.go` (register `GET /fills/summary`)
- `agent/fills-summary.js` (new)
- `agent/fills-summary.test.mjs` (new)
- `agent/harness.js` (`_emitFillsSummary` + start-path call)
- `agent/server.js` (`emitConnectFillsSummaries` + `/api/events` call)

## Open considerations (deferred)

- **Options/Harvest fidelity:** Alpaca `GetOrders` returns options orders by OCC
  symbol; the summary will show that symbol. Friendlier underlying/leg formatting
  is a later refinement, not part of this change.
- **Persistence:** if the operator later wants broker fills recorded durably, the
  `SummarizeFills` output is a natural input to a reconciliation writer — but that
  is the trade-history-persistence feature, explicitly out of scope here.
