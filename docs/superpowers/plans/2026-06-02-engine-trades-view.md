# Engine Trades View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only "Engine Trades" dashboard section that surfaces trades placed directly by Go-scheduler agents (Turtle, DefensiveProphet) — which bypass the LLM trade log — sourced from broker order history.

**Architecture:** A pure `agent/engine-trades.js` filters/normalizes the Go bot's broker order history (`/api/v1/orders?status=all`) down to the Go-agent strategy tags (`trend`→Turtle, `prophet-defensive`→DefensiveProphet). A thin soft-failing `GET /api/engine-trades` route in `agent/server.js` serves it, and a new section in `agent/public/index.html` renders it. Read-only; no order-placement changes.

**Tech Stack:** Node.js (ES modules), `node:test`, Express, the existing `goAxios` Go-bot client, vanilla-JS dashboard.

**Design spec:** `docs/superpowers/specs/2026-06-01-engine-trades-view-design.md`

---

## File Structure

- **Create** `agent/engine-trades.js` — pure logic: `ENGINE_AGENTS` map, `normalizeEngineOrder`, `filterEngineTrades`. One responsibility: turning raw broker orders into Go-engine trade rows. Self-contained (own normalizer) so it doesn't couple to the reconciliation module.
- **Create** `agent/engine-trades.test.mjs` — `node:test` unit tests for the pure logic.
- **Modify** `agent/server.js` — add `GET /api/engine-trades` (import `filterEngineTrades`, fetch via `getGoClientForSandbox`, soft-fail).
- **Modify** `agent/public/index.html` — add the "Engine Trades" section + `fetchEngineTrades`/`renderEngineTrades`.

---

### Task 1: engine-trades.js pure logic

**Files:**
- Create: `agent/engine-trades.js`
- Test: `agent/engine-trades.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `agent/engine-trades.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE_AGENTS, normalizeEngineOrder, filterEngineTrades } from './engine-trades.js';

// Go-engine orders (trend, prophet-defensive) are included and mapped to their agent.
test('includes Go-engine tags and maps agent names', () => {
  const raw = [
    { Symbol: 'EEM', Side: 'buy', Qty: 59, Type: 'limit', Status: 'filled', FilledQty: 59, SubmittedAt: '2026-05-26T21:00:00Z', Strategy: 'trend' },
    { Symbol: 'QQQ260X', Side: 'buy', Qty: 1, Type: 'limit', Status: 'filled', FilledQty: 1, SubmittedAt: '2026-06-01T21:00:00Z', Strategy: 'prophet-defensive' },
  ];
  const rows = filterEngineTrades(raw);
  assert.equal(rows.length, 2);
  const byStrat = Object.fromEntries(rows.map((r) => [r.strategy, r.agentName]));
  assert.equal(byStrat['trend'], 'Turtle');
  assert.equal(byStrat['prophet-defensive'], 'DefensiveProphet');
});

// LLM-agent and untagged orders are excluded so the view never double-counts the
// LLM Trades tab.
test('excludes LLM-agent and untagged orders', () => {
  const raw = [
    { Symbol: 'AAPL', Side: 'buy', Status: 'filled', SubmittedAt: '2026-06-01T15:00:00Z', Strategy: 'mean-rev' },
    { Symbol: 'NVDA260821C00210000', Side: 'sell', Status: 'canceled', SubmittedAt: '2026-06-01T19:06:00Z', Strategy: 'v2-options' },
    { Symbol: 'X', Side: 'buy', Status: 'filled', SubmittedAt: '2026-06-01T15:00:00Z', Strategy: 'drift' },
    { Symbol: 'Y', Side: 'buy', Status: 'filled', SubmittedAt: '2026-06-01T15:00:00Z', Strategy: '' },
  ];
  assert.deepEqual(filterEngineTrades(raw), []);
});

