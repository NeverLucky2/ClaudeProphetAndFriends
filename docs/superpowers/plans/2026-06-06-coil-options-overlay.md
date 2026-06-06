# Coil Options-Overlay Feasibility Model — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A cheap, assumption-swept model that screens whether expressing Coil's [0,5) edge via long calls or short puts has any room after IV-crush/spike + theta + spread — deciding whether real options data is worth buying.

**Architecture:** Four small `.mjs` under `scripts/coil-opt-*.mjs` (BS pricer → realized vol → per-structure overlay P&L → score/sweep/RESULTS). Pure functions unit-tested with `node:test`; the score CLI loads the existing Coil tape + daily bar-cache and is validated end-to-end on real data. Reuses `coil-threshold-metrics.mjs` (`bootstrapMeanCI`, `mean`, `winRate`) and `coil-eventstudy-bars.mjs` (`loadBars`).

**Tech Stack:** Node ≥18 ESM, `node:test`. No new deps. No network (data already on disk).

**Spec:** `docs/superpowers/specs/2026-06-06-coil-options-overlay-design.md`

**Execution:** inline TDD (small). Feature branch `coil-options-overlay`. Squash-merge to local main on completion. Lab-only.

**Locked constants:** `r=0.04`; entry-vol primary 5-day RV (sweep {5,20}); premium {0.8,1.0,1.2,1.5} (primary 1.2); crush {0,0.2,0.4} (primary 0.2); spike {0,0.3,0.6} (primary 0.3); spread {0.05,0.10} (primary 0.10); DTE {7,14,30} (primary 14). Bootstrap: block 15, 10000 iters, seed 1234.

---

## Task 1: Black-Scholes pricer

**Files:** Create `scripts/coil-opt-bsm.mjs`; Test `scripts/coil-opt-bsm.test.mjs`.

- [ ] **Step 1: failing test**
```js
// scripts/coil-opt-bsm.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bsPrice, normCdf } from './coil-opt-bsm.mjs';
const approx = (a, b, e = 1e-3) => assert.ok(Math.abs(a - b) <= e, `${a} ≈ ${b}`);

test('normCdf basics', () => { approx(normCdf(0), 0.5); approx(normCdf(1.96), 0.975, 2e-3); });
test('ATM call r=0 known value (~7.9656)', () => {
  approx(bsPrice('call', 100, 100, 1, 0, 0.2), 7.9656, 5e-3);
});
test('put-call parity: C - P = S - K e^{-rT}', () => {
  const C = bsPrice('call', 105, 100, 0.5, 0.04, 0.3);
  const P = bsPrice('put', 105, 100, 0.5, 0.04, 0.3);
  approx(C - P, 105 - 100 * Math.exp(-0.04 * 0.5), 1e-6);
});
test('T<=0 or sigma<=0 → intrinsic', () => {
  approx(bsPrice('call', 110, 100, 0, 0.04, 0.3), 10);
  approx(bsPrice('put', 90, 100, -1, 0.04, 0.3), 10);
  approx(bsPrice('call', 90, 100, 0.5, 0.04, 0), 0);
});
```
- [ ] **Step 2: run → FAIL.**
- [ ] **Step 3: implement**
```js
// scripts/coil-opt-bsm.mjs
// Black-Scholes European pricer. normCdf via Abramowitz-Stegun 7.1.26 erf approximation.
export function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}
export function bsPrice(type, S, K, T, r, sigma) {
  if (T <= 0 || sigma <= 0) return type === 'call' ? Math.max(0, S - K) : Math.max(0, K - S);
  const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  if (type === 'call') return S * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2);
  return K * Math.exp(-r * T) * normCdf(-d2) - S * normCdf(-d1);
}
```
- [ ] **Step 4: run → PASS (4 tests).**
- [ ] **Step 5: commit** `git -C "<wt>" add scripts/coil-opt-bsm.mjs scripts/coil-opt-bsm.test.mjs && git -C "<wt>" commit -m "feat(coil-opt): Black-Scholes pricer"`

---

## Task 2: Trailing realized vol

**Files:** Create `scripts/coil-opt-rv.mjs`; Test `scripts/coil-opt-rv.test.mjs`.

`trailingRealizedVol(closes, idx, window)` = annualized sample stdev of the `window` simple daily returns ending at `idx` (returns use closes[idx-window..idx]). `null` if `idx < window`.

