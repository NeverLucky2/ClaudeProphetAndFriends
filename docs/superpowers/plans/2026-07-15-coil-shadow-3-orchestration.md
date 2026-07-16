# Coil Shadow Eval — Plan 3: Orchestration + Scheduler

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the Plan-1 endpoint and Plan-2 core into three runnable scripts — the daily snapshot+tag job, the retrospective scorer, and the rollup/verdict — plus a default-OFF scheduler slot.

**Architecture:** Each script has a pure, dependency-injected core (`runDailyJob` / `runScorer` / `runRollup`) tested with in-memory fakes, and a thin `main()` that wires real fetch/LLM/fs. State: authoritative write-once `data/coil-shadow/daily/<ET>.json` files; a rebuildable `episodes.json` index. Atomic writes (temp→rename).

**Tech Stack:** Node ESM, `@anthropic-ai/sdk` (already a dependency), `node:test`, `node:fs/promises`. Scheduler in `agent/analysis-scheduler.js`.

## Global Constraints

- **Default-OFF:** every entry point no-ops unless `COIL_SHADOW_ENABLED === 'true'`.
- **No trading, no orders.** Only reads meanrev endpoints + the LLM; writes only under `data/coil-shadow/`.
- **Info cutoff ≤ 15:45 ET.** v1 tags on signal stats ONLY (no headlines), so the cutoff is satisfied by construction. (Headlines remain a pre-registered *option*; if ever added they must carry a ≤15:45 timestamp.)
- **Idempotent per ET day:** a second daily run for a date that already has a `daily/<ET>.json` is a no-op.
- **Testable side-effects:** each core takes injected `fetchImpl` / `tagger` / `io`; the real deps live only in `main()`.

## File Structure

- `scripts/lib/coil-shadow-io.mjs` — fs helpers (atomic write, episode store) — Task 1
- `scripts/lib/coil-shadow-llm.mjs` — the `@anthropic-ai/sdk` tagger — Task 1
- `scripts/coil-shadow.mjs` — daily snapshot + tag + open episodes — Task 2
- `scripts/coil-shadow-score.mjs` — retrospective scorer — Task 3
- `scripts/coil-shadow-rollup.mjs` — regression + verdict report — Task 4
- `agent/analysis-scheduler.js` — the 16:55 slot — Task 5

---

### Task 1: IO helpers + LLM tagger

**Files:**
- Create: `scripts/lib/coil-shadow-io.mjs`, `scripts/lib/coil-shadow-llm.mjs`
- Test: `scripts/lib/coil-shadow-llm.test.mjs`

**Interfaces:**
- Produces (io): `makeFsIo(rootDir)` → `{ readEpisodes(), writeEpisodes(arr), dailyExists(etDate), writeDaily(etDate, obj), listDailyDates() }` (all async, atomic writes).
- Produces (llm): `tagCandidates(candidates, { client, model }): Promise<{tags, request, response}>` — `tags` maps `name → 'fire_early'|'declined'`; retries once; throws after the retry. `makeAnthropicTagger()` builds a `client` from `CLAUDE_API_KEY || ANTHROPIC_API_KEY`.

- [ ] **Step 1: Write the failing tagger test** (io is thin fs glue, exercised via the Task 2 mock; the tagger carries the parsing/retry logic worth unit-testing)

