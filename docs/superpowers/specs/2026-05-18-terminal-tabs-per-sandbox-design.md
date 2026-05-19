# Terminal Tabs Per Sandbox + Cross-Tab Status Sync

**Date:** 2026-05-18
**Scope:** `agent/public/index.html` (web dashboard at port 3737)
**Type:** UI/UX regression fix
**Branch:** `feat-accounts-tab-redesign`
**Related:** PR #41 (Accounts tab redesign / v4→v5 account dedup)

## Problem

PR #41 deduped four fake "accounts" into a single real Alpaca account in `config.accounts`, but two pieces of UI code still iterate `config.accounts` to enumerate sandboxes. After the migration:

### Bug 1 — Terminal tab strip collapses to one tab

`renderSandboxTabs` (index.html:2859) builds tab chips from `config.accounts` and synthesizes `sandboxId = 'sbx_' + a.id`:

```js
// agent/public/index.html:2873
html += accounts.map(a => {
  const sandboxId = 'sbx_' + a.id;
  …
  const label = a.name || (a.paper ? 'Paper' : 'Live');
  …
});
```

With one account, there is one tab labeled "Paper (from .env)" — even though `config.sandboxes` has four entries (Paper, Harvest, Turtle, Spark), each with its own Go bot process, port, and harness. The expected behavior is one tab per sandbox, since logs and runtime state are per-sandbox.

The label source (`a.name`) would also collide if the iteration were fixed naively, because four sandboxes share one account.

### Bug 2 — Cross-tab status does not sync in real time

Both `renderSandboxTabs` and `renderSandboxesTab` (index.html:2534, the new card grid) read `running` and `paused` from `window._healthState.sandboxes[i].state`. `_healthState` is populated by:

- The 15-second `checkHealth()` poll (index.html:4340)
- An explicit `checkHealth()` call inside `_refreshAfterAction(id)` (line 2206) after a Start/Stop click

The SSE `status` event handler (line 1771) updates only the top-bar Start/Stop button via `updateButtons(d.status)`; it neither mutates `_healthState` nor re-renders the tab strip or the sandbox cards. Net effect: starting sandbox A from its card flips its card badge to "Running" (because `_refreshAfterAction` ran), but the terminal tab strip continues showing "Stopped" for A until the next poll — and the inverse path (start from top-bar) leaves the card stale.

## Goals

1. Render one terminal tab per sandbox in `config.sandboxes`, labeled by `sbx.name`.
2. When a sandbox's running/paused state changes, both surfaces (tab strip and sandbox cards) flip within one SSE round-trip.
3. When a sandbox is deleted, its terminal tab and cached DOM are torn down and the selection snaps to a still-valid tab.
4. The user can reorder sandbox tabs by dragging; the order persists across page reloads in `localStorage`.

## Non-goals

- No change to the Sandboxes panel layout or card content (cosmetic surface unaffected).
- No change to the Manager pseudo-tab (still pinned first; not a real sandbox).
- No backend changes. `orchestrator.js` already injects `sandboxId` into every event forwarded from each runtime's harness (orchestrator.js:119), so the `status` SSE event reliably carries `sandboxId` for `started` / `stopped` / `paused` / `resumed`.
- No new SSE event type. We patch the existing `status` handler in place.
- No persisted "last-used tab" state.
- No extraction of `renderSandboxTabs` / SSE handlers into testable modules. Deferred to a follow-up.

## Design decisions (confirmed during brainstorming)

| Decision | Choice |
|---|---|
| Tab order | User-saved order from `localStorage`, else `createdAt` ascending; Manager pinned first and not reorderable |
| On sandbox delete | Tear down `#term-wrap-<id>` DOM and drop `sandboxTerminals[id]`; if the deleted sandbox was the active tab, snap to `getEffectiveSandboxId()` |
| Default tab on load | Honor `selectedSandboxId` → `config.activeSandboxId` → first sandbox in the effective render order; Manager only when zero sandboxes exist |
| Sync mechanism | Patch `window._healthState` locally on SSE `status` and re-render both surfaces. Existing 15-s `checkHealth()` poll remains source-of-truth for beats / P&L |
| Drag-reorder persistence | `localStorage` key `prophet:sandbox-tab-order` — JSON array of sandboxIds. Per-browser, no backend change |

