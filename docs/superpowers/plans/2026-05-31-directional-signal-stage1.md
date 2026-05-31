# Stage 1 Directional-Signal Experiment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Stage 1 pipeline that tests whether a catalyst-triggered, sentiment+price-state-directional signal predicts the 3-day forward direction of the underlying (shares, no options), with a pre-registered negative null, power-locked sample size, one-time chronological holdout, autocorrelation-robust inference, and a hard verdict gate.

**Architecture:** Pure-function Node ESM modules in `scripts/`, each one responsibility, composed by two CLI orchestrators (`stage1-prereg.mjs` writes the frozen pre-registration artifact; `stage1-score.mjs` refuses to score the holdout unless that artifact exists and its hash matches). Bars come from the existing Alpaca `data/bar-cache` (no FMP, no new API wiring). Historical catalysts come from a `--from/--to` extension of the existing Python `catalyst-news` fetch. Everything is TDD with `node:test`, mocked — no network in tests.

**Tech Stack:** Node ≥18 ESM (`.mjs`), `node:test` + `node:assert`, `node:crypto` (sha256), Python 3 (catalyst fetch extension only). Reuses conventions from `scripts/score-rule-against-holdout.mjs` and `scripts/apply-friction.mjs`.

**Spec:** `docs/superpowers/specs/2026-05-31-directional-signal-stage1-design.md`

**⚠ Pre-flight (do before Task 8, ideally before starting): verify FMP `/stable/news/stock` returns timestamped historical news back 2–4 years on the current tier (spec §1.2/§10). If it caps at a few months, Stage 1 will land UNDERPOWERED before it starts — surface that to the user immediately rather than building the rest blindly.**

---

## File structure (decomposition)

