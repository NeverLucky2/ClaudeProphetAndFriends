# Coil Shadow Eval — Plan 2: Node Eval Core (pure functions)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure-function core of the shadow eval — candidate filter, episode lifecycle, exit-rule replay, group/M assignment, and the fixed-effects + cluster-robust regression and verdict — with no I/O, fully unit-tested.

**Architecture:** Small focused ES-module libraries under `scripts/lib/`, each one responsibility, each a pure function of its inputs. Plan 3's I/O scripts import these. Reuses `classifyWatch`/`computeMargins`/`STOP_PCT` from `scripts/coil-preview.mjs`.

**Tech Stack:** Node ESM (`.mjs`), `node:test` + `node:assert/strict`. No third-party dependencies — the regression is hand-rolled (the within-transformation reduces the design matrix to ~7 columns, keeping it small, auditable, and dependency-free; a stats library was considered and rejected to keep the numeric path inspectable).

## Global Constraints

- **Pure functions only** — no `fs`, no network, no `Date.now()` in core logic (dates arrive as ET-date strings / trading-day counts from the caller).
- **Exit replay starts the trading day AFTER entry** (Coil evaluates exits on subsequent heartbeats). Precedence: stop → target(`RSI>70` or `close>SMA5`) → 5-day timeout.
- **Single adjustment basis** — the scorer re-reads `entry_ref` from the same signal-series it scores against; entry and exit always share one basis (fixes corporate-action drift). A single-day adjusted move `>50%` in-window ⇒ `unscorable` (data-glitch guard).
- **Strict pullback population** — an eval candidate requires `last_close < sma_5` strictly (not `classifyWatch`'s ≤0.5%-above band).
- **Decision statistic** — β on `fire_early` in `return ~ fire_early + RSI-buckets + sma5_gap + sma200_gap + entry-day fixed effects`, standard errors **clustered by name**. KEEP if one-sided-90% lower bound `> 0` and `β ≥ +1.0%`; REJECT if upper bound `< +1.0%`; else INCONCLUSIVE. `z = 1.2816`.

## File Structure

- `scripts/lib/coil-shadow-episodes.mjs` — candidate filter + episode open/reopen (Task 1)
- `scripts/lib/coil-shadow-score.mjs` — exit-rule replay (Task 2)
- `scripts/lib/coil-shadow-groups.mjs` — group + M-benchmark assignment (Task 3)
- `scripts/lib/coil-shadow-matrix.mjs` — minimal linear algebra (Task 4a)
- `scripts/lib/coil-shadow-stats.mjs` — regression + verdict + futility gate (Task 4b, Task 5)
- `.test.mjs` sibling per file.

---

### Task 1: Candidate filter + episode lifecycle

**Files:**
- Create: `scripts/lib/coil-shadow-episodes.mjs`
- Test: `scripts/lib/coil-shadow-episodes.test.mjs`

**Interfaces:**
- Consumes: `classifyWatch`, `computeMargins` from `../coil-preview.mjs`; a signal `sig = {ticker,last_close,rsi_2,sma_5,sma_200,entry_signal,earnings_within_5d,as_of}`.
- Produces:
  - `isEvalCandidate(sig): boolean`
  - `weekdaysBetween(isoA, isoB): number` — trading-day approximation (weekday count, exclusive of A, inclusive of B).
  - `openEpisodes({active, candidates, tags, etDate}): {episodes, active}` where `active` is `{ NAME: openDateISO }` of names whose prior episode's 5-weekday window has not elapsed; `episodes` are newly-opened records `{name, openDate, entryRef, tag, rsi2AtEntry, sma5GapAtEntry, sma200GapAtEntry, status:'open'}`.

- [ ] **Step 1: Write the failing test**

Create `scripts/lib/coil-shadow-episodes.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isEvalCandidate, weekdaysBetween, openEpisodes } from './coil-shadow-episodes.mjs';

const base = { ticker: 'X', entry_signal: false, earnings_within_5d: false,
  last_close: 98, rsi_2: 6, sma_5: 100, sma_200: 90, as_of: '2026-07-15T20:00:00Z' };

test('isEvalCandidate: strict pullback below the 5-day', () => {
  assert.equal(isEvalCandidate(base), true);
  assert.equal(isEvalCandidate({ ...base, last_close: 100.4 }), false); // above SMA5 (the band classifyWatch would allow)
  assert.equal(isEvalCandidate({ ...base, last_close: 100 }), false);   // equal to SMA5, not strictly below
  assert.equal(isEvalCandidate({ ...base, rsi_2: 4 }), false);          // firing, not WATCH
  assert.equal(isEvalCandidate({ ...base, last_close: 80 }), false);    // below SMA200, out of regime
  assert.equal(isEvalCandidate({ ...base, earnings_within_5d: true }), false);
});

test('weekdaysBetween counts trading days, skipping the weekend', () => {
  assert.equal(weekdaysBetween('2026-07-15', '2026-07-16'), 1); // Wed→Thu
  assert.equal(weekdaysBetween('2026-07-17', '2026-07-20'), 1); // Fri→Mon (skip Sat/Sun)
  assert.equal(weekdaysBetween('2026-07-15', '2026-07-22'), 5); // Wed→next Wed
});

test('openEpisodes opens fresh names and blocks reopen within the 5-day window', () => {
  const cand = { ...base, ticker: 'AMGN' };
  const r1 = openEpisodes({ active: {}, candidates: [cand], tags: { AMGN: 'fire_early' }, etDate: '2026-07-15' });
  assert.equal(r1.episodes.length, 1);
  assert.equal(r1.episodes[0].tag, 'fire_early');
  assert.equal(r1.episodes[0].entryRef, 98);
  assert.ok('AMGN' in r1.active);

  // Same name, 2 weekdays later → still active → no new episode.
  const r2 = openEpisodes({ active: r1.active, candidates: [cand], tags: { AMGN: 'declined' }, etDate: '2026-07-17' });
  assert.equal(r2.episodes.length, 0);

  // 6 weekdays after open → window elapsed → reopens.
  const r3 = openEpisodes({ active: r2.active, candidates: [cand], tags: { AMGN: 'declined' }, etDate: '2026-07-23' });
  assert.equal(r3.episodes.length, 1);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test scripts/lib/coil-shadow-episodes.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `scripts/lib/coil-shadow-episodes.mjs`:

```js
// Pure candidate-filter + episode-lifecycle logic for the Coil shadow eval.
import { classifyWatch, computeMargins } from '../coil-preview.mjs';

// isEvalCandidate: a WATCH name tightened to a real pullback (strictly below the
// 5-day), matching Coil's actual entry condition (close < SMA5). classifyWatch
// already enforces RSI(2) in [5,15), close>SMA200, no earnings, not-firing.
export function isEvalCandidate(sig) {
  return classifyWatch(sig) && sig.last_close < sig.sma_5;
}

// weekdaysBetween: trading-day approximation — count of weekdays strictly after
// isoA up to and including isoB (holidays ignored; a rare holiday only slightly
// extends a reopen window, which is harmless).
export function weekdaysBetween(isoA, isoB) {
  const a = new Date(`${isoA}T00:00:00Z`);
  const b = new Date(`${isoB}T00:00:00Z`);
  let n = 0;
  const cur = new Date(a.getTime());
  while (cur < b) {
    cur.setUTCDate(cur.getUTCDate() + 1);
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6) n += 1;
  }
  return n;
}