## Design

### 1. `renderSandboxTabs` rewrite (index.html:2859)

Replace `const accounts = config.accounts || []` and the `accounts.map(a => …)` block with a sandboxes iteration ordered by the effective tab order (see §5 for `getSandboxTabOrder`):

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

  // Sandbox tabs (one per sandbox, not per account; draggable)
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

  // Orphan sweep: tear down cached terminals whose sandbox no longer exists
  const liveIds = new Set(['_manager', ...sandboxes.map(s => s.id)]);
  for (const cachedId of Object.keys(sandboxTerminals)) {
    if (!liveIds.has(cachedId)) teardownSandboxTerminal(cachedId);
  }

  // If the active tab was just removed, snap to the new effective sandbox
  if (currentSid && !liveIds.has(currentSid)) {
    switchSandboxTab(getEffectiveSandboxId());
    return; // switchSandboxTab will re-call renderSandboxTabs
  }

  // Show/hide terminals
  for (const [sid, t] of Object.entries(sandboxTerminals)) {
    t.el.style.display = sid === getEffectiveSandboxId() ? 'flex' : 'none';
  }
}
```

Notes:
- Tab order comes from `getSandboxTabOrder()` (§5), which honors the saved `localStorage` order and falls back to `createdAt` ascending.
- `paused` is rendered as a distinct dot class and "Paused" status text. CSS for `.dot.paused` is added together with the drag styling in §5.
- `(paused ? 'Paused' : 'Beat #' + beats)` is a UX improvement over the current code, which would show "Beat #N" while the harness was paused.
- The `switchSandboxTab(getEffectiveSandboxId())` call inside `renderSandboxTabs` is re-entrant: `switchSandboxTab` synchronously calls `renderSandboxTabs()` again (line 3041), but on the second pass `selectedSandboxId` is a valid id present in `liveIds`, so the orphan-snap branch is not taken and recursion terminates after one level.
- Drag-related `on*` attributes only appear on sandbox tabs, never on Manager.

### 2. `teardownSandboxTerminal` helper (new)

```js
function teardownSandboxTerminal(sandboxId) {
  if (!sandboxId || sandboxId === '_manager') return;
  const t = sandboxTerminals[sandboxId];
  if (!t) return;
  if (t.el && t.el.parentNode) t.el.parentNode.removeChild(t.el);
  delete sandboxTerminals[sandboxId];
}
```

### 3. `getEffectiveSandboxId` fallback (index.html:1525)

Extend the fallback chain so that when neither `selectedSandboxId` nor `config.activeSandboxId` is a valid sandbox key, return the first sandbox in the effective tab order (which respects user drag-reordering). Only return `'_manager'` when zero sandboxes exist.

```js
function getEffectiveSandboxId() {
  if (selectedSandboxId === '_manager') return '_manager';
  const sandboxes = config.sandboxes || {};
  if (selectedSandboxId && sandboxes[selectedSandboxId]) return selectedSandboxId;
  if (config.activeSandboxId && sandboxes[config.activeSandboxId]) return config.activeSandboxId;
  // Fallback: first sandbox in the user's tab order (createdAt if no saved order)
  const ordered = getSandboxTabOrder();
  if (ordered.length === 0) return '_manager';
  return ordered[0].id;
}
```

Existing callers continue to work; they will never see `null` again — they get a real sandboxId or `'_manager'`.

### 4. SSE `status` handler patch (index.html:1771)

Replace:

```js
es.addEventListener('status', e => {
  const d = JSON.parse(e.data);
  if (selectedSandboxId && d.sandboxId !== selectedSandboxId) return;
  if (!selectedSandboxId || !d.sandboxId || d.sandboxId === getEffectiveSandboxId()) updateButtons(d.status);
});
```

with:

```js
es.addEventListener('status', e => {
  const d = JSON.parse(e.data);

  // 1. Patch _healthState for the sandbox whose status changed.
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
    // 2. Re-render both surfaces so tab dot + card badge flip immediately.
    renderSandboxTabs();
    renderSandboxesTab();
  }

  // 3. Preserve existing top-bar button behavior.
  if (selectedSandboxId && d.sandboxId && d.sandboxId !== selectedSandboxId) return;
  if (!selectedSandboxId || !d.sandboxId || d.sandboxId === getEffectiveSandboxId()) updateButtons(d.status);
});
```

If `_healthState` hasn't loaded yet (first paint before the initial `checkHealth()` resolves), the patch is a no-op; the in-flight poll will populate it.

### 5. Tab-order persistence + drag handlers

#### Order resolution

```js
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
  const all = getSandboxEntries(); // Object.values(config.sandboxes||{})
  const byId = new Map(all.map(s => [s.id, s]));
  const saved = loadTabOrder();
  const ordered = [];
  const seen = new Set();

  // 1. Known IDs from saved order that still exist
  for (const id of saved) {
    if (byId.has(id) && !seen.has(id)) {
      ordered.push(byId.get(id));
      seen.add(id);
    }
  }

  // 2. New sandboxes not yet in saved order, appended by createdAt ascending
  const remaining = all.filter(s => !seen.has(s.id))
    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || '') || a.id.localeCompare(b.id));
  for (const s of remaining) ordered.push(s);

  return ordered;
}
```

This means: a brand-new install with no saved order falls through to pure `createdAt` ordering (Goal 1 from PR #41 holds for new users). Once the user drags, their order sticks. When a new sandbox is added later, it appears at the end until they drag it where they want.

#### Drag handlers

Stored on `window` (the SPA pattern in this file). One module-scope variable holds the dragged sandboxId for the lifetime of a single drag:

```js
let _draggedSandboxId = null;