- [ ] **Step 1: failing test**
```js
// scripts/coil-opt-rv.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trailingRealizedVol } from './coil-opt-rv.mjs';

test('null when insufficient history', () => {
  assert.equal(trailingRealizedVol([100, 101, 102], 1, 5), null);
});
test('zero vol on constant returns', () => {
  const c = [100, 110, 121, 133.1]; // constant +10%/bar → zero stdev of returns
  assert.equal(trailingRealizedVol(c, 3, 3), 0);
});
test('annualizes (×√252); positive for dispersed returns', () => {
  const c = [100, 110, 99, 108.9]; // alternating returns → positive vol
  const v = trailingRealizedVol(c, 3, 3);
  assert.ok(v > 0 && Number.isFinite(v));
});
```
- [ ] **Step 2: run → FAIL.**
- [ ] **Step 3: implement**
```js
// scripts/coil-opt-rv.mjs
// Annualized trailing realized vol (sample stdev of `window` simple daily returns ending at idx).
export function trailingRealizedVol(closes, idx, window) {
  if (idx < window) return null;
  const rets = [];
  for (let i = idx - window + 1; i <= idx; i += 1) rets.push(closes[i] / closes[i - 1] - 1);
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const varc = rets.reduce((a, b) => a + (b - m) * (b - m), 0) / (rets.length - 1);
  return Math.sqrt(varc) * Math.sqrt(252);
}
```
- [ ] **Step 4: run → PASS (3 tests).**
- [ ] **Step 5: commit** `git -C "<wt>" add scripts/coil-opt-rv.mjs scripts/coil-opt-rv.test.mjs && git -C "<wt>" commit -m "feat(coil-opt): trailing realized vol"`

---

## Task 3: Structure overlay P&L (state-dependent exit IV)

**Files:** Create `scripts/coil-opt-overlay.mjs`; Test `scripts/coil-opt-overlay.test.mjs`.

- [ ] **Step 1: failing test**
```js
// scripts/coil-opt-overlay.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exitIV, callPnl, putPnlMirror, putPnlHoldToExpiry } from './coil-opt-overlay.mjs';
const approx = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) <= e, `${a} ≈ ${b}`);

test('exitIV crushes on bounce, spikes on loser', () => {
  approx(exitIV(0.4, 100, 105, 0.2, 0.3), 0.4 * 0.8);   // S1>=S0 → crush
  approx(exitIV(0.4, 100, 95, 0.2, 0.3), 0.4 * 1.3);    // S1<S0 → spike
});
test('long call profits on a clean bounce (return on premium > 0)', () => {
  const r = callPnl({ S0: 100, S1: 106, daysHeld: 2, ivEntry: 0.4, dte: 14, r: 0.04, crush: 0, spike: 0.3, spreadPct: 0.10 });
  assert.ok(r > 0);
});
test('CSP hold-to-expiry keeps full premium when S_exp >= S0; loses big on a deep drop', () => {
  const win = putPnlHoldToExpiry({ S0: 100, S_exp: 103, ivEntry: 0.4, dte: 14, r: 0.04, spreadPct: 0.10 });
  const lose = putPnlHoldToExpiry({ S0: 100, S_exp: 80, ivEntry: 0.4, dte: 14, r: 0.04, spreadPct: 0.10 });
  assert.ok(win > 0 && lose < 0 && lose < -0.1);  // -20% intrinsic dwarfs premium
});
test('CSP mirror-exit: loser spike makes the buy-back more expensive (worse) than no spike', () => {
  const noSpike = putPnlMirror({ S0: 100, S1: 96, daysHeld: 2, ivEntry: 0.4, dte: 14, r: 0.04, crush: 0.2, spike: 0, spreadPct: 0.10 });
  const withSpike = putPnlMirror({ S0: 100, S1: 96, daysHeld: 2, ivEntry: 0.4, dte: 14, r: 0.04, crush: 0.2, spike: 0.6, spreadPct: 0.10 });
  assert.ok(withSpike < noSpike); // spike on the loser hurts the short put
});
```
- [ ] **Step 2: run → FAIL.**
- [ ] **Step 3: implement**
```js
// scripts/coil-opt-overlay.mjs
// Per-structure option overlay P&L for the Coil tape. State-dependent exit IV (leverage effect:
// vol falls on bounces, rises on losers). Calls priced at Coil's stock exit; CSP primary = hold
// to expiry (full theta), secondary = mirror Coil's stock exit (where the loser spike bites).
import { bsPrice } from './coil-opt-bsm.mjs';

export function exitIV(ivEntry, S0, S1, crush, spike) {
  return S1 >= S0 ? ivEntry * (1 - crush) : ivEntry * (1 + spike);
}

export function callPnl({ S0, S1, daysHeld, ivEntry, dte, r, crush, spike, spreadPct }) {
  const entry = bsPrice('call', S0, S0, dte / 365, r, ivEntry);
  if (entry <= 0) return null;
  const Tx = (dte - daysHeld) / 365;
  const xiv = exitIV(ivEntry, S0, S1, crush, spike);
  const exit = Tx > 0 ? bsPrice('call', S1, S0, Tx, r, xiv) : Math.max(0, S1 - S0);
  const buyNet = entry * (1 + spreadPct / 2), sellNet = exit * (1 - spreadPct / 2);
  return (sellNet - buyNet) / buyNet;                       // return on premium
}

export function putPnlMirror({ S0, S1, daysHeld, ivEntry, dte, r, crush, spike, spreadPct }) {
  const entry = bsPrice('put', S0, S0, dte / 365, r, ivEntry);
  const Tx = (dte - daysHeld) / 365;
  const xiv = exitIV(ivEntry, S0, S1, crush, spike);
  const exit = Tx > 0 ? bsPrice('put', S1, S0, Tx, r, xiv) : Math.max(0, S0 - S1);
  const premRec = entry * (1 - spreadPct / 2), buyBack = exit * (1 + spreadPct / 2);
  return (premRec - buyBack) / S0;                          // return on collateral (≈ strike)
}

export function putPnlHoldToExpiry({ S0, S_exp, ivEntry, dte, r, spreadPct }) {
  const entry = bsPrice('put', S0, S0, dte / 365, r, ivEntry);
  const premRec = entry * (1 - spreadPct / 2);
  const intrinsic = Math.max(0, S0 - S_exp);               // settle/assign at expiry intrinsic
  return (premRec - intrinsic) / S0;
}
```
- [ ] **Step 4: run → PASS (4 tests).**
- [ ] **Step 5: commit** `git -C "<wt>" add scripts/coil-opt-overlay.mjs scripts/coil-opt-overlay.test.mjs && git -C "<wt>" commit -m "feat(coil-opt): structure overlay P&L with state-dependent exit IV"`

