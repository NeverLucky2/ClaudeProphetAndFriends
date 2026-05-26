# Failed-Trade Indicator — design

**Date:** 2026-05-26
**Status:** Approved (design); pending implementation plan
**Scope:** Capture whether an order-placement tool call actually succeeded or
errored, persist that outcome on the trade record, and indicate failed trades in
the dashboard's Trades tab.

## Problem

When an agent calls an order tool (`place_buy_order`, `place_sell_order`,
`place_options_order`, `place_managed_position`, `close_managed_position`), the
harness records the trade using **only the parameters the agent passed in**
(`agent/harness.js:1264-1282`). It captures the tool's *result* into `toolOutput`
(`harness.js:1241`) but never inspects it. So whether the broker accepted the
order, the risk-guard rejected it, a permission check blocked it, or the call
errored out, the trade is logged identically — as if it succeeded.

The persisted records confirm this: today's `data/sandboxes/<acct>/trades/2026-05-26.jsonl`
lines carry `type/tool/symbol/side/quantity/price/timestamp` and **no status
field**. The Trades tab (`agent/public/index.html` `addTradeCard`) has no failure
indicator, so this morning's failed orders render as ordinary trades. The
file even shows the tell-tale signature of the gap — three near-identical
`QQQ260717C00730000` buys at 13:37 / 13:43 / 14:04 (an order that kept failing
and was retried), each logged as a normal trade.

This is a visibility gap, not a trading-path bug. The failure information exists
transiently (the MCP server returns `Error: <message>` with `isError: true`, and
that flows through opencode and the live `tool_result` SSE event) but is discarded
before the trade is recorded.

## Goals

- Record, on each order/close trade, whether the placement **succeeded or
  failed** (errored / was rejected at submission), plus a short failure reason.
- Indicate failed trades in the Trades tab so the operator can scan the feed and
  see which orders did not go through.
- Be fully backward-compatible: pre-existing trade records (no status field)
  render exactly as they do today.

## Non-goals

- **No "accepted-but-never-filled" detection.** A limit order that submits
  cleanly but never fills is *not* a failure here. Detecting that requires a
  broker order-status reconciliation pass; explicitly out of scope (it is the
  natural future extension if fill-status tracking is ever wanted).
- **No backfill of this morning's failures.** The outcome of already-logged
  trades was never persisted (only the input was), so retroactive marking would
  be unreliable guesswork. Going-forward only.
- **No change to trade persistence layout.** `trades-store.js` stays a pure
  passthrough; the new fields ride along on the existing trade object.
