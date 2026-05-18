# Scroll-aware Per-Sandbox Terminal

**Date:** 2026-05-18
**Scope:** `agent/public/index.html` (web dashboard at port 3737)
**Type:** UI/UX fix

## Problem

The dashboard's "Terminal" tab renders one log view per sandbox (Spark, Trend, Harvest, Manager). When the Spark agent runs an FMP universe scan, hundreds of log lines arrive in quick succession. The current `logToSandbox` implementation unconditionally jumps the view to the bottom on every new line:

```js
// agent/public/index.html:3052
function logToSandbox(sandboxId, html) {
  const t = sandboxTerminals[sandboxId];
  if (!t) return;
  t.termEl.insertAdjacentHTML('beforeend', html);
  t.termEl.scrollTop = t.termEl.scrollHeight;
}
```

This makes it impossible to scroll up and read a heartbeat or earlier log while a scan is in progress — the user is yanked back to the bottom on every new line.

The legacy single `terminal` element (line 1482) already has the correct behavior: a scroll listener sets a global `autoScroll` flag based on whether the user is within 50px of the bottom (line 1484-1486), and `log()` / `logHtml()` only scroll when that flag is true (lines 1592, 1601). The per-sandbox terminals were never wired up to that pattern.

## Goals

1. While scrolled up in a per-sandbox terminal, new log lines append silently — the view stays where the user put it.
2. When the user is at (or within 50px of) the bottom, new lines push the view down as today.
3. Provide a visible "Jump to bottom" affordance so the user can return to live-tail with one click.
4. Behavior is per-sandbox: scrolling up in Spark does not affect Trend's behavior.

## Non-goals

- No backend changes.
- No log trimming for per-sandbox terminals (legacy terminal's 2000-child cap is a separate concern, intentionally out of scope).
- No persistent UI preferences (autoScroll state is in-memory only — resets on page reload, which is fine).
- No virtualization or performance optimization beyond what already exists.
- No changes to the legacy hidden `terminal` element behavior.

## Design

### State

Each entry in the existing `sandboxTerminals` map gains two fields:

```js
sandboxTerminals[sandboxId] = {
  el: wrapper,
  termEl: wrapper.querySelector('[data-terminal]'),
  autoScroll: true,         // NEW: tracks whether new lines should snap to bottom
  jumpBtn: <button element> // NEW: floating "Jump to bottom" button for this terminal
};
```

Default `autoScroll` is `true` — a freshly-created terminal live-tails until the user scrolls away.

### Scroll listener

Attached inside `ensureSandboxTerminal` (and `ensureManagerTerminal`) right after the wrapper is appended:

```js
const term = sandboxTerminals[sandboxId];
term.termEl.addEventListener('scroll', () => {
  const atBottom = term.termEl.scrollHeight - term.termEl.scrollTop - term.termEl.clientHeight < 50;
  term.autoScroll = atBottom;
  term.jumpBtn.classList.toggle('visible', !atBottom);
});
```

The 50px threshold matches the legacy terminal's behavior — small enough that landing one line up still counts as "at bottom", large enough that intentional scroll-up is detected.

### logToSandbox change

```js
function logToSandbox(sandboxId, html) {
  const t = sandboxTerminals[sandboxId];
  if (!t) return;
  t.termEl.insertAdjacentHTML('beforeend', html);
  if (t.autoScroll) t.termEl.scrollTop = t.termEl.scrollHeight;
}
```

Single-line change: gate the scroll on the flag.

### "Jump to bottom" button

**Markup** — created inside `ensureSandboxTerminal`, appended to `.terminal-split` (the immediate flex parent of `.terminal`):

```html
<button class="jump-bottom-btn" data-jump="<sandboxId>" title="Jump to bottom">
  &#8595; Jump to bottom
</button>
```

**CSS** (added to existing `<style>` block):

```css
.terminal-split { position: relative; }   /* anchor for absolute child */
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

The button inherits theme variables (`--accent`, `--paper`) so it adapts to sunset-forest / sunrise-beach / sunset-tropical-beach themes without per-theme overrides.

**Click handler:**

```js
term.jumpBtn.addEventListener('click', () => {
  term.termEl.scrollTop = term.termEl.scrollHeight;
  // The scroll event listener will set autoScroll=true and hide the button.
});
```

No need to flip `autoScroll` manually — the resulting scroll event will trigger the listener, which will detect the at-bottom state and update both the flag and visibility.

### Programmatic resets

When a terminal is cleared programmatically, `autoScroll` must be reset to `true` so the next batch of logs scrolls normally:

- `newManagerSession` (line 2961) — clears `termEl.innerHTML`. Add `t.autoScroll = true; t.jumpBtn.classList.remove('visible');` afterward.
- Any other site that wipes a sandbox terminal — currently none, but the pattern is established for future callers.

### Mobile considerations

The `.terminal-split` becomes column-direction on mobile (line 957). The button stays positioned in the bottom-right of the terminal section, which is the user-expected location. The 12px / 16px offsets work on both layouts. No mobile-specific overrides needed.

## Files Touched

- `agent/public/index.html` — single file, ~6 small change sites:
  - Add CSS rule for `.terminal-split { position: relative; }` and the `.jump-bottom-btn` styles.
  - Modify `ensureSandboxTerminal` (~line 2744): add jump button HTML, scroll listener, `autoScroll` + `jumpBtn` fields in the map entry.
  - Modify `ensureManagerTerminal` (~line 2872): same additions as above (uses the same map).
  - Modify `logToSandbox` (~line 3052): gate scroll on `t.autoScroll`.
  - Modify `newManagerSession` (~line 2958): reset `autoScroll` and button visibility after clearing.

## Testing

This is static `index.html` with inline JS — the repo has no front-end test harness, and adding one for a six-line fix is disproportionate. Verification is manual:

1. Start the agent, open `http://localhost:3737`, switch to Terminal tab → Spark.
2. Trigger an FMP scan (heartbeat firing during market hours) and observe: while at the bottom, new lines push the view down as before.
3. Scroll up mid-scan. Confirm:
   - The view stays put as new lines append.
   - The "↓ Jump to bottom" button appears in the bottom-right.
4. Click the button. Confirm the view jumps to the bottom and the button disappears.
5. Manually scroll back down (without the button). Confirm the button disappears and auto-scroll resumes for the next line.
6. Switch to a different sandbox tab (Trend / Harvest / Manager), confirm each tab tracks its own scroll state independently.
7. On Manager tab: trigger "New conversation" (which clears the terminal). Confirm auto-scroll re-enables and the button is hidden.
8. Test on mobile viewport (Chrome devtools, narrow width): button is reachable, doesn't overlap critical content.

## Risks

- **Low risk**: the change is additive and the new conditional path falls back to today's behavior when `autoScroll` is true (which is the default and the steady state for users who don't scroll).
- The CSS `position: relative` on `.terminal-split` could in theory affect descendants that rely on a different positioning context. Spot-check via grep: nothing inside `.terminal-split` currently uses `position: absolute`, so this is safe.

## Out of scope (parking lot)

- Unread-line count badge on the button (option C from brainstorming, not chosen).
- A keyboard shortcut for jump-to-bottom (e.g., `End` key).
- Persisting autoScroll preference across page reloads.
- Trim cap for per-sandbox terminals analogous to the legacy 2000-line cap.
