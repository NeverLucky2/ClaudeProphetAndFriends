# Failed-Trade Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture whether an order-placement tool call actually succeeded or errored, persist that outcome on the trade record, and show a FAILED indicator in the dashboard Trades tab.

**Architecture:** Add failure detection at the one place that already holds the resolved tool result — the harness `tool_use` handler. A pure `classifyOrderResult(part)` helper decides success/failure; the harness attaches `status` (and `errorReason` on failure) to the trade object. Those fields ride the existing trade object through the unchanged persistence (`appendTrade` spreads `...trade`) and SSE paths, so only the UI (`addTradeCard`) needs to learn to read them.

**Tech Stack:** Node.js (ES modules, `node:test`), vanilla browser JS + CSS in a single `index.html`.

**Spec:** `docs/superpowers/specs/2026-05-26-failed-trade-indicator-design.md`

---

## File Structure

- `agent/harness.js` — add exported pure helper `classifyOrderResult(part)`; set `status`/`errorReason` on both `addTrade` payloads in the `tool_use` case (~lines 1254-1284).
- `agent/failed-trade-indicator.test.mjs` — **new** test file (picked up by the existing `npm test` glob `agent/**/*.test.mjs`): unit tests for the helper + a harness-level executor test for the trade-recording path.
- `agent/public/index.html` — `addTradeCard` (~line 2480): FAILED pill in header, `is-failed` class on the card, Status/Reason rows in the expanded view; plus CSS (~line 962 block).
- No changes to `agent/server.js` or `agent/trades-store.js`.

---

## Task 1: `classifyOrderResult` helper (pure detection)

**Files:**
- Modify: `agent/harness.js` (add exported function near the other module-level helpers, e.g. just above `export class AgentState` at line 177)
- Test: `agent/failed-trade-indicator.test.mjs` (create)

- [ ] **Step 1: Write the failing test**

Create `agent/failed-trade-indicator.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyOrderResult } from './harness.js';

// classifyOrderResult inspects a resolved opencode tool `part` and decides
// whether the order tool call errored/was rejected. Multi-signal so it is
// robust to however opencode surfaces an MCP isError result.

test('state.status === "error" is a failure, reason from state.error', () => {
  const part = { state: { status: 'error', error: 'order rejected by guard', input: {}, output: '' } };
  const r = classifyOrderResult(part);
  assert.equal(r.failed, true);
  assert.match(r.reason, /order rejected by guard/);
});

test('output text beginning with "Error:" is a failure (MCP error shape)', () => {
  const part = { state: { status: 'completed', input: {}, output: 'Error: Order value $999 exceeds max allowed $500. Reduce size or change permissions.' } };
  const r = classifyOrderResult(part);
  assert.equal(r.failed, true);
  assert.match(r.reason, /exceeds max allowed/);
});

test('output object with isError:true is a failure', () => {
  const part = { state: { status: 'completed', input: {}, output: { isError: true, content: [{ type: 'text', text: 'Error: Live trading is DISABLED' }] } } };
  const r = classifyOrderResult(part);
  assert.equal(r.failed, true);
  assert.match(r.reason, /Live trading is DISABLED/);
});

test('a clean order-confirmation output is NOT a failure', () => {
  const part = { state: { status: 'completed', input: {}, output: '{\n  "id": "abc-123",\n  "status": "accepted",\n  "symbol": "QQQ260717C00730000"\n}' } };
  const r = classifyOrderResult(part);
  assert.equal(r.failed, false);
  assert.equal(r.reason, '');
});

test('missing/empty state does not throw and is not a failure', () => {
  assert.deepEqual(classifyOrderResult({}), { failed: false, reason: '' });
  assert.deepEqual(classifyOrderResult({ state: {} }), { failed: false, reason: '' });
  assert.deepEqual(classifyOrderResult(null), { failed: false, reason: '' });
});

test('reason is trimmed and truncated to <= 200 chars', () => {
  const long = 'Error: ' + 'x'.repeat(400);
  const part = { state: { status: 'completed', input: {}, output: long } };
  const r = classifyOrderResult(part);
  assert.equal(r.failed, true);
  assert.ok(r.reason.length <= 200, `reason length ${r.reason.length} should be <= 200`);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test agent/failed-trade-indicator.test.mjs`
Expected: FAIL — `classifyOrderResult` is not exported (`SyntaxError`/`undefined is not a function`).

