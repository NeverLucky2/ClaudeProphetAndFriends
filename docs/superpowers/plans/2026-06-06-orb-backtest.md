# ORB Backtest — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a pre-registered, lab-only intraday Opening-Range-Breakout backtest that decides (on liquid ETFs) whether generic ORB has edge, gated on R-multiple friction-net AND per-name-β market-relative return.

**Architecture:** Node `.mjs` under `scripts/orb-*.mjs`, mirroring the EMA study split (universe → bars → indicators → signal → exitsim → build → marketrel → report → prereg → score → grid). Pure functions unit-tested with `node:test`; CLIs guarded by the `import.meta.url === argv1` idiom. Reuses `coil-threshold-metrics.mjs` (friction, date-block bootstrap), `ema-beta.mjs` (`olsBeta`, `residual`), `coil-eventstudy-build.mjs` (`chronoSplit`), the `ema-prereg.mjs` hash idiom, and the `stage1_backfill_bars.mjs` Alpaca fetch pattern.

**Tech Stack:** Node ≥18 ESM (`node:test`, `node:fs`, `node:crypto`, global `fetch`), Alpaca IEX 5-min bars. No new deps.

**Spec:** `docs/superpowers/specs/2026-06-06-orb-backtest-design.md`

**Commit cadence:** per-task commits during the build; squash to one commit when merging to local main. Lab-only, read-only, no feature flags.

**Locked decision constants (copied into the prereg, Task 9):**
- Opening range = first 15 min (three 5-min bars, ET-start 09:30/09:35/09:40); first trigger-eligible bar = ET-start 09:45; entry fills at the NEXT bar's open.
- Stop = OR opposite side; exit = session's last RTH bar close; no profit target (primary).
- Gated metric = **R-multiple**; friction round-trip bps ETF 1/2/**5**… decision **2**; large-cap 5/**10**/20 decision **10** (large-cap is exploratory only).
- Benchmark SPY; per-name intraday β (OLS train 5-min returns, frozen). `gate_net` over ETF cut (SPY/QQQ/IWM/DIA); `gate_mktrel` over ETF cut **ex-SPY** (QQQ/IWM/DIA).
- Split chronological 50/50; bootstrap date-block 15 sessions, 10000 iters, seed 1234; power floor 200 trades & 100 distinct dates.
- RTH minute-of-day: ET 09:30 = 570; OR = [570,585); trigger-eligible ≥ 585; RTH = [570,960).

---

## Task 1: ORB universe

**Files:** Create `scripts/orb-universe.mjs`; Test `scripts/orb-universe.test.mjs`.

- [ ] **Step 1: Failing test**
```js
// scripts/orb-universe.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ORB_ETF_UNIVERSE, ORB_LARGECAP_EXPLORATORY, BENCHMARK, gatedMktrelTickers, allOrbTickers } from './orb-universe.mjs';

test('ETF cut is the four liquid index ETFs', () => {
  assert.deepEqual([...ORB_ETF_UNIVERSE].sort(), ['DIA', 'IWM', 'QQQ', 'SPY']);
});
test('large-cap cut is exploratory momentum names', () => {
  for (const t of ['AAPL', 'NVDA', 'TSLA', 'AMD', 'META']) assert.ok(ORB_LARGECAP_EXPLORATORY.includes(t));
});
test('benchmark is SPY; gate_mktrel excludes SPY', () => {
  assert.equal(BENCHMARK, 'SPY');
  assert.deepEqual([...gatedMktrelTickers()].sort(), ['DIA', 'IWM', 'QQQ']);
});
test('allOrbTickers unions ETF + largecap + benchmark, deduped', () => {
  const a = allOrbTickers();
  assert.equal(new Set(a).size, a.length);
  assert.ok(a.includes('SPY') && a.includes('AAPL'));
});
```
- [ ] **Step 2: Run → FAIL** `node --test "<wt>/scripts/orb-universe.test.mjs"` (module not found).
- [ ] **Step 3: Implement**
```js
// scripts/orb-universe.mjs
// ORB study universes. The ETF cut is the SOLE gated/decision universe (no selection on the
// tested behavior). The large-cap cut is EXPLORATORY ONLY — those names are selected on the
// dependent variable (today's momentum names), so they flatter ORB and never gate the verdict.
export const ORB_ETF_UNIVERSE = ['SPY', 'QQQ', 'IWM', 'DIA'];
export const ORB_LARGECAP_EXPLORATORY = ['AAPL', 'NVDA', 'TSLA', 'AMD', 'META'];
export const BENCHMARK = 'SPY';
// gate_mktrel excludes SPY (SPY-hedged-against-SPY ≈ 0 by construction).
export function gatedMktrelTickers() { return ORB_ETF_UNIVERSE.filter(t => t !== BENCHMARK); }
export function allOrbTickers() {
  return [...new Set([...ORB_ETF_UNIVERSE, ...ORB_LARGECAP_EXPLORATORY, BENCHMARK])];
}
```
- [ ] **Step 4: Run → PASS** (4 tests).
- [ ] **Step 5: Commit**
```bash
git -C "<wt>" add scripts/orb-universe.mjs scripts/orb-universe.test.mjs
git -C "<wt>" commit -m "feat(orb): study universes (gated ETF cut + exploratory large-cap)"
```

---

## Task 2: Intraday bars — ET session helper, loader, Alpaca 5Min fetch

**Files:** Create `scripts/orb-bars.mjs`, `scripts/orb-fetch-bars.mjs`; Test `scripts/orb-bars.test.mjs`.

The ET minute-of-day + session-date are the off-by-one danger zone, so they are unit-tested directly. `etParts(iso)` returns `{ date:'YYYY-MM-DD', minutes }` (minutes since ET midnight, DST-correct). `toSessionBars(rawBars)` filters to RTH `[570,960)` and groups into `{ date, bars:[{minutes,open,high,low,close,volume}] }` ascending. `loadOrbSessions(root,ticker)` reads the lab cache.

