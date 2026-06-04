# Coil Pre-Close Scouting Report (`/coil-preview`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only `/coil-preview` command that, run a few hours before Coil's 15:45 ET beat, shows which large-caps Coil is likely to buy (FIRING) and which are near (WATCH), with mirror-trade details, so the operator can prepare to mirror Coil in a personal Merrill account.

**Architecture:** A standalone Node ESM script (`scripts/coil-preview.mjs`) calls Coil's own HTTP endpoints on the running Go bot — `/api/v1/meanrev/universe`, `/api/v1/meanrev/candidates`, `/api/v1/meanrev/signal/:symbol` — and renders a ranked markdown report. It reimplements no signal math and fetches no bars itself, so it is byte-for-byte what Coil computes. A thin skill (`.claude/skills/coil-preview/SKILL.md`) runs the script and shows its output.

**Tech Stack:** Node 18+ ESM (`"type": "module"`), `node:test` + `node:assert/strict`, global `fetch` (injectable for tests). No new dependencies. Reference spec: `docs/superpowers/specs/2026-06-04-coil-preview-design.md`.

---

## File Structure

- **Create `scripts/coil-preview.mjs`** — one file, grown task by task. Pure, exported logic (constants, margins, WATCH classification, mirror block, banner, report assembly, markdown rendering) + a thin injectable I/O shell (`fetchJson`, `runPreview`) + a `main()`/CLI guard. The pure logic is unit-tested; the I/O shell is tested with a stub fetcher; `main()` is verified by manual smoke run.
- **Create `scripts/coil-preview.test.mjs`** — `node:test` suite, grown alongside. No network: pure-logic tests call functions directly; `runPreview` tests inject a stub fetcher.
- **Create `.claude/skills/coil-preview/SKILL.md`** — the user-facing `/coil-preview` skill; runs the script and presents its output.

### Endpoint response shapes (verified, for reference while implementing)

`GET /api/v1/meanrev/universe` → `{ "count": 80, "universe": ["AAPL", ...] }`

`GET /api/v1/meanrev/candidates` → `MeanRevCandidatesResponse`:
```
{ as_of, count, bear_regime (bool), bear_mode ("normal"|"halfsize"|"halt"),
  candidates: [ MeanRevSignal ],   // entry_signal=true only, sorted by rsi_2 asc
  errors?: [string] }
```

`GET /api/v1/meanrev/signal/:symbol` → `MeanRevSignal` (200), or `{error,...}` 422 (insufficient history) / 500 (fetch failed):
```
{ ticker, as_of, bars_count, last_close, rsi_2, sma_200, sma_5,
  earnings_within_5d (bool), entry_signal (bool), signal_version, explanation? }
```

---

## Task 1: Constants, margins, and WATCH classification

**Files:**
- Create: `scripts/coil-preview.mjs`
- Test: `scripts/coil-preview.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `scripts/coil-preview.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WATCH_RSI_MAX, WATCH_SMA5_BAND, THIN_REGIME_PCT,
  computeMargins, classifyWatch,
} from './coil-preview.mjs';

// A non-firing, in-regime, oversold-ish signal that qualifies as WATCH.
function watchSig(over = {}) {
  return {
    ticker: 'AAPL', last_close: 99, rsi_2: 10, sma_5: 100, sma_200: 90,
    earnings_within_5d: false, entry_signal: false, ...over,
  };
}

test('computeMargins arithmetic', () => {
  const m = computeMargins({ last_close: 99, rsi_2: 10, sma_5: 100, sma_200: 90 });
  assert.equal(m.rsi2_margin, 5);                 // 10 - 5
  assert.ok(Math.abs(m.sma5_gap_pct - (-1)) < 1e-9);   // (99-100)/100*100
  assert.ok(Math.abs(m.sma200_gap_pct - (10)) < 1e-9); // (99-90)/90*100
});

test('classifyWatch accepts a near-miss', () => {
  assert.equal(classifyWatch(watchSig()), true);
});

test('classifyWatch rejects firing signals', () => {
  assert.equal(classifyWatch(watchSig({ entry_signal: true })), false);
});

test('classifyWatch rejects earnings-within-5d', () => {
  assert.equal(classifyWatch(watchSig({ earnings_within_5d: true })), false);
});

test('classifyWatch rejects out-of-regime (at/below 200-day)', () => {
  assert.equal(classifyWatch(watchSig({ last_close: 90, sma_200: 90 })), false);
});

test('classifyWatch RSI band is exclusive at the max', () => {
  assert.equal(classifyWatch(watchSig({ rsi_2: WATCH_RSI_MAX })), false);
  assert.equal(classifyWatch(watchSig({ rsi_2: WATCH_RSI_MAX - 0.01 })), true);
});