// openEpisodes: given the active-name map, today's candidate sigs, their tags,
// and the ET date, expire elapsed actives and open one episode per fresh name.
// A name with a not-yet-elapsed (< 5 weekday) prior episode is skipped — the
// minimum-gap reopen rule, which also makes gaps harmless (blocking is by date,
// not by how many days the job ran).
export function openEpisodes({ active, candidates, tags, etDate }) {
  const nextActive = {};
  for (const [name, openDate] of Object.entries(active)) {
    if (weekdaysBetween(openDate, etDate) < 5) nextActive[name] = openDate; // still active
  }
  const episodes = [];
  for (const sig of candidates) {
    const name = sig.ticker;
    if (name in nextActive) continue; // prior episode still open
    const m = computeMargins(sig);
    episodes.push({
      name,
      openDate: etDate,
      entryRef: sig.last_close,
      tag: tags[name] || 'unknown',
      rsi2AtEntry: sig.rsi_2,
      sma5GapAtEntry: m.sma5_gap_pct,
      sma200GapAtEntry: m.sma200_gap_pct,
      status: 'open',
    });
    nextActive[name] = etDate;
  }
  return { episodes, active: nextActive };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test scripts/lib/coil-shadow-episodes.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/coil-shadow-episodes.mjs scripts/lib/coil-shadow-episodes.test.mjs
git commit -m "feat(coil-shadow): candidate filter + episode lifecycle"
```

---

### Task 2: Exit-rule replay (scorer core)

**Files:**
- Create: `scripts/lib/coil-shadow-score.mjs`
- Test: `scripts/lib/coil-shadow-score.test.mjs`

**Interfaces:**
- Consumes: `STOP_PCT` from `../coil-preview.mjs`; an episode from Task 1; a `series` = signal points `{as_of,last_close,rsi_2,sma_5}` oldest→newest spanning the entry day + following days (from the Plan-1 endpoint).
- Produces: `scoreEpisode(episode, series): episode` with `status:'closed'|'unscorable'`, and on close `{exitDate, exitClose, ret, outcome:'bounce'|'no-bounce', laterFired}`, on unscorable `{unscorableReason}`.

- [ ] **Step 1: Write the failing test**

Create `scripts/lib/coil-shadow-score.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreEpisode } from './coil-shadow-score.mjs';