- **No change to the "Trades" stat counter semantics.** `stats.trades`
  (`harness.js:1261`) currently counts order-tool actions and keeps incrementing
  on failed attempts too. Re-defining it is out of scope (a deliberate
  non-change, flagged so it's a conscious choice).

## Architecture

All capture happens at one point — the harness `tool_use` handler, which already
holds the resolved tool result at the moment it builds the trade. The new fields
ride the existing trade object through the existing persistence and SSE paths, so
only the UI needs to learn to read them.

```
opencode 'tool_use' event (input + resolved output)   [agent/harness.js _handleOpenCodeEvent]
        │
   classifyOrderResult(part) ──▶ { failed: bool, reason: string }   [harness, pure helper]
        │
   state.addTrade({ ...fields, status, errorReason? })   [harness.js:1264 / :1275]
        │
   emit('trade', stamped)
        │
   server 'trade' handler ──▶ appendTrade(PROJECT_ROOT, accountId, { ...trade })   [unchanged: spreads ...trade]
        │                                                          │
   per-day .jsonl (now carries status/errorReason)        broadcast SSE 'trade'
                                                                   │
                                              addTradeCard(trade)   [agent/public/index.html]
                                              renders FAILED pill + accent when status==='failed'
```

## Components

### 1. `classifyOrderResult(part)` — failure detection (harness, pure)

A small helper, exported for unit testing, that inspects the resolved tool part
and returns `{ failed: boolean, reason: string }`. Multi-signal so it is robust
to however opencode surfaces an MCP `isError` result:

- `failed = true` when **any** of:
  - `part.state?.status === 'error'`, or
  - `part.state?.error` is truthy (use as the reason), or
  - the output text (string form of `part.state?.output`) matches `/^\s*Error:/i`
    (the MCP server's error shape from `mcp-server.js:3184-3193`), or
  - the output parses to an object with `isError === true`.
- `reason`: the first available of `part.state.error`, the matched/leading
  `Error: …` line, or the raw output — trimmed and truncated (e.g. ≤200 chars).
- When none of the signals fire, `failed = false`, `reason = ''`.

Detection runs at the existing `tool_use` case; the comment at `harness.js:1215`
documents that input/output are already resolved when this event fires, so the
result is available inline. (This assumption is verified by the harness-level
test below.)

### 2. Trade record (harness)

Both `addTrade(...)` payloads gain status fields:

- Order branch (`harness.js:1275`) and close branch (`harness.js:1264`):
  add `status: failed ? 'failed' : 'success'`, and `errorReason: reason` only
  when `failed`.
- New successful trades carry `status: 'success'` explicitly so going-forward
  data is clean.

### 3. Persistence & transport — no change

`server.js`'s `trade` handler already spreads `...trade` into `appendTrade`, and
broadcasts the trade over SSE. The new fields persist to the per-day `.jsonl` and
stream to connected dashboards with no code change. `trades-store.js` is a pure
passthrough and is untouched.

### 4. Trades tab (`agent/public/index.html` `addTradeCard`)

Render the new state. `trade.status === 'failed'` is the only trigger; absent or
`'success'` renders exactly as today (backward compatible).

- **Header:** a red `FAILED` pill next to the existing side badge.
- **Card:** a red left-border accent (e.g. a `trade-card--failed` class) so
  failures are scannable while scrolling the feed.
- **Expanded view:** add a `Status: FAILED` field and a `Reason: <errorReason>`
  field to the existing field list (`harness.js`-style `fields` array around
  `index.html:2521`). All values pass through the existing `esc()` escaper.

No change to the agent filter, counts, seeding, or historic-mode paths — failed
trades are ordinary cards that happen to carry extra fields.

## Error handling

- Detection is best-effort and must never throw: `classifyOrderResult` is
  defensive about missing `part.state`, non-string outputs, and unparseable JSON,
  defaulting to `failed = false` on any internal error so a detection miss can
  never block recording a trade.
- A false negative (a real failure read as success) degrades to today's behavior
  — no worse than the status quo. A false positive (a success flagged failed) is
  the riskier direction; the multi-signal rule is conservative (requires an
  explicit error signal) to avoid it.

## Testing

- **Unit — `classifyOrderResult`:** table of part shapes →
  - `status: 'error'` ⇒ failed, reason from `state.error`.
  - output string `"Error: order rejected by guard"` ⇒ failed, reason captured.
  - output object `{ isError: true, content: [...] }` ⇒ failed.
  - clean success output (e.g. an order-confirmation JSON) ⇒ not failed.
  - missing/empty `state` ⇒ not failed, no throw.
- **Harness-level (mock-based):** feed a mocked errored `tool_use` event through
  the event handler and assert the emitted/recorded trade carries
  `status: 'failed'` + `errorReason`; feed a success event and assert
  `status: 'success'`. This tests the executor (the side-effecting
  `addTrade` path), not just the predicate, per standing project preference.
- Run with `node:test`.

## Files touched

- `agent/harness.js` — add `classifyOrderResult` helper; set `status`/`errorReason`
  on both `addTrade` payloads.
- `agent/public/index.html` — `addTradeCard`: FAILED pill, failed-card accent
  class + CSS, Status/Reason in expanded view.
- Test file (new) — `agent/*.test.mjs` for the helper + harness path.
- No changes to `agent/server.js` or `agent/trades-store.js`.