test('classifyWatch SMA5 band edge: just inside vs just outside +0.5%', () => {
  // band = sma_5 * (1 + 0.005) = 100.5; strictly less-than required
  assert.equal(classifyWatch(watchSig({ last_close: 100.5 })), false);
  assert.equal(classifyWatch(watchSig({ last_close: 100.49 })), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/coil-preview.test.mjs`
Expected: FAIL — cannot resolve `./coil-preview.mjs` (module not created yet).

- [ ] **Step 3: Write minimal implementation**

Create `scripts/coil-preview.mjs`:

```js
// scripts/coil-preview.mjs
// Read-only pre-close scouting report for the Coil mean-reversion agent.
// Calls Coil's own HTTP endpoints so the numbers are byte-for-byte Coil's.
// See docs/superpowers/specs/2026-06-04-coil-preview-design.md.

export const RSI_ENTRY_MAX = 5;        // Coil's entry trigger (rsi_2 < 5)
export const WATCH_RSI_MAX = 15;       // WATCH band: oversold-ish but not yet firing
export const WATCH_SMA5_BAND = 0.005;  // WATCH band: at most 0.5% above the 5-day
export const WATCH_MAX_NAMES = 10;     // cap on the WATCH list
export const STOP_PCT = 0.07;          // Coil's -7% hard stop
export const THIN_REGIME_PCT = 1.0;    // soft-warn when 0 < sma200_gap_pct < this

// computeMargins returns the distance of each gate from its threshold.
//   rsi2_margin  : rsi_2 - 5      (<=0 means past the trigger)
//   sma5_gap_pct : % above/below the 5-day  (negative = pullback condition met)
//   sma200_gap_pct: % above/below the 200-day (positive = in uptrend regime)
export function computeMargins(sig) {
  return {
    rsi2_margin: sig.rsi_2 - RSI_ENTRY_MAX,
    sma5_gap_pct: ((sig.last_close - sig.sma_5) / sig.sma_5) * 100,
    sma200_gap_pct: ((sig.last_close - sig.sma_200) / sig.sma_200) * 100,
  };
}

// classifyWatch: a non-firing name worth watching. Relaxes ONLY the two
// intraday-moving conditions (RSI and close-vs-5-day); regime and earnings stay hard.
export function classifyWatch(sig) {
  if (sig.entry_signal) return false;                 // already firing
  if (sig.earnings_within_5d) return false;           // disqualified
  if (!(sig.last_close > sig.sma_200)) return false;  // out of regime
  if (!(sig.rsi_2 < WATCH_RSI_MAX)) return false;
  if (!(sig.last_close < sig.sma_5 * (1 + WATCH_SMA5_BAND))) return false;
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/coil-preview.test.mjs`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/coil-preview.mjs scripts/coil-preview.test.mjs
git commit -m "feat(coil-preview): margins + WATCH classification"
```

---

## Task 2: Mirror block and bear-regime banner

**Files:**
- Modify: `scripts/coil-preview.mjs`
- Test: `scripts/coil-preview.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `scripts/coil-preview.test.mjs`:

```js
import { buildMirror, buildBanner, STOP_PCT } from './coil-preview.mjs';

test('buildMirror: fill-relative stop rule + illustrative number + exit rules', () => {
  const m = buildMirror({ last_close: 100 });
  assert.equal(m.entry_ref, 100);
  assert.match(m.entry_ref_note, /provisional/i);
  assert.equal(m.illustrative_stop, 93);                 // round(100 * 0.93, 2)
  assert.match(m.stop_rule, /fill/i);
  assert.match(m.stop_rule, /0\.93/);
  assert.match(m.stop_rule, /illustrative/i);
  assert.match(m.exit_rules, /RSI\(2\)>70/);
  assert.match(m.exit_rules, /5-day SMA/);
  assert.match(m.exit_rules, /5 trading days/);
});

test('buildMirror rounds the illustrative stop to 2dp', () => {
  assert.equal(buildMirror({ last_close: 123.456 }).illustrative_stop, 114.81); // 123.456*0.93=114.81408
});

test('buildBanner: normal regime', () => {
  const b = buildBanner(false, 'halfsize');
  assert.equal(b.halt, false);
  assert.match(b.text, /Normal regime/i);
});

test('buildBanner: bear + halfsize', () => {
  const b = buildBanner(true, 'halfsize');
  assert.equal(b.halt, false);
  assert.match(b.text, /halves size/i);
});

test('buildBanner: bear + halt sets halt flag', () => {
  const b = buildBanner(true, 'halt');
  assert.equal(b.halt, true);
  assert.match(b.text, /HALT/);
});

test('buildBanner: bear + normal mode (SPY<200d but operator chose normal)', () => {
  const b = buildBanner(true, 'normal');
  assert.equal(b.halt, false);
  assert.match(b.text, /Bear regime/i);
});

test('buildBanner defaults missing mode to halfsize', () => {
  assert.match(buildBanner(true, undefined).text, /halves size/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/coil-preview.test.mjs`
Expected: FAIL — `buildMirror`/`buildBanner` are not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/coil-preview.mjs`:

```js
function round2(x) { return Math.round(x * 100) / 100; }

// buildMirror: everything the operator needs to replicate the full trade.
// The stop is expressed as a RULE relative to the actual fill, not a fixed
// number anchored to the (provisional) preview price.
export function buildMirror(sig) {
  return {
    entry_ref: sig.last_close,
    entry_ref_note: 'provisional midday reference, not your expected fill',
    illustrative_stop: round2(sig.last_close * (1 - STOP_PCT)),
    stop_rule: 'Set your stop at your actual fill × 0.93 (−7%). The number above is illustrative only.',
    exit_rules: 'Exit when RSI(2)>70, OR close above the 5-day SMA, OR 5 trading days elapse (whichever first).',
    timing: 'To match Coil, place near its 15:45 ET beat (same-day). Next-morning entry adds overnight gap risk.',
    sizing_note: 'Coil sizes ~5% of its book, max 4 concurrent — size your own account.',
  };
}

// buildBanner maps Coil's (bear_regime, bear_mode) into an operator-facing line
// and a halt flag. halt=true means Coil will place NO new entries today.
export function buildBanner(bearRegime, bearMode) {
  if (!bearRegime) return { text: 'Normal regime — Coil sizes full.', halt: false };
  const mode = String(bearMode || 'halfsize').toLowerCase();
  if (mode === 'halt') {
    return { text: '⛔ Bear regime + HALT — Coil will place NO new entries today.', halt: true };
  }
  if (mode === 'normal') {
    return { text: '⚠️ Bear regime (mode=normal) — Coil still sizes full despite SPY<200d.', halt: false };
  }
  return { text: '⚠️ Bear regime — Coil halves size today.', halt: false };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/coil-preview.test.mjs`
Expected: PASS (all Task 1 + Task 2 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/coil-preview.mjs scripts/coil-preview.test.mjs
git commit -m "feat(coil-preview): fill-relative mirror block + regime banner"
```

---

## Task 3: Signal enrichment and report assembly

**Files:**
- Modify: `scripts/coil-preview.mjs`
- Test: `scripts/coil-preview.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `scripts/coil-preview.test.mjs`:

```js
import { enrichSignal, assembleReport, WATCH_MAX_NAMES } from './coil-preview.mjs';

function sig(over = {}) {
  return {
    ticker: 'XYZ', last_close: 99, rsi_2: 10, sma_5: 100, sma_200: 90,
    earnings_within_5d: false, entry_signal: false, ...over,
  };
}

test('enrichSignal attaches margins, thin_regime, and a mirror block', () => {
  const e = enrichSignal(sig({ last_close: 90.5, sma_200: 90 })); // 0.56% over 200d -> thin
  assert.equal(e.ticker, 'XYZ');
  assert.ok(e.thin_regime, 'thin regime margin should be flagged');
  assert.ok(e.mirror && e.mirror.exit_rules);
  assert.ok(typeof e.rsi2_margin === 'number');
});

test('enrichSignal: comfortable regime is not thin', () => {
  assert.equal(enrichSignal(sig({ last_close: 99, sma_200: 90 })).thin_regime, false);
});

test('assembleReport: firing from candidates, watch from signals, sorted + capped', () => {
  const candidatesResp = {
    as_of: '2026-06-04T19:45:00Z', bear_regime: false, bear_mode: 'halfsize',
    candidates: [sig({ ticker: 'AAA', rsi_2: 2, entry_signal: true })],
  };
  const signals = new Map();
  // 12 watch-qualifying names with varying rsi to test sort + cap
  for (let i = 0; i < 12; i += 1) {
    const t = `W${i}`;
    signals.set(t, sig({ ticker: t, rsi_2: 14 - i * 0.5 })); // W11 most oversold
  }
  // one non-qualifying (out of regime) name that must be excluded
  signals.set('OUT', sig({ ticker: 'OUT', last_close: 80, sma_200: 90 }));

  const r = assembleReport({
    universe: ['AAA', ...[...signals.keys()]],
    candidatesResp, signals, failed: [], now: new Date('2026-06-04T16:30:00Z'),
  });

  assert.equal(r.bot_ok, true);
  assert.equal(r.firing.length, 1);
  assert.equal(r.firing[0].ticker, 'AAA');
  assert.equal(r.watch.length, WATCH_MAX_NAMES);            // capped at 10
  assert.equal(r.watch_truncated, true);
  assert.equal(r.watch[0].ticker, 'W11');                   // most oversold first
  assert.equal(r.halt, false);
  assert.ok(!r.watch.some((w) => w.ticker === 'OUT'));      // out-of-regime excluded
});

test('assembleReport: halt regime sets halt flag', () => {
  const r = assembleReport({
    universe: ['AAA'],
    candidatesResp: { bear_regime: true, bear_mode: 'halt', candidates: [] },
    signals: new Map(), failed: [],
  });
  assert.equal(r.halt, true);
  assert.match(r.spy.banner, /HALT/);
});

test('assembleReport: incomplete counts failed names', () => {
  const r = assembleReport({
    universe: ['A', 'B', 'C'],
    candidatesResp: { bear_regime: false, bear_mode: 'halfsize', candidates: [] },
    signals: new Map(), failed: ['B', 'C'],
  });
  assert.equal(r.incomplete.failed, 2);
  assert.equal(r.incomplete.total, 3);
  assert.deepEqual(r.incomplete.names, ['B', 'C']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/coil-preview.test.mjs`
Expected: FAIL — `enrichSignal`/`assembleReport` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/coil-preview.mjs`:

```js
// ET date/time helpers (America/New_York), matching the convention used by the
// other coil-*.mjs scripts.
const ET_DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
});
export function etDateStr(d = new Date()) {
  const p = {};
  for (const x of ET_DATE_FMT.formatToParts(d)) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}`;
}
const ET_TIME_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
});
export function etTimeStr(d = new Date()) { return ET_TIME_FMT.format(d); } // "HH:MM"

// enrichSignal turns a raw MeanRevSignal into a render-ready row.
export function enrichSignal(sig) {
  const m = computeMargins(sig);
  return {
    ticker: sig.ticker,
    last_close: sig.last_close,
    rsi_2: sig.rsi_2,
    sma_5: sig.sma_5,
    sma_200: sig.sma_200,
    rsi2_margin: m.rsi2_margin,
    sma5_gap_pct: m.sma5_gap_pct,
    sma200_gap_pct: m.sma200_gap_pct,
    thin_regime: m.sma200_gap_pct > 0 && m.sma200_gap_pct < THIN_REGIME_PCT,
    earnings_within_5d: !!sig.earnings_within_5d,
    mirror: buildMirror(sig),
  };
}

// assembleReport builds the full report object from the three endpoint results.
//   firing : from /candidates (authoritative, already entry_signal=true, rsi-sorted)
//   watch  : non-firing names from per-symbol /signal that pass classifyWatch
//   failed : tickers whose /signal fetch errored (drives the INCOMPLETE warning)
export function assembleReport({ universe, candidatesResp, signals, failed, now = new Date() }) {
  const bearRegime = !!candidatesResp.bear_regime;
  const bearMode = candidatesResp.bear_mode || 'halfsize';
  const banner = buildBanner(bearRegime, bearMode);

  const firingRaw = Array.isArray(candidatesResp.candidates) ? candidatesResp.candidates : [];
  const firing = firingRaw.map(enrichSignal);
  const firingSet = new Set(firingRaw.map((c) => c.ticker));

  const watchAll = [];
  for (const [ticker, sig] of signals) {
    if (firingSet.has(ticker)) continue;
    if (classifyWatch(sig)) watchAll.push(enrichSignal(sig));
  }
  watchAll.sort((a, b) => a.rsi_2 - b.rsi_2);

  return {
    as_of: candidatesResp.as_of || null,
    preview_time_et: etTimeStr(now),
    preview_date_et: etDateStr(now),
    bot_ok: true,
    spy: { bear_regime: bearRegime, bear_mode: bearMode, banner: banner.text },
    halt: banner.halt,
    firing,
    watch: watchAll.slice(0, WATCH_MAX_NAMES),
    watch_truncated: watchAll.length > WATCH_MAX_NAMES,
    incomplete: { failed: (failed || []).length, total: (universe || []).length, names: failed || [] },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/coil-preview.test.mjs`
Expected: PASS (Tasks 1–3).

- [ ] **Step 5: Commit**

```bash
git add scripts/coil-preview.mjs scripts/coil-preview.test.mjs
git commit -m "feat(coil-preview): signal enrichment + report assembly"
```

---

## Task 4: Markdown rendering

**Files:**
- Modify: `scripts/coil-preview.mjs`
- Test: `scripts/coil-preview.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `scripts/coil-preview.test.mjs`:

```js
import { renderReport } from './coil-preview.mjs';

function baseReport(over = {}) {
  return {
    as_of: '2026-06-04T19:45:00Z', preview_time_et: '12:30', preview_date_et: '2026-06-04',
    bot_ok: true, spy: { bear_regime: false, bear_mode: 'halfsize', banner: 'Normal regime — Coil sizes full.' },
    halt: false, firing: [], watch: [], watch_truncated: false,
    incomplete: { failed: 0, total: 80, names: [] }, ...over,
  };
}

test('renderReport always shows the provisional caveat header and regime', () => {
  const out = renderReport(baseReport());
  assert.match(out, /Provisional read as of 12:30 ET/);
  assert.match(out, /Normal regime/);
  assert.match(out, /FIRING/);
  assert.match(out, /WATCH/);
});

test('renderReport renders a firing name with its mirror block', () => {
  const out = renderReport(baseReport({ firing: [enrichSignal({
    ticker: 'NVDA', last_close: 100, rsi_2: 3, sma_5: 102, sma_200: 80,
    earnings_within_5d: false, entry_signal: true,
  })] }));
  assert.match(out, /NVDA/);
  assert.match(out, /0\.93/);            // stop rule wording
  assert.match(out, /RSI\(2\)>70/);      // exit rules
});

test('renderReport greys FIRING and notes HALT when halted', () => {
  const out = renderReport(baseReport({ halt: true, spy: { bear_regime: true, bear_mode: 'halt', banner: '⛔ Bear regime + HALT — Coil will place NO new entries today.' } }));
  assert.match(out, /HALTED/);
  assert.match(out, /reference only/i);
});

test('renderReport shows a loud INCOMPLETE warning', () => {
  const out = renderReport(baseReport({ incomplete: { failed: 3, total: 80, names: ['A', 'B', 'C'] } }));
  assert.match(out, /INCOMPLETE/);
  assert.match(out, /3 of 80/);
});

test('renderReport notes the WATCH cap when truncated', () => {
  const out = renderReport(baseReport({ watch_truncated: true }));
  assert.match(out, /capped at 10/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/coil-preview.test.mjs`
Expected: FAIL — `renderReport` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/coil-preview.mjs`:

```js
function renderName(c) {
  const out = [];
  const thin = c.thin_regime ? '  ⚠️ thin regime margin' : '';
  out.push(`### ${c.ticker} — $${c.last_close.toFixed(2)}`);
  out.push(`- RSI(2) ${c.rsi_2.toFixed(1)} (margin ${c.rsi2_margin.toFixed(1)}) · vs 5-day ${c.sma5_gap_pct.toFixed(2)}% · vs 200-day ${c.sma200_gap_pct.toFixed(2)}%${thin}`);
  if (c.earnings_within_5d) out.push('- ⚠️ earnings within 5 trading days');
  out.push(`- **Mirror:** entry ref $${c.mirror.entry_ref.toFixed(2)} (${c.mirror.entry_ref_note}). ${c.mirror.stop_rule} (illustrative: $${c.mirror.illustrative_stop.toFixed(2)})`);
  out.push(`- ${c.mirror.exit_rules}`);
  out.push(`- _${c.mirror.timing} ${c.mirror.sizing_note}_`);
  out.push('');
  return out;
}

// renderReport produces the full operator-facing markdown report.
export function renderReport(r) {
  const lines = [];
  lines.push('# Coil Scouting Report');
  lines.push('');
  lines.push(`> **Provisional read as of ${r.preview_time_et} ET (${r.preview_date_et})** — names can drop off or appear by Coil's 15:45 ET beat. Regime can flip too if SPY crosses its 200-day.`);
  lines.push('');
  lines.push(`**Regime:** ${r.spy.banner}`);
  lines.push('');
  if (r.incomplete.failed > 0) {
    lines.push(`> ⚠️ **${r.incomplete.failed} of ${r.incomplete.total} universe names failed to fetch — WATCH list is INCOMPLETE.** (${r.incomplete.names.join(', ')})`);
    lines.push('');
  }

  if (r.halt) {
    lines.push(`## 🟢 FIRING (${r.firing.length}) — ⛔ reference only`);
    lines.push('');
    lines.push('_Coil is HALTED today — it will NOT enter these. Shown for reference only._');
  } else {
    lines.push(`## 🟢 FIRING (${r.firing.length}) — likely Coil buys at 15:45`);
  }
  lines.push('');
  if (r.firing.length === 0) lines.push('_None firing right now._');
  for (const c of r.firing) lines.push(...renderName(c));
  lines.push('');

  const cap = r.watch_truncated ? ` — capped at ${WATCH_MAX_NAMES}` : '';
  lines.push(`## 🟡 WATCH (${r.watch.length})${cap} — near, could flip by close`);
  lines.push('');
  if (r.watch.length === 0) lines.push('_No near-misses._');
  for (const c of r.watch) lines.push(...renderName(c));

  return lines.join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/coil-preview.test.mjs`
Expected: PASS (Tasks 1–4).

- [ ] **Step 5: Commit**

```bash
git add scripts/coil-preview.mjs scripts/coil-preview.test.mjs
git commit -m "feat(coil-preview): markdown report rendering"
```

---

## Task 5: HTTP shell — `fetchJson` and `runPreview` (stub-fetcher tests)

**Files:**
- Modify: `scripts/coil-preview.mjs`
- Test: `scripts/coil-preview.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `scripts/coil-preview.test.mjs`:

```js
import { runPreview } from './coil-preview.mjs';

// Build a stub fetch over a route table. Each value is { status, body } or a
// function (path) => { status, body }. Missing routes -> network error (throws).
function stubFetch(routes) {
  return async (url) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    let entry = routes[path];
    if (typeof entry === 'function') entry = entry(path);
    if (!entry) throw new Error(`no route: ${path}`);
    return {
      ok: entry.status >= 200 && entry.status < 300,
      status: entry.status,
      json: async () => entry.body,
    };
  };
}

function rawSig(t, over = {}) {
  return {
    ticker: t, last_close: 99, rsi_2: 10, sma_5: 100, sma_200: 90,
    earnings_within_5d: false, entry_signal: false, ...over,
  };
}

test('runPreview: happy path buckets firing vs watch', async () => {
  const routes = {
    '/api/v1/meanrev/universe': { status: 200, body: { count: 3, universe: ['AAA', 'BBB', 'CCC'] } },
    '/api/v1/meanrev/candidates': { status: 200, body: {
      as_of: 'x', bear_regime: false, bear_mode: 'halfsize',
      candidates: [rawSig('AAA', { rsi_2: 2, entry_signal: true })],
    } },
    '/api/v1/meanrev/signal/BBB': { status: 200, body: rawSig('BBB', { rsi_2: 8 }) },   // watch
    '/api/v1/meanrev/signal/CCC': { status: 200, body: rawSig('CCC', { rsi_2: 50, last_close: 130 }) }, // not watch
  };
  const r = await runPreview({ base: 'http://localhost:4534', fetchImpl: stubFetch(routes) });
  assert.equal(r.bot_ok, true);
  assert.deepEqual(r.firing.map((f) => f.ticker), ['AAA']);
  assert.deepEqual(r.watch.map((w) => w.ticker), ['BBB']);
  assert.equal(r.incomplete.failed, 0);
});

test('runPreview: 422 (insufficient history) is skipped, not a failure', async () => {
  const routes = {
    '/api/v1/meanrev/universe': { status: 200, body: { universe: ['AAA', 'BBB'] } },
    '/api/v1/meanrev/candidates': { status: 200, body: { bear_regime: false, bear_mode: 'halfsize', candidates: [] } },
    '/api/v1/meanrev/signal/AAA': { status: 422, body: { error: 'insufficient history' } },
    '/api/v1/meanrev/signal/BBB': { status: 200, body: rawSig('BBB', { rsi_2: 8 }) },
  };
  const r = await runPreview({ base: 'http://x', fetchImpl: stubFetch(routes) });
  assert.equal(r.incomplete.failed, 0);
  assert.deepEqual(r.watch.map((w) => w.ticker), ['BBB']);
});

test('runPreview: a per-symbol network error lands in incomplete', async () => {
  const routes = {
    '/api/v1/meanrev/universe': { status: 200, body: { universe: ['AAA', 'BBB'] } },
    '/api/v1/meanrev/candidates': { status: 200, body: { bear_regime: false, bear_mode: 'halfsize', candidates: [] } },
    '/api/v1/meanrev/signal/AAA': { status: 200, body: rawSig('AAA', { rsi_2: 8 }) },
    // BBB intentionally absent -> stub throws -> network error
  };
  const r = await runPreview({ base: 'http://x', fetchImpl: stubFetch(routes) });
  assert.equal(r.incomplete.failed, 1);
  assert.deepEqual(r.incomplete.names, ['BBB']);
});

test('runPreview: candidates failure aborts with bot_ok false', async () => {
  const routes = {
    '/api/v1/meanrev/universe': { status: 200, body: { universe: ['AAA'] } },
    '/api/v1/meanrev/candidates': { status: 500, body: { error: 'boom' } },
  };
  const r = await runPreview({ base: 'http://x', fetchImpl: stubFetch(routes) });
  assert.equal(r.bot_ok, false);
  assert.match(r.error, /candidates/);
});

test('runPreview: unreachable bot (universe throws) aborts', async () => {
  const r = await runPreview({ base: 'http://x', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal(r.bot_ok, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/coil-preview.test.mjs`
Expected: FAIL — `runPreview` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/coil-preview.mjs`:

```js
// fetchJson does one GET and normalizes the result. Never throws: a network
// error returns { ok:false, status:0 }.
export async function fetchJson(base, path, fetchImpl = globalThis.fetch) {
  let res;
  try {
    res = await fetchImpl(`${base}${path}`);
  } catch (e) {
    return { ok: false, status: 0, error: e.message, data: null };
  }
  let data = null;
  try { data = await res.json(); } catch { /* leave null on non-JSON */ }
  return { ok: res.ok, status: res.status, data };
}

// runPreview orchestrates the three endpoint reads and returns a report object.
// On a missing universe/candidates endpoint it returns { bot_ok:false, error }.
export async function runPreview({ base, fetchImpl = globalThis.fetch, now = new Date() }) {
  const uni = await fetchJson(base, '/api/v1/meanrev/universe', fetchImpl);
  if (!uni.ok || !uni.data || !Array.isArray(uni.data.universe)) {
    return { bot_ok: false, error: `universe fetch failed (status ${uni.status})` };
  }
  const universe = uni.data.universe;

  const cand = await fetchJson(base, '/api/v1/meanrev/candidates', fetchImpl);
  if (!cand.ok || !cand.data) {
    return { bot_ok: false, error: `candidates fetch failed (status ${cand.status})` };
  }
  const candidatesResp = cand.data;
  const firingSet = new Set((candidatesResp.candidates || []).map((c) => c.ticker));

  const signals = new Map();
  const failed = [];
  for (const ticker of universe) {
    if (firingSet.has(ticker)) continue;
    const r = await fetchJson(base, `/api/v1/meanrev/signal/${ticker}`, fetchImpl);
    if (r.ok && r.data && typeof r.data.rsi_2 === 'number') {
      signals.set(ticker, r.data);
    } else if (r.status === 422) {
      // insufficient history — Coil drops these too; not a failure
    } else {
      failed.push(ticker);
    }
  }

  return assembleReport({ universe, candidatesResp, signals, failed, now });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/coil-preview.test.mjs`
Expected: PASS (Tasks 1–5).

- [ ] **Step 5: Commit**

```bash
git add scripts/coil-preview.mjs scripts/coil-preview.test.mjs
git commit -m "feat(coil-preview): HTTP shell (fetchJson + runPreview)"
```

---

## Task 6: CLI entry point (`main`) + namespaced cache write

**Files:**
- Modify: `scripts/coil-preview.mjs`

This task adds the executable shell. It is verified by a manual smoke run rather
than a unit test (it touches the filesystem and the live bot).

- [ ] **Step 1: Add imports at the very top of `scripts/coil-preview.mjs`**

Insert these import lines immediately under the opening comment block (above the
`export const RSI_ENTRY_MAX` line):

```js
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
```

- [ ] **Step 2: Append `main()` and the CLI guard at the end of `scripts/coil-preview.mjs`**

```js
// resolveBase mirrors agent/server.js: TRADING_BOT_URL, else localhost:PORT.
export function resolveBase(env = process.env) {
  return env.TRADING_BOT_URL || `http://localhost:${env.TRADING_BOT_PORT || '4534'}`;
}

async function main() {
  const base = resolveBase();
  const report = await runPreview({ base });
  if (report.bot_ok === false) {
    console.error(`Coil bot not reachable at ${base} — cannot preview. (${report.error || 'unknown error'})`);
    console.error('If the bot is down, Coil is not trading, so there is nothing to mirror.');
    process.exit(1);
  }
  const dir = path.join(PROJECT_ROOT, 'data', 'coil-preview');
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${report.preview_date_et}.json`), JSON.stringify(report, null, 2), 'utf8');
  } catch (e) {
    console.error(`(warning: could not write cache file: ${e.message})`);
  }
  console.log(renderReport(report));
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked === fileURLToPath(import.meta.url)) {
  main();
}
```

- [ ] **Step 3: Verify the unit tests still pass (no regressions from the new imports)**

Run: `node --test scripts/coil-preview.test.mjs`
Expected: PASS (Tasks 1–5 unchanged). Importing the module must not trigger `main()`
(the CLI guard prevents it).

- [ ] **Step 4: Manual smoke run with the bot up**

Precondition: the Go bot is running (e.g. the fleet is up) and reachable at
`http://localhost:4534`, during or near market hours so signals are meaningful.

Run: `node scripts/coil-preview.mjs`
Expected: a markdown "Coil Scouting Report" prints, with the provisional caveat
header, a regime line, FIRING/WATCH sections, and a JSON file appears at
`data/coil-preview/<today-ET>.json`.

Bot-down check — run with a bad port:
Run (PowerShell): `$env:TRADING_BOT_URL='http://localhost:9'; node scripts/coil-preview.mjs; Remove-Item Env:\TRADING_BOT_URL`
Expected: prints "Coil bot not reachable ..." to stderr and exits non-zero (no crash/stack trace).

- [ ] **Step 5: Commit**

```bash
git add scripts/coil-preview.mjs
git commit -m "feat(coil-preview): CLI entry point + namespaced cache write"
```

---

## Task 7: The `/coil-preview` skill

**Files:**
- Create: `.claude/skills/coil-preview/SKILL.md`

- [ ] **Step 1: Create the skill file**

Create `.claude/skills/coil-preview/SKILL.md`:

```markdown
---
name: coil-preview
description: Pre-close scouting report for the Coil mean-reversion agent. Run a few hours before Coil's 15:45 ET beat to see which large-caps it is likely to buy (FIRING) and which are near (WATCH), with mirror-trade details, so the operator can prepare to mirror Coil's entries in a personal account. Read-only; requires the Go bot running. Use when asked to preview Coil's trades, "what is Coil about to buy", a Coil scouting list/watchlist, or before mirroring Coil in a real brokerage account.
---

# Coil Preview

Read-only advance preview of the Coil agent's likely end-of-day entries, so the
operator can prepare to mirror them manually. Coil itself fires once per trading
day at 15:45 ET; this surfaces its scouting list a few hours early.

## How to run

From the project root:

```
node scripts/coil-preview.mjs
```

The script calls Coil's own HTTP endpoints (`/api/v1/meanrev/universe`,
`/api/v1/meanrev/candidates`, `/api/v1/meanrev/signal/:symbol`) on the running Go
bot (default `http://localhost:4534`; override with `TRADING_BOT_URL`), so the
numbers are byte-for-byte what Coil computes. It prints a ready-to-read markdown
report and writes a JSON copy to `data/coil-preview/<ET-date>.json`.

## Presenting the result

Show the script's markdown output to the operator as-is. It already contains:

- the provisional-read caveat header (names drift before 15:45),
- the SPY bear-regime banner (and a HALT notice when Coil will not enter today),
- the FIRING bucket (likely buys) and the WATCH bucket (near-misses), each with
  per-name margins and a mirror block (entry reference, fill-relative stop rule,
  and the three exit triggers),
- a loud INCOMPLETE warning if any universe name failed to fetch.

If the script exits non-zero with "Coil bot not reachable", tell the operator the
Go bot must be running to preview Coil — and that if it is down, Coil is not
trading, so there is nothing to mirror.

Do not re-derive or second-guess the numbers; they are Coil's own computation. Do
not place any orders — this is a read-only prep tool. The operator executes in
their own brokerage, sizing to their own account, and sets the stop at their
actual fill (× 0.93), not at the provisional preview price.
```

- [ ] **Step 2: Verify the skill is discoverable**

Run: `node -e "const fs=require('fs');const s=fs.readFileSync('.claude/skills/coil-preview/SKILL.md','utf8');if(!/^name: coil-preview$/m.test(s)||!/^description:/m.test(s))throw new Error('frontmatter missing');console.log('SKILL.md frontmatter OK');"`
Expected: prints `SKILL.md frontmatter OK`.

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/coil-preview/SKILL.md
git commit -m "feat(coil-preview): /coil-preview skill"
```

---

## Task 8: Final verification and branch wrap-up

**Files:** none (verification only)

- [ ] **Step 1: Run the full preview test file**

Run: `node --test scripts/coil-preview.test.mjs`
Expected: all tests PASS, 0 failures.

- [ ] **Step 2: Run the repo test suite to confirm no regressions**

Run: `node --test scripts/**/*.test.mjs`
Expected: PASS. (If the shell does not expand the glob on Windows, run the new
file explicitly plus one neighbor, e.g. `node --test scripts/coil-preview.test.mjs scripts/coil-meanrev-signal.test.mjs`.)

- [ ] **Step 3: Live end-to-end smoke (bot up)**

With the Go bot running near market hours: `node scripts/coil-preview.mjs`
Confirm the report renders sensibly and `data/coil-preview/<today>.json` exists
and parses (`node -e "JSON.parse(require('fs').readFileSync('data/coil-preview/'+new Date().toLocaleDateString('en-CA',{timeZone:'America/New_York'})+'.json'))" && echo ok`).
Spot-check: the FIRING tickers in the report match the `candidates` returned by
`curl http://localhost:4534/api/v1/meanrev/candidates` (same names) — confirming
the preview agrees with Coil's own endpoint.

- [ ] **Step 4: Confirm read-only contract**

Confirm by inspection that `scripts/coil-preview.mjs` performs only GET requests
and writes only under `data/coil-preview/` — no order placement, no POST/PUT/DELETE,
no writes to any fleet/agent state.

- [ ] **Step 5: Final commit (if any uncommitted changes remain) and summary**

```bash
git status
```
The branch `coil-preview` now contains: the spec, the script, its tests, and the
skill. Hand back to the operator for the merge decision (squash to local main per
house workflow) and the live eyeball.

---

## Self-Review (completed by plan author)

**Spec coverage:** endpoint-only architecture (Tasks 5–6), FIRING from `/candidates`
+ WATCH from `/signal` with the exact band (Tasks 1, 3, 5), per-name margins +
thin-regime soft-warning (Tasks 1, 3), fill-relative mirror block (Task 2),
bear-regime banner + halt-greyed FIRING (Tasks 2, 4), provisional caveat header
(Task 4), loud INCOMPLETE warning (Tasks 3, 4), WATCH cap (Tasks 1, 3), namespaced
cache (Task 6), read-only contract (Task 8), the skill (Task 7). The deferred items
(auto-schedule, regime-gate overlay) are intentionally out of scope.

**Placeholder scan:** none — every step has complete code or an exact command.

**Type consistency:** field names (`last_close`, `rsi_2`, `sma_5`, `sma_200`,
`earnings_within_5d`, `entry_signal`, `bear_regime`, `bear_mode`, `candidates`)
match the verified endpoint shapes throughout; helper names (`computeMargins`,
`classifyWatch`, `buildMirror`, `buildBanner`, `enrichSignal`, `assembleReport`,
`renderReport`, `fetchJson`, `runPreview`, `resolveBase`, `etDateStr`, `etTimeStr`)
are used consistently across tasks and tests.
```