- [ ] **Step 1: Failing test**
```js
// scripts/orb-bars.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { etParts, toSessionBars, loadOrbSessions } from './orb-bars.mjs';

test('etParts converts an EST 14:30Z bar to 09:30 ET = minute 570', () => {
  const p = etParts('2020-01-02T14:30:00Z');
  assert.equal(p.date, '2020-01-02');
  assert.equal(p.minutes, 570);
});
test('etParts handles EDT (13:30Z = 09:30 ET in summer)', () => {
  assert.equal(etParts('2020-07-01T13:30:00Z').minutes, 570);
});
test('toSessionBars keeps RTH only, groups by ET date, sorts ascending', () => {
  const raw = [
    { Timestamp: '2020-01-02T14:00:00Z', Open: 1, High: 1, Low: 1, Close: 1, Volume: 9 }, // 09:00 ET pre-market → dropped
    { Timestamp: '2020-01-02T14:30:00Z', Open: 2, High: 3, Low: 1, Close: 2.5, Volume: 10 }, // 09:30 ET kept
    { Timestamp: '2020-01-02T20:55:00Z', Open: 5, High: 6, Low: 4, Close: 5, Volume: 11 }, // 15:55 ET kept
    { Timestamp: '2020-01-02T21:00:00Z', Open: 9, High: 9, Low: 9, Close: 9, Volume: 1 }, // 16:00 ET → dropped (>=960)
  ];
  const s = toSessionBars(raw);
  assert.equal(s.length, 1);
  assert.equal(s[0].date, '2020-01-02');
  assert.deepEqual(s[0].bars.map(b => b.minutes), [570, 955]);
});
test('loadOrbSessions reads {bars:[...]} from the lab cache', () => {
  const root = mkdtempSync(join(tmpdir(), 'orb-'));
  mkdirSync(join(root, 'data', 'lab', 'orb-bar-cache'), { recursive: true });
  writeFileSync(join(root, 'data', 'lab', 'orb-bar-cache', 'SPY.json'), JSON.stringify({ bars: [
    { Timestamp: '2020-01-02T14:30:00Z', Open: 2, High: 3, Low: 1, Close: 2.5, Volume: 10 },
  ] }));
  const s = loadOrbSessions(root, 'SPY');
  assert.equal(s[0].bars[0].close, 2.5);
});
```
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**
```js
// scripts/orb-bars.mjs
// Session-aware intraday loader for the ORB study. Bars keyed by ET minute-of-day so the
// opening-range / entry-trigger boundaries are unambiguous. RTH = [09:30, 16:00) ET.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const RTH_OPEN = 570;   // 09:30 ET in minutes
export const RTH_CLOSE = 960;  // 16:00 ET
export const OR_END = 585;     // 09:45 ET (OR = [570,585) = three 5-min bars)
export const ORB_CACHE_SUBDIR = join('data', 'lab', 'orb-bar-cache');

const ET = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});
export function etParts(iso) {
  const p = {}; for (const x of ET.formatToParts(new Date(iso))) p[x.type] = x.value;
  let hh = parseInt(p.hour, 10); if (hh === 24) hh = 0; // Intl can emit 24 for midnight
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: hh * 60 + parseInt(p.minute, 10) };
}

export function toSessionBars(rawBars) {
  const byDate = new Map();
  for (const b of rawBars) {
    const ts = b.Timestamp || b.timestamp; if (!ts) continue;
    const { date, minutes } = etParts(ts);
    if (minutes < RTH_OPEN || minutes >= RTH_CLOSE) continue;
    const bar = { minutes, open: b.Open ?? b.open, high: b.High ?? b.high, low: b.Low ?? b.low, close: b.Close ?? b.close, volume: b.Volume ?? b.volume };
    if (!Number.isFinite(bar.open) || !Number.isFinite(bar.close)) continue;
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(bar);
  }
  const out = [];
  for (const [date, bars] of byDate) { bars.sort((a, b) => a.minutes - b.minutes); out.push({ date, bars }); }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

export function loadOrbSessions(projectRoot, ticker) {
  const path = join(projectRoot, ORB_CACHE_SUBDIR, `${ticker.toUpperCase()}.json`);
  let obj; try { obj = JSON.parse(readFileSync(path, 'utf8')); } catch { return []; }
  return toSessionBars(Array.isArray(obj) ? obj : (obj.bars || []));
}
```
- [ ] **Step 4: Run → PASS** (4 tests).
- [ ] **Step 5: Fetch CLI (no unit test — network; mirrors `stage1_backfill_bars.mjs` exactly, only `timeframe` differs)**
```js
// scripts/orb-fetch-bars.mjs
// Backfill Alpaca IEX 5-min bars → data/lab/orb-bar-cache/{TICKER}.json. Creds from root .env.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ORB_CACHE_SUBDIR } from './orb-bars.mjs';
import { allOrbTickers } from './orb-universe.mjs';

const START = '2016-01-01', END = new Date().toISOString().slice(0, 10);
function creds() {
  const env = readFileSync('.env', 'utf8'); const m = {};
  for (const line of env.split(/\r?\n/)) { const mm = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/); if (mm) m[mm[1]] = mm[2].trim().replace(/^["']|["']$/g, ''); }
  return { id: m.ALPACA_PUBLIC_KEY || m.ALPACA_API_KEY, sec: m.ALPACA_SECRET_KEY || m.ALPACA_API_SECRET };
}
async function fetchBars(sym, id, sec) {
  const headers = { 'APCA-API-KEY-ID': id, 'APCA-API-SECRET-KEY': sec };
  let token = null; const out = [];
  for (let page = 0; page < 2000; page += 1) {
    const q = new URLSearchParams({ timeframe: '5Min', start: START, end: END, adjustment: 'all', limit: '10000', feed: 'iex' });
    if (token) q.set('page_token', token);
    const r = await fetch(`https://data.alpaca.markets/v2/stocks/${encodeURIComponent(sym)}/bars?${q}`, { headers });
    if (!r.ok) throw new Error(`${sym}: HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
    const j = await r.json();
    for (const b of (j.bars || [])) out.push({ Timestamp: b.t, Open: b.o, High: b.h, Low: b.l, Close: b.c, Volume: b.v });
    token = j.next_page_token; if (!token) break;
  }
  return out;
}
{
  const { id, sec } = creds();
  if (!id || !sec) { console.error('missing Alpaca creds in .env'); process.exit(1); }
  mkdirSync(join(process.cwd(), ORB_CACHE_SUBDIR), { recursive: true });
  for (const sym of allOrbTickers()) {
    try { const bars = await fetchBars(sym, id, sec);
      writeFileSync(join(process.cwd(), ORB_CACHE_SUBDIR, `${sym}.json`), JSON.stringify({ written_at: new Date().toISOString(), bars }));
      console.log(`${sym}: ${bars.length} 5-min bars`);
    } catch (e) { console.log(`${sym}: ${e.message}`); }
    await new Promise(r => setTimeout(r, 350));
  }
}
```
- [ ] **Step 6: `node --check "<wt>/scripts/orb-fetch-bars.mjs"` → exit 0. Commit**
```bash
git -C "<wt>" add scripts/orb-bars.mjs scripts/orb-fetch-bars.mjs scripts/orb-bars.test.mjs
git -C "<wt>" commit -m "feat(orb): ET session-aware intraday loader + Alpaca 5Min backfill"
```

---

## Task 3: Session VWAP

**Files:** Create `scripts/orb-indicators.mjs`; Test `scripts/orb-indicators.test.mjs`.

- [ ] **Step 1: Failing test**
```js
// scripts/orb-indicators.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionVWAP } from './orb-indicators.mjs';

const approx = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) <= e, `${a} ≈ ${b}`);

test('sessionVWAP is cumulative Σ(tp·vol)/Σ(vol), aligned to bars', () => {
  const bars = [
    { high: 10, low: 10, close: 10, volume: 100 }, // tp 10
    { high: 12, low: 12, close: 12, volume: 300 }, // tp 12
  ];
  const v = sessionVWAP(bars);
  approx(v[0], 10);
  approx(v[1], (10 * 100 + 12 * 300) / 400); // 11.5
});
test('zero-volume bars do not divide-by-zero (carry prior vwap)', () => {
  const bars = [{ high: 5, low: 5, close: 5, volume: 0 }];
  assert.ok(Number.isFinite(sessionVWAP(bars)[0]));
});
```
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**
```js
// scripts/orb-indicators.mjs
// Session VWAP for the ORB study: cumulative Σ(typical_price·vol)/Σ(vol) from the RTH open,
// aligned to the session bars. A volume-weighted ratio is robust to IEX undersampling.
export function sessionVWAP(bars) {
  const out = new Array(bars.length).fill(null);
  let pv = 0, vv = 0, last = null;
  for (let i = 0; i < bars.length; i += 1) {
    const tp = (bars[i].high + bars[i].low + bars[i].close) / 3;
    const vol = bars[i].volume || 0;
    pv += tp * vol; vv += vol;
    out[i] = vv > 0 ? pv / vv : (last ?? tp);
    last = out[i];
  }
  return out;
}
```
- [ ] **Step 4: Run → PASS** (2 tests).
- [ ] **Step 5: Commit**
```bash
git -C "<wt>" add scripts/orb-indicators.mjs scripts/orb-indicators.test.mjs
git -C "<wt>" commit -m "feat(orb): session VWAP (cumulative, IEX-robust ratio)"
```

---

## Task 4: ORB signal — OR, VWAP-aligned close-break, next-bar-open entry

**Files:** Create `scripts/orb-signal.mjs`; Test `scripts/orb-signal.test.mjs`.

`orbSignal(sessionBars)` returns `null` (no trade) or `{ direction, triggerMinutes, entryMinutes, entryFill, stop, orHigh, orLow }`. The OR uses bars with `minutes ∈ [570,585)`. The first bar with `minutes ≥ 585` whose close breaks the OR AND is VWAP-aligned is the trigger; **entry fills at the NEXT bar's open**. No entry if the trigger is the last bar.

- [ ] **Step 1: Failing test**
```js
// scripts/orb-signal.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orbSignal } from './orb-signal.mjs';

// helper: build a session with three OR bars then post-OR bars
function session(orBars, postBars) {
  const bars = [];
  const mins = [570, 575, 580];
  orBars.forEach((b, i) => bars.push({ minutes: mins[i], ...b }));
  let m = 585;
  for (const b of postBars) { bars.push({ minutes: m, ...b }); m += 5; }
  return { date: '2020-01-02', bars };
}
const flat = (c, v = 100) => ({ open: c, high: c, low: c, close: c, volume: v });

test('long: close breaks OR high + above VWAP → fills at NEXT bar open', () => {
  const s = session(
    [flat(100), flat(100), flat(100)],            // OR = [100,100]
    [{ open: 100, high: 101.5, low: 100, close: 101, volume: 100 }, // trigger: close 101 > 100, > vwap
     { open: 101.2, high: 102, low: 101, close: 101.8, volume: 100 }], // entry fills here at open 101.2
  );
  const sig = orbSignal(s);
  assert.equal(sig.direction, 1);
  assert.equal(sig.triggerMinutes, 585);
  assert.equal(sig.entryMinutes, 590);
  assert.equal(sig.entryFill, 101.2);   // next bar OPEN, not the trigger close
  assert.equal(sig.stop, 100);          // OR low
});

test('no trade when no post-OR close breaks the range', () => {
  const s = session([flat(100), flat(100), flat(100)], [flat(100), flat(100)]);
  assert.equal(orbSignal(s), null);
});

test('VWAP filter rejects a break that is on the wrong side of VWAP', () => {
  // huge early up-volume pulls VWAP above a marginal high-break close → long rejected
  const s = session(
    [{ open: 100, high: 105, low: 100, close: 105, volume: 100000 }, flat(100), flat(100)],
    [{ open: 100, high: 100.6, low: 100, close: 100.5, volume: 1 }, flat(100.5)],
  );
  assert.equal(orbSignal(s), null); // close 100.5 > OR high 100 but < session VWAP (~104) → no long
});

test('no entry if the trigger is the last bar of the session', () => {
  const s = session([flat(100), flat(100), flat(100)], [{ open: 100, high: 102, low: 100, close: 101, volume: 100 }]);
  assert.equal(orbSignal(s), null);
});
```
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**
```js
// scripts/orb-signal.mjs
// Mechanical ORB signal: 15-min opening range, first VWAP-aligned close-break after 09:45,
// entry FILLED at the next bar's open (the breakout is only confirmed at the trigger close).
import { OR_END } from './orb-bars.mjs';
import { sessionVWAP } from './orb-indicators.mjs';

export function orbSignal(sessionBars) {
  const bars = sessionBars.bars;
  const orBars = bars.filter(b => b.minutes < OR_END);
  if (orBars.length < 3) return null; // need the full opening range
  const orHigh = Math.max(...orBars.map(b => b.high));
  const orLow = Math.min(...orBars.map(b => b.low));
  const vwap = sessionVWAP(bars);
  for (let i = 0; i < bars.length; i += 1) {
    if (bars[i].minutes < OR_END) continue;            // only post-OR bars trigger
    const c = bars[i].close;
    let dir = 0;
    if (c > orHigh && c > vwap[i]) dir = 1;
    else if (c < orLow && c < vwap[i]) dir = -1;
    if (!dir) continue;
    if (i + 1 >= bars.length) return null;              // no next bar to fill on
    const entry = bars[i + 1].open;
    return {
      direction: dir, triggerMinutes: bars[i].minutes, entryMinutes: bars[i + 1].minutes,
      entryFill: entry, stop: dir === 1 ? orLow : orHigh, orHigh, orLow,
    };
  }
  return null;
}
```
- [ ] **Step 4: Run → PASS** (4 tests).
- [ ] **Step 5: Commit**
```bash
git -C "<wt>" add scripts/orb-signal.mjs scripts/orb-signal.test.mjs
git -C "<wt>" commit -m "feat(orb): OR + VWAP-aligned close-break signal, next-bar-open entry"
```

---

## Task 5: Exit sim — gap-honest stop + EOD, R-multiple

**Files:** Create `scripts/orb-exitsim.mjs`; Test `scripts/orb-exitsim.test.mjs`.

`simulateOrbTrade(sessionBars, signal)` walks bars from the entry bar (inclusive) to the session's last bar. Stop is a gap-honest market exit; if untouched, exit at the last RTH bar's close (handles half-days — "last bar" is whatever the session actually has). Returns `{ entry, exit, exitReason, direction, R, rMultiple, retPct, entryMinutes, exitMinutes }` where `R = |entry − stop|`, `rMultiple = direction·(exit−entry)/R`, `retPct = direction·(exit−entry)/entry`.

- [ ] **Step 1: Failing test**
```js
// scripts/orb-exitsim.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulateOrbTrade } from './orb-exitsim.mjs';

const approx = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) <= e, `${a} ≈ ${b}`);
function sess(bars) { return { date: 'd', bars }; }
// entry filled at the bar tagged entryMinutes; signal carries entryFill + stop.

test('long stops out gap-honest; R-multiple ≈ -1 on a clean stop', () => {
  const bars = [
    { minutes: 590, open: 101, high: 101.5, low: 100.9, close: 101 }, // entry bar, entryFill 101
    { minutes: 595, open: 100.2, high: 100.3, low: 99.5, close: 99.8 }, // low 99.5 ≤ stop 100 → stop
  ];
  const sig = { direction: 1, entryMinutes: 590, entryFill: 101, stop: 100 };
  const t = simulateOrbTrade(sess(bars), sig);
  assert.equal(t.exitReason, 'stop');
  approx(t.exit, 100);                 // intrabar touch fills at stop
  approx(t.R, 1);
  approx(t.rMultiple, (100 - 101) / 1); // -1
});

test('long gap-through stop fills at the bar open (worse than stop)', () => {
  const bars = [
    { minutes: 590, open: 101, high: 101, low: 101, close: 101 },
    { minutes: 595, open: 99, high: 99, low: 98, close: 98 },  // opens below stop 100
  ];
  const sig = { direction: 1, entryMinutes: 590, entryFill: 101, stop: 100 };
  const t = simulateOrbTrade(sess(bars), sig);
  assert.equal(t.exitReason, 'stop');
  approx(t.exit, 99);                  // gap-through → open
});

test('EOD exit at last bar close when stop never hit; positive R on a winner', () => {
  const bars = [
    { minutes: 590, open: 101, high: 101, low: 101, close: 101 },
    { minutes: 955, open: 104, high: 105, low: 103.9, close: 104.5 }, // last bar
  ];
  const sig = { direction: 1, entryMinutes: 590, entryFill: 101, stop: 100 };
  const t = simulateOrbTrade(sess(bars), sig);
  assert.equal(t.exitReason, 'eod');
  approx(t.exit, 104.5);
  approx(t.rMultiple, (104.5 - 101) / 1); // +3.5R
});

test('short winner: positive R when price falls to EOD', () => {
  const bars = [
    { minutes: 590, open: 99, high: 99, low: 99, close: 99 },
    { minutes: 955, open: 97, high: 97.5, low: 96, close: 96.5 },
  ];
  const sig = { direction: -1, entryMinutes: 590, entryFill: 99, stop: 100 }; // R=1
  const t = simulateOrbTrade(sess(bars), sig);
  assert.equal(t.exitReason, 'eod');
  approx(t.rMultiple, (-1) * (96.5 - 99) / 1); // +2.5R
});
```
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**
```js
// scripts/orb-exitsim.mjs
// ORB exit: gap-honest market stop, else exit at the session's last bar close (half-day safe).
// R-multiple is the primary unit; retPct reported alongside.

export function simulateOrbTrade(sessionBars, sig) {
  const bars = sessionBars.bars;
  const start = bars.findIndex(b => b.minutes === sig.entryMinutes);
  const entry = sig.entryFill, stop = sig.stop, dir = sig.direction;
  const R = Math.abs(entry - stop);
  const finish = (exit, reason, minutes) => ({
    entry, exit, exitReason: reason, direction: dir, R,
    rMultiple: R > 0 ? (dir * (exit - entry)) / R : 0,
    retPct: dir * (exit - entry) / entry,
    entryMinutes: sig.entryMinutes, exitMinutes: minutes,
  });
  for (let j = start; j < bars.length; j += 1) {
    const b = bars[j];
    const stopHit = dir === 1 ? b.low <= stop : b.high >= stop;
    if (stopHit) {
      const fill = dir === 1 ? Math.min(b.open, stop) : Math.max(b.open, stop); // gap-through → open
      return finish(fill, 'stop', b.minutes);
    }
    if (j === bars.length - 1) return finish(b.close, 'eod', b.minutes);
  }
  // unreachable when start is valid; defensive:
  const last = bars[bars.length - 1];
  return finish(last.close, 'eod', last.minutes);
}
```
- [ ] **Step 4: Run → PASS** (4 tests).
- [ ] **Step 5: Commit**
```bash
git -C "<wt>" add scripts/orb-exitsim.mjs scripts/orb-exitsim.test.mjs
git -C "<wt>" commit -m "feat(orb): gap-honest stop + EOD exit, R-multiple metric"
```

---

## Task 6: Build — one trade per session, chrono split, CLI

**Files:** Create `scripts/orb-build.mjs`; Test `scripts/orb-build.test.mjs`.

`enumerateOrbTrades(sessions, ticker, cut)` → one trade per session that produces a signal, each `{ ticker, cut, date, ...trade }`. CLI loads both cuts, chrono-splits (reuse `chronoSplit`), writes `data/lab/orb-instances.json`, prints counts + an entry-time histogram.

- [ ] **Step 1: Failing test**
```js
// scripts/orb-build.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enumerateOrbTrades } from './orb-build.mjs';

const flat = (c, v = 100) => ({ open: c, high: c, low: c, close: c, volume: v });
function day(date) {
  return { date, bars: [
    { minutes: 570, ...flat(100) }, { minutes: 575, ...flat(100) }, { minutes: 580, ...flat(100) },
    { minutes: 585, open: 100, high: 101.5, low: 100, close: 101, volume: 100 }, // break up
    { minutes: 590, open: 101.2, high: 101.2, low: 101.2, close: 101.2, volume: 100 }, // entry fill
    { minutes: 955, ...flat(102) }, // EOD winner
  ] };
}

test('one trade per signalling session, tagged with ticker/cut/date', () => {
  const trades = enumerateOrbTrades([day('2020-01-02'), day('2020-01-03')], 'QQQ', 'etf');
  assert.equal(trades.length, 2);
  for (const t of trades) {
    assert.equal(t.ticker, 'QQQ'); assert.equal(t.cut, 'etf');
    assert.equal(t.direction, 1); assert.ok(t.rMultiple > 0);
    assert.ok(t.entryMinutes === 590);
  }
});
```
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**
```js
// scripts/orb-build.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { orbSignal } from './orb-signal.mjs';
import { simulateOrbTrade } from './orb-exitsim.mjs';
import { loadOrbSessions } from './orb-bars.mjs';
import { ORB_ETF_UNIVERSE, ORB_LARGECAP_EXPLORATORY } from './orb-universe.mjs';
import { chronoSplit } from './coil-eventstudy-build.mjs';

export function enumerateOrbTrades(sessions, ticker, cut) {
  const out = [];
  for (const s of sessions) {
    const sig = orbSignal(s);
    if (!sig) continue;
    const t = simulateOrbTrade(s, sig);
    out.push({ ticker, cut, date: s.date, ...t });
  }
  return out;
}

// CLI: node scripts/orb-build.mjs [--out data/lab/orb-instances.json]
{
  const argv1 = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (fileURLToPath(import.meta.url) === argv1) {
    const args = process.argv.slice(2);
    const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
    const root = process.cwd();
    const rows = [];
    for (const [cut, uni] of [['etf', ORB_ETF_UNIVERSE], ['largecap', ORB_LARGECAP_EXPLORATORY]]) {
      for (const t of uni) for (const tr of enumerateOrbTrades(loadOrbSessions(root, t), t, cut)) rows.push(tr);
    }
    const { all } = chronoSplit(rows);
    const out = flag('--out', join(root, 'data', 'lab', 'orb-instances.json'));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(all, null, 2));
    const hist = {}; for (const r of rows) hist[r.entryMinutes] = (hist[r.entryMinutes] || 0) + 1;
    process.stdout.write(JSON.stringify({ out, trades: rows.length, entry_minute_hist: hist }, null, 2) + '\n');
  }
}
```
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit**
```bash
git -C "<wt>" add scripts/orb-build.mjs scripts/orb-build.test.mjs
git -C "<wt>" commit -m "feat(orb): one-trade-per-session enumeration + build CLI"
```

---

## Task 7: Market-relative — SPY window return (open→close) + per-trade R helpers

**Files:** Create `scripts/orb-marketrel.mjs`; Test `scripts/orb-marketrel.test.mjs`.

`spyWindowReturn(spyByKey, date, entryMinutes, exitMinutes)` = `spyClose@exit / spyOpen@entry − 1` (entry is an open, exit is a close — must match the trade's fills). `netR(trade, frictionBps)` and `mktRelR(trade, frictionBps, beta, spyWindowRet)` convert to R-units. Reuses `ema-beta.residual` for the sign-aware hedge.

- [ ] **Step 1: Failing test**
```js
// scripts/orb-marketrel.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spyWindowReturn, netR, mktRelR } from './orb-marketrel.mjs';

const approx = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) <= e, `${a} ≈ ${b}`);

test('spyWindowReturn uses open@entry and close@exit on the same date', () => {
  const spy = new Map([['d|590', { open: 400, close: 400 }], ['d|955', { open: 404, close: 404 }]]);
  approx(spyWindowReturn(spy, 'd', 590, 955), 404 / 400 - 1);
});
test('netR subtracts friction in R-units (friction%/Rpct)', () => {
  const trade = { entry: 100, R: 1, rMultiple: 2, retPct: 0.02, direction: 1 };
  const Rpct = 1 / 100; // 0.01
  approx(netR(trade, 20), 2 - (20 / 10000) / Rpct); // 2 - 0.002/0.01 = 1.8
});
test('mktRelR hedges sign-aware then converts to R-units', () => {
  const trade = { entry: 100, R: 1, retPct: 0.02, direction: 1 };
  const Rpct = 0.01;
  // residual% = 0.02 - 1*1.0*0.012 = 0.008 ; net of 20bps = 0.006 ; /Rpct = 0.6
  approx(mktRelR(trade, 20, 1.0, 0.012), (0.02 - 1 * 1.0 * 0.012 - 20 / 10000) / Rpct);
});
```
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**
```js
// scripts/orb-marketrel.mjs
// Per-trade R-unit conversions for the ORB gates. SPY window return matches the trade's fills
// (entry = open, exit = close). Market-relative uses a per-name sign-aware hedge (ema-beta).
import { residual } from './ema-beta.mjs';

export function spyWindowReturn(spyByKey, date, entryMinutes, exitMinutes) {
  const a = spyByKey.get(`${date}|${entryMinutes}`), b = spyByKey.get(`${date}|${exitMinutes}`);
  if (!a || !b) return null;
  return b.close / a.open - 1;
}

export function netR(trade, frictionBps) {
  const Rpct = trade.R / trade.entry;
  if (Rpct <= 0) return null;
  return trade.rMultiple - (frictionBps / 10000) / Rpct;
}

export function mktRelR(trade, frictionBps, beta, spyWindowRet) {
  const Rpct = trade.R / trade.entry;
  if (Rpct <= 0 || spyWindowRet == null) return null;
  const relPct = residual(trade.retPct, { direction: trade.direction, beta, benchRet: spyWindowRet });
  return (relPct - frictionBps / 10000) / Rpct;
}
```
- [ ] **Step 4: Run → PASS** (3 tests).
- [ ] **Step 5: Commit**
```bash
git -C "<wt>" add scripts/orb-marketrel.mjs scripts/orb-marketrel.test.mjs
git -C "<wt>" commit -m "feat(orb): SPY window-return + R-unit net/market-relative helpers"
```

---

## Task 8: Report helpers — drop-top-N, edge-by-hour

**Files:** Create `scripts/orb-report.mjs`; Test `scripts/orb-report.test.mjs`.

`dropTopN(values, n)` returns the mean after removing the n largest (robustness to trend-day winners). `edgeByHour(rows)` groups `{entryMinutes, r}` into ET hour buckets → `{hour, n, mean}`.

- [ ] **Step 1: Failing test**
```js
// scripts/orb-report.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropTopN, edgeByHour } from './orb-report.mjs';

const approx = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) <= e, `${a} ≈ ${b}`);

test('dropTopN removes the n largest before averaging', () => {
  approx(dropTopN([1, 1, 1, 100], 1), 1);          // drop the 100
  approx(dropTopN([1, 2, 3], 0), 2);
});
test('edgeByHour buckets by ET hour from minutes-of-day', () => {
  const rows = [{ entryMinutes: 590, r: 1 }, { entryMinutes: 595, r: 3 }, { entryMinutes: 840, r: -1 }];
  const e = edgeByHour(rows);
  const h9 = e.find(x => x.hour === 9); const h14 = e.find(x => x.hour === 14);
  assert.equal(h9.n, 2); approx(h9.mean, 2);
  assert.equal(h14.n, 1); approx(h14.mean, -1);
});
```
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**
```js
// scripts/orb-report.mjs
// Pure decision-informing report helpers for the ORB study (robustness + intraday texture).
import { mean } from './coil-threshold-metrics.mjs';

export function dropTopN(values, n) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const kept = n > 0 ? s.slice(0, Math.max(0, s.length - n)) : s;
  return mean(kept);
}

export function edgeByHour(rows) {
  const by = {};
  for (const r of rows) { const h = Math.floor(r.entryMinutes / 60); (by[h] ||= []).push(r.r); }
  return Object.keys(by).map(Number).sort((a, b) => a - b)
    .map(h => ({ hour: h, n: by[h].length, mean: mean(by[h]) }));
}
```
- [ ] **Step 4: Run → PASS** (2 tests).
- [ ] **Step 5: Commit**
```bash
git -C "<wt>" add scripts/orb-report.mjs scripts/orb-report.test.mjs
git -C "<wt>" commit -m "feat(orb): drop-top-N + edge-by-hour report helpers"
```

---

## Task 9: Hash-locked pre-registration

**Files:** Create `scripts/orb-prereg.mjs`; Test `scripts/orb-prereg.test.mjs`.

Mirror `ema-prereg.mjs` exactly (reuse `sha256short` from `coil-eventstudy-prereg.mjs` + the `stable()` serializer). Encode the locked ORB config + gates.

- [ ] **Step 1: Failing test**
```js
// scripts/orb-prereg.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOrbPrereg, verifyOrbPrereg } from './orb-prereg.mjs';

test('prereg hashes stably and verifies; expected outcome uncertain', () => {
  const a = buildOrbPrereg({ trainN: 100, holdoutN: 100, createdUtc: '2026-06-06T00:00:00Z' });
  assert.equal(verifyOrbPrereg(a).ok, true);
  assert.equal(a.expected_outcome, 'UNCERTAIN');
  assert.equal(a.gated_metric, 'r_multiple');
});
test('tampering breaks the hash', () => {
  const a = buildOrbPrereg({ trainN: 1, holdoutN: 1, createdUtc: '2026-06-06T00:00:00Z' });
  a.primary.or_minutes = 5;
  assert.equal(verifyOrbPrereg(a).ok, false);
});
```
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** (copy the structure of `scripts/ema-prereg.mjs` — same imports, `stable()`, self-hash, and CLI; substitute this artifact body)
```js
// scripts/orb-prereg.mjs  (imports + stable() + verify + CLI identical in shape to ema-prereg.mjs)
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256short } from './coil-eventstudy-prereg.mjs';

function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter(k => k !== 'artifact_hash').map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export function buildOrbPrereg({ trainN, holdoutN, createdUtc }) {
  const a = {
    prereg_version: '1.0',
    created_utc: createdUtc ?? new Date().toISOString(),
    hypothesis: 'a daily-bar-free generic ORB on liquid ETFs has uncertain net + market-relative edge',
    primary: { or_minutes: 15, entry: 'next_bar_open', stop: 'or_opposite', exit: 'eod', target: 'none', vwap_filter: true, volume_filter: false },
    gated_metric: 'r_multiple',
    grid_train_only: { or_minutes: [5, 30], target: ['1R', '2R'], ema21_filter: [true], vwap_filter: [false], breakout_buffer_or_frac: [0.05] },
    friction_bps: { etf: { optimistic: 1, representative: 2, stress: 5, decision: 2 }, largecap: { optimistic: 5, central: 10, stress: 20, decision: 10 } },
    benchmark: 'SPY',
    beta: 'per-name OLS on TRAIN 5-min RTH returns vs SPY, frozen',
    bootstrap: { method: 'date_block', block_sessions: 15, iterations: 10000, seed: 1234, ci_pct: [2.5, 97.5] },
    decision_rule: {
      gate_net: 'holdout friction-net R-multiple 95% CI lo > 0 over ETF cut',
      gate_mktrel: 'holdout per-name-beta market-relative R-multiple 95% CI lo > 0 over ETF cut EX-SPY',
      gate_robust: 'both positive on train',
      verdict: 'KEEP-CANDIDATE iff all three else REJECT; UNDERPOWERED if holdout trades < 200 or distinct dates < 100',
    },
    power_floor: { trades: 200, distinct_dates: 100 },
    decision_universe: ['SPY', 'QQQ', 'IWM', 'DIA'],
    largecap_exploratory: ['AAPL', 'NVDA', 'TSLA', 'AMD', 'META'],
    iex_caveat: 'IEX inward-OR bias flatters ORB; any KEEP must be re-confirmed on SIP',
    split: 'chronological 50/50',
    counts: { train_n: trainN, holdout_n: holdoutN },
    expected_outcome: 'UNCERTAIN',
  };
  a.artifact_hash = sha256short(stable(a));
  return a;
}
export function verifyOrbPrereg(a) { const expected = sha256short(stable(a)); return { ok: expected === a.artifact_hash, expected, found: a.artifact_hash }; }

{
  const argv1 = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (fileURLToPath(import.meta.url) === argv1) {
    const args = process.argv.slice(2); const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
    const inst = JSON.parse(readFileSync(flag('--instances', 'data/lab/orb-instances.json'), 'utf8'));
    const a = buildOrbPrereg({ trainN: inst.filter(r => r.split === 'train').length, holdoutN: inst.filter(r => r.split === 'holdout').length });
    const out = flag('--out', 'data/lab/orb-prereg.json');
    mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(a, null, 2));
    process.stdout.write(`wrote ${out} (hash ${a.artifact_hash})\n`);
  }
}
```
- [ ] **Step 4: Run → PASS** (2 tests). Also `node --check`.
- [ ] **Step 5: Commit**
```bash
git -C "<wt>" add scripts/orb-prereg.mjs scripts/orb-prereg.test.mjs
git -C "<wt>" commit -m "feat(orb): hash-locked pre-registration (R-multiple dual gates)"
```

---

## Task 10: Score — R-multiple gates, per-name β, RESULTS render

**Files:** Create `scripts/orb-score.mjs`; Test `scripts/orb-score.test.mjs`.

Pure `decideOrb({ gateNet, gateMktrel, trainNetMean, trainMktrelMean, nTrades, distinctDates, powerFloor })` → verdict. `gateNet`/`gateMktrel` are `bootstrapMeanCI` outputs. The CLI loads instances + prereg (hash-verify or `exit(4)`, copy the guard from `ema-score.mjs`), loads SPY + per-ticker session bars, builds a SPY `date|minutes → {open,close}` map, estimates per-name train β via `olsBeta` on 5-min RTH returns, computes per-trade `netR`/`mktRelR`, runs the gates over the **ETF cut** (mktrel ex-SPY), and renders `docs/lab/orb-RESULTS.md` (verdict, R + %-return tables, drop-top-5 survival via `dropTopN`, `edgeByHour`, the large-cap exploratory appendix, and the train/holdout regime-split disclosure).

- [ ] **Step 1: Failing test**
```js
// scripts/orb-score.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideOrb } from './orb-score.mjs';

const floor = { trades: 200, distinct_dates: 100 };
const ok = { gateNet: { lo: 0.02, n: 500 }, gateMktrel: { lo: 0.01, n: 400 }, trainNetMean: 0.03, trainMktrelMean: 0.02, nTrades: 500, distinctDates: 300, powerFloor: floor };

test('KEEP-CANDIDATE only when both holdout CIs > 0 and train both positive', () => {
  assert.equal(decideOrb(ok).verdict, 'KEEP-CANDIDATE');
});
test('REJECT if gate_mktrel CI includes zero', () => {
  assert.equal(decideOrb({ ...ok, gateMktrel: { lo: -0.001, n: 400 } }).verdict, 'REJECT');
});
test('REJECT if train sign not consistent', () => {
  assert.equal(decideOrb({ ...ok, trainMktrelMean: -0.001 }).verdict, 'REJECT');
});
test('UNDERPOWERED takes precedence on thin samples', () => {
  assert.equal(decideOrb({ ...ok, nTrades: 50, distinctDates: 20 }).verdict, 'UNDERPOWERED');
});
```
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** the pure `decideOrb` (below) + the CLI. For the CLI, follow `scripts/ema-score.mjs`'s structure (hash-verify guard, `bootstrapMeanCI`, per-name β loop, render function); the ORB-specific wiring is: build SPY `date|minutes` map from `loadOrbSessions(root,'SPY')`; per trade compute `netR`/`mktRelR` (Task 7) with `spyWindowReturn`; gate_net rows = ETF cut, gate_mktrel rows = ETF cut ex-SPY.
```js
// scripts/orb-score.mjs (pure decision shown in full; CLI mirrors ema-score.mjs)
export function decideOrb({ gateNet, gateMktrel, trainNetMean, trainMktrelMean, nTrades, distinctDates, powerFloor }) {
  if (nTrades < powerFloor.trades || distinctDates < powerFloor.distinct_dates) {
    return { verdict: 'UNDERPOWERED', reason: `n=${nTrades}/${distinctDates}d < ${powerFloor.trades}/${powerFloor.distinct_dates}d` };
  }
  const gNet = gateNet.lo > 0, gMkt = gateMktrel.lo > 0, gRobust = trainNetMean > 0 && trainMktrelMean > 0;
  if (gNet && gMkt && gRobust) return { verdict: 'KEEP-CANDIDATE', reason: 'net & market-relative R CI>0 + train sign-consistent', gNet, gMkt, gRobust };
  return { verdict: 'REJECT', reason: `gate_net=${gNet} gate_mktrel=${gMkt} gate_robust=${gRobust}`, gNet, gMkt, gRobust };
}
```
For the CLI per-name β: build SPY 5-min RTH returns aligned with each ticker's by `date|minutes`, `betas[t] = olsBeta(tickerRets, spyRets)` over **train** dates only. The RESULTS render must include the spec's framing line ("daily-bar-free generic ORB; a REJECT is not a verdict on the seller; large-cap cut is selected-on-DV exploratory"), gate table (R-multiple, both benchmarks-ex-SPY for mktrel), %-return table, drop-top-5 survival, edge-by-hour, regime split, and limitations. Use `node scripts/orb-score.mjs` end-to-end in Task 12 to validate the CLI on real data.
- [ ] **Step 4: Run → PASS** (4 tests). Also `node --check`.
- [ ] **Step 5: Commit**
```bash
git -C "<wt>" add scripts/orb-score.mjs scripts/orb-score.test.mjs
git -C "<wt>" commit -m "feat(orb): R-multiple dual gates + per-name beta + RESULTS render"
```

---

## Task 11: Train-only sensitivity grid

**Files:** Create `scripts/orb-grid.mjs`; Test `scripts/orb-grid.test.mjs`.

`orbGridConfigs(primary, grid)` enumerates one-knob-at-a-time variants (OR window, target, 21-EMA filter, VWAP-off, breakout-buffer). Exploratory; never gates.

- [ ] **Step 1: Failing test**
```js
// scripts/orb-grid.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orbGridConfigs } from './orb-grid.mjs';

test('grid varies one knob at a time off the primary', () => {
  const primary = { or_minutes: 15, target: 'none', ema21_filter: false, vwap_filter: true, breakout_buffer_or_frac: 0 };
  const grid = { or_minutes: [5, 30], target: ['1R', '2R'], ema21_filter: [true], vwap_filter: [false], breakout_buffer_or_frac: [0.05] };
  const cfgs = orbGridConfigs(primary, grid);
  // 1 primary + 2 or + 2 target + 1 ema + 1 vwap + 1 buffer = 8
  assert.equal(cfgs.length, 8);
  assert.ok(cfgs.some(c => c.label === 'primary'));
});
```
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**
```js
// scripts/orb-grid.mjs
// One-knob-at-a-time ORB sensitivity sweep (train-only, exploratory; never gates the verdict).
export function orbGridConfigs(primary, grid) {
  const cfgs = [{ label: 'primary', ...primary }];
  for (const v of grid.or_minutes) cfgs.push({ label: `or_${v}`, ...primary, or_minutes: v });
  for (const v of grid.target) cfgs.push({ label: `target_${v}`, ...primary, target: v });
  for (const v of grid.ema21_filter) cfgs.push({ label: `ema21_${v}`, ...primary, ema21_filter: v });
  for (const v of grid.vwap_filter) cfgs.push({ label: `vwap_${v}`, ...primary, vwap_filter: v });
  for (const v of grid.breakout_buffer_or_frac) cfgs.push({ label: `buffer_${v}`, ...primary, breakout_buffer_or_frac: v });
  return cfgs;
}
```
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit**
```bash
git -C "<wt>" add scripts/orb-grid.mjs scripts/orb-grid.test.mjs
git -C "<wt>" commit -m "feat(orb): train-only one-knob sensitivity grid enumerator"
```

> Note: wiring the grid configs through `enumerateOrbTrades` (parameterizing OR window, target, buffer, EMA/VWAP filters) is an exploratory follow-on like the EMA grid CLI — the primary signal is hard-coded to the locked config; the grid runner is built only if the verdict warrants it.

---

## Task 12: Runbook + end-to-end dry run

**Files:** Create `docs/lab/orb-RUNBOOK.md`.

- [ ] **Step 1: Write the runbook** (prereq `set -a; source .env; set +a`; pipeline `orb-fetch-bars → orb-build → orb-prereg → orb-score`; note `data/lab/*` git-ignored, only `docs/lab/orb-RESULTS.md` committed; IEX caveat + SIP-if-KEEP).
- [ ] **Step 2: Full unit suite** `node --test "<wt>"/scripts/orb-*.test.mjs` → all green.
- [ ] **Step 3: Live dry run** (needs Alpaca creds): `node scripts/orb-fetch-bars.mjs; node scripts/orb-build.mjs; node scripts/orb-prereg.mjs; node scripts/orb-score.mjs` → a `VERDICT:` line + `docs/lab/orb-RESULTS.md`. Confirm holdout trades ≥ 200 and distinct dates ≥ 100 (else UNDERPOWERED) before trusting the verdict.
- [ ] **Step 4: Commit** runbook + RESULTS + prereg.json:
```bash
git -C "<wt>" add docs/lab/orb-RUNBOOK.md docs/lab/orb-RESULTS.md data/lab/orb-prereg.json
git -C "<wt>" commit -m "docs(orb): runbook + first frozen-holdout RESULTS"
```
- [ ] **Step 5: Read RESULTS against the spec.** Confirm the framing line (REJECT ≠ verdict on seller; daily-bar-free), R-multiple gates present, drop-top-5 + edge-by-hour + regime-split rows present, and that the large-cap appendix is labeled exploratory/selected-on-DV.

---

## Self-Review (completed by plan author)

**Spec coverage:** §1 data/IEX → Tasks 2/12 (caveat in prereg+runbook). §2 signal (OR/VWAP/next-bar-open) → Tasks 3/4. §3 fill/exits/friction → Tasks 5/7. §4 universe (ETF gated, large-cap exploratory) → Tasks 1/6/10. §5 gates (R-multiple, per-name β, gate_net/gate_mktrel ex-SPY, power floor, drop-top-N, edge-by-hour) → Tasks 7/8/9/10. §6 grid (incl. breakout buffer) → Task 11. §7 conventions + loader tests → Tasks 2/throughout. §8 limitations → Task 10 render.

**Placeholder scan:** the score CLI render and the grid-config runner are described as compositions of already-tested helpers (`bootstrapMeanCI`, `netR`, `mktRelR`, `dropTopN`, `edgeByHour`, `decideOrb`) following the concrete `ema-score.mjs` pattern, rather than re-pasting the whole CLI; all load-bearing logic (session loader, signal, exit sim, R helpers, decideOrb, prereg) has complete code + tests. Regime-split disclosure is a render string from instance dates (no new logic).

**Type consistency:** the trade record `{ ticker, cut, date, entry, exit, exitReason, direction, R, rMultiple, retPct, entryMinutes, exitMinutes }` is produced in Tasks 5/6 and consumed unchanged in Tasks 7/10. `netR`/`mktRelR` take that record; `bootstrapMeanCI` rows are `{date, net}` (here `net` = the R-unit value). `decideOrb` inputs match the Task 10 CLI call site. SPY map key `date|minutes` is consistent across Tasks 7/10.