const ep = { name: 'X', openDate: '2026-07-15', entryRef: 98 };
const pt = (d, close, rsi = 20, sma5 = 100) => ({ as_of: `2026-07-${d}T20:00:00Z`, last_close: close, rsi_2: rsi, sma_5: sma5 });

test('target exit: close back above the 5-day → bounce', () => {
  const series = [pt('15', 98), pt('16', 99), pt('17', 101, 20, 100)]; // day 17 close 101 > sma5 100
  const r = scoreEpisode({ ...ep }, series);
  assert.equal(r.status, 'closed');
  assert.equal(r.exitDate, '2026-07-17');
  assert.equal(r.outcome, 'bounce');
  assert.ok(Math.abs(r.ret - (101 - 98) / 98) < 1e-9);
});

test('stop exit takes precedence and books a loss', () => {
  const series = [pt('15', 98), pt('16', 90)]; // 90 <= 98*0.93=91.14 → stop
  const r = scoreEpisode({ ...ep }, series);
  assert.equal(r.outcome, 'no-bounce');
  assert.equal(r.exitClose, 90);
});

test('exit replay never fires on the entry day itself', () => {
  // entry day already looks like a target (close 98 with sma5 97) but must be ignored.
  const series = [{ ...pt('15', 98, 20, 97) }, pt('16', 99), pt('17', 99), pt('18', 99), pt('19', 99), pt('22', 99)];
  const r = scoreEpisode({ ...ep }, series);
  assert.equal(r.status, 'closed');
  assert.equal(r.exitDate, '2026-07-22'); // 5-day timeout, not the entry day
});

test('re-reads entry_ref from the series (single adjustment basis)', () => {
  const series = [pt('15', 50 /* adjusted */), pt('16', 52, 20, 51)]; // close 52 > sma5 51 → target
  const r = scoreEpisode({ ...ep, entryRef: 98 /* stale snapshot value, must be ignored */ }, series);
  assert.ok(Math.abs(r.ret - (52 - 50) / 50) < 1e-9);
});

test('entry day missing from series → unscorable', () => {
  const series = [pt('16', 99), pt('17', 100)];
  const r = scoreEpisode({ ...ep }, series);
  assert.equal(r.status, 'unscorable');
});

test('>50% single-day move in window → unscorable (data glitch)', () => {
  const series = [pt('15', 98), pt('16', 40)]; // -59% one-day move
  const r = scoreEpisode({ ...ep }, series);
  assert.equal(r.status, 'unscorable');
});

