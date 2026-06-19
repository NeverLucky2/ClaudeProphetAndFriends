# Prophet Debit Verticals — Phase 3b (Node MCP tools + flag-gated allowlist) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Phase 3a's Go vertical endpoints callable by Prophet's LLM — add 4 thin MCP proxy tools, keep the tool catalog in CI-sync, and gate the tools so they appear in Prophet's allowlist ONLY when `ENABLE_PROPHET_DEBIT_VERTICALS=true` (hide-when-off).

**Architecture:** Three Node edits mirror Prophet's existing single-leg options path. (1) `mcp-server.js` gains 4 inline tools (a schema object in the `ListToolsRequestSchema` array + a `case` in the call-handler `switch`), each a thin `callTradingBot` HTTP proxy to a Phase-3a Go endpoint. (2) `agent/tool-allowlists.js` adds the 4 names to `ALL_TOOLS` (CI catalog-sync), excludes them from Prophet's *static* computed list, and re-adds them at resolve time only when a `verticalsEnabled` flag is passed. (3) `agent/harness.js` reads `process.env.ENABLE_PROPHET_DEBIT_VERTICALS` and passes that boolean into `resolveAllowedTools`. The gating decision lives in the pure `resolveAllowedTools` function (unit-tested); the harness change is a trivial env-read.

**Tech Stack:** Node ESM, `node:test`/`node:assert`, `axios` (via the existing `callTradingBot` helper), the MCP `@modelcontextprotocol/sdk` server already wired in `mcp-server.js`.

---

## Background the engineer needs (verified facts)

**The 4 Phase-3a Go endpoints** (already built + merged; under the `/api/v1` group, which `callTradingBot` prepends automatically):

| Tool | Method + endpoint (pass to `callTradingBot`) | Request body | Success 200 |
|------|----------------------------------------------|--------------|-------------|
| `propose_debit_vertical` | `'/options/verticals/propose'`, `'POST'` | `{ underlying, direction, expiration, target_width }` | `{ proposal_id, card }` |
| `place_debit_vertical` | `'/options/verticals/place'`, `'POST'` | `{ proposal_id }` | `{ vertical_id }` |
| `list_debit_verticals` | `'/options/verticals'` (GET) | — | `{ verticals: [...] }` |
| `close_debit_vertical` | `'/options/verticals/close'`, `'POST'` | `{ vertical_id }` | `{ status }` |

