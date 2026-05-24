# Adapt-Strategy Epoch-Conditional Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `adapt-strategy` (and its mirror `adapt-strategy-penny`) learn only from trades under the current ruleset epoch — narrowing to the current epoch when a window straddles a rule change, and standing down when current-epoch data is too thin.

**Architecture:** Two new pure ESM helpers carry all the logic so it is unit-testable: `resolve-current-epoch.mjs` decides which version(s) are "current" (marker > newest-stamped-trade > config recompute, with a consistency warning), and `segment-by-epoch.mjs` labels trades, applies the straddle policy, and emits counts/case/reporting. Both expose a stdin CLI matching the repo's existing `significance-gate.mjs` pattern. The skill markdown pipes trades through them and acts on `recommended_case`.

**Tech Stack:** Node ESM, `node:test` + `node:assert/strict`. Tests run via `npm test`. Depends on `scripts/strategy-version.mjs` from the Spec A plan (`resolveStrategyRules`, `computeStrategyVersion`) — implement that plan first, or at least Tasks 1-2 of it.

**Spec:** `docs/superpowers/specs/2026-05-23-adapt-strategy-epoch-conditional-split-design.md`

---

## File Structure

- `scripts/resolve-current-epoch.mjs` (NEW) — `resolveCurrentEpoch({ markers, newestStampedVersion, configVersion })` → current version set + source + consistency warning + divergence. Stdin CLI.
- `scripts/resolve-current-epoch.test.mjs` (NEW) — precedence + post-mutation + multi-marker tests.
- `scripts/segment-by-epoch.mjs` (NEW) — `labelTrade`, `currentEpochRate`, `segment`. Stdin CLI.
- `scripts/segment-by-epoch.test.mjs` (NEW) — labeling + policy + reporting tests.
- `.claude/skills/adapt-strategy/SKILL.md` (MODIFY) — Step 1 addition, Step 3 addition, new Step 3.4, Step 3.5 change.
- `.claude/skills/adapt-strategy-penny/SKILL.md` (MODIFY) — mirror the same four edits.

---

## Task 1: `resolveCurrentEpoch` (source-of-truth precedence)

**Files:**
- Create: `scripts/resolve-current-epoch.mjs`
- Test: `scripts/resolve-current-epoch.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// scripts/resolve-current-epoch.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCurrentEpoch } from './resolve-current-epoch.mjs';

test('marker wins over config (post-mutation: config edited after stamping)', () => {
  // Trades were stamped X; marker says X; config was since edited to imply Y.
  const r = resolveCurrentEpoch({ markers: [{ strategyVersion: 'X' }], newestStampedVersion: 'X', configVersion: 'Y' });
  assert.deepEqual(r.currentVersions, ['X']);          // NOT reclassified to Y
  assert.equal(r.source, 'marker');
  assert.match(r.consistencyWarning, /un-deployed|Config implies/i);
});

test('no marker -> newest stamped trade', () => {
  const r = resolveCurrentEpoch({ markers: [], newestStampedVersion: 'Z', configVersion: 'Y' });
  assert.deepEqual(r.currentVersions, ['Z']);
  assert.equal(r.source, 'newest-trade');
  assert.equal(r.consistencyWarning, null);
});

test('no marker, no stamps -> config recompute (inferred)', () => {
  const r = resolveCurrentEpoch({ markers: [], newestStampedVersion: null, configVersion: 'Y' });
  assert.deepEqual(r.currentVersions, ['Y']);
  assert.equal(r.source, 'config-inferred');
});

test('multiple divergent markers -> all current, divergent flag', () => {
  const r = resolveCurrentEpoch({ markers: [{ strategyVersion: 'X' }, { strategyVersion: 'W' }], configVersion: 'X' });
  assert.deepEqual(r.currentVersions.sort(), ['W', 'X']);
  assert.equal(r.divergent, true);
});

test('nothing resolvable -> empty + source none', () => {
  const r = resolveCurrentEpoch({ markers: [], newestStampedVersion: null, configVersion: null });
  assert.deepEqual(r.currentVersions, []);
  assert.equal(r.source, 'none');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/resolve-current-epoch.test.mjs`