// Rows are newest-first by submittedAt.
test('sorts newest-first by submittedAt', () => {
  const raw = [
    { Symbol: 'EEM', Side: 'buy', Status: 'filled', SubmittedAt: '2026-05-26T21:00:00Z', Strategy: 'trend' },
    { Symbol: 'DBB', Side: 'buy', Status: 'filled', SubmittedAt: '2026-06-01T21:00:00Z', Strategy: 'trend' },
  ];
  const rows = filterEngineTrades(raw);
  assert.deepEqual(rows.map((r) => r.symbol), ['DBB', 'EEM']);
});

// Missing optional fields must not throw and get null/0 defaults.
test('tolerates missing optional fields', () => {
  const rows = filterEngineTrades([{ Symbol: 'EEM', Side: 'buy', Status: 'filled', Strategy: 'trend' }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].limitPrice, null);
  assert.equal(rows[0].filledAvgPrice, null);
  assert.equal(rows[0].qty, 0);
});

// Non-array / nullish input is handled.
test('handles non-array input', () => {
  assert.deepEqual(filterEngineTrades(null), []);
  assert.deepEqual(filterEngineTrades(undefined), []);
});

// normalizeEngineOrder maps PascalCase with lowercase fallback.
test('normalizeEngineOrder maps PascalCase and lowercase', () => {
  assert.equal(normalizeEngineOrder({ Symbol: 'EEM' }).symbol, 'EEM');
  assert.equal(normalizeEngineOrder({ symbol: 'eem' }).symbol, 'eem');
  assert.equal(ENGINE_AGENTS['trend'], 'Turtle');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test agent/engine-trades.test.mjs`
Expected: FAIL — `Cannot find module './engine-trades.js'` (file doesn't exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `agent/engine-trades.js`:

```javascript
// Surfaces trades placed directly by Go-scheduler agents (Turtle, DefensiveProphet),
// which bypass the LLM trade log. Pure logic over the broker order history returned by
// the Go bot's /api/v1/orders. Read-only; never places or mutates anything.

// Strategy tag -> agent display name. A held order is shown only if its strategy is a
// key here, which both attributes it and keeps the view to Go agents (so it never
// double-counts the LLM Trades tab). Add a future Go agent with one line.
export const ENGINE_AGENTS = {
  trend: 'Turtle',
  'prophet-defensive': 'DefensiveProphet',
};

// normalizeEngineOrder maps the Go interfaces.Order JSON (PascalCase, no json tags) to
// the lower-camel shape the view uses. Lowercase fallbacks guard against future
// json-tag changes. Self-contained (does not depend on trade-reconciliation.js).
export function normalizeEngineOrder(o) {
  const g = o || {};
  return {
    id: g.ID ?? g.id ?? '',
    symbol: g.Symbol ?? g.symbol ?? '',
    side: g.Side ?? g.side ?? '',
    qty: g.Qty ?? g.qty ?? 0,
    type: g.Type ?? g.type ?? '',
    status: g.Status ?? g.status ?? '',
    limitPrice: g.LimitPrice ?? g.limitPrice ?? null,
    stopPrice: g.StopPrice ?? g.stopPrice ?? null,
    filledQty: g.FilledQty ?? g.filledQty ?? 0,
    filledAvgPrice: g.FilledAvgPrice ?? g.filledAvgPrice ?? null,
    submittedAt: g.SubmittedAt ?? g.submittedAt ?? null,
    strategy: g.Strategy ?? g.strategy ?? '',
  };
}

// filterEngineTrades normalizes broker orders, keeps only Go-engine strategies, tags
// each with its agent display name, and returns them newest-first.
export function filterEngineTrades(rawOrders) {
  const list = Array.isArray(rawOrders) ? rawOrders : [];
  const rows = [];
  for (const raw of list) {
    const o = normalizeEngineOrder(raw);
    const agentName = ENGINE_AGENTS[o.strategy];
    if (!agentName) continue; // LLM agent, or untagged — not a Go engine trade
    rows.push({ ...o, agentName });
  }
  rows.sort((a, b) => new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0));
  return rows;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test agent/engine-trades.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add agent/engine-trades.js agent/engine-trades.test.mjs
git commit -m "feat(engine-trades): pure broker-order filter for Go-agent trades"
```

---

### Task 2: /api/engine-trades route

**Files:**
- Modify: `agent/server.js` (import near the other `./` imports ~line 33; route after `/api/reconciliation` ~line 974)

- [ ] **Step 1: Add the import**

In `agent/server.js`, alongside the existing agent-module imports (near line 33, e.g. just after `import { appendTrade, readTrades } from './trades-store.js';`), add:

```javascript
import { filterEngineTrades } from './engine-trades.js';
```

- [ ] **Step 2: Add the route**

Immediately after the `app.get('/api/reconciliation', ...)` handler (ends ~line 974), add:

```javascript
// GET /api/engine-trades — trades placed directly by Go-scheduler agents (Turtle,
// DefensiveProphet), which bypass the LLM trade log. Sourced from broker order history
// (the shared account → any sandbox's Go client returns all of it). Soft-fails to an
// empty list with unavailable:true when the bot is unreachable, so the page never breaks.
app.get('/api/engine-trades', async (req, res) => {
  const sandboxId = req.query.sandboxId ? String(req.query.sandboxId) : undefined;
  const goAxios = getGoClientForSandbox(sandboxId);
  if (!goAxios) return res.json({ trades: [], unavailable: true });
  try {
    const resp = await goAxios.get('/api/v1/orders?status=all', { timeout: 5000 });
    const raw = Array.isArray(resp?.data) ? resp.data : [];
    res.json({ trades: filterEngineTrades(raw) });
  } catch {
    res.json({ trades: [], unavailable: true });
  }
});
```

- [ ] **Step 3: Verify the file parses**

Run: `node --check agent/server.js`
Expected: no output (exit 0) — the file is syntactically valid.

- [ ] **Step 4: Commit**

```bash
git add agent/server.js
git commit -m "feat(engine-trades): soft-failing /api/engine-trades route"
```

---

### Task 3: Engine Trades dashboard section

**Files:**
- Modify: `agent/public/index.html`

- [ ] **Step 1: Locate the existing trades rendering to mirror**

Read the existing trades section so the new one matches its markup/classes:

Run: `grep -n "renderTradesBulk\|async function fetchTrades\|id=\"trades" agent/public/index.html`
Expected: line numbers for `fetchTrades` (~3070), `renderTradesBulk` (~3058), and the trades section container. Open those regions and note the card/list markup + CSS classes used (e.g. the container element id and the per-row class).

- [ ] **Step 2: Add the Engine Trades section container**

In `agent/public/index.html`, add a new section near the existing Trades section markup (mirror its surrounding structure). Use this block, adjusting the wrapper classes to match the existing Trades section:

```html
<section id="engine-trades-section" class="card">
  <h2>Engine Trades</h2>
  <p class="muted">
    Trades placed directly by Go-scheduler engines (Turtle, DefensiveProphet).
    These do not appear in the LLM Trades tab. Source: broker order history (true fill status).
  </p>
  <div id="engine-trades-status" class="muted"></div>
  <div id="engine-trades-list"></div>
</section>
```

- [ ] **Step 3: Add fetch + render JS**

In the dashboard script block (near `fetchTrades`/`renderTradesBulk`), add:

```javascript
async function fetchEngineTrades() {
  const statusEl = document.getElementById('engine-trades-status');
  const listEl = document.getElementById('engine-trades-list');
  if (!listEl) return;
  try {
    const res = await fetch('/api/engine-trades');
    const data = await res.json();
    if (data.unavailable) {
      statusEl.textContent = 'Engine trades unavailable (bot offline).';
      listEl.innerHTML = '';
      return;
    }
    renderEngineTrades(data.trades || []);
    statusEl.textContent = (data.trades || []).length ? '' : 'No engine trades yet.';
  } catch {
    statusEl.textContent = 'Engine trades unavailable.';
  }
}

function renderEngineTrades(trades) {
  const listEl = document.getElementById('engine-trades-list');
  if (!listEl) return;
  const fmtPrice = (p) => (p == null ? '' : Number(p).toFixed(2));
  const fmtTime = (t) => (t ? new Date(t).toLocaleString() : '');
  listEl.innerHTML = trades.map((t) => `
    <div class="trade-row">
      <span class="trade-time">${fmtTime(t.submittedAt)}</span>
      <span class="trade-agent">${t.agentName}</span>
      <span class="trade-symbol">${t.symbol}</span>
      <span class="trade-side ${t.side}">${t.side} ${t.qty}</span>
      <span class="trade-type">${t.type}</span>
      <span class="trade-price">${fmtPrice(t.limitPrice ?? t.stopPrice)}</span>
      <span class="trade-status status-${t.status}">${t.status}</span>
      <span class="trade-filled">filled ${t.filledQty}${t.filledAvgPrice != null ? ' @ ' + fmtPrice(t.filledAvgPrice) : ''}</span>
    </div>`).join('');
}
```

Then call `fetchEngineTrades()` wherever the dashboard initializes/refreshes the Trades view (mirror the existing `fetchTrades(...)` call site so it loads on page load and on the dashboard's refresh tick).

- [ ] **Step 4: Verify in the live dashboard**

Start the dashboard (per the project's run method) with the Go bot reachable, open it, and confirm the **Engine Trades** section lists Turtle's **EEM** and **DBB** with their true broker status, and that the section is separate from the LLM Trades tab. If the bot is offline, confirm it shows "Engine trades unavailable" rather than breaking the page.

Adjust the row markup/classes in Step 3 to match the existing trades cards if the styling looks off.

- [ ] **Step 5: Commit**

```bash
git add agent/public/index.html
git commit -m "feat(engine-trades): dashboard Engine Trades section"
```

---

### Task 4: Full verification + squash

- [ ] **Step 1: Run the full JS test suite**

Run: `node --test agent/`
Expected: all tests pass, including `engine-trades.test.mjs` and the pre-existing agent tests (no regression).

- [ ] **Step 2: Squash to one backlog commit (per workflow preference)**

The three task commits are TDD/checkpoint commits. Squash them into one for this backlog item:

```bash
git reset --soft <commit-before-task-1>
git commit -m "feat(engine-trades): read-only dashboard view of Go-agent trades"
```

(`<commit-before-task-1>` = the spec+plan commit for this feature.)

---

## Self-Review

**Spec coverage:**
- Data flow (frontend → `/api/engine-trades` → Go bot `/api/v1/orders?status=all` → filter) → Tasks 2 + 3. ✓
- `ENGINE_AGENTS` map (`trend`→Turtle, `prophet-defensive`→DefensiveProphet) → Task 1. ✓
- `filterEngineTrades` returning normalized rows newest-first, Go-tags only → Task 1 + tests. ✓
- Self-contained normalizer for `type`/`limitPrice`/`stopPrice`/`filledAvgPrice` (the fields `normalizeBrokerOrder` omits) → Task 1 `normalizeEngineOrder`. ✓
- Soft-fail on bot unreachable → Task 2 (`{ trades: [], unavailable: true }`) + Task 3 "unavailable" note. ✓
- Separate section, no double-counting → Task 3 (own section) + Task 1 exclusion test. ✓
- True broker status (filled/canceled/rejected) shown → Task 3 render uses `t.status`. ✓
- Read-only, no flag → no order-placement code, no flag added. ✓
- Excludes LLM tags → Task 1 explicit exclusion test. ✓

**Placeholder scan:** No TBD/TODO. Frontend markup (Task 3) is concrete JS + a concrete section block, with an explicit instruction to align row classes to the existing trades cards during the eyeball step (frontend styling is verified visually, not by unit test). ✓

**Type consistency:** Row shape from `filterEngineTrades` (`symbol/side/qty/type/status/limitPrice/stopPrice/filledQty/filledAvgPrice/submittedAt/strategy/agentName`) is produced in Task 1 and consumed identically in Task 3's `renderEngineTrades`. `filterEngineTrades`/`normalizeEngineOrder`/`ENGINE_AGENTS` names match across tasks. Route returns `{ trades }` / `{ trades: [], unavailable: true }`, consumed by `fetchEngineTrades`. ✓