function onSandboxTabDragStart(e) {
  const tab = e.currentTarget;
  _draggedSandboxId = tab.dataset.sandboxId || null;
  if (!_draggedSandboxId) return;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', _draggedSandboxId);
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
  const targetId = e.currentTarget.dataset.sandboxId;
  e.currentTarget.classList.remove('drag-over');
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

Manager tab does not get `draggable="true"`, has no `data-sandbox-id`, and is not iterated in the saved order, so it stays pinned first and cannot be dropped on.

#### CSS additions

Next to the existing `.sandbox-tab` rules around index.html:751:

```css
.sandbox-tab { cursor: grab; }
.sandbox-tab.dragging { opacity: 0.5; cursor: grabbing; }
.sandbox-tab.drag-over { box-shadow: inset 2px 0 0 var(--accent); }
.sandbox-tab .dot.paused { background: var(--warning); }
```

The `box-shadow: inset 2px 0 0` paints a vertical bar on the drop target's left edge — a low-effort drop indicator that doesn't need DOM insertion points.

## Data flow

```
User clicks Start in Sandboxes card (or top-bar Start)
  → POST /api/sandboxes/:id/start
  → orchestrator.startGoBackend + harness.start
  → harness emits 'status' { status:'started', sandboxId }   (harness.js:316)
  → orchestrator wraps with sandboxId                        (orchestrator.js:119)
  → server.broadcast('status', { sandboxId, status:'started' })
  → SSE handler patches _healthState[i].state.running = true
  → renderSandboxTabs() flips dot + "Beat #0"
  → renderSandboxesTab() flips card badge to Running and swaps Start → Pause/Stop
```

The 15-s `checkHealth()` poll remains the source-of-truth for beat counts and P&L; SSE patches are the fast-path that keeps dots/badges in lock-step.

## Error handling & edge cases

- **SSE payload without `sandboxId`** (legacy paths): falls through to existing `updateButtons(d.status)`. No `_healthState` patch, no extra re-render. Same as today; no regression.
- **`_healthState` not yet loaded** on first paint: SSE patch is a no-op; the initial poll catches up.
- **Sandbox deleted while its tab is active**: orphan sweep in `renderSandboxTabs` removes the DOM, then `switchSandboxTab(getEffectiveSandboxId())` snaps to the new effective tab. If zero sandboxes remain, lands on Manager.
- **Label collision across sandboxes that share one account** (4 sandboxes → 1 Paper account): label is `sbx.name`, which is unique per sandbox by construction. No more "Paper" × 4.
- **Out-of-order SSE delivery**: each `status` event is self-contained — `started` sets `running:true,paused:false`; `stopped` sets `running:false,paused:false`. There is no accumulator that could desync.
- **Race against `_refreshAfterAction(id)`**: the SSE patch and the eventual `checkHealth()` may both run. Idempotent; whichever lands last wins and reflects fact.
- **`localStorage` quota or unavailable** (private-mode browsers, etc.): `loadTabOrder` and `saveTabOrder` are `try`/`catch`-wrapped and degrade silently to `createdAt` ordering. Drag still works in the session; it just won't survive reload.
- **Saved order contains stale IDs** (sandbox deleted while user was on another machine): `getSandboxTabOrder` filters those out. New sandboxes not in the saved order append at the end by `createdAt`.
- **Drop on self or on Manager**: dropping on the same `data-sandbox-id` is a no-op; Manager has no `data-sandbox-id` and no drag listeners, so dropping on it has no effect.

## Constraints preserved

- **Turtle scheduler gate** (`orchestrator.js:175-191`): untouched. This change is entirely client-side + one SSE handler tweak.
- **Account dedup (v5)**: untouched. Sandboxes continue to share `accountId` where appropriate; only the tab strip stops being keyed by account.
- **Existing 318-test suite** under `agent/*.test.mjs`: no JS module boundary changed; backend code unchanged.

## Testing

Server-side: confirm `npm test` (all 318 tests) still passes — no backend code changed, but `safeConfig` / SSE shape tests incidentally exercise the payload shape this UI consumes.

Client-side manual smoke (no DOM test harness exists for the SPA today):

1. **One tab per sandbox**: load the dashboard; tab strip shows Manager + 4 sandbox tabs (Paper, Harvest, Turtle, Spark), each labeled by sandbox name.
2. **Default order**: with no saved order, tabs are `createdAt` ascending.
3. **Start from card → tab flips**: open Sandboxes panel, click Start on Spark. Within ~100 ms the Spark tab dot flips to running and shows "Beat #0" (or "Beat #1" if the first beat fires before the next render).
4. **Start from top-bar → card flips**: select Turtle tab, click top-bar Start. The Turtle card in the Sandboxes panel flips to "Running" and swaps Start → Pause/Stop without waiting for the 15-s poll.
5. **Pause/Resume**: pause Harvest; tab shows "Paused" and dot uses the paused class; resume restores "Beat #N".
6. **Delete**: delete a sandbox from the Sandboxes panel; its tab disappears, and if it was active, selection snaps to the next sandbox in tab order (or Manager if zero remain). No leftover `#term-wrap-<id>` in DOM.
7. **No regression to Manager**: Manager tab still pinned first; switching to it still hides Start/Pause/Stop buttons.
8. **Top-bar status still flips for the active tab**: existing `updateButtons(d.status)` behavior preserved when the SSE `sandboxId` matches `getEffectiveSandboxId()`.
9. **Drag reorder**: drag Spark before Paper; drop. Order updates immediately; reload the page; new order persists. `localStorage.getItem('prophet:sandbox-tab-order')` returns the JSON array of sandboxIds.
10. **Drag does not affect Manager**: Manager tab is not draggable and cannot be made non-first via drop.
11. **New sandbox after reorder**: after dragging, create a new sandbox via the Sandboxes panel; its tab appears at the end of the user-ordered list, not at its `createdAt` position.
12. **`localStorage` clear**: clear the storage key in DevTools; reload; order falls back to `createdAt` ascending.

Per the user's `feedback-verification` memory (test the executor, not just the predicate): the change is render-only over a state map; the executor here is the SSE handler's `_healthState` patch + re-render. Manual smoke for items 3–5 exercises that path end-to-end. A follow-up to carve `renderSandboxTabs` and the SSE handlers into a testable module is filed implicitly — not in scope for this fix.

## Out-of-scope follow-ups

- Extract `renderSandboxTabs`, `renderSandboxesTab`, and the SSE event handlers into testable ES modules with a jsdom harness.
- Add a per-sandbox tab close affordance (×) distinct from the Sandboxes-panel Delete.
- Persist last-selected tab in `localStorage`.
- Touch-device drag support (the HTML5 drag-and-drop API used here is desktop-only; touch reordering is a separate concern).
- Sync tab order to the backend so it follows the user across browsers/devices.