Expected: FAIL — `Cannot find module './resolve-current-epoch.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/resolve-current-epoch.mjs
// Decide which strategyVersion(s) are "current" — i.e. what the live agent is
// stamping — for adapt-strategy. Source of truth is the marker, NOT a config
// recompute, so a config edit after the agent started cannot reclassify valid
// current-epoch trades as prior.
// Spec: docs/superpowers/specs/2026-05-23-adapt-strategy-epoch-conditional-split-design.md
import { fileURLToPath } from 'node:url';
import { resolve as resolvePath } from 'node:path';

export function resolveCurrentEpoch({ markers = [], newestStampedVersion = null, configVersion = null } = {}) {
  const markerVersions = markers.map(m => m && m.strategyVersion).filter(Boolean);
  let source, currentVersions;
  if (markerVersions.length) {
    source = 'marker';
    currentVersions = [...new Set(markerVersions)];
  } else if (newestStampedVersion) {
    source = 'newest-trade';
    currentVersions = [newestStampedVersion];
  } else if (configVersion) {
    source = 'config-inferred';
    currentVersions = [configVersion];
  } else {
    source = 'none';
    currentVersions = [];
  }
  let consistencyWarning = null;
  if (source === 'marker' && configVersion && !currentVersions.includes(configVersion)) {
    consistencyWarning = `Config implies version ${configVersion} but the running agent is stamping ${currentVersions.join(', ')}. Un-deployed rule change — loaded trades reflect the running rules, not the edited config.`;
  }
  return { currentVersions, source, consistencyWarning, divergent: currentVersions.length > 1 };
}

// CLI: reads { markers, newestStampedVersion, configVersion } JSON on stdin.
{
  const __filename = fileURLToPath(import.meta.url);
  const argv1abs = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (__filename === argv1abs) {
    let stdin = '';
    process.stdin.on('data', c => { stdin += c; });
    process.stdin.on('end', () => {
      let input;
      try { input = JSON.parse(stdin); } catch (err) {
        process.stderr.write(`stdin is not valid JSON: ${err.message}\n`); process.exit(6);
      }
      process.stdout.write(JSON.stringify(resolveCurrentEpoch(input), null, 2) + '\n');
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/resolve-current-epoch.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/resolve-current-epoch.mjs scripts/resolve-current-epoch.test.mjs
git commit -m "feat(epoch): resolveCurrentEpoch marker-first source of truth"
```

---

## Task 2: `labelTrade` + `currentEpochRate`

**Files:**
- Create: `scripts/segment-by-epoch.mjs`
- Test: `scripts/segment-by-epoch.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// scripts/segment-by-epoch.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labelTrade, currentEpochRate } from './segment-by-epoch.mjs';

const CUR = ['X'];

test('labelTrade: stamped matching version -> current', () => {
  assert.equal(labelTrade({ strategyVersion: 'X', timestamp: '2026-05-20T00:00:00Z' }, CUR, null), 'current');
});
test('labelTrade: stamped differing version -> prior', () => {
  assert.equal(labelTrade({ strategyVersion: 'W', timestamp: '2026-05-20T00:00:00Z' }, CUR, null), 'prior');
});
test('labelTrade: unstamped + updatedAt, ts after -> current', () => {
  assert.equal(labelTrade({ timestamp: '2026-05-20T00:00:00Z' }, CUR, '2026-05-15T00:00:00Z'), 'current');
});
test('labelTrade: unstamped + updatedAt, ts before -> prior', () => {
  assert.equal(labelTrade({ timestamp: '2026-05-10T00:00:00Z' }, CUR, '2026-05-15T00:00:00Z'), 'prior');
});
test('labelTrade: unstamped + no updatedAt -> unknown', () => {
  assert.equal(labelTrade({ timestamp: '2026-05-20T00:00:00Z' }, CUR, null), 'unknown');
});

test('currentEpochRate: trades/day over span', () => {
  const trades = [
    { timestamp: '2026-05-20T00:00:00Z' },
    { timestamp: '2026-05-22T00:00:00Z' },
    { timestamp: '2026-05-24T00:00:00Z' },
  ];
  const { rate_per_day } = currentEpochRate(trades);
  assert.ok(rate_per_day > 0);                  // 3 trades over 4 days -> ~0.75/day
});
test('currentEpochRate: empty -> null', () => {
  assert.equal(currentEpochRate([]).rate_per_day, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/segment-by-epoch.test.mjs`
