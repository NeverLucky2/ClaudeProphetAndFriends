# Terminal Tabs Per Sandbox + Cross-Tab Status Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two regressions from PR #41 (account dedup): collapse-to-one-tab in the terminal tab strip and missing cross-surface status sync. Plus: drag-to-reorder sandbox tabs, persisted in `localStorage`.

**Architecture:** Pure client-side change in one monolithic file (`agent/public/index.html`). One ordering-by-saved-localStorage-then-`createdAt` helper, one tab-strip render rewrite keyed by sandboxId, one SSE handler patch that locally mutates `window._healthState` and re-renders both surfaces. Drag uses the native HTML5 drag-and-drop API; persistence is a single JSON array under `prophet:sandbox-tab-order`.

**Tech Stack:** Vanilla browser JS (no framework), inline `<script>` in `agent/public/index.html`, SSE-driven state, `window.localStorage`.

**Spec:** `docs/superpowers/specs/2026-05-18-terminal-tabs-per-sandbox-design.md`

**Verification mode:** This file is a monolithic SPA with no JS module boundary and no existing test harness for `agent/public/index.html` UI code. The approved spec accepts manual smoke as the verification path for this PR, with an out-of-scope follow-up to carve render functions into testable modules. **Every task ends with a concrete manual smoke step the engineer must execute against a running dashboard before committing** — this is the "executor verification" surrogate for unit tests in this single PR.

**Workspace assumptions:**
- You are on branch `feat-accounts-tab-redesign` with PR #41's commits already present.
- The dashboard runs at `http://localhost:3737` via `npm run agent`. Have it open in a browser before you start.
- You have at least 2 sandboxes configured in `config.sandboxes` (ideally the 4-sandbox setup: Paper, Harvest, Turtle, Spark).
- One squashed commit per backlog item is the user's preference (memory: workflow-preferences). The intermediate commits below should be squashed at PR-ready time.

---

## File map

**Modified:** `agent/public/index.html` (only)

Insertion points referenced by current-file line numbers:

| What | File:line | Notes |
|---|---|---|
| CSS additions | `agent/public/index.html:753` (after the existing `.dot.stopped` rule) | 4 new rules |
| Tab-order helpers (`TAB_ORDER_STORAGE_KEY`, `loadTabOrder`, `saveTabOrder`, `getSandboxTabOrder`, `teardownSandboxTerminal`, drag-state var) | `agent/public/index.html:1523` (immediately after `getSandboxEntries`) | New block |
| `getEffectiveSandboxId` extension | `agent/public/index.html:1525-1529` (replace body) | Body rewrite |
| SSE `status` handler patch | `agent/public/index.html:1771-1775` (replace body) | Body rewrite |
| Drag handler functions | `agent/public/index.html:3038` (immediately before `switchSandboxTab`) | 5 new functions |
| `renderSandboxTabs` rewrite | `agent/public/index.html:2859-2892` (replace body) | Body rewrite |

Note: line numbers refer to the file's state at commit `16e7318`. After any edit, subsequent line numbers shift. Always re-locate by anchor symbol (`function renderSandboxTabs`, `es.addEventListener('status'`, etc.) rather than trusting numeric lines.

---

## Task 1: Add CSS rules

**Files:**
- Modify: `agent/public/index.html` (CSS block, after `.sandbox-tab .dot.stopped`)

- [ ] **Step 1: Locate the insertion point**

The existing CSS block at `agent/public/index.html:751-753` defines `.sandbox-tab .dot`, `.dot.running`, and `.dot.stopped`. Insert the four new rules immediately after `.dot.stopped` so they live next to their siblings.

- [ ] **Step 2: Add the four CSS rules**

After the line `    .sandbox-tab .dot.stopped { background: var(--ink-faint); }`, insert:

```css
    .sandbox-tab .dot.paused { background: var(--warning); }
    .sandbox-tab[draggable="true"] { cursor: grab; }
    .sandbox-tab.dragging { opacity: 0.5; cursor: grabbing; }
    .sandbox-tab.drag-over { box-shadow: inset 2px 0 0 var(--accent); }
```

Match the surrounding indentation (4 spaces, then 4 more for the rule).

