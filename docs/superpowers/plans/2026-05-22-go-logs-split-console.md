# Go Logs → Per-Agent Split Console — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route each agent's Go-backend logs into a dedicated side pane within its Terminal, keeping the LLM-reasoning pane clean, while mirroring backend *errors* into both panes.

**Architecture:** Producer (`orchestrator.js`) stamps `source: 'go'` on the Go `agent_log` events via a tiny `goLog()` helper. A pure `classifyLogPanes()` helper (browser-served + Node-tested) decides per line whether it renders in the reasoning pane, the Go console, or both. The browser's single `agent_log` SSE handler consults the classifier and appends to the matching pane(s) of the line's sandbox.

**Tech Stack:** Node.js (ESM, `node:test`), vanilla browser JS in a single inline `<script>`, Express static serving from `agent/public/`.

**Spec:** `docs/superpowers/specs/2026-05-22-go-logs-split-console-design.md`

---

## File Structure

**New files:**
- `agent/public/log-source.js` — pure `classifyLogPanes(event) → { main, go }`. Lives under `public/` so the browser can `import` it; it is also imported directly by the Node test. (Spec §5 named this `agent/log-source.mjs`; moved into `public/` because the browser must fetch it and `express.static` only serves `agent/public/`. Behavior identical.)
- `agent/log-source.test.mjs` — `node:test` suite for the classifier. Kept out of `public/` so test code is not web-served.
- `agent/go-log.js` — pure `goLog(sandboxId, level, message) → { sandboxId, level, message, source: 'go' }`. Single definition of the Go-log event shape; guarantees no emit site forgets the field.
- `agent/go-log.test.mjs` — `node:test` suite for `goLog`.

**Modified files:**
- `agent/orchestrator.js` — import `goLog`; route all 6 Go `agent_log` emits through it.
- `agent/public/index.html` — Go Console CSS, pane DOM in `ensureSandboxTerminal`, `goTermEl` on the terminal record, classifier module shim, `logToGoConsole`, `agent_log` routing, `filterGoConsole`, `toggleGoConsole` + persistence.

**Note on testing scope:** The codebase has no browser/DOM test harness (`index.html` is untested by convention). Pure logic (`classifyLogPanes`, `goLog`) gets full TDD with `node:test`. The DOM wiring tasks (3–6) are edit + **manual verification** + commit, consistent with the existing codebase. Task 7 is the integration verification.

---

## Task 1: Pure pane classifier + tests

**Files:**
- Create: `agent/public/log-source.js`
- Test: `agent/log-source.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `agent/log-source.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLogPanes } from './public/log-source.js';

test('non-Go line (no source, no prefix) → reasoning pane only', () => {
  assert.deepEqual(
    classifyLogPanes({ message: 'Beat #12: scanning momentum', level: 'info' }),
    { main: true, go: false },
  );
});

test('Go info (source flag) → Go console only', () => {
  assert.deepEqual(
    classifyLogPanes({ source: 'go', message: '[go:4536] fetching bars', level: 'info' }),
    { main: false, go: true },
  );
});

test('Go stderr warning → Go console only (routine, not mirrored)', () => {
  assert.deepEqual(
    classifyLogPanes({ source: 'go', message: '[go:4536] slow response', level: 'warning' }),
    { main: false, go: true },
  );
});

test('Go ready (success) → Go console only', () => {
  assert.deepEqual(
    classifyLogPanes({ source: 'go', message: 'Trading backend ready on port 4536', level: 'success' }),
    { main: false, go: true },
  );
});

test('Go error (crash) → both panes', () => {
  assert.deepEqual(
    classifyLogPanes({ source: 'go', message: 'Trading backend crashed — auto-restarting', level: 'error' }),
    { main: true, go: true },
  );
});

test('untagged [go:PORT] info (regex fallback) → Go console only', () => {
  assert.deepEqual(
    classifyLogPanes({ message: '[go:4536] legacy line', level: 'info' }),
    { main: false, go: true },
  );
});