Expected: FAIL — `Cannot find module './segment-by-epoch.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/segment-by-epoch.mjs
// Label loaded trades by ruleset epoch and apply the straddle policy for
// adapt-strategy. Pure functions + stdin CLI.
// Spec: docs/superpowers/specs/2026-05-23-adapt-strategy-epoch-conditional-split-design.md
import { fileURLToPath } from 'node:url';
import { resolve as resolvePath } from 'node:path';

export function labelTrade(trade, currentVersions, updatedAt) {
  if (trade.strategyVersion) {
    return currentVersions.includes(trade.strategyVersion) ? 'current' : 'prior';
  }
  if (!updatedAt) return 'unknown';
  return new Date(trade.timestamp).getTime() >= new Date(updatedAt).getTime() ? 'current' : 'prior';
}

export function currentEpochRate(currentTrades) {
  if (!currentTrades.length) return { rate_per_day: null, span_days: 0 };
  const times = currentTrades.map(t => new Date(t.timestamp).getTime()).sort((a, b) => a - b);
  const spanDays = Math.max((times[times.length - 1] - times[0]) / 86400000, 1 / 24); // floor at 1h
  return { rate_per_day: +(currentTrades.length / spanDays).toFixed(3), span_days: +spanDays.toFixed(3) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/segment-by-epoch.test.mjs`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/segment-by-epoch.mjs scripts/segment-by-epoch.test.mjs
git commit -m "feat(epoch): add labelTrade + currentEpochRate"
```

---

## Task 3: `segment` (policy + reporting + override)

**Files:**
- Modify: `scripts/segment-by-epoch.mjs`
- Test: `scripts/segment-by-epoch.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// append to scripts/segment-by-epoch.test.mjs
import { segment } from './segment-by-epoch.mjs';

const stamped = (v, ts) => ({ strategyVersion: v, timestamp: ts });
const cur = (ts) => stamped('X', ts);
const prior = (ts) => stamped('W', ts);

test('segment Case 1: single epoch -> recommended_case 1, full set kept', () => {
  const trades = [cur('2026-05-20T00:00:00Z'), cur('2026-05-21T00:00:00Z')];
  const r = segment(trades, { currentVersions: ['X'], updatedAt: null });
  assert.equal(r.recommended_case, 1);
  assert.equal(r.current_epoch_set.length, 2);
  assert.equal(r.mixed_provenance, false);
});

test('segment Case 2: straddled + cur>=min -> case 2, only current kept', () => {
  const trades = [];
  for (let i = 0; i < 20; i++) trades.push(cur(`2026-05-${10 + i % 10}T0${i % 9}:00:00Z`));
  trades.push(prior('2026-05-01T00:00:00Z'));
  const r = segment(trades, { currentVersions: ['X'], updatedAt: null, minCurrent: 20 });
  assert.equal(r.recommended_case, 2);
  assert.equal(r.counts.current, 20);
  assert.equal(r.current_epoch_set.length, 20);
  assert.equal(r.drop.dropped, 1);
});

test('segment Case 3: straddled + cur<min -> case 3 (no proposals)', () => {
  const trades = [cur('2026-05-20T00:00:00Z'), prior('2026-05-01T00:00:00Z')];
  const r = segment(trades, { currentVersions: ['X'], updatedAt: null, minCurrent: 20 });
  assert.equal(r.recommended_case, 3);
  assert.equal(r.trades_needed, 19);
  assert.equal(r.low_confidence, false);
});

test('segment Case 3 + override -> case 2, low_confidence', () => {
  const trades = [cur('2026-05-20T00:00:00Z'), cur('2026-05-21T00:00:00Z'), prior('2026-05-01T00:00:00Z')];
  const r = segment(trades, { currentVersions: ['X'], updatedAt: null, minCurrent: 20, minCurrentOverride: 2 });
  assert.equal(r.recommended_case, 2);
  assert.equal(r.override_applied, true);
  assert.equal(r.low_confidence, true);
});

test('segment: mixed provenance flag when stamped + unstamped coexist in straddle', () => {
  const trades = [cur('2026-05-20T00:00:00Z'), { timestamp: '2026-05-02T00:00:00Z' }]; // 2nd unstamped, no updatedAt -> unknown
  const r = segment(trades, { currentVersions: ['X'], updatedAt: null, minCurrent: 20 });
  assert.equal(r.mixed_provenance, true);
  assert.equal(r.counts.unknown, 1);
});