test('laterFired flag set when RSI dips below 5 mid-hold', () => {
  const series = [pt('15', 98), pt('16', 97, 3), pt('17', 96, 3), pt('18', 96, 3), pt('19', 96, 3), pt('22', 96, 3)];
  const r = scoreEpisode({ ...ep }, series);
  assert.equal(r.laterFired, true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test scripts/lib/coil-shadow-score.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `scripts/lib/coil-shadow-score.mjs`:

```js
// Retrospective exit-rule replay for the Coil shadow eval. Deterministic and
// reproducible: reads entry AND exit from one adjusted series (single basis).
import { STOP_PCT } from '../coil-preview.mjs';

const HOLD_DAYS = 5;
const GLITCH_MOVE = 0.5; // >50% single-day adjusted move ⇒ data glitch

function etDate(as_of) { return String(as_of).slice(0, 10); }

// scoreEpisode replays Coil's exits over the days AFTER the entry day. Returns a
// closed episode (with return/outcome) or an unscorable one (with a reason).
export function scoreEpisode(episode, series) {
  const entryIdx = series.findIndex((p) => etDate(p.as_of) === episode.openDate);
  if (entryIdx < 0) {
    return { ...episode, status: 'unscorable', unscorableReason: 'entry day not in series' };
  }
  const entryRef = series[entryIdx].last_close; // re-read: single adjustment basis
  const window = series.slice(entryIdx + 1, entryIdx + 1 + HOLD_DAYS);

  // Data-glitch guard: any >50% single-day move across entry→window.
  let prev = entryRef;
  for (const p of window) {
    if (Math.abs(p.last_close / prev - 1) > GLITCH_MOVE) {
      return { ...episode, status: 'unscorable', unscorableReason: 'implausible in-window move' };
    }
    prev = p.last_close;
  }

  const laterFired = window.some((p) => p.rsi_2 < 5);
  const stopLevel = entryRef * (1 - STOP_PCT);

  for (let i = 0; i < window.length; i += 1) {
    const p = window[i];
    let exitClose = null;
    if (p.last_close <= stopLevel) exitClose = p.last_close;            // 1. stop
    else if (p.rsi_2 > 70 || p.last_close > p.sma_5) exitClose = p.last_close; // 2. target
    else if (i === HOLD_DAYS - 1) exitClose = p.last_close;             // 4. timeout
    if (exitClose !== null) {
      const ret = (exitClose - entryRef) / entryRef;
      return { ...episode, status: 'closed', exitDate: etDate(p.as_of), exitClose,
        ret, outcome: ret > 0 ? 'bounce' : 'no-bounce', laterFired };
    }
  }
  // Window shorter than HOLD_DAYS with no exit ⇒ missing trading day(s).
  return { ...episode, status: 'unscorable', unscorableReason: 'incomplete window' };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test scripts/lib/coil-shadow-score.test.mjs`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/coil-shadow-score.mjs scripts/lib/coil-shadow-score.test.mjs
git commit -m "feat(coil-shadow): retrospective exit-rule replay scorer"
```

---

### Task 3: Group + M-benchmark assignment

**Files:**
- Create: `scripts/lib/coil-shadow-groups.mjs`
- Test: `scripts/lib/coil-shadow-groups.test.mjs`

**Interfaces:**
- Consumes: closed, scorable episodes (Task 2) carrying `{name, openDate, tag, rsi2AtEntry, ret, outcome}`.
- Produces: `assignGroups(episodes): {A, B, C, M}` — A=fire_early, B=declined, C=A∪B (excludes `unknown`), M=per-day k-lowest-`rsi2AtEntry` (k = that day's fire_early count), drawn from C.

- [ ] **Step 1: Write the failing test**

Create `scripts/lib/coil-shadow-groups.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignGroups } from './coil-shadow-groups.mjs';

const e = (name, day, tag, rsi) => ({ name, openDate: day, tag, rsi2AtEntry: rsi, ret: 0, outcome: 'bounce' });

test('A/B/C split and unknown excluded', () => {
  const eps = [e('A', 'd1', 'fire_early', 6), e('B', 'd1', 'declined', 7), e('C', 'd1', 'unknown', 8)];
  const g = assignGroups(eps);
  assert.deepEqual(g.A.map((x) => x.name), ['A']);
  assert.deepEqual(g.B.map((x) => x.name), ['B']);
  assert.deepEqual(g.C.map((x) => x.name).sort(), ['A', 'B']);
});

test('M picks the k lowest-RSI names per day, k = that day fire_early count', () => {
  // Day d1: 2 fire_early → M = 2 lowest-RSI of the tagged set {6,7,9,11}.
  const eps = [
    e('P', 'd1', 'fire_early', 11), e('Q', 'd1', 'fire_early', 9),
    e('R', 'd1', 'declined', 6), e('S', 'd1', 'declined', 7),
  ];
  const g = assignGroups(eps);
  assert.deepEqual(g.M.map((x) => x.name).sort(), ['R', 'S']); // lowest two RSI overall
});

test('M empty on a zero-fire day', () => {
  const g = assignGroups([e('A', 'd1', 'declined', 6), e('B', 'd1', 'declined', 7)]);
  assert.equal(g.M.length, 0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test scripts/lib/coil-shadow-groups.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `scripts/lib/coil-shadow-groups.mjs`:

```js
// Group assignment for the Coil shadow eval. M is the same-rate mechanical
// benchmark: each day's k lowest-RSI candidates, k = that day's fire_early count.
export function assignGroups(episodes) {
  const C = episodes.filter((e) => e.tag === 'fire_early' || e.tag === 'declined');
  const A = C.filter((e) => e.tag === 'fire_early');
  const B = C.filter((e) => e.tag === 'declined');

  const byDay = new Map();
  for (const e of C) {
    if (!byDay.has(e.openDate)) byDay.set(e.openDate, []);
    byDay.get(e.openDate).push(e);
  }
  const M = [];
  for (const dayEps of byDay.values()) {
    const k = dayEps.filter((e) => e.tag === 'fire_early').length;
    if (k === 0) continue;
    const sorted = [...dayEps].sort((a, b) => a.rsi2AtEntry - b.rsi2AtEntry);
    M.push(...sorted.slice(0, k));
  }
  return { A, B, C, M };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test scripts/lib/coil-shadow-groups.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/coil-shadow-groups.mjs scripts/lib/coil-shadow-groups.test.mjs
git commit -m "feat(coil-shadow): group + M-benchmark assignment"
```

---

### Task 4: Linear algebra + within/clustered regression

**Files:**
- Create: `scripts/lib/coil-shadow-matrix.mjs`, `scripts/lib/coil-shadow-stats.mjs`
- Test: `scripts/lib/coil-shadow-matrix.test.mjs`, `scripts/lib/coil-shadow-stats.test.mjs`

**Interfaces:**
- Produces (matrix): `matT`, `matMul`, `matVec`, `solveSPD(A, b)` (Cholesky-free Gaussian elimination), `invSPD(A)`.
- Produces (stats): `fitWithinClustered(rows): {beta, se, ciLower, ciUpper, n, nClusters, nIdentifyingDays}` — β is the `fire_early` coefficient after entry-day demeaning; SE clustered by name; `z = 1.2816` (one-sided 90%). Each row: `{ret, fireEarly, rsi2, sma5Gap, sma200Gap, day, name}`.

- [ ] **Step 1: Write the failing matrix test**

Create `scripts/lib/coil-shadow-matrix.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matMul, matT, solveSPD, invSPD } from './coil-shadow-matrix.mjs';

test('matMul and transpose', () => {
  const A = [[1, 2], [3, 4]];
  assert.deepEqual(matT(A), [[1, 3], [2, 4]]);
  assert.deepEqual(matMul(A, [[1, 0], [0, 1]]), A);
});

test('solveSPD solves A x = b for symmetric positive-definite A', () => {
  const A = [[4, 1], [1, 3]];
  const b = [1, 2];
  const x = solveSPD(A, b);
  // A x should reproduce b
  assert.ok(Math.abs(4 * x[0] + 1 * x[1] - 1) < 1e-9);
  assert.ok(Math.abs(1 * x[0] + 3 * x[1] - 2) < 1e-9);
});

test('invSPD inverts', () => {
  const A = [[4, 1], [1, 3]];
  const Inv = invSPD(A);
  const I = matMul(A, Inv);
  assert.ok(Math.abs(I[0][0] - 1) < 1e-9 && Math.abs(I[1][1] - 1) < 1e-9);
  assert.ok(Math.abs(I[0][1]) < 1e-9 && Math.abs(I[1][0]) < 1e-9);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test scripts/lib/coil-shadow-matrix.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the matrix module**

Create `scripts/lib/coil-shadow-matrix.mjs`:

```js
// Minimal linear algebra for the shadow-eval regression. Small dense matrices
// (K ~ 7), so plain Gaussian elimination with partial pivoting is ample.
export function matT(A) {
  const r = A.length, c = A[0].length;
  const out = Array.from({ length: c }, () => new Array(r));
  for (let i = 0; i < r; i += 1) for (let j = 0; j < c; j += 1) out[j][i] = A[i][j];
  return out;
}
export function matMul(A, B) {
  const n = A.length, m = B[0].length, k = B.length;
  const out = Array.from({ length: n }, () => new Array(m).fill(0));
  for (let i = 0; i < n; i += 1)
    for (let t = 0; t < k; t += 1) {
      const a = A[i][t];
      for (let j = 0; j < m; j += 1) out[i][j] += a * B[t][j];
    }
  return out;
}
export function matVec(A, x) {
  return A.map((row) => row.reduce((s, v, j) => s + v * x[j], 0));
}
// solveSPD: solve A x = b via Gaussian elimination with partial pivoting.
export function solveSPD(A, b) {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col += 1) {
    let piv = col;
    for (let r = col + 1; r < n; r += 1) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) throw new Error('singular matrix in solveSPD');
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= n; c += 1) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}
export function invSPD(A) {
  const n = A.length;
  const cols = [];
  for (let j = 0; j < n; j += 1) {
    const e = new Array(n).fill(0); e[j] = 1;
    cols.push(solveSPD(A, e));
  }
  // cols[j] is the j-th column of the inverse; transpose into row-major.
  return Array.from({ length: n }, (_, i) => cols.map((c) => c[i]));
}
```

- [ ] **Step 4: Run matrix tests**

Run: `node --test scripts/lib/coil-shadow-matrix.test.mjs`
Expected: PASS.

- [ ] **Step 5: Write the failing stats test**

Create `scripts/lib/coil-shadow-stats.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitWithinClustered } from './coil-shadow-stats.mjs';

// Build rows where, within each day, fire_early names get exactly +delta return
// over declined names → the within (day-FE) estimator must recover β ≈ delta.
function synth(delta, days = 40) {
  const rows = [];
  for (let d = 0; d < days; d += 1) {
    const dayShock = (d % 5) * 0.01; // common shift the FE absorbs
    for (let i = 0; i < 4; i += 1) {
      const fire = i < 2 ? 1 : 0;
      rows.push({
        ret: dayShock + (fire ? delta : 0),
        fireEarly: fire, rsi2: 6 + i, sma5Gap: -1 - i * 0.1, sma200Gap: 5 + i,
        day: `d${d}`, name: `N${i}`,
      });
    }
  }
  return rows;
}

test('within estimator recovers the planted effect and FE absorbs the day shock', () => {
  const fit = fitWithinClustered(synth(0.02));
  assert.ok(Math.abs(fit.beta - 0.02) < 1e-6, `beta=${fit.beta}`);
  assert.equal(fit.nClusters, 4);
  assert.ok(fit.ciLower > 0);
});

test('null effect → beta ≈ 0 and CI straddles 0', () => {
  const fit = fitWithinClustered(synth(0));
  assert.ok(Math.abs(fit.beta) < 1e-6);
  assert.ok(fit.ciLower < 0 && fit.ciUpper > 0);
});

test('clustered SE exceeds the naive i.i.d. SE under within-name correlation', () => {
  // Same name carries a persistent offset across days → positive within-name
  // correlation → clustered SE must widen vs a naive independent-obs SE.
  const rows = [];
  for (let d = 0; d < 40; d += 1) {
    for (let i = 0; i < 4; i += 1) {
      const fire = i < 2 ? 1 : 0;
      const nameOffset = (i === 0 ? 0.03 : 0); // one name persistently high
      rows.push({ ret: nameOffset + (fire ? 0.01 : 0), fireEarly: fire,
        rsi2: 6 + i, sma5Gap: -1, sma200Gap: 5, day: `d${d}`, name: `N${i}` });
    }
  }
  const fit = fitWithinClustered(rows);
  assert.ok(fit.se > fit.naiveSe, `clustered ${fit.se} should exceed naive ${fit.naiveSe}`);
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `node --test scripts/lib/coil-shadow-stats.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 7: Implement the regression**

Create `scripts/lib/coil-shadow-stats.mjs`:

```js
// Fixed-effects (entry-day) + cluster-robust (by name) regression for the Coil
// shadow eval. Uses the within transformation: demean y and every regressor by
// its day-group mean, so day fixed effects are absorbed and the design matrix
// stays small (fire_early + RSI-bucket dummies + sma5_gap + sma200_gap).
import { matT, matMul, matVec, invSPD } from './coil-shadow-matrix.mjs';

const Z_ONE_SIDED_90 = 1.2816;

// RSI(2) buckets over [5,15): [5,7),[7,9),[9,11),[11,13),[13,15). The first
// bucket is the dropped reference; returns 4 dummy values.
function rsiBuckets(rsi2) {
  const edges = [7, 9, 11, 13]; // dummies for buckets 2..5
  return edges.map((e, i) => (rsi2 >= e && rsi2 < (edges[i + 1] ?? 15) ? 1 : 0));
}

function designRow(r) {
  return [r.fireEarly, ...rsiBuckets(r.rsi2), r.sma5Gap, r.sma200Gap];
}

// demeanByGroup subtracts each row's day-group mean from y and every X column.
function demean(rows, ys, xs) {
  const sums = new Map(); // day → {n, sy, sx[]}
  const K = xs[0].length;
  for (let i = 0; i < rows.length; i += 1) {
    const d = rows[i].day;
    if (!sums.has(d)) sums.set(d, { n: 0, sy: 0, sx: new Array(K).fill(0) });
    const g = sums.get(d);
    g.n += 1; g.sy += ys[i];
    for (let j = 0; j < K; j += 1) g.sx[j] += xs[i][j];
  }
  const yd = new Array(rows.length), xd = new Array(rows.length);
  const identifyingDays = new Set();
  for (let i = 0; i < rows.length; i += 1) {
    const g = sums.get(rows[i].day);
    yd[i] = ys[i] - g.sy / g.n;
    xd[i] = xs[i].map((v, j) => v - g.sx[j] / g.n);
    if (Math.abs(xd[i][0]) > 1e-12) identifyingDays.add(rows[i].day); // fire_early varies this day
  }
  return { yd, xd, nIdentifyingDays: identifyingDays.size };
}

export function fitWithinClustered(rows) {
  const ys = rows.map((r) => r.ret);
  const xsRaw = rows.map(designRow);
  const { yd, xd, nIdentifyingDays } = demean(rows, ys, xsRaw);
  const n = rows.length;
  const K = xd[0].length;

  const Xt = matT(xd);                 // K×n
  const XtX = matMul(Xt, xd);          // K×K
  const XtXinv = invSPD(XtX);
  const XtY = matVec(Xt, yd);          // K
  const beta = matVec(XtXinv, XtY);    // K coefficients; beta[0] is fire_early
  const resid = yd.map((y, i) => y - xd[i].reduce((s, v, j) => s + v * beta[j], 0));

  // Cluster-robust "meat": Σ_g (X_g' e_g)(X_g' e_g)'  clustered by name.
  const byCluster = new Map();
  for (let i = 0; i < n; i += 1) {
    const c = rows[i].name;
    if (!byCluster.has(c)) byCluster.set(c, new Array(K).fill(0));
    const s = byCluster.get(c);
    for (let j = 0; j < K; j += 1) s[j] += xd[i][j] * resid[i];
  }
  const meat = Array.from({ length: K }, () => new Array(K).fill(0));
  for (const s of byCluster.values())
    for (let a = 0; a < K; a += 1) for (let b = 0; b < K; b += 1) meat[a][b] += s[a] * s[b];

  const G = byCluster.size;
  // Sandwich with the standard finite-sample cluster correction.
  const dof = (G / (G - 1)) * ((n - 1) / (n - K));
  const mid = matMul(meat, XtXinv);
  const V = matMul(XtXinv, mid).map((row) => row.map((v) => v * dof));
  const se = Math.sqrt(V[0][0]);

  // Naive (independent-obs) SE for the diagnostic comparison.
  const s2 = resid.reduce((a, e) => a + e * e, 0) / (n - K);
  const naiveSe = Math.sqrt(s2 * XtXinv[0][0]);

  return {
    beta: beta[0], se, naiveSe,
    ciLower: beta[0] - Z_ONE_SIDED_90 * se,
    ciUpper: beta[0] + Z_ONE_SIDED_90 * se,
    n, nClusters: G, nIdentifyingDays,
  };
}
```

- [ ] **Step 8: Run stats tests**

Run: `node --test scripts/lib/coil-shadow-stats.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 9: Commit**

```bash
git add scripts/lib/coil-shadow-matrix.mjs scripts/lib/coil-shadow-matrix.test.mjs scripts/lib/coil-shadow-stats.mjs scripts/lib/coil-shadow-stats.test.mjs
git commit -m "feat(coil-shadow): within/cluster-robust regression"
```

---

### Task 5: Verdict + futility gate

**Files:**
- Modify: `scripts/lib/coil-shadow-stats.mjs` (append)
- Test: `scripts/lib/coil-shadow-stats.test.mjs` (append)

**Interfaces:**
- Consumes: a fit `{beta, ciLower, ciUpper}` from Task 4.
- Produces:
  - `computeVerdict(fit, {floor=0.01}): 'KEEP'|'REJECT'|'INCONCLUSIVE'`
  - `futilityGate(fit, {floor=0.01}): 'early-reject'|'continue'` (never KEEP).

- [ ] **Step 1: Write the failing test**

Append to `scripts/lib/coil-shadow-stats.test.mjs`:

```js
import { computeVerdict, futilityGate } from './coil-shadow-stats.mjs';

test('verdict: KEEP needs lower bound > 0 AND beta ≥ floor', () => {
  assert.equal(computeVerdict({ beta: 0.015, ciLower: 0.004, ciUpper: 0.026 }), 'KEEP');
  assert.equal(computeVerdict({ beta: 0.015, ciLower: -0.001, ciUpper: 0.03 }), 'INCONCLUSIVE'); // lower≤0
  assert.equal(computeVerdict({ beta: 0.008, ciLower: 0.002, ciUpper: 0.014 }), 'INCONCLUSIVE'); // beta<floor
});

test('verdict: REJECT when upper bound < floor', () => {
  assert.equal(computeVerdict({ beta: 0.002, ciLower: -0.004, ciUpper: 0.008 }), 'REJECT');
});

test('futility gate early-rejects when a worthwhile edge is already ruled out, never KEEPs', () => {
  assert.equal(futilityGate({ beta: 0.001, ciLower: -0.005, ciUpper: 0.006 }), 'early-reject');
  assert.equal(futilityGate({ beta: 0.02, ciLower: 0.01, ciUpper: 0.03 }), 'continue'); // strong → continue, not KEEP
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test scripts/lib/coil-shadow-stats.test.mjs`
Expected: FAIL — `computeVerdict` not exported.

- [ ] **Step 3: Implement**

Append to `scripts/lib/coil-shadow-stats.mjs`:

```js
// computeVerdict maps a fit to the pre-registered terminal decision.
// floor = the +1.0% effect-size floor (in return units).
export function computeVerdict(fit, { floor = 0.01 } = {}) {
  if (fit.ciLower > 0 && fit.beta >= floor) return 'KEEP';
  if (fit.ciUpper < floor) return 'REJECT';
  return 'INCONCLUSIVE';
}

// futilityGate is the ~8-week staged check: it can only early-REJECT (a
// worthwhile edge already ruled out) or continue. It NEVER emits KEEP, so it
// introduces no optional-stopping bias toward a false positive.
export function futilityGate(fit, { floor = 0.01 } = {}) {
  return fit.ciUpper < floor ? 'early-reject' : 'continue';
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test scripts/lib/coil-shadow-stats.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the whole core suite + commit**

Run: `node --test scripts/lib/*.test.mjs`
Expected: all PASS.

```bash
git add scripts/lib/coil-shadow-stats.mjs scripts/lib/coil-shadow-stats.test.mjs
git commit -m "feat(coil-shadow): terminal verdict + staged futility gate"
```

---

## Self-Review

- **Spec coverage.** Candidate filter with strict `close<SMA5` (Task 1) ✓; min-gap reopen + gap-robust open (Task 1) ✓; exit replay starting day-after-entry, stop→target→timeout, single adjustment basis, glitch guard, `laterFired` (Task 2) ✓; groups + M k-lowest-RSI (Task 3) ✓; day-FE + name-clustered regression controlling RSI-buckets/sma5_gap/sma200_gap (Task 4) ✓; KEEP/REJECT/INCONCLUSIVE + never-KEEP futility gate (Task 5) ✓. The `nIdentifyingDays` field surfaces the honest "constant-fire days drop out" cost. `naiveSe` backs the clustered-vs-naive diagnostic.
- **Placeholder scan.** None — every function and test has complete code.
- **Type consistency.** Episode fields (`name, openDate, entryRef, tag, rsi2AtEntry, sma5GapAtEntry, sma200GapAtEntry`, then `ret/outcome/laterFired/status`) are produced in Task 1–2 and consumed unchanged in Task 3; regression row shape `{ret, fireEarly, rsi2, sma5Gap, sma200Gap, day, name}` is defined in Task 4's interface and built by Plan 3 from these fields.
- **Deferred to Plan 3.** The `sma200_gap` control and RSI-bucket edges are pre-registered here; the daily job, the `@anthropic-ai/sdk` tag call, the scorer/rollup orchestration, persistence, and scheduler wiring live in Plan 3, which imports every function above.