Create `scripts/lib/coil-shadow-llm.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tagCandidates } from './coil-shadow-llm.mjs';

const cands = [
  { name: 'AMGN', rsi2: 2.2, sma5Gap: -1.9, sma200Gap: 6.1, lastClose: 355 },
  { name: 'VRTX', rsi2: 6.5, sma5Gap: -2.2, sma200Gap: 6.3, lastClose: 476 },
];

function fakeClient(text, { failFirst = false } = {}) {
  let calls = 0;
  return { messages: { create: async () => {
    calls += 1;
    if (failFirst && calls === 1) throw new Error('transient');
    return { content: [{ type: 'text', text }] };
  } } };
}

test('parses strict JSON tags', async () => {
  const text = JSON.stringify({ per_name: [
    { ticker: 'AMGN', fire_early: true, reason: 'deep oversold' },
    { ticker: 'VRTX', fire_early: false, reason: 'not yet' }] });
  const { tags } = await tagCandidates(cands, { client: fakeClient(text), model: 'm' });
  assert.deepEqual(tags, { AMGN: 'fire_early', VRTX: 'declined' });
});

test('retries once then succeeds', async () => {
  const text = JSON.stringify({ per_name: [{ ticker: 'AMGN', fire_early: true, reason: 'x' },
    { ticker: 'VRTX', fire_early: false, reason: 'y' }] });
  const { tags } = await tagCandidates(cands, { client: fakeClient(text, { failFirst: true }), model: 'm' });
  assert.equal(tags.AMGN, 'fire_early');
});

test('missing name in response defaults to declined (never fabricates a fire)', async () => {
  const text = JSON.stringify({ per_name: [{ ticker: 'AMGN', fire_early: true, reason: 'x' }] });
  const { tags } = await tagCandidates(cands, { client: fakeClient(text), model: 'm' });
  assert.equal(tags.VRTX, 'declined');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test scripts/lib/coil-shadow-llm.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement io + tagger**

Create `scripts/lib/coil-shadow-io.mjs`:

```js
import { readFile, writeFile, rename, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';

// makeFsIo returns an atomic-write-backed store rooted at rootDir.
export function makeFsIo(rootDir) {
  const dailyDir = path.join(rootDir, 'daily');
  const episodesPath = path.join(rootDir, 'episodes.json');

  async function writeAtomic(file, obj) {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
    await rename(tmp, file); // atomic on same volume
  }
  async function readJson(file, fallback) {
    try { return JSON.parse(await readFile(file, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
  }
  return {
    readEpisodes: () => readJson(episodesPath, []),
    writeEpisodes: (arr) => writeAtomic(episodesPath, arr),
    dailyExists: async (etDate) => (await readJson(path.join(dailyDir, `${etDate}.json`), null)) !== null,
    writeDaily: (etDate, obj) => writeAtomic(path.join(dailyDir, `${etDate}.json`), obj),
    listDailyDates: async () => {
      try { return (await readdir(dailyDir)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort(); }
      catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    },
  };
}
```

Create `scripts/lib/coil-shadow-llm.mjs`:

```js
import Anthropic from '@anthropic-ai/sdk';

const SYSTEM = `You are a trading-signal judge for a research shadow evaluation. For each large-cap stock — a mechanical mean-reversion near-miss (RSI(2) just above the 5 trigger, in a pullback within an uptrend) — decide whether it will bounce SOON enough to "fire early" on. Use ONLY the numeric signals given; no outside knowledge. Respond with STRICT JSON: {"per_name":[{"ticker","fire_early":bool,"reason":string}]}. No prose outside the JSON.`;

// tagCandidates asks the model to tag each candidate fire_early or not. Retries
// once. Missing / unparseable names default to 'declined' (never fabricate a
// fire). Returns the tag map plus the raw request/response for the audit log.
export async function tagCandidates(candidates, { client, model }) {
  const request = { model, max_tokens: 1024, system: SYSTEM,
    messages: [{ role: 'user', content: JSON.stringify({ candidates }) }] };

  let lastErr;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const resp = await client.messages.create(request);
      const text = (resp.content || []).map((b) => b.text || '').join('');
      const parsed = JSON.parse(text);
      const fire = new Set((parsed.per_name || [])
        .filter((r) => r && r.fire_early === true)
        .map((r) => String(r.ticker).toUpperCase()));
      const tags = {};
      for (const c of candidates) tags[c.name] = fire.has(c.name) ? 'fire_early' : 'declined';
      return { tags, request, response: text };
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

export function makeAnthropicTagger(model = 'claude-sonnet-5') {
  const apiKey = process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('CLAUDE_API_KEY or ANTHROPIC_API_KEY required');
  const client = new Anthropic({ apiKey });
  return { client, model };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test scripts/lib/coil-shadow-llm.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/coil-shadow-io.mjs scripts/lib/coil-shadow-llm.mjs scripts/lib/coil-shadow-llm.test.mjs
git commit -m "feat(coil-shadow): fs store + anthropic tagger"
```

---

### Task 2: Daily snapshot + tag job

**Files:**
- Create: `scripts/coil-shadow.mjs`
- Test: `scripts/coil-shadow.test.mjs`

**Interfaces:**
- Consumes: `fetchJson`, `resolveLiveBase` from `./coil-preview.mjs`; `isEvalCandidate`, `openEpisodes` (Task 1, Plan 2); `computeMargins` from `./coil-preview.mjs`; `tagCandidates` (Task 1); an `io` (Task 1).
- Produces: `runDailyJob({ base, fetchImpl, tagger, io, etDate }): Promise<{status, opened, halted, gap}>`.

- [ ] **Step 1: Write the failing test**

Create `scripts/coil-shadow.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDailyJob } from './coil-shadow.mjs';

// In-memory io.
function memIo() {
  let episodes = []; const daily = new Map();
  return {
    _daily: daily,
    readEpisodes: async () => episodes,
    writeEpisodes: async (a) => { episodes = a; },
    dailyExists: async (d) => daily.has(d),
    writeDaily: async (d, o) => { daily.set(d, o); },
    listDailyDates: async () => [...daily.keys()].sort(),
  };
}

// Fake endpoint: 80-ish universe compressed to 3 names; AMGN is a WATCH candidate.
function fakeFetch(overrides = {}) {
  const sig = (t, rsi, close, sma5, sma200) => ({ ticker: t, rsi_2: rsi, last_close: close,
    sma_5: sma5, sma_200: sma200, entry_signal: false, earnings_within_5d: false,
    as_of: '2026-07-15T20:00:00Z' });
  const signals = {
    AMGN: sig('AMGN', 6, 98, 100, 90),   // WATCH candidate (below sma5, in regime)
    KO: sig('KO', 30, 100, 99, 90),      // not a pullback
    SPY: sig('SPY', 40, 500, 495, 480),  // regime healthy
    ...overrides.signals,
  };
  return async (base, p) => {
    if (p === '/api/v1/meanrev/universe') return { ok: true, status: 200, data: { universe: ['AMGN', 'KO'] } };
    if (p === '/api/v1/meanrev/candidates') return { ok: true, status: 200, data: { candidates: [], bear_regime: overrides.bear || false, bear_mode: overrides.bearMode || 'halfsize' } };
    const m = p.match(/\/signal\/(\w+)/);
    if (m) return { ok: true, status: 200, data: signals[m[1]] };
    return { ok: false, status: 404, data: null };
  };
}

const tagger = { client: { messages: { create: async () => ({ content: [{ text: JSON.stringify({ per_name: [{ ticker: 'AMGN', fire_early: true, reason: 'x' }] }) }] }) } }, model: 'm' };

test('opens a WATCH candidate episode, tags it, writes the daily file', async () => {
  const io = memIo();
  const r = await runDailyJob({ base: 'x', fetchImpl: fakeFetch(), tagger, io, etDate: '2026-07-15' });
  assert.equal(r.opened, 1);
  const eps = await io.readEpisodes();
  assert.equal(eps[0].name, 'AMGN');
  assert.equal(eps[0].tag, 'fire_early');
  assert.ok(io._daily.has('2026-07-15'));
});

test('idempotent: second run same day is a no-op', async () => {
  const io = memIo();
  await runDailyJob({ base: 'x', fetchImpl: fakeFetch(), tagger, io, etDate: '2026-07-15' });
  const r2 = await runDailyJob({ base: 'x', fetchImpl: fakeFetch(), tagger, io, etDate: '2026-07-15' });
  assert.equal(r2.status, 'already-ran');
  assert.equal((await io.readEpisodes()).length, 1);
});

test('bear-halt day opens nothing but records the day', async () => {
  const io = memIo();
  const r = await runDailyJob({ base: 'x', fetchImpl: fakeFetch({ bear: true, bearMode: 'halt' }), tagger, io, etDate: '2026-07-16' });
  assert.equal(r.halted, true);
  assert.equal(r.opened, 0);
  assert.ok(io._daily.has('2026-07-16'));
});

test('LLM failure → candidates tagged unknown, still logged', async () => {
  const io = memIo();
  const badTagger = { client: { messages: { create: async () => { throw new Error('down'); } } }, model: 'm' };
  const r = await runDailyJob({ base: 'x', fetchImpl: fakeFetch(), tagger: badTagger, io, etDate: '2026-07-15' });
  assert.equal(r.opened, 1);
  assert.equal((await io.readEpisodes())[0].tag, 'unknown');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test scripts/coil-shadow.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `scripts/coil-shadow.mjs`:

```js
import { fetchJson, resolveLiveBase, computeMargins, buildBanner } from './coil-preview.mjs';
import { isEvalCandidate, openEpisodes } from './lib/coil-shadow-episodes.mjs';
import { tagCandidates } from './lib/coil-shadow-llm.mjs';
import { makeFsIo } from './lib/coil-shadow-io.mjs';
import { makeAnthropicTagger } from './lib/coil-shadow-llm.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// activeFromEpisodes rebuilds the {name: openDate} active map from stored
// episodes: a name is "active" (blocks reopen) while its most recent episode is
// still 'open'. openEpisodes re-checks the 5-weekday window itself.
function activeFromEpisodes(episodes) {
  const active = {};
  for (const e of episodes) if (e.status === 'open') active[e.name] = e.openDate;
  return active;
}

// runDailyJob: idempotent per ET day. Snapshots WATCH candidates over the full
// universe, tags them with the LLM (or 'unknown' on failure), opens episodes,
// and persists. Never trades.
export async function runDailyJob({ base, fetchImpl, tagger, io, etDate }) {
  if (await io.dailyExists(etDate)) return { status: 'already-ran', opened: 0, halted: false, gap: false };

  const cand = await fetchJson(base, '/api/v1/meanrev/candidates', fetchImpl);
  if (!cand.ok || !cand.data) {
    await io.writeDaily(etDate, { etDate, gap: true, reason: 'candidates fetch failed' });
    return { status: 'gap', opened: 0, halted: false, gap: true };
  }
  const banner = buildBanner(!!cand.data.bear_regime, cand.data.bear_mode);
  const spy = await fetchJson(base, '/api/v1/meanrev/signal/SPY', fetchImpl);
  const spyRegime = spy.ok && spy.data ? { close: spy.data.last_close, sma200: spy.data.sma_200 } : null;

  if (banner.halt) {
    await io.writeDaily(etDate, { etDate, halt: true, bearRegime: true, spy: spyRegime, candidates: [], tags: {}, gap: false });
    return { status: 'halt', opened: 0, halted: true, gap: false };
  }

  const uni = await fetchJson(base, '/api/v1/meanrev/universe', fetchImpl);
  const universe = uni.ok && uni.data && Array.isArray(uni.data.universe) ? uni.data.universe : [];
  const firing = new Set((cand.data.candidates || []).map((c) => c.ticker));

  const candidates = [];
  for (const name of universe) {
    if (firing.has(name)) continue; // firing = Coil enters anyway, not a near-miss
    const r = await fetchJson(base, `/api/v1/meanrev/signal/${name}`, fetchImpl);
    if (!(r.ok && r.data && typeof r.data.rsi_2 === 'number')) continue;
    if (!isEvalCandidate(r.data)) continue;
    const m = computeMargins(r.data);
    candidates.push({ name, rsi2: r.data.rsi_2, sma5Gap: m.sma5_gap_pct,
      sma200Gap: m.sma200_gap_pct, lastClose: r.data.last_close, _sig: r.data });
  }

  let tags = {}; let llm = { request: null, response: null, error: null };
  if (candidates.length > 0) {
    try {
      const res = await tagCandidates(candidates.map(({ _sig, ...c }) => c), tagger);
      tags = res.tags; llm = { request: res.request, response: res.response, error: null };
    } catch (e) {
      for (const c of candidates) tags[c.name] = 'unknown';
      llm = { request: null, response: null, error: String(e.message || e) };
    }
  }

  const episodes = await io.readEpisodes();
  const { episodes: opened } = openEpisodes({
    active: activeFromEpisodes(episodes),
    candidates: candidates.map((c) => c._sig),
    tags, etDate,
  });
  await io.writeEpisodes([...episodes, ...opened]);
  await io.writeDaily(etDate, { etDate, halt: false, bearRegime: !!cand.data.bear_regime,
    spy: spyRegime, candidates: candidates.map(({ _sig, ...c }) => c), tags, llm, gap: false });

  return { status: 'ok', opened: opened.length, halted: false, gap: false };
}

async function main() {
  if (process.env.COIL_SHADOW_ENABLED !== 'true') return;
  const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { base } = await resolveLiveBase();
  const io = makeFsIo(path.join(PROJECT_ROOT, 'data', 'coil-shadow'));
  const tagger = makeAnthropicTagger();
  const etDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const r = await runDailyJob({ base, fetchImpl: globalThis.fetch, tagger, io, etDate });
  console.log(`coil-shadow ${etDate}: ${JSON.stringify(r)}`);
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`coil-shadow failed: ${e.message}`); process.exit(1); });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test scripts/coil-shadow.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/coil-shadow.mjs scripts/coil-shadow.test.mjs
git commit -m "feat(coil-shadow): daily snapshot + tag + open-episode job"
```

---

### Task 3: Retrospective scorer

**Files:**
- Create: `scripts/coil-shadow-score.mjs`
- Test: `scripts/coil-shadow-score.test.mjs`

**Interfaces:**
- Consumes: `fetchJson`, `resolveLiveBase` from `./coil-preview.mjs`; `weekdaysBetween` (Plan 2, Task 1); `scoreEpisode` (Plan 2, Task 2); an `io`.
- Produces: `runScorer({ base, fetchImpl, io, nowEtDate }): Promise<{scored, unscorable, pending}>`.

- [ ] **Step 1: Write the failing test**

Create `scripts/coil-shadow-score.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScorer } from './coil-shadow-score.mjs';

function memIo(episodes) {
  return { readEpisodes: async () => episodes, writeEpisodes: async (a) => { episodes = a; return a; }, _get: () => episodes };
}

function seriesFetch(closesByName) {
  return async (base, p) => {
    const m = p.match(/signal-series\/(\w+)/);
    if (!m) return { ok: false, status: 404, data: null };
    return { ok: true, status: 200, data: { series: closesByName[m[1]] } };
  };
}

test('scores an elapsed episode and leaves an un-elapsed one pending', async () => {
  const episodes = [
    { name: 'AMGN', openDate: '2026-07-01', entryRef: 98, tag: 'fire_early', status: 'open' },
    { name: 'VRTX', openDate: '2026-07-14', entryRef: 100, tag: 'declined', status: 'open' },
  ];
  const pt = (d, c, rsi = 20, sma5 = 100) => ({ as_of: `2026-07-${d}T20:00:00Z`, last_close: c, rsi_2: rsi, sma_5: sma5 });
  const io = memIo(episodes);
  const fetchImpl = seriesFetch({
    AMGN: [pt('01', 98), pt('02', 99), pt('03', 101, 20, 100)], // target → bounce
  });
  const r = await runScorer({ base: 'x', fetchImpl, io, nowEtDate: '2026-07-15' });
  assert.equal(r.scored, 1);
  assert.equal(r.pending, 1); // VRTX opened 2026-07-14, < 5 weekdays before 07-15
  const amgn = io._get().find((e) => e.name === 'AMGN');
  assert.equal(amgn.status, 'closed');
  assert.equal(amgn.outcome, 'bounce');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test scripts/coil-shadow-score.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `scripts/coil-shadow-score.mjs`:

```js
import { fetchJson, resolveLiveBase } from './coil-preview.mjs';
import { weekdaysBetween } from './lib/coil-shadow-episodes.mjs';
import { scoreEpisode } from './lib/coil-shadow-score.mjs';
import { makeFsIo } from './lib/coil-shadow-io.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOLD_DAYS = 5;

// runScorer scores every 'open' episode whose 5-trading-day window has elapsed,
// fetching just enough signal-series to cover its window. Reproducible; a missing
// window day yields 'unscorable' rather than a wrong score.
export async function runScorer({ base, fetchImpl, io, nowEtDate }) {
  const episodes = await io.readEpisodes();
  let scored = 0, unscorable = 0, pending = 0;

  for (const ep of episodes) {
    if (ep.status !== 'open') continue;
    const elapsed = weekdaysBetween(ep.openDate, nowEtDate);
    if (elapsed < HOLD_DAYS + 1) { pending += 1; continue; } // window not fully past
    const days = Math.min(14, elapsed + 2); // reach back to the entry day
    const r = await fetchJson(base, `/api/v1/meanrev/signal-series/${ep.name}?days=${days}`, fetchImpl);
    const series = r.ok && r.data && Array.isArray(r.data.series) ? r.data.series : [];
    const result = scoreEpisode(ep, series);
    Object.assign(ep, result);
    if (ep.status === 'closed') scored += 1; else unscorable += 1;
  }

  await io.writeEpisodes(episodes);
  return { scored, unscorable, pending };
}

async function main() {
  if (process.env.COIL_SHADOW_ENABLED !== 'true') return;
  const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { base } = await resolveLiveBase();
  const io = makeFsIo(path.join(PROJECT_ROOT, 'data', 'coil-shadow'));
  const nowEtDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const r = await runScorer({ base, fetchImpl: globalThis.fetch, io, nowEtDate });
  console.log(`coil-shadow-score ${nowEtDate}: ${JSON.stringify(r)}`);
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`coil-shadow-score failed: ${e.message}`); process.exit(1); });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test scripts/coil-shadow-score.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/coil-shadow-score.mjs scripts/coil-shadow-score.test.mjs
git commit -m "feat(coil-shadow): retrospective scorer orchestration"
```

---

### Task 4: Rollup + verdict report

**Files:**
- Create: `scripts/coil-shadow-rollup.mjs`
- Test: `scripts/coil-shadow-rollup.test.mjs`

**Interfaces:**
- Consumes: `assignGroups` (Plan 2, Task 3); `fitWithinClustered`, `computeVerdict`, `futilityGate` (Plan 2, Tasks 4–5); an `io`.
- Produces: `runRollup({ io, stage }): Promise<{verdict|gate, beta, ciLower, ciUpper, nA, nIdentifyingDays, aVsM, report}>` where `stage` is `'terminal'` (verdict) or `'futility'` (gate).

- [ ] **Step 1: Write the failing test**

Create `scripts/coil-shadow-rollup.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runRollup } from './coil-shadow-rollup.mjs';

// Closed episodes with a planted +2% fire-early edge over declined, day FE noise.
function episodes() {
  const eps = [];
  for (let d = 0; d < 40; d += 1) {
    const day = `2026-07-${String((d % 27) + 1).padStart(2, '0')}`;
    for (let i = 0; i < 4; i += 1) {
      const fire = i < 2;
      eps.push({ name: `N${i}`, openDate: `${day}-w${d}`, tag: fire ? 'fire_early' : 'declined',
        status: 'closed', rsi2AtEntry: 6 + i, sma5GapAtEntry: -1 - i * 0.1, sma200GapAtEntry: 5 + i,
        ret: (d % 5) * 0.01 + (fire ? 0.02 : 0), outcome: 'bounce' });
    }
  }
  return eps;
}

test('terminal rollup recovers the planted edge and returns KEEP', async () => {
  const io = { readEpisodes: async () => episodes() };
  const r = await runRollup({ io, stage: 'terminal' });
  assert.ok(Math.abs(r.beta - 0.02) < 1e-3, `beta=${r.beta}`);
  assert.equal(r.verdict, 'KEEP');
  assert.ok(r.report.includes('KEEP'));
});

test('futility stage returns a gate, never KEEP', async () => {
  const io = { readEpisodes: async () => episodes() };
  const r = await runRollup({ io, stage: 'futility' });
  assert.ok(r.gate === 'continue' || r.gate === 'early-reject');
  assert.equal(r.verdict, undefined);
});

test('only closed, tagged episodes enter the regression', async () => {
  const eps = [...episodes(),
    { name: 'U', openDate: 'x', tag: 'unknown', status: 'closed', rsi2AtEntry: 6, sma5GapAtEntry: -1, sma200GapAtEntry: 5, ret: 9, outcome: 'bounce' },
    { name: 'O', openDate: 'y', tag: 'fire_early', status: 'open', rsi2AtEntry: 6, sma5GapAtEntry: -1, sma200GapAtEntry: 5 }];
  const io = { readEpisodes: async () => eps };
  const r = await runRollup({ io, stage: 'terminal' });
  assert.ok(Math.abs(r.beta - 0.02) < 1e-3); // the ret=9 unknown/open rows excluded
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test scripts/coil-shadow-rollup.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `scripts/coil-shadow-rollup.mjs`:

```js
import { assignGroups } from './lib/coil-shadow-groups.mjs';
import { fitWithinClustered, computeVerdict, futilityGate } from './lib/coil-shadow-stats.mjs';
import { makeFsIo } from './lib/coil-shadow-io.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN; }

// runRollup loads closed episodes, fits the pre-registered regression, and emits
// either the terminal verdict or the futility gate (never a KEEP at the gate).
export async function runRollup({ io, stage = 'terminal' }) {
  const all = await io.readEpisodes();
  const closed = all.filter((e) => e.status === 'closed' && (e.tag === 'fire_early' || e.tag === 'declined'));
  const { A, M } = assignGroups(closed);

  const rows = closed.map((e) => ({ ret: e.ret, fireEarly: e.tag === 'fire_early' ? 1 : 0,
    rsi2: e.rsi2AtEntry, sma5Gap: e.sma5GapAtEntry, sma200Gap: e.sma200GapAtEntry,
    day: e.openDate, name: e.name }));

  const fit = fitWithinClustered(rows);
  const aVsM = mean(A.map((e) => e.ret)) - mean(M.map((e) => e.ret)); // robustness read

  const lines = [
    `# Coil Shadow Eval — ${stage} rollup`,
    ``,
    `N (closed A∪B): ${rows.length}   N_A: ${A.length}   clusters(names): ${fit.nClusters}   identifying days: ${fit.nIdentifyingDays}`,
    `beta (fire_early): ${(fit.beta * 100).toFixed(3)}%   clustered SE: ${(fit.se * 100).toFixed(3)}%   (naive SE: ${(fit.naiveSe * 100).toFixed(3)}%)`,
    `one-sided 90% CI: [${(fit.ciLower * 100).toFixed(3)}%, ${(fit.ciUpper * 100).toFixed(3)}%]`,
    `robustness A-vs-M mean-return gap: ${(aVsM * 100).toFixed(3)}%`,
  ];

  if (stage === 'futility') {
    const gate = futilityGate(fit);
    lines.push(``, `Futility gate: ${gate === 'early-reject' ? 'EARLY-REJECT (worthwhile edge already ruled out)' : 'CONTINUE'}`);
    return { gate, beta: fit.beta, ciLower: fit.ciLower, ciUpper: fit.ciUpper, nA: A.length,
      nIdentifyingDays: fit.nIdentifyingDays, aVsM, report: lines.join('\n') };
  }
  const verdict = computeVerdict(fit);
  const disagree = A.length && M.length && Math.sign(aVsM) !== Math.sign(fit.beta);
  lines.push(``, `VERDICT: ${verdict}`);
  if (verdict === 'KEEP' && disagree) lines.push(`⚠ A-vs-M disagrees in sign — run the nonlinear RSI diagnostic before filing KEEP (pre-registered).`);
  return { verdict, beta: fit.beta, ciLower: fit.ciLower, ciUpper: fit.ciUpper, nA: A.length,
    nIdentifyingDays: fit.nIdentifyingDays, aVsM, report: lines.join('\n') };
}

async function main() {
  const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const io = makeFsIo(path.join(PROJECT_ROOT, 'data', 'coil-shadow'));
  const stage = process.argv.includes('--futility') ? 'futility' : 'terminal';
  const r = await runRollup({ io, stage });
  console.log(r.report);
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`coil-shadow-rollup failed: ${e.message}`); process.exit(1); });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test scripts/coil-shadow-rollup.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/coil-shadow-rollup.mjs scripts/coil-shadow-rollup.test.mjs
git commit -m "feat(coil-shadow): rollup + verdict/futility report"
```

---

### Task 5: Scheduler wiring (default-OFF)

**Files:**
- Modify: `agent/analysis-scheduler.js` (add the 16:55-adjacent slot + a `coil_shadow` job runner)
- Test: none new — the runnable cores are covered by Tasks 2–4; this task is a guarded trigger wire.

**Interfaces:**
- Consumes: the daily job / scorer `main` entry points (spawned) — same spawn pattern the scheduler already uses for python/skill jobs.
- Produces: a `coil_shadow` scheduled trigger firing daily at 16:56 ET (after the 16:55 reasoning digest), gated by `COIL_SHADOW_ENABLED`.

- [ ] **Step 1: Add the trigger**

In `agent/analysis-scheduler.js`, in the same time-dispatch block as the reasoning digest (near the existing `hour === 16 && minute === 55` check), add:

```js
    // Coil shadow eval — daily snapshot+tag then score, 16:56 ET (after the
    // 16:55 digest). No-op unless COIL_SHADOW_ENABLED=true. Idempotent per ET day.
    if (isWeekday && hour === 16 && minute === 56 &&
        process.env.COIL_SHADOW_ENABLED === 'true' &&
        this._lastCoilShadowDate !== isoDate) {
      this._lastCoilShadowDate = isoDate;
      this.triggerJob('coil_shadow').catch(() => {});
    }
```

- [ ] **Step 2: Add the job runner**

In `agent/analysis-scheduler.js`, alongside the other `_run*` job methods, add a runner that spawns the daily job then the scorer (mirror the existing `spawn(process.execPath, [script])` pattern used for node scripts; if the file uses a helper like `_spawnNode`, reuse it):

```js
  async _runCoilShadow() {
    const scripts = ['scripts/coil-shadow.mjs', 'scripts/coil-shadow-score.mjs'];
    for (const rel of scripts) {
      await new Promise((resolve) => {
        const p = spawn(process.execPath, [path.join(PROJECT_ROOT, rel)], {
          cwd: PROJECT_ROOT, env: process.env, stdio: 'inherit',
        });
        p.on('close', () => resolve());
        p.on('error', () => resolve());
      });
    }
  }
```

Wire `triggerJob('coil_shadow')` to call `_runCoilShadow()` following the existing `triggerJob` switch/dispatch convention in the file.

- [ ] **Step 3: Verify the gate holds when OFF**

Run: `node -e "process.env.COIL_SHADOW_ENABLED=''; import('./scripts/coil-shadow.mjs').then(m=>m).catch(e=>{console.error(e);process.exit(1)})"`
Expected: exits 0 with no output (main no-ops when the flag is unset).

- [ ] **Step 4: Full suite**

Run: `node --test scripts/**/*.test.mjs && go test ./services/ ./controllers/`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/analysis-scheduler.js
git commit -m "feat(coil-shadow): default-OFF scheduler slot (16:56 ET)"
```

---

## Self-Review

- **Spec coverage.** Daily job with full-universe WATCH snapshot, LLM tag via `@anthropic-ai/sdk`, min-gap-aware episode open, atomic authoritative daily files + rebuildable episodes index, SPY-regime logging, bear-halt handling, and idempotency (Task 2) ✓; retrospective per-episode scorer with elapsed-window gating and gap→unscorable (Task 3) ✓; rollup emitting the pre-registered verdict + the A-vs-M robustness read + the never-KEEP futility gate, over closed/tagged episodes only (Task 4) ✓; default-OFF scheduler slot after the digest (Task 5) ✓.
- **Honest scoping note.** The spec says "SPY/VIX regime" on gap days; this plan logs **SPY** regime (available from `/signal/SPY`) and omits VIX (no wired source) — a deliberate v1 narrowing, not a silent drop. v1 also tags on **signal stats only, no headlines**, which makes the ≤15:45 information cutoff automatic; headlines remain a pre-registered future option.
- **Placeholder scan.** None — every core has complete code and mock-based tests. Task 5 reuses the file's existing spawn/`triggerJob` conventions (exact wiring depends on the current switch shape in `analysis-scheduler.js`, which the implementer follows).
- **Type consistency.** `runDailyJob`/`runScorer`/`runRollup` signatures and the `io` shape (`readEpisodes/writeEpisodes/dailyExists/writeDaily/listDailyDates`) match across scripts and tests; episode fields flow unchanged from Plan 2. `tagCandidates` returns `{tags, request, response}` as consumed by the daily job.
- **Verification-before-done.** Per the project's testing norm, every side-effecting core (daily job, scorer, rollup) is exercised through injected fakes asserting the actual state transition — not just its predicates.
