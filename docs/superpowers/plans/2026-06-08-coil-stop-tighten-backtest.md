# Coil Stop-Tightening Backtest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a read-only, pre-registered backtest that decides whether tightening Coil's −7% stop (primary −5%) cuts risk while holding returns, then run it and record the verdict.

**Architecture:** A direct mirror of the exit-timeout study (`scripts/coil-timeout-*.mjs`). The exit simulator already parametrizes `stopPct`, so the only new code is: a CVaR helper, a build that enumerates the *marginal set* (trades a tighter stop changes), a thin portfolio wrapper (reusing the timeout study's generic book engine) adding an `admitted` accounting, a hash-locked prereg, and a scorer applying the two-gate "cut risk, hold returns" rule. Output is reports + lab artifacts only — **no live Coil change**.

**Tech Stack:** Node ESM `.mjs`, `node:test`, the existing `scripts/coil-*` harness (exitsim/metrics/earnings/eventstudy), FMP earnings JSON (reused), `data/bar-cache/` daily bars.

**Spec:** `docs/superpowers/specs/2026-06-08-coil-stop-tighten-backtest-design.md`

**Branch:** `coil-stop-tighten-backtest` (spec already committed there at `ec9371c`). Lab-only; squash-merge to local main at the end, like the sibling studies.

---

## File Structure

**Reused unchanged (imported, not modified):**
- `scripts/coil-threshold-exitsim.mjs` — `simulateTrade(bars, entryIdx, { stopPct, maxHold, rsiExit })`, `entryFiresAt(closes, idx, rsiMax)`.
- `scripts/coil-threshold-metrics.mjs` — `applyFriction`, `mean`, `median`, `winRate`, `profitFactor`, `bootstrapMeanCI`, `bootstrapDiffCI`. **(Task 1 ADDS `cvar` here.)**
- `scripts/coil-threshold-earnings.mjs` — `earningsWithinNext5(barDates, idx, dates, horizon)`.
- `scripts/coil-eventstudy-bars.mjs` — `loadBars(root, ticker)` → `[{date,open,high,low,close}]`.
- `scripts/coil-eventstudy-build.mjs` — `MEANREV_UNIVERSE`, `chronoSplit`.
- `scripts/coil-meanrev-signal.mjs` — `wilderRSI(closes, period)`, `sma(closes, idx, period)`.
- `scripts/coil-eventstudy-prereg.mjs` — `sha256short`.
- `scripts/coil-timeout-build.mjs` — `boundaryFrom`, `tagSplit` (generic split helpers).
- `scripts/coil-timeout-portfolio.mjs` — `simulateTimeoutPortfolio` (strategy-agnostic, candidate-based book engine), `deepestDD`.
- `scripts/coil-timeout-score.mjs` — `ddPlacement`, `winsorizeUpside`.
- `data/lab/coil-earnings-dates.json` — reused (forward earnings filter).

**New files (this plan):**
- `scripts/coil-stop-build.mjs` + `.test.mjs` — marginal-set + per-variant portfolio enumeration at varying `stopPct`.
- `scripts/coil-stop-portfolio.mjs` + `.test.mjs` — `admittedByTightening` + re-export of the reused book engine.
- `scripts/coil-stop-prereg.mjs` + `.test.mjs` — hash-locked pre-registration.
- `scripts/coil-stop-score.mjs` + `.test.mjs` — `stopDeltas`, `saveWhipsawDecomp`, `frictionizeCandidates`, `decideStop`, render + CLI.
- `data/lab/coil-stop-prereg.json` — committed prereg artifact (Task 6).
- `data/lab/coil-stop-instances.json` — build output (gitignored data artifact; Task 6).
- `docs/lab/coil-stop-tighten-RESULTS.md` — final report (Task 6).

---

## Task 1: CVaR(5%) helper in metrics

**Files:**
- Modify: `scripts/coil-threshold-metrics.mjs` (add one export)
- Test: `scripts/coil-threshold-metrics.test.mjs` (append cases)

- [ ] **Step 1: Write the failing test** — append to `scripts/coil-threshold-metrics.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cvar } from './coil-threshold-metrics.mjs';

test('cvar averages the worst alpha-fraction of returns', () => {
  // 5 returns, alpha 0.4 -> ceil(0.4*5)=2 worst = [-0.5,-0.3] -> mean -0.4
  assert.equal(cvar([0.1, 0.2, -0.3, -0.5, 0.05], 0.4), -0.4);
});

test('cvar returns the single worst trade for a tiny sample at 5%', () => {
  assert.equal(cvar([-0.07], 0.05), -0.07);          // k = max(1, ceil(0.05*1)) = 1
  assert.equal(cvar([0.02, -0.04, 0.01], 0.05), -0.04); // k=1 -> worst single
});

test('cvar is monotonic: a deeper tail lowers it; empty -> null', () => {
  const a = cvar([0.01, -0.05, 0.02, -0.10, 0.03], 0.4);
  const b = cvar([0.01, -0.05, 0.02, -0.30, 0.03], 0.4);
  assert.ok(b < a);
  assert.equal(cvar([], 0.05), null);
  assert.equal(cvar([NaN, Infinity], 0.05), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/coil-threshold-metrics.test.mjs`
Expected: FAIL — `cvar` is not exported (`SyntaxError: ... does not provide an export named 'cvar'`).

- [ ] **Step 3: Add the implementation** — append to `scripts/coil-threshold-metrics.mjs` (after `profitFactor`):

```js
// Conditional Value-at-Risk at the alpha tail: mean of the worst alpha-fraction of returns
// (most negative). k = max(1, ceil(alpha*n)) so even a tiny sample reports its single worst
// trade. Non-finite values are dropped; empty -> null.
export function cvar(returns, alpha = 0.05) {
  const xs = returns.filter(Number.isFinite);
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const k = Math.max(1, Math.ceil(alpha * sorted.length));
  return mean(sorted.slice(0, k));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/coil-threshold-metrics.test.mjs`
Expected: PASS (all cvar cases + the pre-existing metrics cases).

- [ ] **Step 5: Commit**

```bash
git add scripts/coil-threshold-metrics.mjs scripts/coil-threshold-metrics.test.mjs
git commit -m "feat(coil-stop): add CVaR(5%) tail metric to the shared toolkit"
```

---

## Task 2: Build — marginal-set + per-variant portfolio enumeration

**Files:**
- Create: `scripts/coil-stop-build.mjs`
- Test: `scripts/coil-stop-build.test.mjs`

The marginal set is **paired**: fresh RSI<5 entries enumerated once on the **baseline 0.07** schedule, each re-simulated at every tighter `stopPct`. An entry is kept iff a tighter stop changes it *at all* — detected at the shallowest probe `0.03` (marginal sets are nested: `marginal@0.03 ⊇ marginal@0.04 ⊇ marginal@0.05 ⊇ marginal@0.06`, because a path that never reaches −3% never reaches a deeper level). Because a tighter stop exits **no later** than the baseline, no Phase-1 entry can censor when the baseline did not — so `n_delta = n_marginal` (no censoring bookkeeping needed here, unlike the timeout study).

- [ ] **Step 1: Write the failing test** — create `scripts/coil-stop-build.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enumerateMarginal, enumeratePortfolioStop, MARGINAL_PROBE } from './coil-stop-build.mjs';

// Synthetic bars: ascending dates, controllable OHLC. A long flat warmup keeps idx >= MIN_BARS-1
// reachable in tests by passing minBars:2 and stubbed entryFires/sim.
function bars(rows) {
  return rows.map((r, i) => ({ date: `2020-01-${String(i + 1).padStart(2, '0')}`, open: r.o, high: r.h, low: r.l, close: r.c }));
}

test('enumerateMarginal keeps only entries a tighter stop changes (marginal at the 0.03 probe)', () => {
  const b = bars([{ o: 100, h: 100, l: 100, c: 100 }, { o: 100, h: 100, l: 100, c: 100 }, { o: 100, h: 100, l: 100, c: 100 }]);
  // entryFires only at idx 0. Baseline (0.07) sim = a time_stop at +0 (flat). A variant sim that
  // returns a DIFFERENT gross at the 0.03 probe makes the entry marginal; identical gross drops it.
  const baseRes = { entry: 100, exit: 100, exitReason: 'time_stop', daysHeld: 1, grossReturn: 0, censored: false };
  const stub = (which) => (bb, i, opts) => {
    if (opts.stopPct === 0.07) return baseRes;
    if (which === 'changed') return { ...baseRes, exit: 97, exitReason: 'stop', grossReturn: -0.03 };
    return baseRes; // unchanged
  };
  const kept = enumerateMarginal(b, { minBars: 2, variants: [0.03, 0.04, 0.05, 0.06], entryFires: (c, i) => i === 0, sim: stub('changed') });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].grossBase, 0);
  assert.equal(kept[0].baseReason, 'time_stop');
  assert.equal(kept[0].perS['0.03'].gross, -0.03);

  const dropped = enumerateMarginal(b, { minBars: 2, variants: [0.03, 0.04, 0.05, 0.06], entryFires: (c, i) => i === 0, sim: stub('unchanged') });
  assert.equal(dropped.length, 0); // not marginal anywhere -> dropped
});

test('MARGINAL_PROBE is the shallowest tighter stop in the variant set', () => {
  assert.equal(MARGINAL_PROBE, 0.03);
});

test('enumeratePortfolioStop emits one fresh trade per non-overlapping signal with exitDate + exitReason', () => {
  const b = bars([{ o: 100, h: 100, l: 100, c: 100 }, { o: 100, h: 100, l: 100, c: 100 }, { o: 100, h: 100, l: 100, c: 100 }]);
  const sim = (bb, i, opts) => ({ entry: 100, exit: 102, exitReason: 'sma5_cross', daysHeld: 1, grossReturn: 0.02, censored: false });
  const out = enumeratePortfolioStop(b, { stopPct: 0.05, minBars: 2, entryFires: (c, i) => i === 0, sim });
  assert.equal(out.length, 1);
  assert.equal(out[0].exitDate, b[1].date);
  assert.equal(out[0].exitReason, 'sma5_cross');
  assert.equal(out[0].gross, 0.02);
});

test('enumeratePortfolioStop stops at a censored trade (no exit within the data)', () => {
  const b = bars([{ o: 100, h: 100, l: 100, c: 100 }, { o: 100, h: 100, l: 100, c: 100 }]);
  const sim = () => ({ entry: 100, exit: null, exitReason: null, daysHeld: 1, grossReturn: null, censored: true });
  const out = enumeratePortfolioStop(b, { stopPct: 0.05, minBars: 1, entryFires: () => true, sim });
  assert.equal(out.length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/coil-stop-build.test.mjs`
Expected: FAIL — module not found / no exports.

- [ ] **Step 3: Write the implementation** — create `scripts/coil-stop-build.mjs`:

```js
// scripts/coil-stop-build.mjs
// Stop-tightening study build (mirror of coil-timeout-build.mjs; the knob is stopPct, maxHold
// stays 5). Phase 1: paired marginal set on the 0.07 baseline schedule. Phase 2: per-variant
// fresh enumeration (a tighter stop frees a slot earlier -> the realized entry set is endogenous).
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wilderRSI } from './coil-meanrev-signal.mjs';
import { loadBars } from './coil-eventstudy-bars.mjs';
import { MEANREV_UNIVERSE } from './coil-eventstudy-build.mjs';
import { entryFiresAt, simulateTrade } from './coil-threshold-exitsim.mjs';
import { earningsWithinNext5 } from './coil-threshold-earnings.mjs';
import { boundaryFrom, tagSplit } from './coil-timeout-build.mjs';

export const MIN_BARS = 210, ENTRY_RSI = 5, MAX_HOLD = 5, BASELINE = 0.07;
export const VARIANTS = [0.03, 0.04, 0.05, 0.06];
export const MARGINAL_PROBE = 0.03; // shallowest tighter stop -> superset marginal set

// Phase 1: fresh RSI<5 entries on the BASELINE (0.07) schedule, re-simulated at every tighter
// stopPct. Keep only entries a tighter stop changes at all (marginal at the 0.03 probe).
export function enumerateMarginal(bars, {
  earningsDates = [], variants = VARIANTS, baseline = BASELINE, maxHold = MAX_HOLD, minBars = MIN_BARS,
  entryFires = (closes, i) => entryFiresAt(closes, i, ENTRY_RSI),
  sim = simulateTrade,
} = {}) {
  const closes = bars.map(b => b.close);
  const barDates = bars.map(b => b.date);
  const out = [];
  let openUntil = -1;
  for (let i = Math.max(minBars - 1, 0); i < bars.length; i += 1) {
    if (i <= openUntil) continue;
    if (!entryFires(closes, i)) continue;
    if (earningsWithinNext5(barDates, i, earningsDates)) continue;
    const base = sim(bars, i, { stopPct: baseline, maxHold });
    openUntil = i + (base.censored ? bars.length : base.daysHeld); // advance on the baseline schedule
    if (base.censored) break;
    const rsi2 = wilderRSI(closes.slice(0, i + 1), 2);
    const perS = {};
    for (const s of variants) {
      const t = sim(bars, i, { stopPct: s, maxHold });
      perS[String(s)] = { gross: t.grossReturn, exitReason: t.exitReason, daysHeld: t.daysHeld, censored: t.censored };
    }
    const probe = perS[String(MARGINAL_PROBE)];
    const changed = probe && (probe.exitReason !== base.exitReason || probe.gross !== base.grossReturn);
    if (!changed) continue; // tighter stop never touches this trade -> delta 0 at every variant
    out.push({ idx: i, date: barDates[i], rsi2, grossBase: base.grossReturn, baseReason: base.exitReason, perS });
  }
  return out;
}

// Phase 2: per-variant fresh enumeration at a fixed stopPct. openUntil advances by THIS variant's
// hold, so a tighter stop (shorter hold) frees the slot earlier and can admit a nearby re-entry.
// Records exitReason so the scorer's stop-slippage arm can dock slippage on stop exits only.
export function enumeratePortfolioStop(bars, {
  stopPct = BASELINE, earningsDates = [], maxHold = MAX_HOLD, minBars = MIN_BARS,
  entryFires = (closes, i) => entryFiresAt(closes, i, ENTRY_RSI),
  sim = simulateTrade,
} = {}) {
  const closes = bars.map(b => b.close);
  const barDates = bars.map(b => b.date);
  const out = [];
  let openUntil = -1;
  for (let i = Math.max(minBars - 1, 0); i < bars.length; i += 1) {
    if (i <= openUntil) continue;
    if (!entryFires(closes, i)) continue;
    if (earningsWithinNext5(barDates, i, earningsDates)) continue;
    const t = sim(bars, i, { stopPct, maxHold });
    openUntil = i + (t.censored ? bars.length : t.daysHeld);
    if (t.censored) break;
    const rsi2 = wilderRSI(closes.slice(0, i + 1), 2);
    out.push({ idx: i, date: barDates[i], rsi2, exitDate: barDates[i + t.daysHeld], exitReason: t.exitReason, gross: t.grossReturn });
  }
  return out;
}

// CLI: node scripts/coil-stop-build.mjs [--earnings ...] [--out data/lab/coil-stop-instances.json]
{
  const argv1 = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (fileURLToPath(import.meta.url) === argv1) {
    const args = process.argv.slice(2);
    const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
    const root = process.cwd();
    const earnPath = flag('--earnings', join(root, 'data', 'lab', 'coil-earnings-dates.json'));
    const out = flag('--out', join(root, 'data', 'lab', 'coil-stop-instances.json'));
    let earningsByTicker = {};
    if (existsSync(earnPath)) earningsByTicker = JSON.parse(readFileSync(earnPath, 'utf8'));
    else process.stderr.write(`WARNING: ${earnPath} missing — running WITHOUT the earnings filter (verdict not trustworthy until present)\n`);

    const allStops = [...VARIANTS, BASELINE]; // 0.03..0.06 + 0.07
    const marginal = [];
    const portfolio = Object.fromEntries(allStops.map(s => [String(s), []]));
    const canonicalDates = []; // baseline (0.07) fresh entries, for the split boundary
    for (const t of MEANREV_UNIVERSE) {
      const bars = loadBars(root, t);
      if (bars.length < MIN_BARS) continue;
      const ed = earningsByTicker[t] || [];
      for (const m of enumerateMarginal(bars, { earningsDates: ed })) marginal.push({ ticker: t, ...m });
      for (const s of allStops) {
        for (const c of enumeratePortfolioStop(bars, { stopPct: s, earningsDates: ed })) {
          portfolio[String(s)].push({ ticker: t, ...c });
          if (s === BASELINE) canonicalDates.push({ date: c.date });
        }
      }
    }
    const boundaryDate = boundaryFrom(canonicalDates);
    const taggedMarginal = tagSplit(marginal, boundaryDate);
    const taggedPortfolio = {};
    for (const s of allStops) taggedPortfolio[String(s)] = tagSplit(portfolio[String(s)], boundaryDate);

    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({
      boundaryDate, variants: VARIANTS, baseline: BASELINE,
      marginal: taggedMarginal, portfolio: taggedPortfolio,
      counts: { marginal: marginal.length, portfolioBaseline: portfolio[String(BASELINE)].length },
    }, null, 2));
    process.stdout.write(JSON.stringify({
      out, boundaryDate, marginal: marginal.length,
      portfolio: Object.fromEntries(allStops.map(s => [String(s), portfolio[String(s)].length])),
    }, null, 2) + '\n');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/coil-stop-build.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/coil-stop-build.mjs scripts/coil-stop-build.test.mjs
git commit -m "feat(coil-stop): build — marginal-set + per-variant portfolio enumeration"
```

---

## Task 3: Portfolio — admitted-by-tightening accounting

**Files:**
- Create: `scripts/coil-stop-portfolio.mjs`
- Test: `scripts/coil-stop-portfolio.test.mjs`

The book engine (`simulateTimeoutPortfolio`) is strategy-agnostic — it consumes candidates `{ticker,date,rsi2,exitDate,net}` and is reused as-is. The only new piece is `admittedByTightening`: the mirror of the timeout study's `blockedByExtension` — signals filled under the tighter stop but **not** under baseline (the realized opportunity *benefit* of faster slot turnover).

- [ ] **Step 1: Write the failing test** — create `scripts/coil-stop-portfolio.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulateStopPortfolio, admittedByTightening } from './coil-stop-portfolio.mjs';

test('admittedByTightening returns fills present under tighter stop but absent at baseline', () => {
  const pBase = { fills: [{ ticker: 'AAA', date: '2020-01-01', rsi2: 2, net: 0.01 }] };
  const pTight = { fills: [
    { ticker: 'AAA', date: '2020-01-01', rsi2: 2, net: 0.01 },
    { ticker: 'BBB', date: '2020-01-03', rsi2: 1, net: -0.05 },
  ] };
  const a = admittedByTightening(pBase, pTight);
  assert.equal(a.count, 1);
  assert.deepEqual(a.signals, [{ ticker: 'BBB', date: '2020-01-03', rsi2: 1, net: -0.05 }]);
});

test('admittedByTightening is empty when the tighter book admits nothing new', () => {
  const p = { fills: [{ ticker: 'AAA', date: '2020-01-01', rsi2: 2, net: 0.01 }] };
  assert.equal(admittedByTightening(p, p).count, 0);
});

test('simulateStopPortfolio is the reused candidate-based book engine (cap binds at maxPositions)', () => {
  const cands = [
    { ticker: 'A', date: '2020-01-01', rsi2: 1, exitDate: '2020-01-09', net: 0.10 },
    { ticker: 'B', date: '2020-01-01', rsi2: 2, exitDate: '2020-01-09', net: 0.10 },
    { ticker: 'C', date: '2020-01-01', rsi2: 3, exitDate: '2020-01-09', net: 0.10 },
  ];
  const r = simulateStopPortfolio(cands, { maxPositions: 2 });
  assert.equal(r.nTrades, 2);          // third is blocked by the 2-position cap
  assert.equal(r.blocked.length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/coil-stop-portfolio.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation** — create `scripts/coil-stop-portfolio.mjs`:

```js
// scripts/coil-stop-portfolio.mjs
// The Coil book engine is strategy-agnostic (candidate-based), so the timeout study's
// simulateTimeoutPortfolio is reused verbatim as the stop study's book sim. The only new piece
// is admittedByTightening — the mirror of blockedByExtension (opportunity BENEFIT, not cost).
import { simulateTimeoutPortfolio, deepestDD } from './coil-timeout-portfolio.mjs';

export { simulateTimeoutPortfolio as simulateStopPortfolio, deepestDD };

// Signals filled under the TIGHTER stop but NOT under baseline — the realized opportunity benefit
// of a tighter stop freeing slots faster. Keyed by ticker@date (mirror of blockedByExtension).
export function admittedByTightening(pBase, pTight) {
  const key = (f) => `${f.ticker}@${f.date}`;
  const filledBase = new Set(pBase.fills.map(key));
  const gained = pTight.fills.filter(f => !filledBase.has(key(f)));
  return { count: gained.length, signals: gained.map(f => ({ ticker: f.ticker, date: f.date, rsi2: f.rsi2, net: f.net })) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/coil-stop-portfolio.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/coil-stop-portfolio.mjs scripts/coil-stop-portfolio.test.mjs
git commit -m "feat(coil-stop): portfolio — admitted-by-tightening (opportunity-benefit) accounting"
```

---

## Task 4: Pre-registration artifact (hash-locked)

**Files:**
- Create: `scripts/coil-stop-prereg.mjs`
- Test: `scripts/coil-stop-prereg.test.mjs`

Mirror of `coil-timeout-prereg.mjs`. The `stable` serializer + `sha256short` self-hash means the scorer refuses to run on any post-hoc edit to the prereg.

- [ ] **Step 1: Write the failing test** — create `scripts/coil-stop-prereg.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStopPrereg, verifyStopPrereg } from './coil-stop-prereg.mjs';

test('buildStopPrereg fixes the primary -5% and the two 0.90 thresholds', () => {
  const a = buildStopPrereg({ marginalN: 100, trainN: 50, holdoutN: 50, createdUtc: '2026-06-08T00:00:00Z' });
  assert.equal(a.primary_stop_pct, 0.05);
  assert.equal(a.baseline_stop_pct, 0.07);
  assert.deepEqual(a.secondary_stop_pct, [0.03, 0.04, 0.06]);
  assert.equal(a.decision_rule.dd_reduction_floor, 0.90);
  assert.equal(a.decision_rule.return_retention_floor, 0.90);
  assert.equal(a.expected_outcome, 'KEEP');
});

test('verifyStopPrereg passes on a clean artifact and fails after tampering', () => {
  const a = buildStopPrereg({ marginalN: 100, trainN: 50, holdoutN: 50, createdUtc: '2026-06-08T00:00:00Z' });
  assert.equal(verifyStopPrereg(a).ok, true);
  const tampered = { ...a, primary_stop_pct: 0.04 }; // changed AFTER hashing
  assert.equal(verifyStopPrereg(tampered).ok, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/coil-stop-prereg.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation** — create `scripts/coil-stop-prereg.mjs`:

```js
// scripts/coil-stop-prereg.mjs
// Hash-locked pre-registration for the stop-tightening study (mirror of coil-timeout-prereg.mjs).
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256short } from './coil-eventstudy-prereg.mjs';

function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter(k => k !== 'artifact_hash')
      .map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export function buildStopPrereg({ marginalN, trainN, holdoutN, createdUtc }) {
  const a = {
    prereg_version: '1.0',
    created_utc: createdUtc ?? new Date().toISOString(),
    hypothesis: 'tightening Coil -7% stop does NOT cut risk enough to justify the expectancy give-up (expected null: KEEP)',
    variants: [0.03, 0.04, 0.05, 0.06],
    baseline_stop_pct: 0.07,
    primary_stop_pct: 0.05,
    secondary_stop_pct: [0.03, 0.04, 0.06],
    marginal_probe_pct: 0.03,
    exit_model: { rsi_exit: 70, sma5_cross: true, max_hold_days: 5, entry_rsi: 5, stop: 'intraday_gap_honest' },
    entry_fill: 'signal_day_close',
    earnings_filter: 'forward 5 trading bars, FMP stable earnings-calendar',
    enumeration: 'paired on the 0.07 baseline schedule (Phase 1 marginal subset); per-variant fresh enumeration (Phase 2)',
    friction_bps: { optimistic: 10, representative: 20, stress: 30 },
    stop_slippage_bps: 10,
    success_criterion: 'cut risk, hold returns',
    decision_metric: 'friction-net total return + max drawdown at 20bps',
    bootstrap: { method: 'date_block', block_sessions: 15, iterations: 10000, seed: 1234, ci_pct: [2.5, 97.5] },
    winsorize_pct: 90,
    decision_rule: {
      gateA_risk: 'holdout |maxDD(0.05)| <= 0.90 * |maxDD(0.07)| (>=10% relative drawdown reduction)',
      gateB_returns: 'holdout totalNet(0.05) >= 0.90 * totalNet(0.07) (<=10% relative give-up)',
      cvar: 'trade-level CVaR(5%) reported as corroboration, NOT a hard sub-gate',
      verdict: 'TIGHTEN iff gateA AND gateB; else KEEP labeled by failing gate; UNDERPOWERED if marginal n@0.05 < 30',
      dd_reduction_floor: 0.90,
      return_retention_floor: 0.90,
      dd_untested_ratio: 0.5,
    },
    power_floor_n: 30,
    expected_outcome: 'KEEP',
    split: 'chronological 50/50',
    counts: { marginal_n: marginalN, train_n: trainN, holdout_n: holdoutN },
  };
  a.artifact_hash = sha256short(stable(a));
  return a;
}

export function verifyStopPrereg(a) {
  const expected = sha256short(stable(a));
  return { ok: expected === a.artifact_hash, expected, found: a.artifact_hash };
}

// CLI: node scripts/coil-stop-prereg.mjs --instances data/lab/coil-stop-instances.json --out data/lab/coil-stop-prereg.json
{
  const argv1 = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (fileURLToPath(import.meta.url) === argv1) {
    const args = process.argv.slice(2);
    const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
    const inst = JSON.parse(readFileSync(flag('--instances', 'data/lab/coil-stop-instances.json'), 'utf8'));
    const marginal = inst.marginal || [];
    const trainN = marginal.filter(r => r.split === 'train').length;
    const holdoutN = marginal.filter(r => r.split === 'holdout').length;
    const a = buildStopPrereg({ marginalN: marginal.length, trainN, holdoutN });
    const out = flag('--out', 'data/lab/coil-stop-prereg.json');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(a, null, 2));
    process.stdout.write(`wrote ${out} (hash ${a.artifact_hash})\n`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/coil-stop-prereg.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/coil-stop-prereg.mjs scripts/coil-stop-prereg.test.mjs
git commit -m "feat(coil-stop): hash-locked pre-registration artifact"
```

---

## Task 5: Scorer — deltas, decomposition, two-gate decision, render

**Files:**
- Create: `scripts/coil-stop-score.mjs`
- Test: `scripts/coil-stop-score.test.mjs`

Pure functions first (unit-tested), then the CLI that wires them to the instances + prereg and writes `docs/lab/coil-stop-tighten-RESULTS.md`.

- [ ] **Step 1: Write the failing test** — create `scripts/coil-stop-score.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stopDeltas, saveWhipsawDecomp, frictionizeCandidates, decideStop } from './coil-stop-score.mjs';

// Two marginal entries at -5%: one SAVE (baseline went to the -7% stop, tightened locks -5%),
// one WHIPSAW (baseline reverted to +2% via sma5, tightened stopped at -5%).
const marginal = [
  { date: '2020-01-01', grossBase: -0.07, baseReason: 'stop',
    perS: { '0.05': { gross: -0.05, exitReason: 'stop' }, '0.03': { gross: -0.03, exitReason: 'stop' } } },
  { date: '2020-01-02', grossBase: 0.02, baseReason: 'sma5_cross',
    perS: { '0.05': { gross: -0.05, exitReason: 'stop' }, '0.03': { gross: -0.03, exitReason: 'stop' } } },
  { date: '2020-01-03', grossBase: 0.01, baseReason: 'sma5_cross',
    perS: { '0.05': { gross: 0.01, exitReason: 'sma5_cross' }, '0.03': { gross: -0.03, exitReason: 'stop' } } }, // NOT marginal at 0.05
];

test('stopDeltas computes the friction-net paired delta over only the entries marginal at s', () => {
  const rows = stopDeltas(marginal, 0.05, { frictionBps: 20 });
  assert.equal(rows.length, 2); // third entry is unchanged at 0.05 -> excluded
  // friction cancels at 20bps no-slip: delta = grossS - grossBase
  const byDate = Object.fromEntries(rows.map(r => [r.date, r]));
  assert.ok(Math.abs(byDate['2020-01-01'].net - 0.02) < 1e-12);  // -0.05 - (-0.07) = +0.02 SAVE
  assert.equal(byDate['2020-01-01'].branch, 'save');
  assert.ok(Math.abs(byDate['2020-01-02'].net - (-0.07)) < 1e-12); // -0.05 - 0.02 = -0.07 WHIPSAW
  assert.equal(byDate['2020-01-02'].branch, 'whipsaw');
});

test('stopDeltas stop-slippage arm docks slip on stop legs only, worsening whipsaws', () => {
  const rows = stopDeltas(marginal, 0.05, { frictionBps: 20, stopSlipBps: 10 });
  const byDate = Object.fromEntries(rows.map(r => [r.date, r]));
  // SAVE: both legs are stops -> slip cancels -> unchanged at +0.02
  assert.ok(Math.abs(byDate['2020-01-01'].net - 0.02) < 1e-12);
  // WHIPSAW: only the -5% leg is a stop -> delta worsens by 10bps -> -0.07 - 0.001 = -0.071
  assert.ok(Math.abs(byDate['2020-01-02'].net - (-0.071)) < 1e-12);
});

test('saveWhipsawDecomp partitions by sign and sums each branch', () => {
  const d = saveWhipsawDecomp([{ net: 0.02 }, { net: -0.07 }, { net: 0.01 }]);
  assert.equal(d.n, 3);
  assert.equal(d.nSave, 2); assert.ok(Math.abs(d.saveSum - 0.03) < 1e-12);
  assert.equal(d.nWhipsaw, 1); assert.ok(Math.abs(d.dragSum - (-0.07)) < 1e-12);
  assert.ok(Math.abs(d.net - (-0.04)) < 1e-12);
});

test('frictionizeCandidates maps gross->net and docks stop-slip on stop exits only', () => {
  const cands = [
    { ticker: 'A', date: '2020-01-01', rsi2: 1, exitDate: '2020-01-03', exitReason: 'stop', gross: -0.05 },
    { ticker: 'B', date: '2020-01-01', rsi2: 2, exitDate: '2020-01-03', exitReason: 'sma5_cross', gross: 0.02 },
  ];
  const out = frictionizeCandidates(cands, { bps: 20, stopSlipBps: 10 });
  assert.ok(Math.abs(out[0].net - (-0.05 - 0.002 - 0.001)) < 1e-12); // 20bps + 10bps slip on the stop
  assert.ok(Math.abs(out[1].net - (0.02 - 0.002)) < 1e-12);          // 20bps only (not a stop)
});

test('decideStop: TIGHTEN only when both gates pass; labeled KEEPs otherwise; underpowered floor', () => {
  assert.equal(decideStop({ gateA: true, gateB: true, nMarginal: 50 }).verdict, 'TIGHTEN');
  assert.match(decideStop({ gateA: false, gateB: true, nMarginal: 50 }).reason, /no material risk reduction/);
  assert.match(decideStop({ gateA: true, gateB: false, nMarginal: 50 }).reason, /return give-up too large/);
  assert.match(decideStop({ gateA: false, gateB: false, nMarginal: 50 }).reason, /strictly dominated/);
  assert.equal(decideStop({ gateA: true, gateB: true, nMarginal: 12 }).verdict, 'UNDERPOWERED');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/coil-stop-score.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation** — create `scripts/coil-stop-score.mjs`:

```js
// scripts/coil-stop-score.mjs
// Stop-tightening scorer: paired marginal deltas + save/whipsaw decomposition + the two-gate
// "cut risk, hold returns" decision rule. Train kill-gate + single frozen holdout read; refuses
// to score on a prereg-hash mismatch.
import { applyFriction, mean, bootstrapMeanCI, cvar } from './coil-threshold-metrics.mjs';
import { winsorizeUpside, ddPlacement } from './coil-timeout-score.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

// Per-trade friction-net paired delta over entries MARGINAL at s (gross or exit changed vs base).
// Friction cancels at no-slip; the slippage arm docks slip on stop legs only (so whipsaws worsen).
export function stopDeltas(marginal, s, { frictionBps = 20, stopSlipBps = 0 } = {}) {
  const key = String(s);
  const slip = stopSlipBps / 10000;
  const rows = [];
  for (const m of marginal) {
    const e = m.perS[key];
    if (!e || !Number.isFinite(e.gross) || !Number.isFinite(m.grossBase)) continue;
    if (e.gross === m.grossBase && e.exitReason === m.baseReason) continue; // not marginal at this s
    const slipS = (stopSlipBps && e.exitReason === 'stop') ? slip : 0;
    const slipB = (stopSlipBps && m.baseReason === 'stop') ? slip : 0;
    const net = (applyFriction(e.gross, frictionBps) - slipS) - (applyFriction(m.grossBase, frictionBps) - slipB);
    rows.push({ date: m.date, net, branch: net > 0 ? 'save' : 'whipsaw', grossBase: m.grossBase, grossS: e.gross });
  }
  return rows;
}

// Partition paired-delta rows into saves (net>0) and whipsaws (net<=0); the headline operator number.
export function saveWhipsawDecomp(rows) {
  const d = { n: rows.length, nSave: 0, nWhipsaw: 0, saveSum: 0, dragSum: 0, net: 0 };
  for (const r of rows) {
    d.net += r.net;
    if (r.net > 0) { d.nSave += 1; d.saveSum += r.net; }
    else { d.nWhipsaw += 1; d.dragSum += r.net; }
  }
  return d;
}

// gross -> friction-net per portfolio candidate; optional stop-slippage on stop exits only.
export function frictionizeCandidates(cands, { bps = 20, stopSlipBps = 0 } = {}) {
  const slip = stopSlipBps / 10000;
  return cands.map(c => ({
    ticker: c.ticker, date: c.date, rsi2: c.rsi2, exitDate: c.exitDate,
    net: applyFriction(c.gross, bps) - ((stopSlipBps && c.exitReason === 'stop') ? slip : 0),
  }));
}

// Pre-registered "cut risk, hold returns" verdict. gateA = risk cut >=10%; gateB = returns held within 10%.
export function decideStop({ gateA, gateB, nMarginal, powerFloorN = 30 }) {
  if ((nMarginal ?? 0) < powerFloorN) return { verdict: 'UNDERPOWERED', reason: `marginal n@0.05=${nMarginal ?? 0} < ${powerFloorN}` };
  if (gateA && gateB) return { verdict: 'TIGHTEN', reason: 'risk cut >=10% AND returns held within 10%' };
  if (!gateA && !gateB) return { verdict: 'KEEP', reason: 'strictly dominated (worse on risk and returns)' };
  if (!gateA) return { verdict: 'KEEP', reason: 'no material risk reduction (maxDD not cut >=10%)' };
  return { verdict: 'KEEP', reason: 'return give-up too large (>10% relative)' };
}

function pct(x) { return x == null ? 'n/a' : (x * 100).toFixed(2) + '%'; }

function renderResults(d) {
  const L = [];
  L.push('# Coil Stop-Tightening Backtest — Results', '');
  const ddTag = (d.verdict.verdict === 'TIGHTEN' && d.dd.untested) ? ' — **UNCONFIRMED (gate A untested: no material holdout drawdown)**' : '';
  L.push(`**Verdict: ${d.verdict.verdict}** — ${d.verdict.reason}${ddTag}`, '');
  L.push(`Primary stop=−5% vs baseline −7%; friction ${d.bps}bps; prereg hash \`${d.prereg.artifact_hash}\`. Expected: KEEP.`, '');
  L.push('## Marginal set — save vs whipsaw (holdout, primary −5%)', '');
  L.push(`- marginal n@0.05 = ${d.decomp.n}`);
  L.push(`- **saves: n=${d.decomp.nSave}, sum ${pct(d.decomp.saveSum)}**`);
  L.push(`- **whipsaws: n=${d.decomp.nWhipsaw}, drag ${pct(d.decomp.dragSum)}**`);
  L.push(`- net marginal Δ ${pct(d.decomp.net)}; bootstrap CI [${pct(d.deltaCI.lo)}, ${pct(d.deltaCI.hi)}]`);
  L.push(`- winsorized-upside net Δ CI [${pct(d.deltaCIw.lo)}, ${pct(d.deltaCIw.hi)}] (saves capped at p${d.prereg.winsorize_pct})`, '');
  L.push('## Portfolio gates (holdout)', '');
  L.push(`- baseline −7%: net ${pct(d.p07.totalNet)}, maxDD ${pct(d.p07.maxDrawdown)}, CVaR5% ${pct(d.cvar07)}, trades ${d.p07.nTrades}`);
  L.push(`- tightened −5%: net ${pct(d.p05.totalNet)}, maxDD ${pct(d.p05.maxDrawdown)}, CVaR5% ${pct(d.cvar05)}, trades ${d.p05.nTrades}`);
  L.push(`- **gate A (risk):** |maxDD| ${pct(Math.abs(d.p05.maxDrawdown))} vs floor ${pct(d.floorA * Math.abs(d.p07.maxDrawdown))} → ${d.gateA}`);
  L.push(`- **gate B (returns):** net ${pct(d.p05.totalNet)} vs floor ${pct(d.floorB * d.p07.totalNet)} → ${d.gateB}`);
  if (d.returnsBaselineNonPositive) L.push('- ⚠️ baseline holdout net ≤ 0 — gate B ratio is unreliable; treat returns as inconclusive');
  L.push(`- admitted-by-tightening (filled@−5%, not@−7%): ${d.admitted.count}` + (d.admitted.count ? ` — mean counterfactual net ${pct(mean(d.admitted.signals.map(s => s.net)))}` : ''), '');
  L.push('## Stop-slippage sensitivity (fill at stop −10bps; primary verdict reads at 20bps)', '');
  L.push(`- tightened −5% under slip: net ${pct(d.p05slip.totalNet)}, maxDD ${pct(d.p05slip.maxDrawdown)} → gate A ${d.gateAslip}, gate B ${d.gateBslip}`);
  L.push(`- ${d.slipFragile ? '⚠️ a borderline TIGHTEN does NOT survive the slip arm (fragile/unconfirmed)' : 'verdict stable under the slip arm'}`, '');
  L.push('## Drawdown-episode placement (gate A audit)', '');
  L.push(`- split boundary ${d.boundaryDate}`);
  L.push(`- baseline deepest DD — train ${pct(d.dd.trainDD.dd)} @${d.dd.trainDD.at}; holdout ${pct(d.dd.holdoutDD.dd)} @${d.dd.holdoutDD.at}`);
  L.push(`- gate A ${d.dd.untested ? '**UNTESTED** (holdout comparatively calm — a TIGHTEN is unconfirmed)' : 'exercised by a holdout drawdown'}`, '');
  L.push('### Secondary stops (exploratory only — never gate; no post-hoc promotion)', '');
  for (const s of Object.keys(d.secondary)) { const x = d.secondary[s]; L.push(`- stop=−${(s * 100).toFixed(0)}%: marginal net Δ ${pct(x.net)}, portfolio net ${pct(x.pNet)}, maxDD ${pct(x.maxDD)}, whipsaws ${x.nWhipsaw}`); }
  L.push('', '## Limitations', '');
  L.push('- **Survivorship biases TOWARD KEEP** (removes the disaster names a tight stop would rescue), but Coil\'s existing −7% already bounds per-name loss, so the residual is small and a KEEP stays credible; a borderline TIGHTEN carries the caveat.');
  L.push('- Gate A is only meaningful if the holdout contains real stress — see the drawdown-episode placement above; an untested gate A makes any TIGHTEN unconfirmed.');
  L.push('- Daily-low stop touch + gap-through fills; regime sizing held normal; earnings = forward 5-trading-bar FMP filter. KEEP@−5% does not prove no tighter level ever helps — pre-register a fresh study with that level as primary.');
  return L.join('\n');
}

// CLI: node scripts/coil-stop-score.mjs --instances data/lab/coil-stop-instances.json \
//   --prereg data/lab/coil-stop-prereg.json --out docs/lab/coil-stop-tighten-RESULTS.md
{
  const argv1 = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (fileURLToPath(import.meta.url) === argv1) {
    const { verifyStopPrereg } = await import('./coil-stop-prereg.mjs');
    const { simulateStopPortfolio, admittedByTightening } = await import('./coil-stop-portfolio.mjs');
    const args = process.argv.slice(2);
    const flag = (n, dft) => { const i = args.indexOf(n); return i === -1 ? dft : args[i + 1]; };
    const inst = JSON.parse(readFileSync(flag('--instances', 'data/lab/coil-stop-instances.json'), 'utf8'));
    const prereg = JSON.parse(readFileSync(flag('--prereg', 'data/lab/coil-stop-prereg.json'), 'utf8'));
    const v = verifyStopPrereg(prereg);
    if (!v.ok) { process.stderr.write(`REFUSING to score: prereg hash mismatch (expected ${v.expected}, found ${v.found}).\n`); process.exit(4); }

    const bps = prereg.friction_bps.representative;
    const slipBps = prereg.stop_slippage_bps;
    const boot = { iterations: prereg.bootstrap.iterations, seed: prereg.bootstrap.seed, blockSessions: prereg.bootstrap.block_sessions };
    const S = prereg.primary_stop_pct;            // 0.05
    const BASE = prereg.baseline_stop_pct;        // 0.07
    const floorA = prereg.decision_rule.dd_reduction_floor;       // 0.90
    const floorB = prereg.decision_rule.return_retention_floor;   // 0.90
    const marginal = inst.marginal || [];
    const mHold = marginal.filter(r => r.split === 'holdout');
    const mTrain = marginal.filter(r => r.split === 'train');

    const candOf = (s, split, slip = 0) => frictionizeCandidates(
      (inst.portfolio[String(s)] || []).filter(c => c.split === split), { bps, stopSlipBps: slip });

    // TRAIN kill-gate (in-sample): KEEP early if BOTH gates already fail in-sample.
    const t05 = simulateStopPortfolio(candOf(S, 'train'));
    const t07 = simulateStopPortfolio(candOf(BASE, 'train'));
    const trainGateA = Math.abs(t05.maxDrawdown) <= floorA * Math.abs(t07.maxDrawdown);
    const trainGateB = t05.totalNet >= floorB * t07.totalNet;
    const killed = (mTrain.length > 0) && !trainGateA && !trainGateB;

    // FROZEN HOLDOUT (read once).
    const rows = stopDeltas(mHold, S, { frictionBps: bps });
    const decomp = saveWhipsawDecomp(rows);
    const deltaCI = bootstrapMeanCI(rows.map(r => ({ date: r.date, net: r.net })), boot);
    const capped = winsorizeUpside(rows.map(r => r.net), prereg.winsorize_pct);
    const deltaCIw = bootstrapMeanCI(rows.map((r, i) => ({ date: r.date, net: capped[i] })), boot);

    const p05 = simulateStopPortfolio(candOf(S, 'holdout'));
    const p07 = simulateStopPortfolio(candOf(BASE, 'holdout'));
    const cvar05 = cvar(p05.fills.map(f => f.net), 0.05);
    const cvar07 = cvar(p07.fills.map(f => f.net), 0.05);
    const gateA = Math.abs(p05.maxDrawdown) <= floorA * Math.abs(p07.maxDrawdown);
    const gateB = p05.totalNet >= floorB * p07.totalNet;
    const returnsBaselineNonPositive = p07.totalNet <= 0;
    const admitted = admittedByTightening(p07, p05);

    // Stop-slippage arm.
    const p05slip = simulateStopPortfolio(candOf(S, 'holdout', slipBps));
    const gateAslip = Math.abs(p05slip.maxDrawdown) <= floorA * Math.abs(p07.maxDrawdown);
    const gateBslip = p05slip.totalNet >= floorB * p07.totalNet;

    // Gate-A audit: baseline deepest DD train vs holdout over the FULL series.
    const dd = ddPlacement(
      simulateStopPortfolio([...candOf(BASE, 'train'), ...candOf(BASE, 'holdout')]).curve,
      inst.boundaryDate, prereg.decision_rule.dd_untested_ratio);

    const verdict = killed
      ? { verdict: 'KEEP', reason: 'train kill-gate: both gates already fail in-sample' }
      : decideStop({ gateA, gateB, nMarginal: decomp.n, powerFloorN: prereg.power_floor_n });
    const slipFragile = verdict.verdict === 'TIGHTEN' && !(gateAslip && gateBslip);

    // Secondary stops (exploratory).
    const secondary = {};
    for (const s2 of prereg.secondary_stop_pct) {
      const r2 = stopDeltas(mHold, s2, { frictionBps: bps });
      const pp = simulateStopPortfolio(candOf(s2, 'holdout'));
      secondary[s2] = { net: saveWhipsawDecomp(r2).net, pNet: pp.totalNet, maxDD: pp.maxDrawdown, nWhipsaw: saveWhipsawDecomp(r2).nWhipsaw };
    }

    const md = renderResults({
      prereg, bps, boundaryDate: inst.boundaryDate, verdict,
      decomp, deltaCI, deltaCIw, p05, p07, cvar05, cvar07, gateA, gateB, floorA, floorB,
      returnsBaselineNonPositive, admitted, p05slip, gateAslip, gateBslip, slipFragile, dd, secondary,
    });
    const out = flag('--out', 'docs/lab/coil-stop-tighten-RESULTS.md');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, md);
    process.stdout.write(`VERDICT: ${verdict.verdict} (${verdict.reason})${slipFragile ? ' [slip-fragile]' : ''}. Wrote ${out}\n`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/coil-stop-score.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the whole stop suite to confirm nothing regressed**

Run: `node --test scripts/coil-stop-*.test.mjs scripts/coil-threshold-metrics.test.mjs`
Expected: PASS (all).

- [ ] **Step 6: Commit**

```bash
git add scripts/coil-stop-score.mjs scripts/coil-stop-score.test.mjs
git commit -m "feat(coil-stop): scorer — marginal deltas, save/whipsaw decomp, two-gate decision, render"
```

---

## Task 6: Run the study end-to-end and record the verdict

**Files:**
- Create (generated): `data/lab/coil-stop-prereg.json`, `data/lab/coil-stop-instances.json`, `docs/lab/coil-stop-tighten-RESULTS.md`

This task executes the pipeline. The verdict is whatever the data says — **do not tune anything to chase TIGHTEN**; the expected outcome is KEEP and a KEEP is a successful study.

- [ ] **Step 1: Ensure the earnings file is present**

Check `data/lab/coil-earnings-dates.json` exists (reused from the sibling studies). If missing, regenerate (source the root `.env` first for `FMP_API_KEY` — it is not exported to the shell):

```bash
set -a; . ./.env; set +a
node scripts/coil-threshold-earnings.mjs --from 2018-06-01 --to 2026-06-08
```
Expected: `wrote data/lab/coil-earnings-dates.json (... tickers, ... failed)`. If it cannot fetch, the build still runs but prints a loud earnings-filter warning — do not trust the verdict in that case.

- [ ] **Step 2: Build the instances**

Run: `node scripts/coil-stop-build.mjs`
Expected: JSON to stdout with `marginal` count and per-stop `portfolio` counts; `data/lab/coil-stop-instances.json` written. Sanity-check: `marginal` > 0 and the baseline `0.07` portfolio count is in the low thousands.

- [ ] **Step 3: Write the prereg artifact (BEFORE scoring)**

Run: `node scripts/coil-stop-prereg.mjs`
Expected: `wrote data/lab/coil-stop-prereg.json (hash ...)`. This must happen before scoring — the scorer refuses on a hash mismatch.

- [ ] **Step 4: Score (single frozen holdout read)**

Run: `node scripts/coil-stop-score.mjs`
Expected: `VERDICT: <KEEP|TIGHTEN|UNDERPOWERED> (...)`. `docs/lab/coil-stop-tighten-RESULTS.md` written.

- [ ] **Step 5: Read the report and sanity-check the verdict against the spec**

Open `docs/lab/coil-stop-tighten-RESULTS.md`. Confirm: the save/whipsaw decomposition is present; gate A/B values are shown with their floors; the drawdown-episode placement names whether gate A was exercised or UNTESTED; the stop-slippage line is present; secondary stops are clearly marked exploratory. If the verdict is TIGHTEN, verify it is not flagged UNCONFIRMED (untested DD) or slip-fragile before treating it as real.

- [ ] **Step 6: Commit the artifacts + report**

```bash
git add data/lab/coil-stop-prereg.json docs/lab/coil-stop-tighten-RESULTS.md
git commit -m "feat(coil-stop): run study — RESULTS + prereg artifact (verdict: <FILL IN>)"
```
(`data/lab/coil-stop-instances.json` is a regenerable data artifact — only commit it if `data/lab/` is tracked in this repo; check `git status` and match the sibling studies' convention.)

---

## Task 7: Finish the branch

- [ ] **Step 1: Full suite green**

Run: `node --test scripts/coil-stop-*.test.mjs scripts/coil-threshold-metrics.test.mjs`
Expected: PASS.

- [ ] **Step 2: Squash-merge to local main (lab-only, mirrors the sibling studies)**

Re-assert the branch first (shared-root-worktree collision guard), then:

```bash
git checkout main
git merge --squash coil-stop-tighten-backtest
git commit -m "feat(coil-stop): pre-registered stop-tightening backtest (Subproject) — VERDICT: <FILL IN>"
```
Leave unpushed unless asked (the operator deploys from local main; lab studies are not pushed by default).

- [ ] **Step 3: Update the memory note** for this study (verdict + key numbers + that it is lab-only), mirroring the `coil-exit-timeout-backtest` memory entry, and add the one-line pointer to `MEMORY.md`.

---

## Self-Review

**1. Spec coverage** — every spec section maps to a task:
- Variants {0.03,0.04,0.05,0.06} vs 0.07, primary 0.05 → Task 2 (`VARIANTS`/`BASELINE`), Task 4 (prereg).
- Marginal set (outcome-changed, nested, probe at 0.03) → Task 2 `enumerateMarginal`.
- Save/whipsaw headline → Task 5 `stopDeltas` + `saveWhipsawDecomp`.
- Decision rule "cut risk, hold returns" (gate A maxDD ≤ 0.90×, gate B net ≥ 0.90×) → Task 5 `decideStop` + CLI gates; Task 4 prereg `dd_reduction_floor`/`return_retention_floor`.
- CVaR(5%) corroboration → Task 1 helper + Task 5 report (not a gate).
- Train kill-gate + single frozen holdout + hash refuse → Task 5 CLI; Task 4 verify.
- Survivorship-toward-KEEP + bounded caveat → Task 5 render limitations.
- DD-gate-untested → fatal → Task 5 `ddPlacement` + UNCONFIRMED tag.
- Flipped endogeneity / admitted-by-tightening → Task 3.
- Friction 20bps + stop-slippage arm → Task 5 `frictionizeCandidates` + slip arm.
- Secondary no-retro-promotion → Task 5 secondary block + render note.
- Power floor n<30 → Task 5 `decideStop`.
- Output RESULTS.md → Task 6.

**2. Placeholder scan** — the only intentional `<FILL IN>` tokens are the verdict in the Task 6/7 commit messages (filled at run time from real output). No "TBD"/"add error handling"/"similar to" placeholders; every code step shows complete code.

**3. Type consistency** — checked: marginal records carry `{idx,date,rsi2,grossBase,baseReason,perS:{[stop]:{gross,exitReason,daysHeld,censored}}}` (written in Task 2, read in Task 5 `stopDeltas`); portfolio candidates carry `{ticker,date,rsi2,exitDate,exitReason,gross}` (written Task 2, consumed by `frictionizeCandidates` Task 5 → `{...,net}` for `simulateStopPortfolio`/`admittedByTightening`); prereg fields used in Task 5 (`primary_stop_pct`, `baseline_stop_pct`, `decision_rule.dd_reduction_floor`/`return_retention_floor`/`dd_untested_ratio`, `stop_slippage_bps`, `winsorize_pct`, `friction_bps.representative`, `bootstrap.*`, `secondary_stop_pct`, `power_floor_n`) all exist in Task 4 `buildStopPrereg`. `simulateStopPortfolio` (Task 3 re-export) === `simulateTimeoutPortfolio` returns `{fills,blocked,totalNet,maxDrawdown,nTrades,curve}` as consumed in Task 5.