- `direction` is the string `"call_debit"` (bullish) or `"put_debit"` (bearish) — the Go `ParseVerticalDirection` accepts exactly those.
- `expiration` is `YYYY-MM-DD`. **Use the property name `expiration`** (not the spec's shorthand "expiry") — it maps 1:1 to the Go `json:"expiration"` field and matches the existing `get_options_chain` tool.
- The Go endpoints reject with **403** `{"error":"debit verticals disabled"}` when the flag is OFF (defense-in-depth — the Node gating is the primary hide mechanism).
- **No `strategy` tag is added in the Node proxy** (unlike `place_options_order`). The Go executor stamps the `v2-vertical` `client_order_id` tag internally.

**The proxy helper** (`mcp-server.js:214`): `callTradingBot(endpoint, method='GET', data=null)`. On non-2xx it `throw`s an `Error` carrying the bot's `{error, details}` body (`formatTradingBotError`), which the outer `CallToolRequestSchema` handler converts to MCP error content — so 403 / 422 (guard, drift, TTL) rejections surface to the LLM verbatim. **Proxies need no special error handling** — copy the `place_options_order` shape exactly.

**The template** to copy: the `place_options_order` schema object (`mcp-server.js:864-904`, `name:` indented 8 spaces) and its handler `case` (`mcp-server.js:2127-2148`).

**Catalog-sync coupling** (`agent/tool-allowlists.test.mjs:20-28,39-48`): the test regex-scans `mcp-server.js` for `^\s{4,8}name:\s*'([a-z0-9_]+)'` and asserts the set **exactly** equals `ALL_TOOLS` (+ `regimeAndGuardTools`). Therefore the 4 names must be added to BOTH `mcp-server.js` and `ALL_TOOLS` in the same task or CI breaks. (The tool names are all lowercase+underscore, so they match the regex; the proxy handlers must not introduce any other 8-space-indented `name:` line.)

**The gating subtlety** (`agent/tool-allowlists.js:214`): Prophet's `'v2-options'` list is **computed** as `ALL_TOOLS.filter(t => !NON_PROPHET.has(t))`. So merely adding the 4 names to `ALL_TOOLS` would auto-expose them to Prophet *always*. To hide-when-off, the 4 names must ALSO be added to `NON_PROPHET` (excluded from the static list), then re-appended at resolve time when `verticalsEnabled` is true.

**Flag visibility (verified):** `agent/server.js:4` runs `import 'dotenv/config'`, and `agent/orchestrator.js:178` already reads `process.env.ENABLE_PROPHET_DEFENSIVE === 'true'` from the same root `.env`. So `process.env.ENABLE_PROPHET_DEBIT_VERTICALS === 'true'` resolves correctly in the Node harness.

**Tests run without `node_modules`** in the worktree — `tool-allowlists.test.mjs` uses only node built-ins + local files (verified: 13/13 pass at baseline). `node --check` is the syntax gate for `mcp-server.js`/`harness.js` (which DO import external deps and so are not executed here).

---

## File Structure

- **Modify** `mcp-server.js` — 4 tool schema objects (in the `ListToolsRequestSchema` tools array, beside the options tools) + 4 handler `case`s (in the `CallToolRequestSchema` switch, beside `place_options_order`).
- **Modify** `agent/tool-allowlists.js` — add 4 names to `ALL_TOOLS`; add a `VERTICAL_TOOLS` const; add it to `NON_PROPHET` and `_internals`; add a `verticalsEnabled` option to `resolveAllowedTools`.
- **Modify** `agent/tool-allowlists.test.mjs` — update the `v2-options` size assertion; add hide-when-off / show-when-on tests.
- **Modify** `agent/harness.js:1200` — read the env flag and pass `{ verticalsEnabled }` into `resolveAllowedTools`.

No new files. No Go changes (Phase 3a is complete). No dashboard.

---

## Task 1: Node MCP proxy tools + catalog sync

**Files:**
- Modify: `mcp-server.js` (tools array near `:904`; switch near `:2148`)
- Modify: `agent/tool-allowlists.js:23-106` (`ALL_TOOLS`)
- Test: `agent/tool-allowlists.test.mjs` (existing catalog-sync test is the driver)

- [ ] **Step 1: Add the 4 names to `ALL_TOOLS` (drives the failing test first)**

In `agent/tool-allowlists.js`, insert the 4 names into the `ALL_TOOLS` array in alphabetical position:
- `'close_debit_vertical',` — immediately before `'close_managed_position',`
- `'list_debit_verticals',` — immediately before `'list_news_summaries',`
- `'place_debit_vertical',` — immediately after `'place_buy_order',` (before `'place_managed_position',`)
- `'propose_debit_vertical',` — immediately after `'place_sell_order',` (before `'read_latest_report',`)

- [ ] **Step 2: Run the catalog-sync test to verify it fails**

Run: `node --test agent/tool-allowlists.test.mjs`
Expected: FAIL — `ALL_TOOLS exactly matches the live mcp-server catalog` reports `tools in ALL_TOOLS not found in mcp-server.js: close_debit_vertical, list_debit_verticals, place_debit_vertical, propose_debit_vertical`.

- [ ] **Step 3: Add the 4 tool schema objects to `mcp-server.js`**

Insert immediately AFTER the `place_options_order` tool object's closing `},` (the entry ending at `:904`) and BEFORE the `get_options_positions` object (`:905`). Keep the existing 8-space indentation of `name:`:

```js
      {
        name: 'propose_debit_vertical',
        description: 'Propose a defined-risk debit vertical spread (READ-ONLY — places no order). Returns a proposal_id plus a decision card: long/short strikes, net debit (= max loss), breakeven, max profit, and per-leg entry IV/greeks. Call place_debit_vertical with the proposal_id to submit the EXACT proposed strikes. Proposals expire after a few minutes.',
        inputSchema: {
          type: 'object',
          properties: {
            underlying: {
              type: 'string',
              description: 'Underlying stock symbol (e.g., AAPL, QQQ)',
            },
            direction: {
              type: 'string',
              description: 'call_debit = bullish (buy lower-strike call, sell higher-strike call); put_debit = bearish (buy higher-strike put, sell lower-strike put)',
              enum: ['call_debit', 'put_debit'],
            },
            expiration: {
              type: 'string',
              description: 'Expiration date in YYYY-MM-DD format',
            },
            target_width: {
              type: 'number',
              description: 'Desired dollar width between the long and short strikes (e.g., 5 for a $5-wide spread); a helper snaps to the nearest liquid strikes',
            },
          },
          required: ['underlying', 'direction', 'expiration', 'target_width'],
        },
      },
      {
        name: 'place_debit_vertical',
        description: 'Place a previously proposed debit vertical spread by its proposal_id. Submits the EXACT strikes from the proposal (re-priced for drift; rejected if the proposal expired or the net debit moved too far). One spread, 1 contract per leg.',
        inputSchema: {
          type: 'object',
          properties: {
            proposal_id: {
              type: 'string',
              description: 'The proposal_id returned by propose_debit_vertical',
            },
          },
          required: ['proposal_id'],
        },
      },
      {
        name: 'list_debit_verticals',
        description: 'List open debit vertical spreads with live value, unrealized P&L, days-to-expiry, backstop status, and the original entry decision card.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'close_debit_vertical',
        description: 'Request closing an open debit vertical spread by its vertical_id (closes both legs together, fail-closed).',
        inputSchema: {
          type: 'object',
          properties: {
            vertical_id: {
              type: 'string',
              description: 'The vertical_id from list_debit_verticals',
            },
          },
          required: ['vertical_id'],
        },
      },
```

- [ ] **Step 4: Add the 4 handler `case`s to `mcp-server.js`**

Insert immediately AFTER the `place_options_order` case's closing `}` (the case ending at `:2148`) and BEFORE `case 'get_options_positions':` (`:2150`):

```js
      case 'propose_debit_vertical': {
        const requestData = {
          underlying: args.underlying,
          direction: args.direction,
          expiration: args.expiration,
          target_width: args.target_width,
        };
        const data = await callTradingBot('/options/verticals/propose', 'POST', requestData);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      }

      case 'place_debit_vertical': {
        const data = await callTradingBot('/options/verticals/place', 'POST', { proposal_id: args.proposal_id });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      }

      case 'list_debit_verticals': {
        const data = await callTradingBot('/options/verticals');
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      }

      case 'close_debit_vertical': {
        const data = await callTradingBot('/options/verticals/close', 'POST', { vertical_id: args.vertical_id });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      }
```

- [ ] **Step 5: Verify catalog-sync passes and the server parses**

Run: `node --test agent/tool-allowlists.test.mjs`
Expected: PASS (13/13 — the catalog-sync test now balances; the `v2-options` size assertion still holds because `ALL_TOOLS` grew by 4 and the still-un-excluded `v2-options` list also grew by 4).

Run: `node --check mcp-server.js`
Expected: no output, exit 0 (no syntax error).

> Note: at the end of Task 1 the 4 tools are transiently present in Prophet's static `v2-options` list (gating arrives in Task 2). This is harmless — the Go endpoints still 403 while the flag is OFF. Task 2 removes them from the static list and adds the flag-gated re-add.

- [ ] **Step 6: Commit**

```bash
git add mcp-server.js agent/tool-allowlists.js
git commit -m "feat(prophet-vertical): Phase 3b — 4 MCP proxy tools for debit verticals + ALL_TOOLS sync"
```

---

## Task 2: Flag-gated allowlist (hide-when-off) + harness wiring

**Files:**
- Modify: `agent/tool-allowlists.js` (`VERTICAL_TOOLS`, `NON_PROPHET`, `resolveAllowedTools`, `_internals`)
- Modify: `agent/tool-allowlists.test.mjs` (size assertion + new gating tests)
- Modify: `agent/harness.js:1200`
- Test: `agent/tool-allowlists.test.mjs`

- [ ] **Step 1: Write the failing tests + update the size assertion**

In `agent/tool-allowlists.test.mjs`:

(a) Update the existing `v2-options` size assertion (currently at `:128`) to subtract the now-excluded vertical tools:

```js
  assert.equal(STRATEGY_TOOL_ALLOWLISTS['v2-options'].length, ALL_TOOLS.length - 5 - MANAGER_TOOLS.length - _internals.PROPHET_TRIM.length - _internals.VERTICAL_TOOLS.length);
```

(b) Append these new tests at the end of the file:

```js
test('debit-vertical tools are hidden from Prophet when verticalsEnabled is off', () => {
  const off = new Set(resolveAllowedTools([], 'v2-options'));
  const offExplicit = new Set(resolveAllowedTools([], 'v2-options', { verticalsEnabled: false }));
  for (const tool of _internals.VERTICAL_TOOLS) {
    assert.ok(!off.has(tool), `default (no opts) must hide vertical tool "${tool}"`);
    assert.ok(!offExplicit.has(tool), `verticalsEnabled:false must hide vertical tool "${tool}"`);
  }
});

test('debit-vertical tools are exposed to Prophet when verticalsEnabled is on', () => {
  const on = new Set(resolveAllowedTools([], 'v2-options', { verticalsEnabled: true }));
  for (const tool of _internals.VERTICAL_TOOLS) {
    assert.ok(on.has(tool), `verticalsEnabled:true must expose vertical tool "${tool}"`);
  }
  // The flag only ADDS verticals — every statically-allowed Prophet tool is still present.
  for (const tool of STRATEGY_TOOL_ALLOWLISTS['v2-options']) {
    assert.ok(on.has(tool), `enabling verticals must not drop base tool "${tool}"`);
  }
});

test('verticalsEnabled only affects v2-options, never other strategies', () => {
  for (const strat of ['mean-rev-rsi2', 'earnings-drift', 'trend']) {
    const on = new Set(resolveAllowedTools([], strat, { verticalsEnabled: true }));
    for (const tool of _internals.VERTICAL_TOOLS) {
      assert.ok(!on.has(tool), `${strat} must not get vertical tool "${tool}" even when verticalsEnabled`);
    }
  }
});

test('a non-empty sandbox override still wins even when verticalsEnabled', () => {
  const override = ['get_account', 'get_quote'];
  assert.deepEqual(resolveAllowedTools(override, 'v2-options', { verticalsEnabled: true }), override);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test agent/tool-allowlists.test.mjs`
Expected: FAIL — `_internals.VERTICAL_TOOLS` is `undefined` (TypeError on `.length` / iteration) and the hide test fails because the static `v2-options` list still contains the 4 tools.

- [ ] **Step 3: Implement the gating in `agent/tool-allowlists.js`**

(a) Define `VERTICAL_TOOLS` near the other signal-group consts (after the `DRIFT_SIGNALS` line, `:141`):

```js
// Prophet debit-vertical tools (Phase 3b). Default-hidden from Prophet's static
// allowlist (added to NON_PROPHET below) and re-added at resolve time only when
// the caller passes verticalsEnabled — driven by ENABLE_PROPHET_DEBIT_VERTICALS
// (read in harness.js). OFF => absent from the LLM's catalog => zero token cost,
// nothing callable. The Go endpoints also 403 when off (defense-in-depth).
export const VERTICAL_TOOLS = [
  'propose_debit_vertical',
  'place_debit_vertical',
  'list_debit_verticals',
  'close_debit_vertical',
];
```

(b) Add `...VERTICAL_TOOLS` to the `NON_PROPHET` set (currently `:199-205`):

```js
const NON_PROPHET = new Set([
  ...TREND_SIGNALS,
  ...MEANREV_SIGNALS,
  ...DRIFT_SIGNALS,
  ...MANAGER_TOOLS,
  ...PROPHET_TRIM,
  ...VERTICAL_TOOLS,
]);
```

(c) Add a third `opts` parameter to `resolveAllowedTools` (currently `:220-224`) that re-adds the vertical tools for `v2-options` when enabled:

```js
export function resolveAllowedTools(sandboxAllow, strategyId, opts = {}) {
  const sb = Array.isArray(sandboxAllow) ? sandboxAllow.filter(Boolean) : [];
  if (sb.length > 0) return sb;
  const base = STRATEGY_TOOL_ALLOWLISTS[strategyId] || [];
  if (strategyId === 'v2-options' && opts.verticalsEnabled) {
    return [...base, ...VERTICAL_TOOLS];
  }
  return base;
}
```

(d) Expose `VERTICAL_TOOLS` on `_internals` (currently `:227-235`) by adding the line `VERTICAL_TOOLS,` inside the object.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test agent/tool-allowlists.test.mjs`
Expected: PASS (all tests, including the updated size assertion and the 4 new gating tests).

- [ ] **Step 5: Wire the env flag in `agent/harness.js`**

Replace the call at `agent/harness.js:1200`:

```js
      const allowedTools = resolveAllowedTools(perms.allowedTools, this._agentConfig?.strategyId);
```

with:

```js
      const allowedTools = resolveAllowedTools(perms.allowedTools, this._agentConfig?.strategyId, {
        verticalsEnabled: process.env.ENABLE_PROPHET_DEBIT_VERTICALS === 'true',
      });
```

- [ ] **Step 6: Verify the harness parses**

Run: `node --check agent/harness.js`
Expected: no output, exit 0.

- [ ] **Step 7: Commit**

```bash
git add agent/tool-allowlists.js agent/tool-allowlists.test.mjs agent/harness.js
git commit -m "feat(prophet-vertical): Phase 3b — flag-gate vertical tools into Prophet's allowlist (hide-when-off)"
```

---

## Final verification

- [ ] **Step 1: Full allowlist suite + syntax checks**

Run: `node --test agent/tool-allowlists.test.mjs`
Expected: PASS, 0 fail.

Run: `node --check mcp-server.js && node --check agent/harness.js`
Expected: exit 0.

- [ ] **Step 2: Confirm gating both ways from the resolver (sanity, no env needed)**

Run:
```bash
node --input-type=module -e "import { resolveAllowedTools, VERTICAL_TOOLS } from './agent/tool-allowlists.js'; const off = resolveAllowedTools([], 'v2-options'); const on = resolveAllowedTools([], 'v2-options', { verticalsEnabled: true }); console.log('off has verticals:', VERTICAL_TOOLS.some(t => off.includes(t))); console.log('on has all verticals:', VERTICAL_TOOLS.every(t => on.includes(t)));"
```
Expected: `off has verticals: false` then `on has all verticals: true`.

- [ ] **Step 3: Hand off**

Use superpowers:finishing-a-development-branch.

---

## Self-review checklist (run before declaring the plan done)

1. **Spec coverage:** Node 4 tools (Task 1) ✓; `ALL_TOOLS` sync (Task 1) ✓; hide-when-off harness flag-read (Task 2) ✓; guard parity / proposal store / endpoints were Phase 3a (out of scope here) ✓.
2. **Placeholders:** none — every code step shows complete code.
3. **Name consistency:** tool names identical across `ALL_TOOLS`, `VERTICAL_TOOLS`, the `mcp-server.js` schema `name:` fields, the handler `case` labels, and the Go endpoint paths. `expiration` (not `expiry`) used consistently and matches the Go `json:"expiration"`.

## Deploy note (post-merge, user action)

Phase 3b is **Node-only** — activating it needs a **Node orchestrator restart** (no Go rebuild; the Go bot was already rebuilt for the safety fix + 3a). It stays inert until `ENABLE_PROPHET_DEBIT_VERTICALS=true` is set in the root `.env` AND the Node orchestrator is restarted. With the flag on, Prophet's LLM sees the 4 tools and the (already-live) Go endpoints accept them. Recommended first run: paper account, watch one propose→place→list→close cycle.