- [ ] **Step 3: Verify the dashboard still loads**

Refresh `http://localhost:3737`. The tab strip should still render (Manager + however many tabs the broken render produces). No console errors. The `cursor: grab` should NOT show yet because no tab has `draggable="true"` until Task 7.

- [ ] **Step 4: Commit**

```bash
git add agent/public/index.html
git commit -m "feat(ui): add CSS for paused dot + drag visual states"
```

---

## Task 2: Add tab-order helpers and drag-state variable

**Files:**
- Modify: `agent/public/index.html` (immediately after `getSandboxEntries` at line ~1523)

- [ ] **Step 1: Locate `getSandboxEntries`**

Search for `function getSandboxEntries()`. It is a 3-line helper. Insert the new block on the lines that follow (before `function getEffectiveSandboxId()`).

- [ ] **Step 2: Add the helper block**

Paste this immediately after the closing brace of `getSandboxEntries`:

```js
// Persisted sandbox-tab order: per-browser localStorage, falls back to createdAt.
const TAB_ORDER_STORAGE_KEY = 'prophet:sandbox-tab-order';

function loadTabOrder() {
  try {
    const raw = localStorage.getItem(TAB_ORDER_STORAGE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter(x => typeof x === 'string') : [];
  } catch { return []; }
}

function saveTabOrder(ids) {
  try { localStorage.setItem(TAB_ORDER_STORAGE_KEY, JSON.stringify(ids)); } catch {}
}

function getSandboxTabOrder() {
  const all = getSandboxEntries();
  const byId = new Map(all.map(s => [s.id, s]));
  const saved = loadTabOrder();
  const ordered = [];
  const seen = new Set();
  for (const id of saved) {
    if (byId.has(id) && !seen.has(id)) {
      ordered.push(byId.get(id));
      seen.add(id);
    }
  }
  const remaining = all
    .filter(s => !seen.has(s.id))
    .sort((a, b) =>
      (a.createdAt || '').localeCompare(b.createdAt || '') || a.id.localeCompare(b.id)
    );
  for (const s of remaining) ordered.push(s);
  return ordered;
}

function teardownSandboxTerminal(sandboxId) {
  if (!sandboxId || sandboxId === '_manager') return;
  const t = sandboxTerminals[sandboxId];
  if (!t) return;
  if (t.el && t.el.parentNode) t.el.parentNode.removeChild(t.el);
  delete sandboxTerminals[sandboxId];
}

let _draggedSandboxId = null;
```

- [ ] **Step 3: Verify the dashboard still loads**

Refresh `http://localhost:3737`. No console errors. In DevTools console, run:

```js
getSandboxTabOrder().map(s => ({ id: s.id, name: s.name }))
```

Expected: an array of sandbox entries ordered by `createdAt` ascending (because nothing is in localStorage yet).

Then run:

```js
saveTabOrder(['nonexistent_id', getSandboxTabOrder()[0].id]);
getSandboxTabOrder().map(s => s.id);
```

Expected: the first sandbox returned matches the second id in the saved order; the bogus id is dropped; any sandboxes not in the saved order are appended by createdAt.

Clean up:

```js
localStorage.removeItem(TAB_ORDER_STORAGE_KEY);
```

- [ ] **Step 4: Commit**

```bash
git add agent/public/index.html
git commit -m "feat(ui): tab-order localStorage helpers + teardownSandboxTerminal"
```

---

## Task 3: Extend `getEffectiveSandboxId` fallback

**Files:**
- Modify: `agent/public/index.html` (replace body of `getEffectiveSandboxId` at line ~1525)

- [ ] **Step 1: Locate `getEffectiveSandboxId`**

Search for `function getEffectiveSandboxId()`. Current body:

```js
function getEffectiveSandboxId() {
  if (selectedSandboxId === '_manager') return '_manager';
  if (selectedSandboxId && (config.sandboxes || {})[selectedSandboxId]) return selectedSandboxId;
  return config.activeSandboxId || null;
}
```

- [ ] **Step 2: Replace the body**

Replace the entire function with:

```js
function getEffectiveSandboxId() {
  if (selectedSandboxId === '_manager') return '_manager';
  const sandboxes = config.sandboxes || {};
  if (selectedSandboxId && sandboxes[selectedSandboxId]) return selectedSandboxId;
  if (config.activeSandboxId && sandboxes[config.activeSandboxId]) return config.activeSandboxId;
  const ordered = getSandboxTabOrder();
  if (ordered.length === 0) return '_manager';
  return ordered[0].id;
}
```

- [ ] **Step 3: Verify the dashboard still loads and selection logic still works**

Refresh `http://localhost:3737`. Click between sandboxes (using whatever tabs exist after the broken render — even if only one). No console errors. In DevTools console:

```js
getEffectiveSandboxId()
```

Expected: returns a real sandboxId (one of the keys of `config.sandboxes`), not `null`. Previously this could return `null` when `config.activeSandboxId` was unset; now it falls back to the first ordered sandbox.

- [ ] **Step 4: Commit**

```bash
git add agent/public/index.html
git commit -m "feat(ui): getEffectiveSandboxId falls back to first ordered sandbox"
```

---

## Task 4: Add drag handler functions

**Files:**
- Modify: `agent/public/index.html` (immediately before `function switchSandboxTab` at line ~3038)

- [ ] **Step 1: Locate `switchSandboxTab`**

Search for `async function switchSandboxTab(sandboxId)`. Insert the five new functions immediately before it.

- [ ] **Step 2: Add the five drag handlers**

```js
function onSandboxTabDragStart(e) {
  const tab = e.currentTarget;
  _draggedSandboxId = tab.dataset.sandboxId || null;
  if (!_draggedSandboxId) return;
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', _draggedSandboxId); } catch {}
  tab.classList.add('dragging');
}

function onSandboxTabDragOver(e) {
  if (!_draggedSandboxId) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const tab = e.currentTarget;
  if (tab.dataset.sandboxId && tab.dataset.sandboxId !== _draggedSandboxId) {
    tab.classList.add('drag-over');
  }
}

function onSandboxTabDragLeave(e) {
  e.currentTarget.classList.remove('drag-over');
}

function onSandboxTabDrop(e) {
  e.preventDefault();
  const tab = e.currentTarget;
  const targetId = tab.dataset.sandboxId;
  tab.classList.remove('drag-over');
  if (!_draggedSandboxId || !targetId || _draggedSandboxId === targetId) return;

  const order = getSandboxTabOrder().map(s => s.id);
  const fromIdx = order.indexOf(_draggedSandboxId);
  const toIdx = order.indexOf(targetId);
  if (fromIdx < 0 || toIdx < 0) return;

  order.splice(fromIdx, 1);
  order.splice(toIdx, 0, _draggedSandboxId);
  saveTabOrder(order);
  renderSandboxTabs();
}

function onSandboxTabDragEnd(e) {
  e.currentTarget.classList.remove('dragging');
  document.querySelectorAll('.sandbox-tab.drag-over').forEach(el => el.classList.remove('drag-over'));
  _draggedSandboxId = null;
}
```

- [ ] **Step 3: Verify the dashboard still loads**

Refresh `http://localhost:3737`. No console errors. The handlers are defined but not yet wired to any DOM element — visual behavior is unchanged. In DevTools console:

```js
typeof onSandboxTabDragStart === 'function' && typeof onSandboxTabDrop === 'function'
```

Expected: `true`.

- [ ] **Step 4: Commit**

```bash
git add agent/public/index.html
git commit -m "feat(ui): drag handler functions for sandbox-tab reorder"
```

---

## Task 5: Rewrite `renderSandboxTabs`

**Files:**
- Modify: `agent/public/index.html` (replace body of `renderSandboxTabs` at line ~2859)

- [ ] **Step 1: Locate `renderSandboxTabs`**

Search for `function renderSandboxTabs()`. The current implementation runs roughly from line 2859 to line 2892. It iterates `config.accounts` and synthesizes `sbx_<account.id>`.

- [ ] **Step 2: Replace the entire function**

Replace the existing body with:

```js
function renderSandboxTabs() {
  const el = document.getElementById('sandbox-tabs');
  if (!el) return;

  const sandboxes = getSandboxTabOrder();
  const currentSid = getEffectiveSandboxId();

  // Manager tab first (pinned, not draggable)
  ensureManagerTerminal();
  refreshManagerDropdowns();
  let html = '<div class="sandbox-tab ' + (currentSid === '_manager' ? 'active' : '') + '" onclick="switchSandboxTab(\'_manager\')" style="border-right:1px solid var(--border)">'
    + '<span class="dot" style="background:var(--accent)"></span><span>Manager</span></div>';

  // Sandbox tabs (one per sandbox; draggable)
  html += sandboxes.map(sbx => {
    const sandboxId = sbx.id;
    const runtime = (window._healthState?.sandboxes || []).find(s => s.sandboxId === sandboxId);
    const running = !!(runtime?.state?.running);
    const paused = !!(runtime?.state?.paused);
    const active = sandboxId === currentSid;
    const dotClass = running ? (paused ? 'paused' : 'running') : 'stopped';
    const label = sbx.name || sbx.id;
    const beats = runtime?.state?.beatCount || 0;
    ensureSandboxTerminal(sandboxId, label);
    const statusText = running ? (paused ? 'Paused' : 'Beat #' + beats) : 'Stopped';
    return '<div class="sandbox-tab ' + (active ? 'active' : '')
      + '" draggable="true" data-sandbox-id="' + esc(sandboxId) + '"'
      + ' ondragstart="onSandboxTabDragStart(event)"'
      + ' ondragover="onSandboxTabDragOver(event)"'
      + ' ondragleave="onSandboxTabDragLeave(event)"'
      + ' ondrop="onSandboxTabDrop(event)"'
      + ' ondragend="onSandboxTabDragEnd(event)"'
      + ' onclick="switchSandboxTab(\'' + sandboxId + '\')">'
      + '<span class="dot ' + dotClass + '"></span><span>' + esc(label) + '</span>'
      + '<span style="font-size:10px;color:var(--ink-faint);margin-left:2px">' + statusText + '</span></div>';
  }).join('');

  el.innerHTML = html;

  // Orphan sweep: tear down cached terminals whose sandbox no longer exists.
  const liveIds = new Set(['_manager', ...sandboxes.map(s => s.id)]);
  for (const cachedId of Object.keys(sandboxTerminals)) {
    if (!liveIds.has(cachedId)) teardownSandboxTerminal(cachedId);
  }

  // If the active tab was just removed, snap to the new effective sandbox.
  // switchSandboxTab re-calls renderSandboxTabs; on the second pass currentSid
  // is valid, so this branch is not re-entered.
  if (currentSid && !liveIds.has(currentSid)) {
    switchSandboxTab(getEffectiveSandboxId());
    return;
  }

  // Show/hide terminals.
  for (const [sid, t] of Object.entries(sandboxTerminals)) {
    t.el.style.display = sid === getEffectiveSandboxId() ? 'flex' : 'none';
  }
}
```

- [ ] **Step 3: Manual smoke — one tab per sandbox, sandbox names, drag wired**

Refresh `http://localhost:3737`. Verify:

1. Tab strip shows Manager + one tab per entry in `config.sandboxes` (4 if you have Paper/Harvest/Turtle/Spark).
2. Each tab is labeled by `sbx.name` (e.g., "Spark", "Turtle"), not by account name.
3. Tab order matches `createdAt` ascending (no saved order yet).
4. Hover over a sandbox tab — cursor is `grab`.
5. Drag a sandbox tab onto another sandbox tab; on drop, the order updates immediately.
6. Hard-refresh the page (Ctrl/Cmd+Shift+R). Order from step 5 persists.
7. In DevTools: `localStorage.getItem('prophet:sandbox-tab-order')` returns the JSON array of sandboxIds in the new order.
8. Dragging Manager does nothing (it has no `draggable="true"` and no drop semantics).
9. Switching tabs (click) still works — the per-sandbox terminal beneath updates.

- [ ] **Step 4: Commit**

```bash
git add agent/public/index.html
git commit -m "feat(ui): one terminal tab per sandbox + drag-to-reorder"
```

---

## Task 6: Patch the SSE `status` handler

**Files:**
- Modify: `agent/public/index.html` (replace body of `es.addEventListener('status', …)` at line ~1771)