test('untagged [go:PORT] error → both panes', () => {
  assert.deepEqual(
    classifyLogPanes({ message: '[go:4536] boom', level: 'error' }),
    { main: true, go: true },
  );
});

test('empty / missing input defaults to reasoning pane only (never vanishes)', () => {
  assert.deepEqual(classifyLogPanes(), { main: true, go: false });
  assert.deepEqual(classifyLogPanes({}), { main: true, go: false });
  assert.deepEqual(classifyLogPanes({ message: undefined }), { main: true, go: false });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test agent/log-source.test.mjs`
Expected: FAIL — cannot find module `./public/log-source.js`.

- [ ] **Step 3: Write the minimal implementation**

Create `agent/public/log-source.js`:

```js
// Pure classifier: decides which dashboard pane(s) an agent_log line renders into.
// Used by the browser (imported as an ES module) AND by node:test.
// Contract: a Go line is one the orchestrator tagged source:'go', or any line
// still carrying the legacy "[go:PORT]" prefix. Go errors mirror into the
// reasoning pane so a failure is impossible to miss; routine Go output does not.
// (Producer side stamps source:'go' via agent/go-log.js.)
export function classifyLogPanes({ source, message, level } = {}) {
  const isGo = source === 'go' || /^\[go:\d+\]/.test(String(message ?? ''));
  if (!isGo) return { main: true, go: false };
  return { main: level === 'error', go: true };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test agent/log-source.test.mjs`
Expected: PASS — 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add agent/public/log-source.js agent/log-source.test.mjs
git commit -m "Add pure classifyLogPanes helper for Go-log pane routing"
```

---

## Task 2: Producer `goLog` helper + wire orchestrator emits

**Files:**
- Create: `agent/go-log.js`
- Test: `agent/go-log.test.mjs`
- Modify: `agent/orchestrator.js` (import + 6 emit sites)

- [ ] **Step 1: Write the failing test**

Create `agent/go-log.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { goLog } from './go-log.js';

test('stamps source:"go" and passes through fields', () => {
  assert.deepEqual(
    goLog('s_prophet', 'info', '[go:4536] fetching bars'),
    { sandboxId: 's_prophet', level: 'info', message: '[go:4536] fetching bars', source: 'go' },
  );
});

test('preserves error level for lifecycle lines', () => {
  assert.deepEqual(
    goLog('s_turtle', 'error', 'Trading backend crashed — auto-restarting in 5s...'),
    { sandboxId: 's_turtle', level: 'error', message: 'Trading backend crashed — auto-restarting in 5s...', source: 'go' },
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test agent/go-log.test.mjs`
Expected: FAIL — cannot find module `./go-log.js`.

- [ ] **Step 3: Write the minimal implementation**

Create `agent/go-log.js`:

```js
// Build an agent_log payload tagged as Go-backend output so the dashboard routes
// it to the per-agent Go console (and mirrors it into reasoning when level==='error').
// Single source of truth for the Go-log event shape — every orchestrator emit for
// the Go backend goes through here so the source tag can never be forgotten.
// The consumer side is agent/public/log-source.js (classifyLogPanes).
export function goLog(sandboxId, level, message) {
  return { sandboxId, level, message, source: 'go' };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test agent/go-log.test.mjs`
Expected: PASS — 2 tests pass.

- [ ] **Step 5: Add the import to `orchestrator.js`**

In `agent/orchestrator.js`, after the existing line:

```js
import { candidateWarmerFlags } from './candidate-warmer-flags.js';
```

add:

```js
import { goLog } from './go-log.js';
```

- [ ] **Step 6: Route emit site 1 — bot stdout (~line 212)**

Replace:

```js
        this.emit('agent_log', {
          sandboxId,
          level: 'info',
          message: `[go:${runtime.port}] ${message}`,
        });
```

with:

```js
        this.emit('agent_log', goLog(sandboxId, 'info', `[go:${runtime.port}] ${message}`));
```

- [ ] **Step 7: Route emit site 2 — bot stderr (~line 223)**

Replace:

```js
        this.emit('agent_log', {
          sandboxId,
          level: 'warning',
          message: `[go:${runtime.port}] ${message}`,
        });
```

with:

```js
        this.emit('agent_log', goLog(sandboxId, 'warning', `[go:${runtime.port}] ${message}`));
```

- [ ] **Step 8: Route emit site 3 — backend exited (~line 234)**

Replace:

```js
      this.emit('agent_log', {
        sandboxId,
        level: code === 0 || signal === 'SIGTERM' ? 'info' : 'error',
        message: `Trading backend exited (code: ${code}, signal: ${signal})`,
      });
```

with:

```js
      this.emit('agent_log', goLog(sandboxId, code === 0 || signal === 'SIGTERM' ? 'info' : 'error', `Trading backend exited (code: ${code}, signal: ${signal})`));
```

- [ ] **Step 9: Route emit site 4 — crash / auto-restart (~line 242)**

Replace:

```js
        this.emit('agent_log', {
          sandboxId,
          level: 'error',
          message: 'Trading backend crashed — auto-restarting in 5s...',
        });
```

with:

```js
        this.emit('agent_log', goLog(sandboxId, 'error', 'Trading backend crashed — auto-restarting in 5s...'));
```

- [ ] **Step 10: Route emit site 5 — auto-restart failed (~line 250)**

Replace:

```js
            this.emit('agent_log', {
              sandboxId,
              level: 'error',
              message: `Auto-restart failed: ${err.message}`,
            });
```

with:

```js
            this.emit('agent_log', goLog(sandboxId, 'error', `Auto-restart failed: ${err.message}`));
```

- [ ] **Step 11: Route emit site 6 — backend ready (~line 265)**

Replace:

```js
        this.emit('agent_log', {
          sandboxId,
          level: 'success',
          message: `Trading backend ready on port ${runtime.port} for ${account.name}`,
        });
```

with:

```js
        this.emit('agent_log', goLog(sandboxId, 'success', `Trading backend ready on port ${runtime.port} for ${account.name}`));
```

- [ ] **Step 12: Verify the helper test passes and orchestrator still imports cleanly**

Run: `node --test agent/go-log.test.mjs agent/orchestrator-emergency.test.mjs`
Expected: PASS — `orchestrator-emergency.test.mjs` importing `orchestrator.js` confirms no syntax/import regression from the edits.

- [ ] **Step 13: Commit**

```bash
git add agent/go-log.js agent/go-log.test.mjs agent/orchestrator.js
git commit -m "Tag Go-backend agent_log emits with source:'go' via goLog helper"
```

---

## Task 3: Go Console pane scaffold (CSS + DOM + record field)

**Files:**
- Modify: `agent/public/index.html` (CSS block ~842; `ensureSandboxTerminal` markup ~2865 and record ~2931)

At the end of this task the pane renders (empty) to the right of each agent's reasoning terminal. No log routing yet.

- [ ] **Step 1: Add the Go Console CSS**

In `agent/public/index.html`, after:

```css
    .stat-value.positive { color: var(--success); }
    .stat-value.negative { color: var(--error); }
```

insert:

```css

    /* ── Go Console split pane (per-agent backend logs) ── */
    .go-pane {
      display: flex; flex-direction: column;
      flex: 0.8 1 0; min-width: 0;
      border-left: 1px solid var(--rule);
      background: var(--paper); overflow: hidden;
    }
    .go-pane-header {
      display: flex; align-items: center; gap: 8px;
      padding: 6px 10px; flex-shrink: 0;
      border-bottom: 1px solid var(--rule-light);
      font-size: 10px; text-transform: uppercase; letter-spacing: 1px;
      color: var(--ink-muted);
    }
    .go-pane-title { font-weight: 700; }
    .go-pane-port { color: var(--ink-faint); font-family: 'IBM Plex Mono', monospace; letter-spacing: 0; text-transform: none; }
    .go-pane-count { color: var(--ink-faint); font-family: 'IBM Plex Mono', monospace; letter-spacing: 0; }
    .go-pane-search {
      margin-left: auto; width: 110px; max-width: 45%;
      padding: 2px 6px; font-size: 11px;
      background: var(--paper-dark); color: var(--ink);
      border: 1px solid var(--rule); border-radius: 3px;
    }
    .go-pane-search:focus { outline: none; border-color: var(--accent); }
    .go-pane-search::placeholder { color: var(--ink-faint); }
    .go-pane-collapse {
      flex-shrink: 0; cursor: pointer;
      background: var(--paper-dark); color: var(--ink-muted);
      border: 1px solid var(--rule); border-radius: 3px;
      padding: 1px 7px; font-size: 12px; line-height: 1.2;
    }
    .go-pane-collapse:hover { border-color: var(--ink-muted); }
    .go-console {
      flex: 1; overflow-y: auto; padding: 8px 10px;
      font-family: 'IBM Plex Mono', monospace; min-height: 0;
    }
    .go-console::-webkit-scrollbar { width: 4px; }
    .go-console::-webkit-scrollbar-thumb { background: var(--rule); }
    /* Collapsed: fold to a slim bar; reasoning reclaims the width. */
    .go-pane.collapsed { flex: 0 0 auto; }
    .go-pane.collapsed .go-console,
    .go-pane.collapsed .go-pane-search { display: none; }
    .go-pane.collapsed .go-pane-header { border-bottom: none; }
    @media (max-width: 768px) {
      .go-pane { flex: 1 1 auto; border-left: none; border-top: 1px solid var(--rule); }
    }
```

- [ ] **Step 2: Inject the Go Console DOM in `ensureSandboxTerminal`**

In the `ensureSandboxTerminal` template literal, replace:

```js
      </div>
      <div class="sidebar">
        <div class="section">
          <div class="section-title">Account</div>
```

with:

```js
      </div>
      <div class="go-pane ${goConsoleCollapsed() ? 'collapsed' : ''}" data-go-pane="${sandboxId}">
        <div class="go-pane-header">
          <span class="go-pane-title">Go Console</span>
          <span class="go-pane-port" data-go-port="${sandboxId}"></span>
          <span class="go-pane-count" data-go-count="${sandboxId}"></span>
          <input type="text" class="go-pane-search" placeholder="Filter…" autocomplete="off"
                 oninput="filterGoConsole('${sandboxId}')" data-go-search="${sandboxId}">
          <button class="go-pane-collapse" onclick="toggleGoConsole()" title="Collapse / expand Go console">${goConsoleCollapsed() ? '+' : '–'}</button>
        </div>
        <div class="terminal go-console" data-terminal-go="${sandboxId}"></div>
      </div>
      <div class="sidebar">
        <div class="section">
          <div class="section-title">Account</div>
```

> Note: `goConsoleCollapsed()`, `filterGoConsole()`, and `toggleGoConsole()` are added in Tasks 5–6. The template only *references* them; they are called at click/render time, after the script has fully parsed. To keep this task self-contained and the page error-free in the meantime, define the three as no-op-safe stubs now (Step 3) — Tasks 5–6 replace them with real bodies.

- [ ] **Step 3: Add temporary stubs so the page is error-free before Tasks 5–6**

In `agent/public/index.html`, immediately after the `function logToSandbox(sandboxId, html) { ... }` definition (~line 3238), add:

```js
// --- Go Console stubs (real implementations added in later tasks) ---
function goConsoleCollapsed() { return localStorage.getItem('goConsoleCollapsed') === '1'; }
function filterGoConsole(sandboxId) { /* implemented in Task 5 */ }
function toggleGoConsole() { /* implemented in Task 6 */ }
```

- [ ] **Step 4: Add `goTermEl` to the sandbox terminal record**

Replace:

```js
  sandboxTerminals[sandboxId] = { el: wrapper, termEl: wrapper.querySelector('[data-terminal]') };
```

with:

```js
  sandboxTerminals[sandboxId] = { el: wrapper, termEl: wrapper.querySelector('[data-terminal]'), goTermEl: wrapper.querySelector('[data-terminal-go]') };
```

- [ ] **Step 5: Manual verification**

Run: `npm run agent` (starts the dashboard on its configured port), open the dashboard, select an agent's Terminal sub-tab.
Expected: a third column "Go Console" appears between the reasoning terminal and the stats sidebar, with a title, an empty filter box, and a collapse button. No console errors. The Manager tab is unchanged (no Go Console).

- [ ] **Step 6: Commit**

```bash
git add agent/public/index.html
git commit -m "Add empty Go Console split pane to each agent terminal"
```

---

## Task 4: Classifier shim + log routing into the panes

**Files:**
- Modify: `agent/public/index.html` (module shim ~1506; `logToGoConsole` near `logToSandbox` ~3238; `agent_log` handler ~1853)

- [ ] **Step 1: Load the classifier into the browser as a module**

In `agent/public/index.html`, replace:

```html
  <div class="modal" id="modal-content"></div>
</div>

<script>
```

with:

```html
  <div class="modal" id="modal-content"></div>
</div>

<script type="module">
  // Share the pure classifier with the inline script below via a global.
  import { classifyLogPanes } from './log-source.js';
  window.classifyLogPanes = classifyLogPanes;
</script>

<script>
```

- [ ] **Step 2: Add `logToGoConsole`**

In `agent/public/index.html`, immediately after the `logToSandbox` function (~line 3238), add:

```js
const GO_CONSOLE_MAX = 500; // scrollback cap — Go output is high-volume
function logToGoConsole(sandboxId, html, rawMessage) {
  const t = sandboxTerminals[sandboxId];
  if (!t || !t.goTermEl) return;
  const el = t.goTermEl;
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
  el.insertAdjacentHTML('beforeend', html);
  while (el.children.length > GO_CONSOLE_MAX) el.removeChild(el.firstChild);
  if (nearBottom) el.scrollTop = el.scrollHeight;
  // Lazily label the pane with the backend port parsed from "[go:PORT]".
  const portEl = document.querySelector(`[data-go-port="${sandboxId}"]`);
  if (portEl && !portEl.textContent && rawMessage) {
    const m = /^\[go:(\d+)\]/.exec(rawMessage);
    if (m) portEl.textContent = ':' + m[1];
  }
  const countEl = document.querySelector(`[data-go-count="${sandboxId}"]`);
  if (countEl) countEl.textContent = '· ' + el.children.length;
}
```

- [ ] **Step 3: Route the `agent_log` handler through the classifier**

Replace:

```js
  es.addEventListener('agent_log', e => {
    const d = JSON.parse(e.data);
    const sid = d.sandboxId || getEffectiveSandboxId();
    const html = `<div class="log-entry ${d.level||'info'}"><span class="time">${fmtTime()}</span>${esc(d.message)}</div>`;
    logToSandbox(sid, html);
    log(formatSandboxPrefix(d) + d.message, d.level || 'info');
  });
```

with:

```js
  es.addEventListener('agent_log', e => {
    const d = JSON.parse(e.data);
    const sid = d.sandboxId || getEffectiveSandboxId();
    const route = (window.classifyLogPanes || (() => ({ main: true, go: false })))(d);
    const html = `<div class="log-entry ${d.level||'info'}"><span class="time">${fmtTime()}</span>${esc(d.message)}</div>`;
    if (route.main) logToSandbox(sid, html);
    if (route.go) logToGoConsole(sid, html, d.message);
    log(formatSandboxPrefix(d) + d.message, d.level || 'info');
  });
```

> The `(window.classifyLogPanes || fallback)` guard makes the handler safe even if the deferred module has not finished loading when the first event arrives — it falls back to reasoning-pane-only, never dropping a line.

- [ ] **Step 4: Manual verification**

Run: `npm run agent`, open the dashboard, start an agent, watch its Terminal.
Expected:
- `[go:PORT] …` lines appear in the **Go Console**, not in the reasoning pane.
- Beats / tool calls / reasoning appear in the **reasoning pane** only.
- The Go Console header shows the port (e.g. `:4536`) and a live line count.
- To confirm error mirroring without a real crash: in the browser devtools console run
  ```js
  document.querySelector('[data-go-port]'); // confirm a sid, e.g. "default"
  ```
  then dispatch a synthetic event isn't necessary — instead stop the Go backend for that agent (Stop, or kill the `prophet_bot` process) and confirm the red `Trading backend exited …` / `crashed …` line appears in **both** panes.

- [ ] **Step 5: Commit**

```bash
git add agent/public/index.html
git commit -m "Route Go logs into the Go console; mirror errors into reasoning"
```

---

## Task 5: Go Console search filter

**Files:**
- Modify: `agent/public/index.html` (replace the `filterGoConsole` stub ~3240)

- [ ] **Step 1: Replace the stub with the real filter**

Replace:

```js
function filterGoConsole(sandboxId) { /* implemented in Task 5 */ }
```

with:

```js
function filterGoConsole(sandboxId) {
  const search = (document.querySelector(`[data-go-search="${sandboxId}"]`)?.value || '').toLowerCase();
  const el = sandboxTerminals[sandboxId]?.goTermEl;
  if (!el) return;
  el.querySelectorAll('.log-entry').forEach(entry => {
    entry.style.display = !search || entry.textContent.toLowerCase().includes(search) ? '' : 'none';
  });
}
```

- [ ] **Step 2: Manual verification**

Run: `npm run agent`, open an agent with Go logs flowing, type a substring (e.g. a symbol or `accepted`) into the Go Console filter box.
Expected: only matching `[go:…]` lines remain visible in the Go Console; clearing the box restores all. The reasoning pane and its own search bar are unaffected.

- [ ] **Step 3: Commit**

```bash
git add agent/public/index.html
git commit -m "Add search filter to the Go console"
```

---

## Task 6: Collapse toggle + persistence

**Files:**
- Modify: `agent/public/index.html` (replace the `goConsoleCollapsed` and `toggleGoConsole` stubs ~3238)

- [ ] **Step 1: Replace the stubs with real implementations**

Replace:

```js
function goConsoleCollapsed() { return localStorage.getItem('goConsoleCollapsed') === '1'; }
function filterGoConsole(sandboxId) {
```

with:

```js
const GO_CONSOLE_COLLAPSED_KEY = 'goConsoleCollapsed';
function goConsoleCollapsed() { return localStorage.getItem(GO_CONSOLE_COLLAPSED_KEY) === '1'; }
function toggleGoConsole() {
  const next = !goConsoleCollapsed();
  localStorage.setItem(GO_CONSOLE_COLLAPSED_KEY, next ? '1' : '0');
  document.querySelectorAll('.go-pane').forEach(pane => {
    pane.classList.toggle('collapsed', next);
    const btn = pane.querySelector('.go-pane-collapse');
    if (btn) btn.textContent = next ? '+' : '–';
  });
}
function filterGoConsole(sandboxId) {
```

- [ ] **Step 2: Remove the now-duplicate `goConsoleCollapsed` stub and the `toggleGoConsole` stub**

Delete the Task 3 stub block that now conflicts. Remove these three lines (the old stub set):

```js
// --- Go Console stubs (real implementations added in later tasks) ---
function toggleGoConsole() { /* implemented in Task 6 */ }
```

(The `goConsoleCollapsed` line was rewritten in Step 1; the `filterGoConsole` stub was already replaced in Task 5. Ensure exactly one definition of each of the three functions remains.)

- [ ] **Step 3: Manual verification**

Run: `npm run agent`, open an agent's Terminal.
Expected:
- Clicking the collapse button (`–`) folds **every** agent's Go Console to a slim header bar (showing title + port + line count) and the reasoning pane widens; the button shows `+`.
- Reloading the page keeps the Go Console collapsed (localStorage persisted); newly created agent tabs also start collapsed.
- Clicking `+` expands them again and persists across reload.
- While collapsed, force a backend error (Stop the agent) and confirm the red error line still appears in the reasoning pane — collapsing never hides a failure.

- [ ] **Step 4: Commit**

```bash
git add agent/public/index.html
git commit -m "Add collapse toggle + localStorage persistence to the Go console"
```

---

## Task 7: Full verification + spec status

**Files:**
- Modify: `docs/superpowers/specs/2026-05-22-go-logs-split-console-design.md` (status line)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all suites pass, including the new `agent/log-source.test.mjs` (8) and `agent/go-log.test.mjs` (2). No regressions in `orchestrator-emergency`, `harness`, etc.

- [ ] **Step 2: End-to-end manual check**

Run: `npm run agent`, start at least two agents. Confirm:
- Each agent's `[go:PORT]` chatter is in its own Go Console; reasoning panes show only beats/reasoning/tools.
- Each Go Console shows the correct, distinct port label.
- A backend error/exit on one agent mirrors into that agent's reasoning pane and Go Console, and does not leak into the other agent's panes.
- Switching sandbox sub-tabs shows the correct per-agent Go Console.
- The Manager tab has no Go Console and is visually unchanged.
- Collapse state persists across reload.

- [ ] **Step 3: Update the spec status**

In `docs/superpowers/specs/2026-05-22-go-logs-split-console-design.md`, change:

```markdown
**Status:** ✅ Design — approved in brainstorming, ready for implementation planning.
```

to:

```markdown
**Status:** ✅ Implemented (branch `go-logs-split-console`).
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-05-22-go-logs-split-console-design.md
git commit -m "Mark Go-logs split-console spec implemented"
```

---

## Self-Review

**1. Spec coverage** (each spec section → task):
- §2.1 per-agent not shared → Tasks 3–4 render into each sandbox's own `goTermEl`. ✓
- §2.2 split pane placement → Task 3 (DOM/CSS between reasoning and sidebar). ✓
- §2.3 errors mirror to both → Task 1 classifier (`level==='error'` ⇒ both) + Task 4 routing. ✓
- §2.4 producer `source` field → Task 2 (`goLog` on 6 sites). ✓
- §2.5 collapse instead of inline mode → Task 6. ✓
- §4 six emit sites → Task 2 Steps 6–11 (all six). ✓
- §5 classifier contract → Task 1 (exact function + table cases). ✓
- §6 UX: layout/header/search/collapse+localStorage/scrollback/manager-excluded/mobile → Tasks 3–6 (CSS incl. `@media`; Manager untouched because only `ensureSandboxTerminal` changes). ✓
- §7 testing → Tasks 1, 2, 7. ✓
- §9 nuances: stderr stays `warning` (Task 2 site 2 keeps `'warning'`); post-crash `ready` is Go-only (classifier: `success` ⇒ go-only). ✓

**2. Placeholder scan:** No TBD/TODO in code steps; every code step shows full content. The "implemented in Task N" strings appear only inside intentional temporary stubs (Task 3 Step 3) that are explicitly replaced in Tasks 5–6, and Task 6 Step 2 verifies exactly one definition of each remains.

**3. Type/name consistency:** `classifyLogPanes` returns `{ main, go }` everywhere (Tasks 1, 4). `goLog(sandboxId, level, message)` signature consistent (Tasks 2). DOM hooks consistent across tasks: `data-go-pane`, `data-go-port`, `data-go-count`, `data-go-search`, `data-terminal-go`, and record field `goTermEl`. Functions `goConsoleCollapsed` / `filterGoConsole` / `toggleGoConsole` defined once after the stubs are reconciled. localStorage key `'goConsoleCollapsed'` matches between `goConsoleCollapsed()` and `toggleGoConsole()`.

**Risk noted for execution:** Tasks 3→6 mutate overlapping regions of `index.html` (the stub block). Execute them in order; Task 6 Step 2 explicitly reconciles the stubs. If executing out of order, expect duplicate-function-definition errors.