- [ ] **Step 3: Implement the helper**

In `agent/harness.js`, add this exported function (place it just before `export class AgentState extends EventEmitter {` at line 177):

```javascript
// classifyOrderResult inspects a resolved opencode tool `part` and reports
// whether an order-placement/close tool call errored or was rejected. It is
// defensive: any malformed shape returns { failed: false } so a detection miss
// can never block recording a trade. Multi-signal because opencode may surface
// an MCP `isError` result either as an error status, an error field, or as the
// "Error: …" text the MCP server emits (mcp-server.js:3184-3193).
export function classifyOrderResult(part) {
  try {
    const state = part?.state;
    if (!state) return { failed: false, reason: '' };

    const clean = (s) => String(s).trim().slice(0, 200);

    // Signal 1: explicit error status.
    if (state.status === 'error') {
      const reason = state.error || state.output || 'tool reported error status';
      return { failed: true, reason: clean(typeof reason === 'string' ? reason : JSON.stringify(reason)) };
    }

    // Signal 2: an error field on the state.
    if (state.error) {
      return { failed: true, reason: clean(typeof state.error === 'string' ? state.error : JSON.stringify(state.error)) };
    }

    const output = state.output;

    // Signal 3: output object carrying isError (raw MCP result shape).
    if (output && typeof output === 'object') {
      if (output.isError === true) {
        const text = output.content?.[0]?.text || JSON.stringify(output);
        return { failed: true, reason: clean(text) };
      }
      return { failed: false, reason: '' };
    }

    // Signal 4: output text beginning with "Error:" (MCP server's error shape).
    if (typeof output === 'string' && /^\s*Error:/i.test(output)) {
      return { failed: true, reason: clean(output) };
    }

    return { failed: false, reason: '' };
  } catch {
    return { failed: false, reason: '' };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test agent/failed-trade-indicator.test.mjs`
Expected: PASS — all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add agent/harness.js agent/failed-trade-indicator.test.mjs
git commit -m "feat: classifyOrderResult helper for failed-trade detection"
```

---

## Task 2: Attach status/errorReason to trade records

**Files:**
- Modify: `agent/harness.js:1254-1284` (the `tool_use` case order/close branches)
- Test: `agent/failed-trade-indicator.test.mjs` (append harness-level tests)

- [ ] **Step 1: Write the failing executor test**

Append to `agent/failed-trade-indicator.test.mjs`:

```javascript
import { AgentHarness } from './harness.js';

// Executor-level: drive the real _handleOpenCodeEvent tool_use path and assert
// the recorded/emitted trade carries the right status. Tests the side-effecting
// path (state.addTrade -> emit('trade')), not just the predicate.
function captureTrade(event) {
  const harness = new AgentHarness();
  const trades = [];
  harness.state.on('trade', (t) => trades.push(t));
  const ctx = { addToolCall() {}, setSession() {} };
  harness._handleOpenCodeEvent(event, ctx);
  return trades;
}

function toolUseEvent({ tool, input, status = 'completed', output = '', error }) {
  return { type: 'tool_use', part: { tool, state: { status, input, output, ...(error ? { error } : {}) } } };
}

test('a failed options order is recorded with status "failed" + reason', () => {
  const trades = captureTrade(toolUseEvent({
    tool: 'prophet_place_options_order',
    input: { symbol: 'QQQ260717C00730000', side: 'buy', quantity: 4, limit_price: 22 },
    output: 'Error: Order value $8800 exceeds max allowed $5000. Reduce size or change permissions.',
  }));
  assert.equal(trades.length, 1);
  assert.equal(trades[0].status, 'failed');
  assert.equal(trades[0].symbol, 'QQQ260717C00730000');
  assert.match(trades[0].errorReason, /exceeds max allowed/);
});

test('a successful options order is recorded with status "success" and no errorReason', () => {
  const trades = captureTrade(toolUseEvent({
    tool: 'prophet_place_options_order',
    input: { symbol: 'AMD260717C00510000', side: 'buy', quantity: 2, limit_price: 41.62 },
    output: '{ "id": "ord_1", "status": "accepted" }',
  }));
  assert.equal(trades.length, 1);
  assert.equal(trades[0].status, 'success');
  assert.equal(trades[0].errorReason, undefined);
});