---

## Task 4: Score helpers (tail-risk ratio + decision rules)

**Files:** Create `scripts/coil-opt-score.mjs`; Test `scripts/coil-opt-score.test.mjs`.

Pure, unit-tested: `tailRiskRatio(pnls)` (mean ÷ |worst-decile mean|), `decideCallKill(bestCellMean)` (KILLED if ≤0), `decidePutGate({ bandCIlos, spikeOn, tailRatio, stockTailRatio })` (pass iff all band CI los > 0 AND spikeOn AND tailRatio > stockTailRatio). The CLI (added Step 5) wires the real data.

- [ ] **Step 1: failing test**
```js
// scripts/coil-opt-score.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tailRiskRatio, decideCallKill, decidePutGate } from './coil-opt-score.mjs';
const approx = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) <= e, `${a} ≈ ${b}`);

test('tailRiskRatio = mean / |worst-decile mean|', () => {
  const pnls = Array.from({ length: 10 }, (_, i) => i - 4.5); // -4.5..4.5, mean 0
  approx(tailRiskRatio(pnls), 0);
  const p2 = [0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, -0.20];
  approx(tailRiskRatio(p2), (p2.reduce((a, b) => a + b, 0) / 10) / 0.20);
});
test('decideCallKill: KILLED iff best-cell mean <= 0', () => {
  assert.equal(decideCallKill(-0.01).killed, true);
  assert.equal(decideCallKill(0.05).killed, false);
});
test('decidePutGate requires all band CI los > 0, spike on, and tailRatio beats the stock', () => {
  assert.equal(decidePutGate({ bandCIlos: [0.01, 0.005], spikeOn: true, tailRatio: 0.2, stockTailRatio: 0.08 }).pass, true);
  assert.equal(decidePutGate({ bandCIlos: [0.01, -0.001], spikeOn: true, tailRatio: 0.2, stockTailRatio: 0.08 }).pass, false); // a band cell crosses 0
  assert.equal(decidePutGate({ bandCIlos: [0.01], spikeOn: false, tailRatio: 0.2, stockTailRatio: 0.08 }).pass, false); // spike off
  assert.equal(decidePutGate({ bandCIlos: [0.01], spikeOn: true, tailRatio: 0.05, stockTailRatio: 0.08 }).pass, false); // worse than stock
});
```
- [ ] **Step 2: run → FAIL.**
- [ ] **Step 3: implement the pure helpers**
```js
// scripts/coil-opt-score.mjs  (pure helpers shown; CLI appended in Step 5)
import { mean } from './coil-threshold-metrics.mjs';

export function tailRiskRatio(pnls) {
  if (!pnls.length) return null;
  const s = [...pnls].sort((a, b) => a - b);
  const k = Math.max(1, Math.floor(s.length * 0.1));
  const worst = mean(s.slice(0, k));
  return worst >= 0 ? Infinity : mean(pnls) / Math.abs(worst);
}
export function decideCallKill(bestCellMean) {
  return { killed: bestCellMean <= 0, bestCellMean };
}
export function decidePutGate({ bandCIlos, spikeOn, tailRatio, stockTailRatio }) {
  const bandOk = bandCIlos.length > 0 && bandCIlos.every(lo => lo > 0);
  const pass = bandOk && spikeOn && tailRatio > stockTailRatio;
  return { pass, bandOk, spikeOn, beatsStock: tailRatio > stockTailRatio };
}
```
- [ ] **Step 4: run → PASS (3 tests).**
- [ ] **Step 5: append the CLI + run it.** Add an `import.meta.url === argv1` CLI block to `coil-opt-score.mjs` that:
  1. loads `data/lab/coil-threshold-instances.json`, filters `bucket==='[0,5)' && !censored`;
  2. per trade: `closes = loadBars(root, ticker).map(b=>b.close)` indexed by date; `ivEntry = trailingRealizedVol(closes, entryIdx, rvWindow) * premium`; `S_exp` = the bar-cache close on the nearest trading day ≤ `entry_date + dte` calendar days (for the hold-to-expiry put); drop trades missing either;
  3. for each sweep cell (rvWindow × premium × crush × spike × spread × dte): compute `callPnl`, `putPnlHoldToExpiry`, `putPnlMirror` per trade; `bootstrapMeanCI(rows {date,net})`, win rate, and for puts the `tailRiskRatio` + worst-decile loss;
  4. `stockTailRatio = tailRiskRatio(coilStockReturns)` from the same tape (grossReturn);
  5. apply `decideCallKill(best call cell mean)` and `decidePutGate({...})` over the band cells (central + spike-stress + 20-day + premium 0.8/1.5);
  6. render `docs/lab/coil-options-overlay-RESULTS.md`: verdict lines, the full sweep surface (both structures), put tail metrics, the §4 honest ceiling, §6 limitations.

  Run (inline, data on disk): `node scripts/coil-opt-score.mjs` → prints CALL and PUT verdict lines + writes RESULTS. `node --check` first.