test('segment: stamped_vs_fallback split counted', () => {
  const trades = [cur('2026-05-20T00:00:00Z'), { timestamp: '2026-05-19T00:00:00Z' }];
  const r = segment(trades, { currentVersions: ['X'], updatedAt: '2026-05-15T00:00:00Z', minCurrent: 20 });
  assert.equal(r.stamped_vs_fallback.stamped, 1);
  assert.equal(r.stamped_vs_fallback.fallback, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/segment-by-epoch.test.mjs`
Expected: FAIL — `segment is not a function`.

- [ ] **Step 3: Write minimal implementation**

```js
// append to scripts/segment-by-epoch.mjs (before the CLI block in Step 4)
export function segment(trades, opts = {}) {
  const { currentVersions = [], updatedAt = null, minCurrent = 20, minCurrentOverride = null } = opts;
  const labeled = trades.map(t => ({ ...t, epoch: labelTrade(t, currentVersions, updatedAt) }));
  const counts = { current: 0, prior: 0, unknown: 0 };
  let stamped = 0, fallback = 0;
  for (const t of labeled) {
    counts[t.epoch]++;
    if (t.strategyVersion) stamped++; else fallback++;
  }
  const cur = counts.current;
  const straddled = counts.prior > 0 || counts.unknown > 0;
  const current_epoch_set = labeled.filter(t => t.epoch === 'current');

  let recommended_case, override_applied = false, low_confidence = false;
  if (!straddled) {
    recommended_case = 1;
  } else if (cur >= minCurrent) {
    recommended_case = 2;
  } else if (minCurrentOverride != null && cur >= minCurrentOverride) {
    recommended_case = 2; override_applied = true; low_confidence = true;
  } else {
    recommended_case = 3;
  }

  const dropped = counts.prior + counts.unknown;
  const { rate_per_day } = currentEpochRate(current_epoch_set);
  const trades_needed = Math.max(0, minCurrent - cur);
  const eta_days = rate_per_day && rate_per_day > 0 ? Math.ceil(trades_needed / rate_per_day) : null;

  return {
    labeled,
    counts,
    stamped_vs_fallback: { stamped, fallback },
    current_epoch_set,
    straddled,
    recommended_case,
    override_applied,
    low_confidence,
    mixed_provenance: straddled && stamped > 0 && fallback > 0,
    drop: { dropped, total: trades.length, pct: trades.length ? +(dropped / trades.length).toFixed(3) : 0 },
    rate_per_day,
    trades_needed,
    eta_days,
  };
}
```

- [ ] **Step 4: Add the stdin CLI** (append to `scripts/segment-by-epoch.mjs`)

```js
// CLI: trades JSON array on stdin; flags configure the policy.
//   --current-versions X,W   --updated-at <ISO>   --min-current 20   --min-current-override <N>
{
  const __filename = fileURLToPath(import.meta.url);
  const argv1abs = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (__filename === argv1abs) {
    const args = process.argv.slice(2);
    const flag = (n) => { const i = args.indexOf(n); return i === -1 ? undefined : args[i + 1]; };
    const currentVersions = (flag('--current-versions') || '').split(',').map(s => s.trim()).filter(Boolean);
    const updatedAt = flag('--updated-at') || null;
    const minCurrent = Number(flag('--min-current') ?? 20);
    const ov = flag('--min-current-override');
    const minCurrentOverride = ov == null ? null : Number(ov);
    let stdin = '';
    process.stdin.on('data', c => { stdin += c; });
    process.stdin.on('end', () => {
      let trades;
      try { trades = JSON.parse(stdin); } catch (err) {
        process.stderr.write(`stdin is not valid JSON: ${err.message}\n`); process.exit(6);
      }
      process.stdout.write(JSON.stringify(segment(trades, { currentVersions, updatedAt, minCurrent, minCurrentOverride }), null, 2) + '\n');
    });
  }
}
```

- [ ] **Step 5: Run tests + CLI smoke**

Run: `node --test scripts/segment-by-epoch.test.mjs`
Expected: PASS (13 tests total).

Run (smoke):
```bash
echo '[{"strategyVersion":"X","timestamp":"2026-05-20T00:00:00Z"},{"strategyVersion":"W","timestamp":"2026-05-01T00:00:00Z"}]' | node scripts/segment-by-epoch.mjs --current-versions X --min-current 20
```
Expected: JSON with `"recommended_case": 3`, `"counts": { "current": 1, "prior": 1, "unknown": 0 }`.

- [ ] **Step 6: Commit**

```bash
git add scripts/segment-by-epoch.mjs scripts/segment-by-epoch.test.mjs
git commit -m "feat(epoch): segment straddle policy + reporting + override CLI"
```

---

## Task 4: Wire the scripts into `adapt-strategy/SKILL.md`

This task edits the skill's markdown instructions. There is no unit test; verify by reading and by the dry-run in Step 5.

**Files:**
- Modify: `.claude/skills/adapt-strategy/SKILL.md`

- [ ] **Step 1: Add the current-epoch resolution to Step 1**

At the end of `## Step 1 — Resolve target agent, strategy, and sandboxes` (after the existing numbered list, before `## Step 3`), insert:

````markdown
6. **Determine the current epoch.** Build the input for `scripts/resolve-current-epoch.mjs`:
   - `markers`: for each `<DIR>` in `<PROPHET_DIRS>`, read `data/sandboxes/<DIR>/.current_strategy_version.json` if it exists; collect the objects.
   - `newestStampedVersion`: the `strategyVersion` of the most recent loaded trade that has one (resolved in Step 3); pass `null` on this first pass and re-run if needed.
   - `configVersion`: resolve the strategy's current rules with `resolveStrategyRules` (from `scripts/strategy-version.mjs`) and hash with `computeStrategyVersion`.

   Pipe that JSON to `node scripts/resolve-current-epoch.mjs`. Record the returned `currentVersions` (call it `CURRENT_VERSIONS`), `source`, `consistencyWarning`, and `divergent`. Also read the strategy's `updatedAt` (may be absent) for the Step 3.4 fallback.

   State to the user:
   > Current ruleset: `<CURRENT_STRATEGY_ID>` @ `<CURRENT_VERSIONS>` (source: `<source>`; updatedAt: `<updatedAt|none>`).

   If `consistencyWarning` is non-null, surface it prominently (the config has an un-deployed edit; loaded trades reflect the running rules). If `divergent` is true, note that sandboxes are running different rulesets. If `source === 'none'` (no marker, no stamped trades, config rules empty), stop — there is nothing coherent to adapt toward.
````

- [ ] **Step 2: Add stamp-field loading to Step 3**

In `## Step 3 — Load recent decisions`, in the per-record extraction list (after `reasoning`), add:

```markdown
- `strategyId` and `strategyVersion` (both may be absent on pre-stamp records)
```

- [ ] **Step 3: Insert the new Step 3.4**

Immediately before `## Step 3.5 — Split into adapt set and hold-out set`, insert:

````markdown
## Step 3.4 — Epoch segmentation

Pipe the loaded trades (JSON array) to `scripts/segment-by-epoch.mjs` with flags:

```
node scripts/segment-by-epoch.mjs --current-versions <CURRENT_VERSIONS joined by commas> --updated-at <updatedAt or omit> --min-current 20 [--min-current-override <N> only if the user explicitly opts in]
```

Read `recommended_case` and act:

- **Case 1 (single epoch):** proceed to Step 3.5 on the **full** loaded set, unchanged.
  > Single ruleset across all N loaded trades. Proceeding normally.
- **Case 2 (straddled, enough current-epoch data):** proceed to Step 3.5 on `current_epoch_set` only.
  > ⚠️ Window straddles a rule change. Adapting on `counts.current` current-epoch trades. Dropped `drop.dropped` of `drop.total` (`drop.pct`×100%). Hold-out drawn only from the current epoch.
  > If `drop.dropped` is mostly `counts.unknown` (not `counts.prior`): "Most dropped trades are pre-stamp `unknown` — expected this soon after epoch-stamping rollout, not a bug."
- **Case 3 (too little current-epoch data):** run Step 5 gap analysis for information, then **STOP — emit no proposals** (skip Steps 6-8).
  > 🛑 Only `counts.current` trades under the current ruleset; need ≥20. You are `trades_needed` short; at ~`rate_per_day`/day that's ≈ `eta_days` days. To escape sooner: iterate less often, or re-run with `--min-current-override <N>` for low-confidence proposals.

Always print the breakdown prominently: `current=<counts.current>, prior=<counts.prior>, unknown=<counts.unknown>` and the `stamped_vs_fallback` split. If `mixed_provenance` is true, warn: "Mixed-provenance window — un-stamped labels are heuristic and may disagree with stamped neighbors near the boundary." If `override_applied`, tag every resulting proposal **low-confidence**.

**Steps 5-6 operate ONLY on the set Step 3.4 forwards** (full set in Case 1, `current_epoch_set` in Case 2).
````

- [ ] **Step 4: Update Step 3.5 to consume the forwarded set**

At the start of `## Step 3.5`, add one sentence:

```markdown
Operate on the set forwarded by Step 3.4 (the full loaded set in Case 1, or `current_epoch_set` in Case 2). Step 3.5 is not reached in Case 3. The 80/20 split, significance gate, and hold-out scorer are otherwise unchanged — they now receive a single-epoch set, so the hold-out is guaranteed the same ruleset as the adapt set.
```

- [ ] **Step 5: Verify the skill references resolve and the scripts run**

Run (confirms the scripts the skill now calls exist and behave):
```bash
echo '{"markers":[{"strategyVersion":"X"}],"newestStampedVersion":"X","configVersion":"Y"}' | node scripts/resolve-current-epoch.mjs
```
Expected: `"currentVersions": ["X"]`, `"source": "marker"`, non-null `consistencyWarning`.

Read the edited `## Step 1`, `## Step 3`, `## Step 3.4`, `## Step 3.5` sections and confirm each script path and flag name matches Tasks 1-3 exactly (`--current-versions`, `--updated-at`, `--min-current`, `--min-current-override`).

- [ ] **Step 6: Commit**

```bash
git add .claude/skills/adapt-strategy/SKILL.md
git commit -m "feat(epoch): adapt-strategy segments by ruleset epoch before split"
```

---

## Task 5: Mirror into `adapt-strategy-penny/SKILL.md`

**Files:**
- Modify: `.claude/skills/adapt-strategy-penny/SKILL.md`

- [ ] **Step 1: Apply the same four edits**

Open `.claude/skills/adapt-strategy-penny/SKILL.md` and apply the identical edits from Task 4 Steps 1-4, adapting only the surrounding step numbers if the penny skill numbers differ. The script paths, flags, thresholds, case logic, and report wording are identical — the epoch policy is asset-class agnostic. If the penny skill's load/split steps are numbered differently, place the segmentation step immediately before its split step and the current-epoch resolution at the end of its agent/strategy/sandbox-resolution step.

- [ ] **Step 2: Verify**

Read the edited penny skill and confirm: current-epoch resolution added before loading, stamp fields loaded, segmentation step inserted before the split, split consumes the forwarded set. Confirm script paths/flags match Tasks 1-3.

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/adapt-strategy-penny/SKILL.md
git commit -m "feat(epoch): mirror epoch segmentation into adapt-strategy-penny"
```

---

## Task 6: Full-suite regression

- [ ] **Step 1: Run the whole test suite**

Run: `npm test`
Expected: PASS — includes `scripts/resolve-current-epoch.test.mjs` and `scripts/segment-by-epoch.test.mjs` (both under the `scripts/**` glob), plus all prior tests.

- [ ] **Step 2: Commit (only if any test-glob fixups were needed)**

```bash
git add -A
git commit -m "test(epoch): confirm full suite green for epoch split"
```

---

## Self-Review

- **Spec coverage:** Goal 1 (label trades) → Task 2. Goal 2 (learn only from current epoch) → Task 3 (Case 2 filter) + Task 4. Goal 3 (stand down when thin) → Task 3 (Case 3) + Task 4. Goal 4 (preserve single-epoch behavior) → Task 3 (Case 1) + Task 4 Step 3. Goal 5 (current epoch = what the agent is stamping, not config) → Task 1 (marker precedence + post-mutation test). Consistency warning → Task 1. Mixed-provenance → Task 3. Actionable Case 3 + override → Task 3. Drop accounting / unknown prominence → Tasks 3,4. Multi-sandbox divergence → Task 1. Penny mirror → Task 5.
- **No placeholders:** every code/command step is concrete; skill edits give exact insertion text.
- **Type consistency:** `resolveCurrentEpoch({markers,newestStampedVersion,configVersion})` → `{currentVersions,source,consistencyWarning,divergent}`; `labelTrade(trade,currentVersions,updatedAt)`; `segment(trades,{currentVersions,updatedAt,minCurrent,minCurrentOverride})` → fields used identically in the skill markdown (`recommended_case`, `current_epoch_set`, `counts`, `drop`, `stamped_vs_fallback`, `mixed_provenance`, `override_applied`, `low_confidence`, `trades_needed`, `rate_per_day`, `eta_days`). CLI flag names match the skill calls.
- **Dependency:** `resolveStrategyRules`/`computeStrategyVersion` consumed from the Spec A plan's `scripts/strategy-version.mjs`; not re-created here.