test('a failed close_managed_position is recorded with status "failed"', () => {
  const trades = captureTrade(toolUseEvent({
    tool: 'prophet_close_managed_position',
    input: { position_id: 'pos_17793060' },
    status: 'error',
    error: 'position not found',
  }));
  assert.equal(trades.length, 1);
  assert.equal(trades[0].type, 'close');
  assert.equal(trades[0].status, 'failed');
  assert.match(trades[0].errorReason, /position not found/);
});

test('a non-order read tool does not record a trade', () => {
  const trades = captureTrade(toolUseEvent({
    tool: 'prophet_get_account',
    input: {},
    output: '{ "cash": 100000 }',
  }));
  assert.equal(trades.length, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test agent/failed-trade-indicator.test.mjs`
Expected: FAIL — the new executor tests fail because `trades[0].status` is `undefined` (status not yet set).

- [ ] **Step 3: Implement — set status on both addTrade payloads**

In `agent/harness.js`, inside the `tool_use` case, locate the `if (isNewOrder || isClose) {` block (line 1260). Immediately after that line, compute the result classification once:

```javascript
        if (isNewOrder || isClose) {
          this.state.stats.trades++;
          const { failed, reason } = classifyOrderResult(part);
```

Then update the **close** branch (currently lines 1264-1271) to:

```javascript
          if (isClose) {
            const posId = toolInput.position_id || toolInput.id || '';
            this.state.addTrade({
              type: 'close',
              tool: toolName,
              symbol: posId ? posId.substring(0, 12) : '??',
              side: 'close',
              quantity: null,
              price: null,
              status: failed ? 'failed' : 'success',
              ...(failed ? { errorReason: reason } : {}),
            });
          } else {
```

And update the **order** branch (currently lines 1273-1282) to:

```javascript
            const qty = toolInput.quantity || toolInput.qty;
            const dollars = toolInput.allocation_dollars;
            this.state.addTrade({
              type: 'order',
              tool: toolName,
              symbol: toolInput.symbol || toolInput.underlying || '??',
              side: toolInput.side || (fullToolName.includes('buy') ? 'buy' : 'sell'),
              quantity: qty || (dollars ? `$${dollars}` : null),
              price: toolInput.limit_price,
              status: failed ? 'failed' : 'success',
              ...(failed ? { errorReason: reason } : {}),
            });
```

(Note: `classifyOrderResult` is already exported and in the same module from Task 1, so no import is needed inside `harness.js`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test agent/failed-trade-indicator.test.mjs`
Expected: PASS — all Task 1 + Task 2 tests green.

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `npm test`
Expected: PASS — existing tests (including `agent/orchestrator-emergency.test.mjs`) still pass.

- [ ] **Step 6: Commit**

```bash
git add agent/harness.js agent/failed-trade-indicator.test.mjs
git commit -m "feat: record success/failed status on order + close trades"
```

---

## Task 3: Trades-tab FAILED indicator (UI)

**Files:**
- Modify: `agent/public/index.html` — CSS block (~line 962) and `addTradeCard` (~line 2497-2537)

There is no browser-test harness in this repo, so this task is verified manually with a synthetic trade loaded through the existing historic-date picker (cleaned up afterward).

- [ ] **Step 1: Add CSS for the failed state**

In `agent/public/index.html`, find the trade-card CSS block. After the `.trade-card .trade-side.close { color: var(--warning); }` line (line 971), add:

```css
    .trade-card.is-failed { border-left: 3px solid var(--error); }
    .trade-card .trade-failed-badge {
      display: inline-block; font-size: 10px; font-weight: 700; text-transform: uppercase;
      padding: 1px 6px; margin-left: 8px; border-radius: 4px;
      color: #fff; background: var(--error);
    }
```

- [ ] **Step 2: Set the `is-failed` class on failed cards**

In `addTradeCard`, find (line 2497-2498):

```javascript
  const card = document.createElement('div');
  card.className = 'trade-card';
```

Replace with:

```javascript
  const isFailed = trade.status === 'failed';
  const card = document.createElement('div');
  card.className = 'trade-card' + (isFailed ? ' is-failed' : '');
```

- [ ] **Step 3: Add the FAILED pill to the header**

In `addTradeCard`, find the `headerHtml` block (line 2506-2516) and replace its right-hand `<span>` so the pill renders after the side badge:

```javascript
  const headerHtml =
    '<div class="trade-header">' +
      '<span style="display:flex;align-items:center">' +
        '<span class="trade-symbol">' + esc(trade.symbol||'??') + '</span>' +
        '<span class="trade-agent-badge">' + esc(agentName) + '</span>' +
      '</span>' +
      '<span style="display:flex;align-items:center">' +
        '<span class="trade-side ' + esc(trade.side||'') + '">' + esc((trade.side||'--').toUpperCase()) + '</span>' +
        (isFailed ? '<span class="trade-failed-badge">Failed</span>' : '') +
        '<span class="trade-chevron">&#9662;</span>' +
      '</span>' +
    '</div>';
```

- [ ] **Step 4: Add Status/Reason rows to the expanded view**

In `addTradeCard`, find the `fields` array (line 2521-2530). Replace it with the version below, which appends a Status row always-on-failure and a Reason row when present:

```javascript
  const fields = [
    ['Sandbox',   sandboxId || '—'],
    ['Agent',     agentName],
    ['Type',      trade.type || '—'],
    ['Tool',      trade.tool || '—'],
    ['Side',      trade.side || '—'],
    ['Quantity',  trade.quantity != null ? String(trade.quantity) : '—'],
    ['Price',     trade.price != null ? '$' + trade.price : '—'],
    ['Timestamp', trade.timestamp || '—'],
  ];
  if (isFailed) {
    fields.push(['Status', 'FAILED']);
    if (trade.errorReason) fields.push(['Reason', trade.errorReason]);
  }
```

(The existing `.map(...)` over `fields` with `esc()` at line 2531-2535 stays unchanged and escapes the new values.)

- [ ] **Step 5: Manual verification with a synthetic failed trade**

The dashboard's historic-date picker reads `/api/trades?from&to`, which is served from the per-day `.jsonl` files — so a scratch date file is the safest way to render a failed card without touching real data or the live feed.

1. Pick an account dir that has trades, e.g. `data/sandboxes/sbx_6e4f26af/trades/`.
2. Create a scratch file `data/sandboxes/sbx_6e4f26af/trades/2020-01-02.jsonl` with one failed and one success line:

```
{"type":"order","tool":"place_options_order","symbol":"QQQ260717C00730000","side":"buy","quantity":4,"price":22,"status":"failed","errorReason":"Error: Order value $8800 exceeds max allowed $5000.","timestamp":"2020-01-02T14:00:00.000Z","sandboxId":"sbx_6e4f26af","agentId":"default","agentName":"Prophet"}
{"type":"order","tool":"place_options_order","symbol":"AMD260717C00510000","side":"buy","quantity":2,"price":41.62,"status":"success","timestamp":"2020-01-02T14:01:00.000Z","sandboxId":"sbx_6e4f26af","agentId":"default","agentName":"Prophet"}
```

3. Start the agent server (`npm run agent`) and open the dashboard, go to the **Trades** tab, tick **Show historic trades**, set both date pickers to `2020-01-02`, click **Apply**.
4. Confirm: the QQQ card shows a red **FAILED** pill next to **BUY** and a red left border; expanding it shows `Status: FAILED` and `Reason: Error: Order value …`. The AMD card renders normally with no pill/border.
5. Delete the scratch file: `data/sandboxes/sbx_6e4f26af/trades/2020-01-02.jsonl`.

Expected: failed card visually distinct per the approved mockup; success card unchanged.

- [ ] **Step 6: Commit**

```bash
git add agent/public/index.html
git commit -m "feat: show FAILED indicator for failed trades in Trades tab"
```

---

## Self-Review Notes

- **Spec coverage:** detection helper (Task 1) ↔ spec §Components.1; status on trade record (Task 2) ↔ §Components.2; persistence/transport unchanged (verified by not touching `server.js`/`trades-store.js`) ↔ §Components.3; UI pill/accent/Status/Reason (Task 3) ↔ §Components.4; unit + executor tests (Tasks 1-2) ↔ §Testing. Backward compatibility (absent status renders as today) is enforced by gating all UI on `trade.status === 'failed'`.
- **Non-goals respected:** no unfilled-order reconciliation, no backfill, no `stats.trades` semantic change (it still increments before the branch at the existing line 1261).
- **Type consistency:** helper returns `{ failed, reason }` everywhere; trade fields use `status` (`'success'`/`'failed'`) and `errorReason` consistently across harness, tests, and UI.