- [ ] **Step 6: commit** `git -C "<wt>" add scripts/coil-opt-score.mjs scripts/coil-opt-score.test.mjs docs/lab/coil-options-overlay-RESULTS.md && git -C "<wt>" commit -m "feat(coil-opt): sweep/score + tail metrics + RESULTS"`

---

## Self-Review (completed by plan author)

**Spec coverage:** §1 inputs → Task 4 CLI (tape filter + bar-cache RV + expiry lookup). §2 model (state-dependent exit IV, call mirror-exit, CSP hold-to-expiry + mirror) → Tasks 1/3. §3 sweep + bootstrap + tail metrics → Task 4. §4 kill-rule (call best-cell; put band+spike+tail-ratio) → Task 4 helpers + CLI. §5 modules → Tasks 1–4. §6 limitations → Task 4 render.

**Placeholder scan:** the Task 4 Step-5 CLI is described as a concrete composition of already-tested functions (`loadBars`, `trailingRealizedVol`, `callPnl`/`putPnl*`, `bootstrapMeanCI`, `tailRiskRatio`, `decide*`) executed inline and validated on real data — not pasted in full because it's executed/verified by the author in this session, not handed to a cold subagent. All load-bearing pure logic (pricer, RV, overlay, decision rules) has complete code + tests.

**Type consistency:** `bsPrice(type,S,K,T,r,sigma)` consumed by `overlay`; overlay fns take the named `{S0,S1,daysHeld,ivEntry,dte,r,crush,spike,spreadPct}` shape and the CLI passes exactly that; `bootstrapMeanCI` rows are `{date,net}` (net = the structure's per-trade P&L); `decidePutGate` inputs match the CLI call site.
