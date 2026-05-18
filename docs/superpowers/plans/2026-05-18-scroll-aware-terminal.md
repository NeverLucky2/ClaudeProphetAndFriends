# Scroll-Aware Per-Sandbox Terminal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the dashboard's per-sandbox terminals from yanking the user back to the bottom on every new log line while they're scrolled up, and add a "Jump to bottom" button to return to live-tail.

**Architecture:** All changes live in a single file — `agent/public/index.html`. We add a CSS class for the floating jump button, a shared helper that attaches per-terminal scroll state (`autoScroll` flag + button DOM + scroll/click listeners) to entries in the existing `sandboxTerminals` map, and gate the unconditional `scrollTop = scrollHeight` in `logToSandbox` on that flag. The legacy single `terminal` element already implements this pattern at line 1484-1486 — we mirror it for per-sandbox terminals.

**Tech Stack:** Static HTML + inline JS + CSS in `agent/public/index.html`. No backend changes, no new files, no build step. The dashboard is served by the Node agent at `http://localhost:3737`.

**Testing approach:** The dashboard has no front-end test harness — adding one for a six-line behavior fix is disproportionate. Verification is manual against the steps in the spec. Each task includes a concrete reload + check workflow.

**Spec:** `docs/superpowers/specs/2026-05-18-scroll-aware-terminal-design.md`

---

## File Structure

Only one file is touched. Changes are localized to existing functions/blocks:

| Region | Approx. line | Change |
|---|---|---|
| `<style>` block | After `.terminal { ... }` (~line 681) | Add `.terminal-split { position: relative; }` + `.jump-bottom-btn { ... }` rules |
| `ensureSandboxTerminal()` | ~line 2832 (after map assignment) | Call `attachTerminalScrollControls(sandboxId)` |
| `ensureManagerTerminal()` | ~line 2905 (after map assignment) | Call `attachTerminalScrollControls('_manager')` |
| New helper `attachTerminalScrollControls()` | Insert just below `sandboxTerminals` declaration (~line 2743) | Adds `autoScroll`, `jumpBtn` to map entry; binds scroll + click listeners |
| `logToSandbox()` | Line 3052-3057 | Gate `scrollTop = scrollHeight` on `t.autoScroll` |
| `newManagerSession()` | ~line 2958-2963 | After clearing `termEl.innerHTML`, reset `t.autoScroll = true` and hide button |

---

## Task 1: Add CSS for the floating "Jump to bottom" button

**Files:**
- Modify: `agent/public/index.html` (style block, immediately after the `.terminal::-webkit-scrollbar-thumb` rule near line 683)

This task adds styles only. Nothing visual changes until later tasks add the button DOM.

- [ ] **Step 1: Locate the insertion point**

Open `agent/public/index.html` and find the existing CSS block around the `.terminal` rules. The target insertion point is right after this existing rule near line 683:

```css
.terminal::-webkit-scrollbar-thumb { background: var(--rule); }
```

- [ ] **Step 2: Add the new CSS rules**

Insert immediately after the `.terminal::-webkit-scrollbar-thumb` rule:

```css
    .terminal-split { position: relative; }
    .jump-bottom-btn {
      position: absolute;
      bottom: 12px;
      right: 16px;
      display: none;
      padding: 6px 12px;
      font-size: 12px;
      font-family: inherit;
      background: var(--accent);
      color: var(--paper);
      border: none;
      border-radius: 14px;
      box-shadow: 0 2px 6px rgba(0,0,0,0.25);
      cursor: pointer;
      z-index: 10;
    }
    .jump-bottom-btn.visible { display: inline-block; }
    .jump-bottom-btn:hover { filter: brightness(1.1); }
```

(Match the leading indentation of surrounding rules — 4 spaces in this file.)

- [ ] **Step 3: Manual sanity check**