- [ ] **Step 1: Locate the handler**

Search for `es.addEventListener('status'`. Current body:

```js
es.addEventListener('status', e => {
  const d = JSON.parse(e.data);
  if (selectedSandboxId && d.sandboxId !== selectedSandboxId) return;
  if (!selectedSandboxId || !d.sandboxId || d.sandboxId === getEffectiveSandboxId()) updateButtons(d.status);
});
```

- [ ] **Step 2: Replace the handler body**

Replace the entire `addEventListener('status', …)` call with:

```js
  es.addEventListener('status', e => {
    const d = JSON.parse(e.data);

    // 1. Patch _healthState for the sandbox whose status changed so both
    //    renderSandboxTabs and renderSandboxesTab read the new running/paused
    //    state on the very next render.
    if (d.sandboxId && window._healthState?.sandboxes) {
      const entry = window._healthState.sandboxes.find(s => s.sandboxId === d.sandboxId);
      if (entry) {
        entry.state = entry.state || {};
        if (d.status === 'started' || d.status === 'resumed') {
          entry.state.running = true;
          entry.state.paused = false;
        } else if (d.status === 'paused') {
          entry.state.paused = true;
        } else if (d.status === 'stopped') {
          entry.state.running = false;
          entry.state.paused = false;
        }
      }
      renderSandboxTabs();
      renderSandboxesTab();
    }

    // 2. Preserve the top-bar button behavior for the currently selected tab.
    if (selectedSandboxId && d.sandboxId && d.sandboxId !== selectedSandboxId) return;
    if (!selectedSandboxId || !d.sandboxId || d.sandboxId === getEffectiveSandboxId()) updateButtons(d.status);
  });
```

Match the leading indentation of the surrounding `es.addEventListener(...)` calls (2 spaces inside the `connectSSE` body).

- [ ] **Step 3: Manual smoke — cross-surface status sync**

Refresh `http://localhost:3737`. Then:

1. **Card → tab sync.** Open the Sandboxes top-tab. Click **Start** on a stopped sandbox (e.g. Spark). Within ~100 ms the corresponding tab in the terminal tab strip should flip its dot to running and the status text from "Stopped" → "Beat #0" (or "Beat #1" if a beat fires first).
2. **Tab → card sync.** With the just-started sandbox selected in the terminal tab strip, click the top-bar **Stop**. The card in the Sandboxes panel flips to no-badge / Start-button without waiting for the 15-s `checkHealth()` poll.
3. **Pause/Resume.** Start Harvest, then click Pause (top-bar or card). The Harvest tab dot turns warning-color and status text shows "Paused". Click Resume — back to "Beat #N".
4. **Delete propagation.** From the Sandboxes panel, delete a stopped sandbox. Its tab disappears from the terminal tab strip. If it was the active tab, selection snaps to the next sandbox in order (or Manager if zero remain). No `#term-wrap-<deleted-id>` should remain in the DOM (check via DevTools).
5. **Manager regression check.** Click Manager tab — Start/Pause/Stop buttons hide as before.

- [ ] **Step 4: Commit**

```bash
git add agent/public/index.html
git commit -m "fix(ui): SSE status patches _healthState + re-renders both surfaces"
```

---

## Task 7: Backend regression check

**Files:** none (verification only)

- [ ] **Step 1: Run the existing test suite**

```bash
npm test
```

Expected: all 318 tests pass. No backend code was changed, but the suite covers `safeConfig`, SSE shape, and migration paths — if any of those failed, it would indicate accidental coupling.

If a test fails:
- Inspect the failure. If it's flaky/timing-related, re-run once.
- If it's deterministic and traces to a change in `index.html`, you've accidentally touched something else. Do not skip the failure — investigate.

- [ ] **Step 2: Commit only if anything needed updating**

If the suite passed cleanly on first run, no commit needed. If a smoke fixture or snapshot updated:

```bash
git add <changed-files>
git commit -m "chore: refresh test fixture after UI changes"
```

---

## Task 8: End-to-end smoke pass and final verify commit

**Files:** none (verification only)

- [ ] **Step 1: Walk the full Goals list against the running dashboard**

Open `http://localhost:3737` in a fresh browser window. Walk each spec Goal:

1. **One terminal tab per sandbox.** Count tabs in the terminal strip: Manager + 1 per entry in `config.sandboxes`. Labels are sandbox names.
2. **Real-time status sync across surfaces.**
   - Start sandbox A from its **card** → tab dot for A flips to running within ~100 ms.
   - Start sandbox B from the **top-bar** while B's tab is selected → B's card flips to Running immediately.
   - Pause A from the card → A's tab status flips to "Paused" immediately.
3. **Delete cleans up.** Delete a stopped sandbox from the Sandboxes panel.
   - Its tab disappears.
   - If it was the active tab, selection snapped to the next sandbox in order (not Manager, unless zero remain).
   - DevTools: `document.getElementById('term-wrap-<deletedId>')` is `null`.
   - DevTools: `sandboxTerminals['<deletedId>']` is `undefined`.
4. **Drag-to-reorder persists.**
   - Drag Spark before Paper; drop. New order applied.
   - Hard-reload (Ctrl/Cmd+Shift+R). Order persisted.
   - `localStorage.getItem('prophet:sandbox-tab-order')` returns the new order.
   - Run `localStorage.removeItem('prophet:sandbox-tab-order')`, hard-reload. Order reverts to `createdAt` ascending.

- [ ] **Step 2: Verify the spec's edge cases**

In DevTools console while the dashboard is loaded:

1. **Saved order with stale ID.**
   ```js
   const real = getSandboxTabOrder().map(s => s.id);
   saveTabOrder(['ghost_sandbox', ...real]);
   ```
   Refresh. Order should match `real` (ghost dropped). Clean up:
   ```js
   localStorage.removeItem('prophet:sandbox-tab-order');
   ```

2. **No-op drop on self.** Drag a tab onto itself (just don't move it). Expected: no DOM change, no localStorage write.

3. **New sandbox after a saved order.** With a non-default saved order from step (4) above, create a new sandbox via the Sandboxes panel ("New Sandbox" / dropdown flow). Verify its tab appears at the **end** of the tab strip (not at its `createdAt` position), because new IDs aren't in the saved order.

4. **No regression to existing health poll.** Watch the Network tab — `/api/health` continues to fire every 15 seconds. P&L and beat counts in the sidebar still update on that cadence.

- [ ] **Step 3: Final verify commit**

```bash
git commit --allow-empty -m "$(cat <<'EOF'
verify: end-to-end smoke pass for terminal tabs per sandbox

Manual smoke against dashboard at http://localhost:3737 :
- 4 terminal tabs (Paper/Harvest/Turtle/Spark) plus Manager.
- Tab labels come from sbx.name, not account name.
- Card -> tab status sync flips within ~100ms (SSE patch _healthState).
- Tab -> card status sync flips on top-bar Start/Stop without 15s poll.
- Pause/Resume reflects in both surfaces.
- Sandbox delete tears down tab + #term-wrap-<id> + sandboxTerminals[id].
- Drag-reorder persists to localStorage('prophet:sandbox-tab-order').
- Stale IDs in saved order are filtered; new sandboxes append at end.
- localStorage clear reverts to createdAt ascending.
- npm test: 318/318 passing.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4: Squash recommendation**

Per memory `workflow-preferences` (one squashed commit per backlog item), interactive-squash the Task 1–7 commits into a single commit on this branch before merging PR. Keep the Task 8 verify commit as a separate trailing commit (matches the precedent set by `2f5f684 verify: end-to-end smoke pass for accounts tab redesign`).

Recommended final history on top of PR #41:

```
<squashed feature commit> feat(ui): terminal tabs per sandbox + cross-tab sync + drag-reorder
<verify commit>           verify: end-to-end smoke pass for terminal tabs per sandbox
```

Do the squash with `git rebase -i HEAD~9` (8 task commits + 1 spec commit — leave the spec commit `pick`ed if you want it visible; squash the 8 task commits to one).

---

## Out-of-scope follow-ups (do NOT do in this PR)

- Extract render functions and SSE handlers into ES modules with a jsdom test harness.
- Touch-device drag support.
- Backend persistence of tab order (sync across browsers).
- Per-sandbox tab close (×) affordance.