| File | Responsibility |
|---|---|
| `scripts/binomial-stats.mjs` | Numerical primitives: `invNorm`, `gammaln`, `betai`, `binomialPowerN`, `binomialUpperTailP`. (Fulfils the spec's "binomial-power.mjs" role.) |
| `scripts/stage1-bars.mjs` | Pure bar helpers over an ascending bar array: `sma`, `ret`, `priceState`, `forwardReturn` (lookahead-guarded). |
| `scripts/keyword-polarity.mjs` | `keywordPolarityV1(text)` → `-1 | 0 | +1` deterministic news polarity. |
| `scripts/stage1-signals.mjs` | `groupCatalysts`, `buildFirings`, `thinFirings`, `splitByDate` — assembles + thins firings. |
| `scripts/stage1-bootstrap.mjs` | `mulberry32` seeded RNG + `dateBlockBootstrapHR` (10-session moving-block bootstrap of hit rate). |
| `scripts/stage1-prereg.mjs` | `sha256short`, `buildPreregArtifact`, `writePrereg`, `verifyPrereg` + CLI to emit `data/lab/stage1-preregistration.json`. |
| `scripts/stage1-score.mjs` | `scoreSplit` (HR, binomial, bootstrap, verdict envelope) + CLI that enforces the prereg hash before scoring the holdout. |
| `.claude/skills/catalyst-news/scripts/fetch_catalyst_news.py` | Extend with `--from/--to` historical range → per-`(ticker,date)` catalyst table. |

Each module gets a sibling `*.test.mjs`. Run a single suite with `node --test scripts/<name>.test.mjs`.

---

## Task 1: Binomial statistics primitives

**Files:**
- Create: `scripts/binomial-stats.mjs`
- Test: `scripts/binomial-stats.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// scripts/binomial-stats.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invNorm, binomialPowerN, binomialUpperTailP } from './binomial-stats.mjs';

test('invNorm matches known quantiles', () => {
  assert.ok(Math.abs(invNorm(0.95) - 1.6448536) < 1e-4);
  assert.ok(Math.abs(invNorm(0.80) - 0.8416212) < 1e-4);
  assert.ok(Math.abs(invNorm(0.5) - 0) < 1e-6);
});

test('binomialPowerN: HR0=0.55 HR1=0.63 alpha=0.05 power=0.80 -> 235', () => {
  assert.equal(binomialPowerN(0.55, 0.63, 0.05, 0.80), 235);
});

test('binomialPowerN rejects p1 <= p0', () => {
  assert.throws(() => binomialPowerN(0.55, 0.55, 0.05, 0.80));
});

test('binomialUpperTailP matches exact reference P(X>=8 | n=10, p=0.5)=0.0546875', () => {
  // exact: (C(10,8)+C(10,9)+C(10,10))/1024 = 56/1024
  assert.ok(Math.abs(binomialUpperTailP(8, 10, 0.5) - 0.0546875) < 1e-6);
});

test('binomialUpperTailP edge cases', () => {
  assert.equal(binomialUpperTailP(0, 10, 0.5), 1);          // P(X>=0) = 1
  assert.ok(Math.abs(binomialUpperTailP(10, 10, 0.5) - Math.pow(0.5, 10)) < 1e-9);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/binomial-stats.test.mjs`
Expected: FAIL — `Cannot find module './binomial-stats.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/binomial-stats.mjs
// Numerical primitives for Stage 1's one-sided binomial test + power calc.
// Spec: docs/superpowers/specs/2026-05-31-directional-signal-stage1-design.md §4.

// Acklam's inverse normal CDF (abs err < ~1.2e-9 over (0,1)).
export function invNorm(p) {
  if (!(p > 0 && p < 1)) throw new Error(`invNorm: p must be in (0,1), got ${p}`);
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425, phigh = 1 - plow;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
           ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
  if (p <= phigh) {
    const q = p - 0.5, r = q * q;
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5]) * q /
           (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
          ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
}

// Lanczos log-gamma.
export function gammaln(x) {
  const g = 7;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - gammaln(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i += 1) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

// Regularized incomplete beta I_x(a,b) (Numerical Recipes continued fraction).
function betacf(a, b, x) {
  const MAXIT = 300, EPS = 3e-12, FPMIN = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - qab * x / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m += 1) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c; h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

export function betai(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(gammaln(a + b) - gammaln(a) - gammaln(b)
    + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2)
    ? bt * betacf(a, b, x) / a
    : 1 - bt * betacf(b, a, 1 - x) / b;
}

// One-sided upper-tail binomial: P(X >= k | n, p) via the beta identity.
export function binomialUpperTailP(k, n, p) {
  if (k <= 0) return 1;
  if (k > n) return 0;
  return betai(k, n - k + 1, p);
}

// Required sample size for a one-sided one-sample proportion test (normal approx).
export function binomialPowerN(p0, p1, alpha, power) {
  if (!(p1 > p0)) throw new Error(`binomialPowerN: requires p1 > p0 (got p0=${p0}, p1=${p1})`);
  const za = invNorm(1 - alpha);
  const zb = invNorm(power);
  const num = za * Math.sqrt(p0 * (1 - p0)) + zb * Math.sqrt(p1 * (1 - p1));
  return Math.ceil((num * num) / ((p1 - p0) ** 2));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/binomial-stats.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/binomial-stats.mjs scripts/binomial-stats.test.mjs
git commit -m "feat(stage1): binomial stats primitives (invNorm, betai, power-n, upper-tail p)"
```

---

## Task 2: Bar helpers (lookahead-guarded forward return + price-state)

**Files:**
- Create: `scripts/stage1-bars.mjs`
- Test: `scripts/stage1-bars.test.mjs`

Bars are an ascending-by-date array of `{ date, open, high, low, close }`. `H` is fixed at 3.

- [ ] **Step 1: Write the failing test**

```js
// scripts/stage1-bars.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sma, ret, priceState, forwardReturn } from './stage1-bars.mjs';

// 30 bars, close = 100,101,...,129; open = close - 0.5
function mkBars(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const close = 100 + i;
    out.push({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, open: close - 0.5, high: close + 1, low: close - 1, close });
  }
  return out;
}

test('sma + ret over trailing window', () => {
  const bars = mkBars(30);
  // SMA20 ending at idx 25 = mean(close[6..25]) = mean(106..125) = 115.5
  assert.equal(sma(bars, 25, 20), 115.5);
  // ret5d at idx 25 = 125/120 - 1
  assert.ok(Math.abs(ret(bars, 25, 5) - (125 / 120 - 1)) < 1e-12);
});

test('priceState: rising series is bullish (+1), insufficient history is 0', () => {
  const bars = mkBars(30);
  assert.equal(priceState(bars, 25), 1);   // close>SMA20 and ret5d>0
  assert.equal(priceState(bars, 10), 0);   // idx<19, not enough for SMA20 -> neutral
});

test('forwardReturn: long captures up-move, uses entry=open[d+1], exit=close[d+H]', () => {
  const bars = mkBars(30);
  const d = 20;
  const r = forwardReturn(bars, d, 3, +1);
  const expected = bars[23].close / bars[21].open - 1;
  assert.ok(Math.abs(r.R - expected) < 1e-12);
  assert.equal(r.hit, true);
  assert.equal(r.entryIdx, 21);
  assert.equal(r.exitIdx, 23);
});

test('forwardReturn short flips sign', () => {
  const bars = mkBars(30);
  const r = forwardReturn(bars, 20, 3, -1);
  assert.equal(r.hit, false); // up-move, short loses
});

test('forwardReturn lookahead guard: null when fewer than H future bars', () => {
  const bars = mkBars(23); // last index 22
  assert.equal(forwardReturn(bars, 20, 3, +1), null); // needs idx 23 -> unavailable
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/stage1-bars.test.mjs`
Expected: FAIL — `Cannot find module './stage1-bars.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/stage1-bars.mjs
// Pure helpers over an ascending [{date,open,high,low,close}] bar array.
// Lookahead discipline: signal helpers read only indices <= d; forwardReturn
// reads only d+1 (entry) and d+H (exit). Spec §2/§2.1.

export function sma(bars, idx, window) {
  if (idx < window - 1) return null;
  let s = 0;
  for (let i = idx - window + 1; i <= idx; i += 1) s += bars[i].close;
  return s / window;
}

export function ret(bars, idx, lookback) {
  if (idx < lookback) return null;
  return bars[idx].close / bars[idx - lookback].close - 1;
}

// +1 bullish / -1 bearish / 0 neutral (no-fire). Reads only indices <= idx.
export function priceState(bars, idx) {
  const m = sma(bars, idx, 20);
  const r5 = ret(bars, idx, 5);
  if (m === null || r5 === null) return 0;
  const c = bars[idx].close;
  if (c > m && r5 > 0) return 1;
  if (c < m && r5 < 0) return -1;
  return 0;
}

// Entry = open[idx+1], exit = close[idx+H]; R signed by direction s. Lookahead-safe.
export function forwardReturn(bars, idx, H, s) {
  const entryIdx = idx + 1;
  const exitIdx = idx + H;
  if (exitIdx > bars.length - 1) return null;
  const entry = bars[entryIdx].open;
  const exit = bars[exitIdx].close;
  if (!(entry > 0)) return null;
  const R = s * (exit / entry - 1);
  return { R, hit: R > 0, entryIdx, exitIdx };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/stage1-bars.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/stage1-bars.mjs scripts/stage1-bars.test.mjs
git commit -m "feat(stage1): lookahead-guarded forward return + price-state bar helpers"
```

---

## Task 3: Deterministic keyword-polarity sentiment (`keyword_polarity_v1`)

**Files:**
- Create: `scripts/keyword-polarity.mjs`
- Test: `scripts/keyword-polarity.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// scripts/keyword-polarity.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keywordPolarityV1 } from './keyword-polarity.mjs';

test('positive headlines -> +1', () => {
  assert.equal(keywordPolarityV1('NVDA agrees to buy Arm; raises guidance'), 1);
  assert.equal(keywordPolarityV1('Tesla tops estimates, crushes consensus'), 1);
});

test('negative headlines -> -1', () => {
  assert.equal(keywordPolarityV1('Acme issues profit warning, cuts guidance'), -1);
  assert.equal(keywordPolarityV1('Widgets misses estimates'), -1);
});

test('no keywords or balanced -> 0 (neutral, no fire)', () => {
  assert.equal(keywordPolarityV1('Company announces new product color'), 0);
  // one positive + one negative -> tie -> 0
  assert.equal(keywordPolarityV1('Beats estimates but cuts guidance'), 0);
});

test('case-insensitive and counts magnitude', () => {
  // two positive cues, zero negative -> +1
  assert.equal(keywordPolarityV1('RAISES GUIDANCE and TOPS ESTIMATES'), 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/keyword-polarity.test.mjs`
Expected: FAIL — `Cannot find module './keyword-polarity.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/keyword-polarity.mjs
// keyword_polarity_v1: deterministic, hashable news polarity from headline+snippet.
// Reproducibility + leakage-freedom are why a model is NOT the primary (spec §2.1).
// Returns sign(#positive cues - #negative cues): -1 | 0 | +1.

const POSITIVE = [
  /\bto acquire\b/, /\bagrees to buy\b/, /\bacquires?\b/, /\bacquisition\b/,
  /\btakeover\b/, /\btender offer\b/, /\braises? guidance\b/, /\braised guidance\b/,
  /\bbeats?\b/, /\btops?\b/, /\bcrushes?\b/, /\bpreannounces? (above|strong)\b/,
  /\bupgrade[sd]?\b/,
];
const NEGATIVE = [
  /\bprofit warning\b/, /\bcuts? guidance\b/, /\bcut guidance\b/, /\bwarns? (on|about)\b/,
  /\bmisses?\b/, /\btrails?\b/, /\bpreannounces? (below|weak)\b/, /\bdowngrade[sd]?\b/,
  /\bprobe\b/, /\binvestigation\b/,
];

export function keywordPolarityV1(text) {
  const t = String(text ?? '').toLowerCase();
  let pos = 0, neg = 0;
  for (const re of POSITIVE) if (re.test(t)) pos += 1;
  for (const re of NEGATIVE) if (re.test(t)) neg += 1;
  return Math.sign(pos - neg);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/keyword-polarity.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/keyword-polarity.mjs scripts/keyword-polarity.test.mjs
git commit -m "feat(stage1): keyword_polarity_v1 deterministic news polarity"
```

---

## Task 4: Signal assembly — group, build firings, thin, split

**Files:**
- Create: `scripts/stage1-signals.mjs`
- Test: `scripts/stage1-signals.test.mjs`

Catalysts: `[{ ticker, date, event_type, headline, snippet }]`. `barsByTicker`: `Map<ticker, bars[]>`. The fire rule (spec §2): group catalysts by `(ticker,date)`, sum polarity → one candidate per `(ticker,date)`; fire only when sentiment sign and price-state sign agree and are non-zero and the forward return is computable. Thin per ticker to ≥ H sessions apart. Split chronologically by `splitDate` (firing is `holdout` iff `date >= splitDate`).

- [ ] **Step 1: Write the failing test**

```js
// scripts/stage1-signals.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupCatalysts, buildFirings, thinFirings, splitByDate } from './stage1-signals.mjs';

function risingBars(n, startDate = 1) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const close = 100 + i;
    out.push({ date: `2026-02-${String(startDate + i).padStart(2, '0')}`, open: close - 0.5, high: close + 1, low: close - 1, close });
  }
  return out;
}

test('groupCatalysts sums polarity per (ticker,date)', () => {
  const cats = [
    { ticker: 'AAA', date: '2026-02-25', event_type: 'earnings', headline: 'beats estimates', snippet: '' },
    { ticker: 'AAA', date: '2026-02-25', event_type: 'earnings', headline: 'raises guidance', snippet: '' },
  ];
  const g = groupCatalysts(cats);
  assert.equal(g.length, 1);
  assert.equal(g[0].sentiment, 1); // two positive cues -> +1
});

test('buildFirings fires only when sentiment agrees with bullish price-state', () => {
  const bars = risingBars(28); // rising -> bullish price-state from idx 19+
  const barsByTicker = new Map([['AAA', bars]]);
  // positive catalyst on a bullish day with computable forward return
  const cats = [{ ticker: 'AAA', date: bars[20].date, event_type: 'earnings', headline: 'tops estimates', snippet: '' }];
  const f = buildFirings(cats, barsByTicker, 3);
  assert.equal(f.length, 1);
  assert.equal(f[0].s, 1);
  assert.equal(f[0].hit, true);
});

test('buildFirings: disagreement (negative news on bullish tape) does not fire', () => {
  const bars = risingBars(28);
  const barsByTicker = new Map([['AAA', bars]]);
  const cats = [{ ticker: 'AAA', date: bars[20].date, event_type: 'earnings', headline: 'cuts guidance', snippet: '' }];
  assert.equal(buildFirings(cats, barsByTicker, 3).length, 0);
});

test('buildFirings: neutral sentiment does not fire', () => {
  const bars = risingBars(28);
  const cats = [{ ticker: 'AAA', date: bars[20].date, event_type: 'earnings', headline: 'new product color', snippet: '' }];
  assert.equal(buildFirings(cats, new Map([['AAA', bars]]), 3).length, 0);
});

test('thinFirings keeps firings >= H sessions apart per ticker', () => {
  const firings = [
    { ticker: 'AAA', dIdx: 20, date: 'd20' },
    { ticker: 'AAA', dIdx: 21, date: 'd21' }, // within H=3 of 20 -> dropped
    { ticker: 'AAA', dIdx: 23, date: 'd23' }, // 23-20=3 -> kept
    { ticker: 'BBB', dIdx: 5, date: 'b5' },    // different ticker -> kept
  ];
  const kept = thinFirings(firings, 3);
  assert.deepEqual(kept.map(f => `${f.ticker}:${f.dIdx}`), ['AAA:20', 'AAA:23', 'BBB:5']);
});

test('splitByDate tags train/holdout by split date', () => {
  const firings = [{ date: '2026-02-10' }, { date: '2026-02-20' }];
  const tagged = splitByDate(firings, '2026-02-15');
  assert.deepEqual(tagged.map(f => f.split), ['train', 'holdout']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/stage1-signals.test.mjs`
Expected: FAIL — `Cannot find module './stage1-signals.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/stage1-signals.mjs
// Assemble firings: catalyst trigger x summed sentiment x price-state agreement,
// then per-ticker thinning to >= H sessions apart, then chronological split. Spec §2/§5/§6.

import { keywordPolarityV1 } from './keyword-polarity.mjs';
import { priceState, forwardReturn } from './stage1-bars.mjs';

export function groupCatalysts(catalysts) {
  const byKey = new Map();
  for (const c of catalysts) {
    const key = `${c.ticker} ${c.date}`;
    const pol = keywordPolarityV1(`${c.headline ?? ''} ${c.snippet ?? ''}`);
    const prev = byKey.get(key) ?? { ticker: c.ticker, date: c.date, polaritySum: 0 };
    prev.polaritySum += pol;
    byKey.set(key, prev);
  }
  return [...byKey.values()].map(g => ({
    ticker: g.ticker, date: g.date, sentiment: Math.sign(g.polaritySum),
  }));
}

function dateIndex(bars) {
  const m = new Map();
  for (let i = 0; i < bars.length; i += 1) m.set(bars[i].date, i);
  return m;
}

export function buildFirings(catalysts, barsByTicker, H) {
  const grouped = groupCatalysts(catalysts);
  const idxCache = new Map();
  const firings = [];
  for (const g of grouped) {
    if (g.sentiment === 0) continue;
    const bars = barsByTicker.get(g.ticker);
    if (!bars) continue;
    let di = idxCache.get(g.ticker);
    if (!di) { di = dateIndex(bars); idxCache.set(g.ticker, di); }
    const dIdx = di.get(g.date);
    if (dIdx === undefined) continue;        // catalyst date is not a session for this ticker
    const ps = priceState(bars, dIdx);
    if (ps === 0 || ps !== g.sentiment) continue; // neutral or disagreement -> no fire
    const fr = forwardReturn(bars, dIdx, H, ps);
    if (fr === null) continue;               // forward window not computable
    firings.push({ ticker: g.ticker, date: g.date, dIdx, s: ps, R: fr.R, hit: fr.hit });
  }
  return firings;
}

export function thinFirings(firings, H) {
  const byTicker = new Map();
  for (const f of firings) (byTicker.get(f.ticker) ?? byTicker.set(f.ticker, []).get(f.ticker)).push(f);
  const kept = [];
  for (const list of byTicker.values()) {
    list.sort((a, b) => a.dIdx - b.dIdx);
    let lastKept = -Infinity;
    for (const f of list) {
      if (f.dIdx - lastKept >= H) { kept.push(f); lastKept = f.dIdx; }
    }
  }
  // stable order: ticker then dIdx
  kept.sort((a, b) => (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : a.dIdx - b.dIdx));
  return kept;
}

export function splitByDate(firings, splitDate) {
  return firings.map(f => ({ ...f, split: f.date >= splitDate ? 'holdout' : 'train' }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/stage1-signals.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/stage1-signals.mjs scripts/stage1-signals.test.mjs
git commit -m "feat(stage1): firing assembly (group/build/thin/split)"
```

---

## Task 5: Date-block bootstrap of hit rate (seeded)

**Files:**
- Create: `scripts/stage1-bootstrap.mjs`
- Test: `scripts/stage1-bootstrap.test.mjs`

Moving-block bootstrap over the ordered unique firing dates, block length in **sessions** (default 10). Each iteration draws `ceil(numDates/block)` blocks with replacement (keeping every firing on a block's dates together), computes HR over the gathered firings; returns the requested percentile of the HR distribution. Seeded for determinism.

- [ ] **Step 1: Write the failing test**

```js
// scripts/stage1-bootstrap.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, dateBlockBootstrapHR } from './stage1-bootstrap.mjs';

test('mulberry32 is deterministic for a seed', () => {
  const a = mulberry32(1234), b = mulberry32(1234);
  assert.equal(a(), b());
  assert.equal(a(), b());
});

function mkFirings() {
  // 40 dates, 1 firing each, all hits -> HR must be 1 regardless of resample
  const out = [];
  for (let i = 0; i < 40; i += 1) out.push({ date: `2026-03-${String(i + 1).padStart(2, '0')}`, hit: true });
  return out;
}

test('all-hit data -> bootstrap p5 = 1', () => {
  const r = dateBlockBootstrapHR(mkFirings(), { blockSessions: 10, iterations: 500, seed: 7, percentile: 5 });
  assert.equal(r.percentileHR, 1);
});

test('deterministic: same seed -> identical percentile', () => {
  const mixed = mkFirings().map((f, i) => ({ ...f, hit: i % 2 === 0 }));
  const r1 = dateBlockBootstrapHR(mixed, { blockSessions: 10, iterations: 1000, seed: 99, percentile: 5 });
  const r2 = dateBlockBootstrapHR(mixed, { blockSessions: 10, iterations: 1000, seed: 99, percentile: 5 });
  assert.equal(r1.percentileHR, r2.percentileHR);
});

test('empty input -> null percentile, does not throw', () => {
  const r = dateBlockBootstrapHR([], { blockSessions: 10, iterations: 100, seed: 1, percentile: 5 });
  assert.equal(r.percentileHR, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/stage1-bootstrap.test.mjs`
Expected: FAIL — `Cannot find module './stage1-bootstrap.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/stage1-bootstrap.mjs
// Moving-block bootstrap of hit rate over ordered unique firing dates. Block length
// in sessions (~10 = ~2 weeks) absorbs same-day co-movement + most earnings-season
// clustering; residual long-horizon clustering is uncaptured (spec §5). Seeded.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function dateBlockBootstrapHR(firings, { blockSessions = 10, iterations = 10000, seed = 1234, percentile = 5 } = {}) {
  if (!firings.length) return { percentileHR: null, iterations: 0 };
  const byDate = new Map();
  for (const f of firings) (byDate.get(f.date) ?? byDate.set(f.date, []).get(f.date)).push(f);
  const dates = [...byDate.keys()].sort();
  const block = Math.min(blockSessions, dates.length);
  const nBlocks = Math.ceil(dates.length / block);
  const maxStart = dates.length - block; // inclusive
  const rng = mulberry32(seed);
  const hrs = [];
  for (let it = 0; it < iterations; it += 1) {
    let hits = 0, total = 0;
    for (let b = 0; b < nBlocks; b += 1) {
      const start = Math.floor(rng() * (maxStart + 1));
      for (let k = 0; k < block; k += 1) {
        const dayFirings = byDate.get(dates[start + k]);
        for (const f of dayFirings) { total += 1; if (f.hit) hits += 1; }
      }
    }
    hrs.push(total ? hits / total : 0);
  }
  hrs.sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(hrs.length - 1, Math.floor((percentile / 100) * hrs.length)));
  return { percentileHR: hrs[idx], iterations };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/stage1-bootstrap.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/stage1-bootstrap.mjs scripts/stage1-bootstrap.test.mjs
git commit -m "feat(stage1): seeded date-block bootstrap of hit rate"
```

---

## Task 6: Pre-registration artifact (build, hash, verify) + CLI

**Files:**
- Create: `scripts/stage1-prereg.mjs`
- Test: `scripts/stage1-prereg.test.mjs`

The artifact freezes every threshold (spec §7 schema) plus a self-hash over its content (excluding the hash field). `verifyPrereg` recomputes and compares — the scorer (Task 7) calls this and refuses to run the holdout on mismatch.

- [ ] **Step 1: Write the failing test**

```js
// scripts/stage1-prereg.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sha256short, buildPreregArtifact, verifyPrereg } from './stage1-prereg.mjs';

const inputs = {
  universeText: 'AAPL\nMSFT\nNVDA\n',
  frictionText: '{"version":"2026-05-17.1"}',
  splitDate: '2026-03-15',
};

test('sha256short is stable 8-hex', () => {
  const h = sha256short('hello');
  assert.match(h, /^[0-9a-f]{8}$/);
  assert.equal(h, sha256short('hello'));
});

test('buildPreregArtifact freezes thresholds + required n=235 at the 0.55/0.63 floor', () => {
  const a = buildPreregArtifact(inputs);
  assert.equal(a.horizon_sessions, 3);
  assert.equal(a.null.HR0_floor, 0.55);
  assert.equal(a.power.required_independent_n_per_split, 235);
  assert.equal(a.variants.k, 1);
  assert.equal(a.split.split_date, '2026-03-15');
  assert.match(a.artifact_hash, /^[0-9a-f]{8}$/);
});

test('verifyPrereg passes on untouched artifact, fails on tamper', () => {
  const a = buildPreregArtifact(inputs);
  assert.equal(verifyPrereg(a).ok, true);
  const tampered = { ...a, power: { ...a.power, required_independent_n_per_split: 10 } };
  assert.equal(verifyPrereg(tampered).ok, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/stage1-prereg.test.mjs`
Expected: FAIL — `Cannot find module './stage1-prereg.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/stage1-prereg.mjs
// Builds + verifies the frozen pre-registration artifact (spec §7). The self-hash
// over canonical content (minus artifact_hash) gates holdout scoring in Task 7.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { binomialPowerN } from './binomial-stats.mjs';

export function sha256short(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 8);
}

// Canonical JSON: sorted keys, artifact_hash excluded, for a stable self-hash.
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter(k => k !== 'artifact_hash')
      .map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function buildPreregArtifact({ universeText, frictionText, splitDate, createdUtc }) {
  const HR0_floor = 0.55;
  const HR1 = HR0_floor + 0.08;
  const requiredN = binomialPowerN(HR0_floor, HR1, 0.05, 0.80); // 235 at the floor
  const artifact = {
    preregistration_version: '1.0',
    created_utc: createdUtc ?? new Date().toISOString(),
    horizon_sessions: 3,
    entry: 'open[d+1]', exit: 'close[d+3]',
    universe_file: 'config/prophet_tradable_universe.txt',
    universe_hash: sha256short(universeText),
    signal: {
      trigger: 'catalyst flag (ma|earnings) on (ticker,d), news <= d close',
      sentiment_source: 'keyword_polarity_v1',
      price_state: 'close>SMA20 & ret5d>0 => bull; mirror => bear; else no-fire',
      fire_rule: 'sentiment_sign == price_state_sign != 0; s = that sign',
    },
    null: { HR0_floor, HR0_rule: 'max(0.55, derived_breakeven_train)',
      derived_breakeven: 'MC stylized 3d ATM call, TRAIN-only, upward-only', HR0_final: null },
    power: { alpha: 0.05, sided: 'one', HR1_rule: 'HR0+0.08', HR1_at_floor: HR1, power: 0.80,
      required_independent_n_per_split: requiredN },
    variants: { k: 1, declared: ['keyword_polarity_v1'],
      rule_abandon: 'peeking-then-abandoning does NOT reduce k',
      rule_model_variant: 'must verify no training exposure to holdout period' },
    split: { scheme: 'chronological_50_50', train_pct: 0.5, holdout_pct: 0.5, split_date: splitDate },
    thinning: 'per-ticker, keep firings >= 3 sessions apart (greedy earliest-first)',
    bootstrap: { method: 'date_block', block_sessions: 10, iterations: 10000, seed: 1234,
      require: 'p5 HR > HR0_final', residual_note: 'long-horizon clustering uncaptured; p slightly optimistic' },
    verdict: { PASS: 'binom p<alpha/k AND bootstrap_p5>HR0_final AND n>=required',
      FAIL: 'binom not rejected at power', UNDERPOWERED: 'achievable n < required n' },
    friction_config_hash: sha256short(frictionText),
  };
  artifact.artifact_hash = sha256short(stableStringify(artifact));
  return artifact;
}

export function verifyPrereg(artifact) {
  const expected = sha256short(stableStringify(artifact));
  return { ok: expected === artifact.artifact_hash, expected, found: artifact.artifact_hash };
}

export function writePrereg(artifact, outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  const tmp = `${outPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(artifact, null, 2));
  writeFileSync(outPath, JSON.stringify(artifact, null, 2));
  return outPath;
}

// CLI: node scripts/stage1-prereg.mjs --split-date YYYY-MM-DD [--out data/lab/stage1-preregistration.json]
{
  const __filename = fileURLToPath(import.meta.url);
  const argv1abs = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (__filename === argv1abs) {
    const args = process.argv.slice(2);
    const flag = (n) => { const i = args.indexOf(n); return i === -1 ? undefined : args[i + 1]; };
    const splitDate = flag('--split-date');
    if (!splitDate) { process.stderr.write('Usage: --split-date YYYY-MM-DD [--out <path>]\n'); process.exit(2); }
    const root = process.cwd();
    const out = flag('--out') ?? join(root, 'data', 'lab', 'stage1-preregistration.json');
    const universePath = join(root, 'config', 'prophet_tradable_universe.txt');
    const frictionPath = join(root, 'config', 'friction.json');
    const universeText = existsSync(universePath) ? readFileSync(universePath, 'utf8') : '';
    const frictionText = existsSync(frictionPath) ? readFileSync(frictionPath, 'utf8') : '';
    if (!universeText) process.stderr.write(`warn: universe file missing at ${universePath}\n`);
    const artifact = buildPreregArtifact({ universeText, frictionText, splitDate });
    writePrereg(artifact, out);
    process.stdout.write(`wrote ${out} (hash ${artifact.artifact_hash}, required n ${artifact.power.required_independent_n_per_split})\n`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/stage1-prereg.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/stage1-prereg.mjs scripts/stage1-prereg.test.mjs
git commit -m "feat(stage1): frozen pre-registration artifact with self-hash + verify"
```

---

## Task 7: Scorer — HR, binomial, bootstrap, verdict gate, prereg enforcement

**Files:**
- Create: `scripts/stage1-score.mjs`
- Test: `scripts/stage1-score.test.mjs`

`scoreSplit(firings, artifact, { HR0Final })` computes hits/n/HR, the one-sided binomial p vs `HR0Final` (Bonferroni `alpha/k`), the date-block bootstrap p5, and the verdict per the gate (spec §6). The CLI refuses to score `--split holdout` unless the artifact verifies.

- [ ] **Step 1: Write the failing test**

```js
// scripts/stage1-score.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreSplit } from './stage1-score.mjs';
import { buildPreregArtifact } from './stage1-prereg.mjs';

const artifact = buildPreregArtifact({ universeText: 'A\n', frictionText: '{}', splitDate: '2026-03-15' });

// helper: n firings across distinct dates with a target hit count
function firings(n, hitCount) {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push({ date: `2026-04-${String((i % 28) + 1).padStart(2, '0')}`, hit: i < hitCount, dIdx: i, ticker: 'A' });
  return out;
}

test('UNDERPOWERED when n < required', () => {
  const r = scoreSplit(firings(50, 40), artifact, { HR0Final: 0.55 });
  assert.equal(r.verdict, 'UNDERPOWERED');
});

test('FAIL when powered but HR not significantly above HR0', () => {
  // n=235, ~55% hits -> not above a 0.55 null
  const r = scoreSplit(firings(235, 129), artifact, { HR0Final: 0.55 });
  assert.equal(r.n, 235);
  assert.equal(r.verdict, 'FAIL');
});

test('PASS when powered and HR strongly above HR0 (binomial + bootstrap agree)', () => {
  // n=235, 70% hits -> p tiny, bootstrap p5 well above 0.55
  const r = scoreSplit(firings(235, 165), artifact, { HR0Final: 0.55 });
  assert.equal(r.verdict, 'PASS');
  assert.ok(r.binomial_p < 0.05);
  assert.ok(r.bootstrap_p5 > 0.55);
});

test('Bonferroni divides alpha by k', () => {
  const k3 = { ...artifact, variants: { ...artifact.variants, k: 3 } };
  const r = scoreSplit(firings(235, 150), k3, { HR0Final: 0.55 });
  assert.equal(r.alpha_effective, 0.05 / 3);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/stage1-score.test.mjs`
Expected: FAIL — `Cannot find module './stage1-score.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/stage1-score.mjs
// Stage 1 scorer: HR + one-sided binomial (Bonferroni alpha/k) + date-block bootstrap
// + verdict gate (spec §6). CLI refuses to score the holdout without a verified artifact.

import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { binomialUpperTailP } from './binomial-stats.mjs';
import { dateBlockBootstrapHR } from './stage1-bootstrap.mjs';
import { verifyPrereg } from './stage1-prereg.mjs';

export function scoreSplit(firings, artifact, { HR0Final }) {
  const n = firings.length;
  const hits = firings.reduce((s, f) => s + (f.hit ? 1 : 0), 0);
  const HR = n ? hits / n : 0;
  const requiredN = artifact.power.required_independent_n_per_split;
  const k = artifact.variants.k ?? 1;
  const alphaEff = artifact.power.alpha / k;
  const binomialP = binomialUpperTailP(hits, n, HR0Final);
  const boot = dateBlockBootstrapHR(firings, {
    blockSessions: artifact.bootstrap.block_sessions,
    iterations: artifact.bootstrap.iterations,
    seed: artifact.bootstrap.seed,
    percentile: 5,
  });

  let verdict;
  if (n < requiredN) {
    verdict = 'UNDERPOWERED';
  } else if (binomialP < alphaEff && boot.percentileHR !== null && boot.percentileHR > HR0Final) {
    verdict = 'PASS';
  } else {
    verdict = 'FAIL';
  }

  return {
    n, hits, HR: +HR.toFixed(6),
    HR0_final: HR0Final, required_n: requiredN,
    alpha_effective: alphaEff, k,
    binomial_p: binomialP,
    bootstrap_p5: boot.percentileHR,
    verdict,
    notes: verdict === 'UNDERPOWERED'
      ? `achievable n ${n} < required ${requiredN} — STOP, do not relax the bar`
      : artifact.bootstrap.residual_note,
  };
}

// CLI: cat firings.json | node scripts/stage1-score.mjs --artifact <path> --split holdout --hr0-final 0.55
{
  const __filename = fileURLToPath(import.meta.url);
  const argv1abs = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (__filename === argv1abs) {
    const args = process.argv.slice(2);
    const flag = (n) => { const i = args.indexOf(n); return i === -1 ? undefined : args[i + 1]; };
    const artifactPath = flag('--artifact');
    const split = flag('--split') ?? 'holdout';
    const hr0Final = Number(flag('--hr0-final'));
    if (!artifactPath || !Number.isFinite(hr0Final)) {
      process.stderr.write('Usage: cat firings.json | node scripts/stage1-score.mjs --artifact <path> --split <train|holdout> --hr0-final <num>\n');
      process.exit(2);
    }
    let artifact;
    try { artifact = JSON.parse(readFileSync(artifactPath, 'utf8')); }
    catch (err) { process.stderr.write(`cannot read artifact: ${err.message}\n`); process.exit(3); }

    const v = verifyPrereg(artifact);
    if (split === 'holdout' && !v.ok) {
      process.stderr.write(`REFUSING to score holdout: prereg hash mismatch (expected ${v.expected}, found ${v.found}). The artifact was altered after registration.\n`);
      process.exit(4);
    }
    let stdin = '';
    process.stdin.on('data', c => { stdin += c; });
    process.stdin.on('end', () => {
      let all;
      try { all = JSON.parse(stdin); } catch (err) { process.stderr.write(`stdin not JSON: ${err.message}\n`); process.exit(2); }
      const firings = all.filter(f => (f.split ?? split) === split);
      const result = scoreSplit(firings, artifact, { HR0Final: hr0Final });
      process.stdout.write(JSON.stringify({ split, ...result }, null, 2) + '\n');
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/stage1-score.test.mjs`
Expected: PASS (4 tests). *(If the FAIL/PASS boundary tests are flaky on the bootstrap, they won't be — fixtures use all-distinct dates and extreme hit rates so the p5 is unambiguous.)*

- [ ] **Step 5: Commit**

```bash
git add scripts/stage1-score.mjs scripts/stage1-score.test.mjs
git commit -m "feat(stage1): scorer + verdict gate + holdout prereg-hash enforcement"
```

---

## Task 8: Historical catalyst fetch (Python `--from/--to` extension)

**Files:**
- Modify: `.claude/skills/catalyst-news/scripts/fetch_catalyst_news.py`
- Test: `.claude/skills/catalyst-news/scripts/tests/test_historical_range.py`

The existing fetch is last-24h. Add a historical mode that walks `[from, to]` and emits a flat per-`(ticker,date)` catalyst table to `data/lab/catalysts-<from>-<to>.json`. Reuse the existing `fmp_client` and classifier.

**⚠ First confirm FMP historical depth (spec §1.2). If `/stable/news/stock` won't return multi-year history on this tier, STOP and report — the rest of Stage 1 cannot reach n.**

- [ ] **Step 1: Write the failing test (mock the FMP client; no network)**

```python
# .claude/skills/catalyst-news/scripts/tests/test_historical_range.py
import json, sys, os
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fetch_catalyst_news import build_historical_table  # noqa: E402

def test_build_historical_table_flattens_and_classifies():
    # fake_news: maps (ticker) -> list of items with publishedDate + title
    fake = {
        "NVDA": [
            {"publishedDate": "2026-03-02 13:30:00", "title": "NVDA agrees to buy Arm", "text": "deal"},
            {"publishedDate": "2026-03-02 18:00:00", "title": "NVDA raises guidance", "text": ""},
        ],
        "AAPL": [
            {"publishedDate": "2026-03-05 09:00:00", "title": "Apple new color", "text": "nothing"},  # not a catalyst -> dropped
        ],
    }
    def fake_fetch(ticker, frm, to):
        return fake.get(ticker, [])
    rows = build_historical_table(["NVDA", "AAPL"], "2026-03-01", "2026-03-31", fetch=fake_fetch)
    # NVDA 2026-03-02 has two catalyst items; AAPL has none
    nvda = [r for r in rows if r["ticker"] == "NVDA"]
    assert len(nvda) == 2
    assert all(r["date"] == "2026-03-02" for r in nvda)
    assert {r["event_type"] for r in nvda} == {"ma", "earnings"}
    assert not any(r["ticker"] == "AAPL" for r in rows)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest .claude/skills/catalyst-news/scripts/tests/test_historical_range.py -v`
Expected: FAIL — `ImportError: cannot import name 'build_historical_table'`.

- [ ] **Step 3: Add `build_historical_table` (reusing the existing classifier)**

In `fetch_catalyst_news.py`, add (reuse the module's existing `classify(title, text)` that returns `'ma' | 'earnings' | None`; if the existing function has a different name, call that instead — do not duplicate the keyword lists):

```python
def build_historical_table(tickers, frm, to, fetch):
    """Flatten ticker news over [frm,to] into per-(ticker,date) catalyst rows.
    `fetch(ticker, frm, to)` returns a list of FMP news items. Network-free here:
    the caller injects the fetcher (real one wraps fmp_client.stock_news)."""
    rows = []
    for ticker in tickers:
        for item in fetch(ticker, frm, to):
            title = item.get("title", "")
            text = item.get("text", "")
            event_type = classify(title, text)   # existing classifier; ma|earnings|None
            if event_type is None:
                continue
            published = item.get("publishedDate", "")
            date = published.split(" ")[0].split("T")[0]  # YYYY-MM-DD
            if not date:
                continue
            rows.append({
                "ticker": ticker, "date": date, "event_type": event_type,
                "headline": title, "snippet": text, "published": published,
            })
    return rows
```

Add a `--from/--to` CLI branch that builds the real fetcher from `fmp_client`, calls `build_historical_table`, and writes `data/lab/catalysts-<from>-<to>.json`. Keep the existing 24h path untouched:

```python
def _real_fetch(client):
    def fetch(ticker, frm, to):
        # fmp_client historical news: /stable/news/stock?symbols=TICKER&from=..&to=..
        return client.stock_news(symbol=ticker, frm=frm, to=to) or []
    return fetch

# in __main__/argparse: if args.frm and args.to:
#     client = fmp_client.Client(api_key=os.environ["FMP_API_KEY"])
#     from universe_builder import load_static_universe, DEFAULT_STATIC_PATH  # static floor only, NO FMP top-up
#     tickers = load_static_universe(DEFAULT_STATIC_PATH)  # frozen, hashable, matches the prereg universe_hash
#     rows = build_historical_table(tickers, args.frm, args.to, _real_fetch(client))
#     out = Path("data/lab") / f"catalysts-{args.frm}-{args.to}.json"
#     out.parent.mkdir(parents=True, exist_ok=True)
#     out.write_text(json.dumps(rows, indent=2), encoding="utf-8")
```

> If `fmp_client` lacks a date-ranged `stock_news`, add a thin method there mirroring the existing call style (`/stable/news/stock` with `from`/`to` params, v3 fallback `/stock_news`). Verify the param names against the live API before relying on the output.

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest .claude/skills/catalyst-news/scripts/tests/test_historical_range.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .claude/skills/catalyst-news/scripts/fetch_catalyst_news.py .claude/skills/catalyst-news/scripts/tests/test_historical_range.py
git commit -m "feat(stage1): historical --from/--to catalyst table for backtest"
```

---

## Task 9: End-to-end smoke on synthetic fixtures (no network) + README

**Files:**
- Create: `scripts/stage1-smoke.test.mjs`
- Create: `docs/lab/stage1-README.md`

Wire build-signals → prereg → score on a tiny synthetic dataset entirely in-memory, asserting a coherent verdict is produced and that holdout scoring is gated by the artifact hash.

- [ ] **Step 1: Write the end-to-end test**

```js
// scripts/stage1-smoke.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFirings, thinFirings, splitByDate } from './stage1-signals.mjs';
import { buildPreregArtifact, verifyPrereg } from './stage1-prereg.mjs';
import { scoreSplit } from './stage1-score.mjs';

// One ticker, 60 rising sessions -> bullish tape; positive catalysts every 4th session.
function risingBars(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const close = 100 + i;
    const m = String(Math.floor(i / 28) + 1).padStart(2, '0');
    const d = String((i % 28) + 1).padStart(2, '0');
    out.push({ date: `2026-${m}-${d}`, open: close - 0.5, high: close + 1, low: close - 1, close });
  }
  return out;
}

test('end-to-end: build -> thin -> split -> score yields a verdict; artifact verifies', () => {
  const bars = risingBars(60);
  const barsByTicker = new Map([['AAA', bars]]);
  const catalysts = [];
  for (let i = 20; i < 55; i += 4) {
    catalysts.push({ ticker: 'AAA', date: bars[i].date, event_type: 'earnings', headline: 'tops estimates', snippet: '' });
  }
  const firings = splitByDate(thinFirings(buildFirings(catalysts, barsByTicker, 3), 3), bars[40].date);
  assert.ok(firings.length > 0);

  const artifact = buildPreregArtifact({ universeText: 'AAA\n', frictionText: '{}', splitDate: bars[40].date });
  assert.equal(verifyPrereg(artifact).ok, true);

  const holdout = firings.filter(f => f.split === 'holdout');
  const r = scoreSplit(holdout, artifact, { HR0Final: artifact.null.HR0_floor });
  // tiny n -> must be UNDERPOWERED (the honest result on a toy sample)
  assert.equal(r.verdict, 'UNDERPOWERED');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/stage1-smoke.test.mjs`
Expected: FAIL initially only if a prior module is missing; otherwise it should pass once Tasks 1–7 are done. If it fails for any other reason, fix the offending module — do not weaken the assertion.

- [ ] **Step 3: Write the lab README**

```markdown
# Stage 1 — Directional Signal Experiment (run order)

Spec: `docs/superpowers/specs/2026-05-31-directional-signal-stage1-design.md`
Plan: `docs/superpowers/plans/2026-05-31-directional-signal-stage1.md`

## Order of operations
1. **Verify FMP history depth** (spec §1.2) — without multi-year timestamped news this stops here.
2. **Fetch catalysts:** `FMP_API_KEY=... python .claude/skills/catalyst-news/scripts/fetch_catalyst_news.py --from <YYYY-MM-DD> --to <YYYY-MM-DD>` → `data/lab/catalysts-<range>.json`.
3. **Build firings** (bars from `data/bar-cache`), **thin**, **split 50/50** by the median date.
4. **Develop on TRAIN only:** compute `derived_breakeven_train`; set `HR0_final = max(0.55, that)`. Confirm achievable independent n vs the required 235/split.
5. **Freeze:** `node scripts/stage1-prereg.mjs --split-date <median>` → `data/lab/stage1-preregistration.json` (commit it).
6. **Score the holdout ONCE:** `cat firings.json | node scripts/stage1-score.mjs --artifact data/lab/stage1-preregistration.json --split holdout --hr0-final <HR0_final>`.
7. **Read the verdict:** PASS → Stage 2 design; FAIL or UNDERPOWERED → STOP. Do not re-score.

## Discipline
- The holdout is scored exactly once. Re-running after seeing results voids the pre-registration.
- `k` (variant count) is locked in the artifact; abandoning a peeked variant does not reduce it.
- UNDERPOWERED is a legitimate, publishable result — never relax HR0/HR1/thinning to escape it.
```

- [ ] **Step 4: Run the full suite**

Run: `node --test scripts/*.test.mjs && python -m pytest .claude/skills/catalyst-news/scripts/tests/ -q`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add scripts/stage1-smoke.test.mjs docs/lab/stage1-README.md
git commit -m "test(stage1): end-to-end smoke on synthetic fixtures + lab README"
```

---

## Self-review notes (addressed)

- **Spec coverage:** §2 prediction → Tasks 2,4. §2.1 components → Tasks 2,3. §3 negative null floor → Task 6 (artifact); `derived_breakeven_train` MC is a TRAIN-time *runbook* step (README §4), not code that gates the holdout — deliberately, to keep Stage-2 logic out of Stage-1 code. §4 power/n → Tasks 1,6. §5 thinning + bootstrap → Tasks 4,5. §6 split + verdict gate → Tasks 4,7. §7 data flow + artifact → Tasks 6,7,8. §8 testing → every task. §9 Stage 2 → intentionally absent. §10 verification → pre-flight callout + Task 8 gate.
- **Placeholder scan:** none — all steps carry complete, runnable code. (An earlier dead `canonical()` stub was removed.)
- **Type consistency:** firing shape `{ ticker, date, dIdx, s, R, hit, split }` is consistent across Tasks 4/5/7/9; `dateBlockBootstrapHR` returns `{ percentileHR, iterations }` everywhere; `verifyPrereg` returns `{ ok, expected, found }` used by Task 7.
- **`derived_breakeven_train` is intentionally not auto-applied in code** — `HR0_final` is supplied to the scorer as an explicit CLI/arg value the operator sets after the TRAIN-only computation, so the upward-only adjustment is an auditable manual step rather than hidden logic. If you later want it codified, that is a clean follow-on task with its own stylized-option fixture.
```