Restart the agent (or reload `http://localhost:3737` if it's already running). Open the Terminal tab and switch through Manager / Spark / Trend / Harvest tabs. Confirm nothing is visually different — no orphan buttons, no broken layout. The button class exists but no DOM element uses it yet.

- [ ] **Step 4: Commit**

```bash
git add agent/public/index.html
git commit -m "style(dashboard): add jump-bottom button styles + terminal-split positioning context"
```

---

## Task 2: Add `attachTerminalScrollControls` helper and wire both terminal creators

**Files:**
- Modify: `agent/public/index.html`
  - Insert helper after the `const sandboxTerminals = {};` line (~line 2742)
  - One-line addition inside `ensureSandboxTerminal` after `sandboxTerminals[sandboxId] = ...` (~line 2832)
  - One-line addition inside `ensureManagerTerminal` after `sandboxTerminals['_manager'] = ...` (~line 2905)

After this task, scrolling up in any per-sandbox terminal makes the button appear and clicking it scrolls to the bottom. New log lines still force the view down (that's fixed in Task 3) — so the button currently does nothing user-visible while logs are streaming. This intermediate state is intentional and reviewable.

- [ ] **Step 1: Add the helper function**

Insert the following helper immediately after the existing line `const sandboxTerminals = {}; // { sandboxId: { el, logs[] } }` (line 2742):

```js
function attachTerminalScrollControls(sandboxId) {
  const t = sandboxTerminals[sandboxId];
  if (!t || !t.termEl) return;

  t.autoScroll = true;

  const splitEl = t.el.querySelector('.terminal-split');
  if (!splitEl) return;

  const btn = document.createElement('button');
  btn.className = 'jump-bottom-btn';
  btn.type = 'button';
  btn.title = 'Jump to bottom';
  btn.innerHTML = '&#8595; Jump to bottom';
  splitEl.appendChild(btn);
  t.jumpBtn = btn;

  t.termEl.addEventListener('scroll', () => {
    const atBottom = t.termEl.scrollHeight - t.termEl.scrollTop - t.termEl.clientHeight < 50;
    t.autoScroll = atBottom;
    t.jumpBtn.classList.toggle('visible', !atBottom);
  });

  btn.addEventListener('click', () => {
    t.termEl.scrollTop = t.termEl.scrollHeight;
    // The scroll listener will pick up the at-bottom state and hide the button.
  });
}
```

The threshold of 50px mirrors the legacy terminal's behavior at line 1485.

- [ ] **Step 2: Call the helper from `ensureSandboxTerminal`**

Locate this line near 2832:

```js
  sandboxTerminals[sandboxId] = { el: wrapper, termEl: wrapper.querySelector('[data-terminal]') };
  return sandboxTerminals[sandboxId];
```

Insert the helper call between those two lines so it becomes:

```js
  sandboxTerminals[sandboxId] = { el: wrapper, termEl: wrapper.querySelector('[data-terminal]') };
  attachTerminalScrollControls(sandboxId);
  return sandboxTerminals[sandboxId];
```

- [ ] **Step 3: Call the helper from `ensureManagerTerminal`**

Locate this line near 2905:

```js
  sandboxTerminals['_manager'] = { el: wrapper, termEl: wrapper.querySelector('[data-terminal]') };
}
```

Add the helper call right before the closing brace:

```js
  sandboxTerminals['_manager'] = { el: wrapper, termEl: wrapper.querySelector('[data-terminal]') };
  attachTerminalScrollControls('_manager');
}
```

- [ ] **Step 4: Manual verification**

Reload `http://localhost:3737`. Open the Terminal tab and switch through each sandbox tab (Manager / Spark / Trend / Harvest). For each tab:

1. Open browser devtools console — confirm no JavaScript errors during initialization.
2. Scroll up inside the terminal area (you may need to wait for some log content first — clicking around the dashboard generates logs, or hit "Start" if the agent is stopped).
3. Confirm the `↓ Jump to bottom` button appears in the bottom-right of the terminal panel.
4. Click the button — confirm the terminal scrolls to the bottom and the button disappears.
5. Scroll up again — button reappears. Scroll all the way down manually (without clicking the button) — confirm the button disappears.

Note: at this point, if new log lines arrive while you're scrolled up, the view will still be yanked to the bottom — that's Task 3's job. The button behavior in isolation should still work.

- [ ] **Step 5: Commit**

```bash
git add agent/public/index.html
git commit -m "feat(dashboard): add scroll-aware autoScroll state + jump-bottom button to per-sandbox terminals"
```

---

## Task 3: Gate `logToSandbox` on the autoScroll flag

**Files:**
- Modify: `agent/public/index.html` — `logToSandbox` function at line 3052-3057

This is the user-visible fix. After this task, scrolling up while Spark is scanning FMP no longer yanks the view back down.

- [ ] **Step 1: Modify `logToSandbox`**

Current code at line 3052-3057:

```js
function logToSandbox(sandboxId, html) {
  const t = sandboxTerminals[sandboxId];
  if (!t) return;
  t.termEl.insertAdjacentHTML('beforeend', html);
  t.termEl.scrollTop = t.termEl.scrollHeight;
}
```

Replace with:

```js
function logToSandbox(sandboxId, html) {
  const t = sandboxTerminals[sandboxId];
  if (!t) return;
  t.termEl.insertAdjacentHTML('beforeend', html);
  if (t.autoScroll !== false) t.termEl.scrollTop = t.termEl.scrollHeight;
}
```

Note the use of `!== false` rather than truthy check. This makes the function backward-compatible if a future caller adds a terminal entry without calling `attachTerminalScrollControls` — `autoScroll` would be `undefined`, which means "scroll" (preserve current behavior) rather than "don't scroll". `attachTerminalScrollControls` always sets it to a boolean for terminals that go through the normal path.

- [ ] **Step 2: Manual verification — the golden path**

Reload `http://localhost:3737`. With the agent started (or trigger an action that produces a burst of logs — e.g., wait for a Spark heartbeat or hit "Start" on the Spark tab):

1. On the Spark tab, wait for or trigger a burst of log lines (heartbeat firing during market hours, or any action that produces ≥10 lines).
2. While lines are streaming, scroll up. Confirm the view stays put — new lines append below silently but the visible portion doesn't move.
3. Confirm the `↓ Jump to bottom` button is visible.
4. Click the button — confirm the view snaps to the latest line and the button disappears.
5. Confirm new incoming lines now resume pushing the view down (auto-scroll re-enabled).
6. Scroll up again, then manually scroll all the way to the bottom (without the button). Confirm auto-scroll resumes for the next line.

- [ ] **Step 3: Manual verification — independence across tabs**

1. On the Spark tab, scroll up so its button is visible.
2. Switch to the Trend tab — confirm Trend's view is at the bottom and its button is hidden (Trend's autoScroll is independent of Spark's).
3. Switch back to Spark — confirm Spark's view is still where you left it (scrolled up) and the button is still visible. Spark's autoScroll state persisted.

- [ ] **Step 4: Commit**

```bash
git add agent/public/index.html
git commit -m "fix(dashboard): logToSandbox respects per-terminal autoScroll instead of force-scrolling"
```

---

## Task 4: Reset autoScroll when Manager session is cleared

**Files:**
- Modify: `agent/public/index.html` — `newManagerSession` function at line 2958-2963

When the user clicks "New Chat" on the Manager tab, the terminal is wiped. If the user happened to be scrolled up at the time, `autoScroll` would still be `false` and the next "New conversation started" message would not be visible — that's surprising. Reset both the flag and the button visibility on clear.

- [ ] **Step 1: Modify `newManagerSession`**

Current code at line 2958-2963:

```js
async function newManagerSession() {
  await fetch('/api/manager/new-session', { method: 'POST' });
  const term = sandboxTerminals['_manager']?.termEl;
  if (term) term.innerHTML = '<div class="log-entry info"><span class="time">' + fmtTime() + '</span>New conversation started.</div>';
  showToast('New manager session', 'info');
}
```

Replace with:

```js
async function newManagerSession() {
  await fetch('/api/manager/new-session', { method: 'POST' });
  const t = sandboxTerminals['_manager'];
  if (t && t.termEl) {
    t.termEl.innerHTML = '<div class="log-entry info"><span class="time">' + fmtTime() + '</span>New conversation started.</div>';
    t.autoScroll = true;
    if (t.jumpBtn) t.jumpBtn.classList.remove('visible');
  }
  showToast('New manager session', 'info');
}
```

- [ ] **Step 2: Manual verification**

Reload `http://localhost:3737`. On the Manager tab:

1. Generate enough manager output to make the terminal scrollable (send a message that returns multi-line output, or scroll the existing content).
2. Scroll up so the `↓ Jump to bottom` button appears.
3. Click "New Chat" at the top of the Manager terminal.
4. Confirm:
   - The terminal contents are replaced by the single "New conversation started." line.
   - The button is hidden.
   - Sending a new manager message scrolls normally (autoScroll re-enabled).

- [ ] **Step 3: Commit**

```bash
git add agent/public/index.html
git commit -m "fix(dashboard): newManagerSession resets autoScroll and hides jump button"
```

---

## Task 5: Final cross-cutting verification

This task is verification only — no code changes, no commit.

- [ ] **Step 1: Walk through every test case in the spec**

Open the spec at `docs/superpowers/specs/2026-05-18-scroll-aware-terminal-design.md` and run through the eight verification steps in the **Testing** section. Each must pass before declaring done:

1. Open dashboard, Terminal → Spark, observe streaming logs push view down (default behavior preserved).
2. During an FMP scan or any burst, scroll up: view stays put, button appears.
3. Click button: view snaps to bottom, button disappears.
4. Manual scroll back to bottom (without button): button disappears, auto-scroll resumes.
5. Switch sandbox tabs: each has independent scroll state.
6. Manager "New Chat": clears terminal, resets autoScroll, hides button.
7. Mobile viewport (Chrome devtools → narrow width, e.g., 375px): button reachable, no overlap with chat input bar or sidebar toggle.
8. Theme switch (sunset-forest / sunrise-beach / sunset-tropical-beach): button colors adapt via `--accent` and `--paper` variables, remain readable.

- [ ] **Step 2: Regression check**

Confirm that with the user at the bottom of the terminal (the default state), the behavior is identical to before — bursts of FMP scan lines push the view down with no visible delay, no flicker, no button appearing/disappearing.

- [ ] **Step 3: Console errors**

With devtools open, exercise every interaction from step 1 above. Confirm zero JavaScript errors or warnings in the console.

If any verification step fails, fix the issue in the relevant prior task and re-verify. Do not declare the plan complete with failing verification.
