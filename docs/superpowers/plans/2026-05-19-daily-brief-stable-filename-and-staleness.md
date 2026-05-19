# Daily Brief Stable Filename + Staleness Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-day `daily_brief_YYYYMMDD.json` files with a single stable `daily_brief.json` that carries `as_of` and `stale_after` ISO-8601 fields, and make `read_latest_report("daily_brief")` surface staleness loudly instead of silently returning a yesterday-or-older file.

**Architecture:** Mirror the regime-gate pattern (`services/regime_gate_service.go` + `scripts/compute_daily_regime_score.py`) on the JS side. A new pure-helper module owns the freshness contract (constants, injection, parsing). The scheduler writer (`agent/analysis-scheduler.js#_runDailyBriefing`) writes to a stable path and post-processes the LLM's JSON to add freshness fields atomically. The MCP reader (`mcp-server.js#read_latest_report` case `daily_brief`) reads the stable file, parses staleness, and prepends a `STALE_BRIEF:` marker when expired — the agent still gets content but cannot mistake old context for fresh. The startup "have we already run today?" check switches from filename inspection to reading `as_of` out of the stable JSON.

**Tech Stack:** Node.js (>=20, `node:test`, `node:fs/promises`), existing scheduler/MCP server stack. No Go changes needed — the daily brief never went through the Go bot.

---

## File Structure

- Create: `agent/daily-brief-freshness.js`
  - Exports `STALE_AFTER_HOURS = 29` (matches `services/regime_gate_service.go:46`-equivalent window).
  - Exports `DAILY_BRIEF_FILENAME = 'daily_brief.json'`.
  - Exports `injectFreshnessFields(brief, now)` — returns a new object with `as_of` + `stale_after` set deterministically.
  - Exports `parseBriefStaleness(brief, now)` — returns `{ asOf, staleAfter, isStale, hasFields }` from a parsed JSON object.
  - Exports `briefAsOfDate(brief)` — returns the UTC `YYYY-MM-DD` portion of `as_of` for the scheduler's "have we run today?" check.
- Create: `agent/daily-brief-freshness.test.mjs`
  - Pure-helper tests using `node:test`.
- Modify: `agent/analysis-scheduler.js`
  - Replace `daily_brief_${todaySlug}.json` startup file-existence check with a JSON-load + `briefAsOfDate` comparison.
  - Update `_runDailyBriefing` so the LLM prompt writes to `data/reports/daily_brief.json` (no date slug), then the scheduler reads the file, injects freshness via `injectFreshnessFields`, and atomically rewrites it.
  - Update the header docblock and the `_getLockKey('daily_briefing', ...)` comment block to reflect the stable filename.
- Modify: `agent/analysis-scheduler.test.mjs`
  - Update the fixture `daily_brief_20260514.json` reference in `buildRegimeComputeArgv` tests — that file is *only* there as a "should be ignored" filler. The test still works as-is, but add a second filler entry named `daily_brief.json` so the new convention is also exercised as "ignored by regime compute argv".
- Modify: `mcp-server.js`
  - In the `read_latest_report` handler's `daily_brief` branch, read the single stable file, parse staleness with `parseBriefStaleness`, and prefix the returned text with a `STALE_BRIEF:` marker when stale or when freshness fields are missing.
  - Keep the lock-file check (`daily_brief_*.running`) intact so concurrent generation still surfaces `BRIEFING_IN_PROGRESS`. Add a check for `daily_brief.running` too so the new lock naming works.
- Modify: `README.md`
  - One-line update in the daily-brief section (currently mentions date-stamped output) to reflect the new stable filename + freshness fields.

No Go or Python changes. No new MCP tool — the change is invisible to agents except for the new `STALE_BRIEF:` prefix.

---

## Migration / deployment note

Existing `daily_brief_YYYYMMDD.json` files in `data/reports/` (May 6 → May 19) are orphaned after this change. They are small (<6 KB each) and have no downstream consumers — leave them in place; do **not** delete in this plan. A separate cleanup commit can remove them later if desired.

On first run after deploy, no `daily_brief.json` exists, so the scheduler's startup check (Task 3) will trigger a fresh briefing. No race with in-flight reads because the bot restart is the cutover point.

---

## Task 1: Pure freshness helpers (TDD red phase)

**Files:**
- Create: `agent/daily-brief-freshness.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create the file with this content:

```javascript
// Tests for the daily-brief freshness contract (constants + pure helpers).
// The constants must stay in sync with regime_gate's 29h window, and the
// helpers must be deterministic so the scheduler/MCP server can rely on
// them without flakiness around clock skew.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  STALE_AFTER_HOURS,
  DAILY_BRIEF_FILENAME,
  injectFreshnessFields,
  parseBriefStaleness,
  briefAsOfDate,
} from './daily-brief-freshness.js';

test('STALE_AFTER_HOURS matches regime_gate 29h window', () => {
  // Must equal scripts/compute_daily_regime_score.py STALE_AFTER_HOURS (=29).
  // If you change one side, change both — or the operator's mental model
  // for "what counts as stale" diverges across cross-agent gates.
  assert.equal(STALE_AFTER_HOURS, 29);
});

test('DAILY_BRIEF_FILENAME is the stable filename', () => {
  assert.equal(DAILY_BRIEF_FILENAME, 'daily_brief.json');
});

test('injectFreshnessFields adds as_of and stale_after without mutating input', () => {
  const original = { date: '2026-05-19', summary: 'test', breadth_score: 42 };
  const now = new Date('2026-05-19T13:30:00.000Z');
  const out = injectFreshnessFields(original, now);

  // Original untouched (pure helper contract).
  assert.deepEqual(original, { date: '2026-05-19', summary: 'test', breadth_score: 42 });

  // as_of is exactly the supplied `now` in ISO.
  assert.equal(out.as_of, '2026-05-19T13:30:00.000Z');

  // stale_after is now + STALE_AFTER_HOURS, computed deterministically.
  // 13:30Z + 29h = next day 18:30Z.
  assert.equal(out.stale_after, '2026-05-20T18:30:00.000Z');

  // Existing fields preserved.
  assert.equal(out.date, '2026-05-19');
  assert.equal(out.summary, 'test');
  assert.equal(out.breadth_score, 42);
});

test('injectFreshnessFields overrides pre-existing as_of/stale_after (scheduler is source of truth)', () => {
  // If the LLM happened to write its own as_of/stale_after, the scheduler's
  // post-process must win — LLM clocks are unreliable.
  const original = {
    date: '2026-05-19',
    as_of: '1999-01-01T00:00:00.000Z',
    stale_after: '1999-01-02T00:00:00.000Z',
  };
  const now = new Date('2026-05-19T13:30:00.000Z');
  const out = injectFreshnessFields(original, now);

  assert.equal(out.as_of, '2026-05-19T13:30:00.000Z');
  assert.equal(out.stale_after, '2026-05-20T18:30:00.000Z');
});

test('parseBriefStaleness: fresh brief reports not stale', () => {
  const brief = {
    as_of: '2026-05-19T13:30:00.000Z',
    stale_after: '2026-05-20T18:30:00.000Z',
  };
  const now = new Date('2026-05-19T15:00:00.000Z'); // 1.5h after as_of
  const r = parseBriefStaleness(brief, now);
  assert.equal(r.isStale, false);
  assert.equal(r.hasFields, true);
  assert.equal(r.asOf, '2026-05-19T13:30:00.000Z');
  assert.equal(r.staleAfter, '2026-05-20T18:30:00.000Z');
});

test('parseBriefStaleness: expired brief reports stale', () => {
  const brief = {
    as_of: '2026-05-19T13:30:00.000Z',
    stale_after: '2026-05-20T18:30:00.000Z',
  };
  // 1 minute past stale_after.
  const now = new Date('2026-05-20T18:31:00.000Z');
  const r = parseBriefStaleness(brief, now);
  assert.equal(r.isStale, true);
  assert.equal(r.hasFields, true);
});

test('parseBriefStaleness: brief missing stale_after is treated as stale', () => {
  // Defensive: if the scheduler's post-process step was interrupted and the
  // file lacks freshness fields, force a re-run instead of silently trusting
  // it. The LLM-written body alone is not a freshness contract.
  const brief = { date: '2026-05-19', summary: 'no fields' };
  const now = new Date('2026-05-19T15:00:00.000Z');
  const r = parseBriefStaleness(brief, now);
  assert.equal(r.isStale, true);
  assert.equal(r.hasFields, false);
});

test('parseBriefStaleness: malformed stale_after is treated as stale', () => {
  const brief = { as_of: 'not-a-date', stale_after: 'also-not-a-date' };
  const now = new Date('2026-05-19T15:00:00.000Z');
  const r = parseBriefStaleness(brief, now);
  assert.equal(r.isStale, true);
  assert.equal(r.hasFields, false);
});

test('briefAsOfDate extracts UTC YYYY-MM-DD', () => {
  // Scheduler "have we run today?" compares this to today's ISO date slug.
  // Must be UTC date — using local time would cause double-runs near midnight.
  const brief = { as_of: '2026-05-19T23:45:00.000Z' };
  assert.equal(briefAsOfDate(brief), '2026-05-19');
});

test('briefAsOfDate returns null when as_of missing or malformed', () => {
  assert.equal(briefAsOfDate({}), null);
  assert.equal(briefAsOfDate({ as_of: 'garbage' }), null);
  assert.equal(briefAsOfDate(null), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test agent/daily-brief-freshness.test.mjs`
Expected: FAIL with `Cannot find module './daily-brief-freshness.js'` (the module doesn't exist yet).

---

## Task 2: Implement the pure helpers (TDD green phase)

**Files:**
- Create: `agent/daily-brief-freshness.js`

- [ ] **Step 1: Create the module**

Create `agent/daily-brief-freshness.js` with this exact content:

```javascript
// Daily-brief freshness contract.
//
// The daily brief is the LLM-generated pre-market macro snapshot agents read
// at the start of each trading day. Without a freshness contract, a silently-
// failed regenerate would let agents trade Monday using Friday's brief and
// never know — the lexicographic-newest-file pattern in mcp-server.js has no
// staleness gate of its own.
//
// This module owns:
//   - the stable filename (so writer + reader can't drift),
//   - the staleness window (kept equal to regime_gate's 29h for consistency),
//   - the pure helpers the scheduler uses to inject freshness fields and the
//     MCP reader uses to detect stale reads.
//
// All helpers are pure: they accept a `now: Date` parameter so tests are
// deterministic and the scheduler/reader share one implementation.

// Must match scripts/compute_daily_regime_score.py STALE_AFTER_HOURS = 29.
// Briefs are generated weekday mornings ~6 AM ET (≈10/11 UTC). 29h covers
// the longest weekday gap with a small slack for slow generation; the
// Friday→Monday gap is intentionally beyond the window so a Monday-morning
// read of a Friday brief is correctly flagged stale.
export const STALE_AFTER_HOURS = 29;

export const DAILY_BRIEF_FILENAME = 'daily_brief.json';

// injectFreshnessFields returns a shallow copy of `brief` with `as_of` and
// `stale_after` set from `now`. The scheduler — never the LLM — is the source
// of truth for these timestamps, so any pre-existing values are overwritten.
export function injectFreshnessFields(brief, now) {
  const asOf = now.toISOString();
  const staleAfter = new Date(now.getTime() + STALE_AFTER_HOURS * 3600 * 1000).toISOString();
  return { ...brief, as_of: asOf, stale_after: staleAfter };
}

// parseBriefStaleness inspects a parsed brief JSON object and returns the
// freshness verdict. Missing or malformed freshness fields are treated as
// stale on purpose — a brief that can't prove it's fresh isn't trusted.
export function parseBriefStaleness(brief, now) {
  const asOfRaw = brief && typeof brief === 'object' ? brief.as_of : undefined;
  const staleAfterRaw = brief && typeof brief === 'object' ? brief.stale_after : undefined;
  const staleAfterDate = staleAfterRaw ? new Date(staleAfterRaw) : null;
  const hasFields =
    typeof asOfRaw === 'string' &&
    typeof staleAfterRaw === 'string' &&
    staleAfterDate !== null &&
    !Number.isNaN(staleAfterDate.getTime());

  if (!hasFields) {
    return { asOf: null, staleAfter: null, isStale: true, hasFields: false };
  }
  return {
    asOf: asOfRaw,
    staleAfter: staleAfterRaw,
    isStale: now.getTime() > staleAfterDate.getTime(),
    hasFields: true,
  };
}

// briefAsOfDate returns the UTC date portion (YYYY-MM-DD) of `as_of` for the
// scheduler's "have we already run today?" comparison. Returns null on any
// parse failure so the scheduler treats it as "no brief today" and triggers.
export function briefAsOfDate(brief) {
  const asOf = brief && typeof brief === 'object' ? brief.as_of : undefined;
  if (typeof asOf !== 'string') return null;
  const d = new Date(asOf);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `node --test agent/daily-brief-freshness.test.mjs`
Expected: PASS — all 10 tests green.

- [ ] **Step 3: Commit**

```bash
git add agent/daily-brief-freshness.js agent/daily-brief-freshness.test.mjs
git commit -m "feat(daily-brief): pure freshness helpers (as_of/stale_after, 29h window)"
```

---

## Task 3: Scheduler writer — stable filename + post-process injection

**Files:**
- Modify: `agent/analysis-scheduler.js` (`_runDailyBriefing` method around lines 1097–1140, and the file's prompt + log strings)

- [ ] **Step 1: Add the import**

At the top of `agent/analysis-scheduler.js`, add the freshness import near the other relative imports (look for existing `import { ... } from './...'` lines and add this one alongside them):

```javascript
import {
  DAILY_BRIEF_FILENAME,
  injectFreshnessFields,
} from './daily-brief-freshness.js';
```

- [ ] **Step 2: Rewrite the `_runDailyBriefing` body**

Replace the entire `_runDailyBriefing` method (currently at lines ~1094–1140; locate it by the line `async _runDailyBriefing(date) {`) with this version:

```javascript
async _runDailyBriefing(date) {
  const dateSlug = date.replace(/-/g, '');
  // Lock is acquired by triggerJob — no per-runner lock needed here.

  this._log(`Starting daily briefing for ${date}...`, 'info');
  this.emit('scheduler_job_start', { job: 'daily_briefing', date });

  const briefPath = path.join(REPORTS_DIR, DAILY_BRIEF_FILENAME);

  const hasFmp = !!process.env.FMP_API_KEY;
  const fmpNote = hasFmp ? '' : '\nNote: FMP_API_KEY not set — FTD check, economic calendar, earnings calendar, analyst actions, and catalyst news will be skipped.';

  const prompt = `You are the Prophet Pre-Market Analysis Agent. Today is ${date}. Your job is to run the daily pre-market briefing pipeline and save the results.${fmpNote}

Call these MCP tools in this exact order:
1. run_market_briefing — fetches breadth and uptrend ratio data from public CSV sources (no API key needed). Wait for it to complete.
${hasFmp ? `2. run_ftd_check — detects Follow-Through Day signals (requires FMP API).
3. run_economic_calendar — fetches this week's tier-1 macro events (FOMC, CPI, NFP, GDP).
4. run_earnings_calendar — fetches key earnings announcements for this week.
5. run_analyst_actions — fetches the last 24h of analyst rating changes and price-target updates across Prophet's liquid optionable universe (~50 names). Tier-1 banks (Goldman, Morgan Stanley, JPM, BofA, Citi, Wells Fargo) and large PT moves rank highest.
6. run_catalyst_news — fetches the last 24h of ticker-filtered news for the same universe, narrowed to M&A activity and earnings whispers (preannouncements, guidance cuts/raises, profit warnings, beat/miss). Returns up to 3 events.
7. get_marketwatch_all — fetches all MarketWatch feeds (top stories, realtime headlines, bulletins, market pulse). Scan for any market-moving news: earnings results or misses (including private companies), executive commentary, sector contagion, macro surprises, or geopolitical events. Extract up to 7 headlines that a trader must know about today.` : `2. (Skipping FTD, economic calendar, earnings calendar, analyst actions, and catalyst news — FMP_API_KEY not set)
3. get_marketwatch_all — fetches all MarketWatch feeds. Scan for market-moving headlines and extract up to 7 that a trader must know about today.`}

After all tools have returned, use the Write tool to save the briefing to exactly this path:
data/reports/${DAILY_BRIEF_FILENAME}

The JSON must be exactly this structure (fill all values from tool results):
{
  "date": "${date}",
  "generated_at": "<current UTC ISO timestamp>",
  "market_posture": "<BULLISH|NEUTRAL|BEARISH — based on breadth score: BULLISH >70, NEUTRAL 40-70, BEARISH <40>",
  "breadth_score": <integer 0-100 from run_market_briefing composite score>,
  "uptrend_ratio": <float 0-100 from run_market_briefing uptrend ratio field>,
  "ftd_status": "<active_ftd|rally_attempt|no_signal|correction — from run_ftd_check, or null if skipped>",
  "tier1_macro_events": [<objects from run_economic_calendar with date, event, impact fields — empty array if skipped or none>],
  "key_earnings_this_week": [<objects from run_earnings_calendar with date, ticker, timing fields — empty array if skipped or none>],
  "analyst_actions": [<top-ranked objects from run_analyst_actions — pass through the JSON array as-is (up to 15 events). Each event: {ticker, type ("pt_change"|"rating_change"), firm, action, from, to, date}. Empty array if skipped or none.>],
  "ticker_catalysts": [<objects from run_catalyst_news — pass through the JSON array as-is (up to 3 events). Each event: {ticker, event_type ("ma"|"earnings"), headline, source, url, published}. Empty array if skipped or none.>],
  "market_headlines": [<up to 7 objects from get_marketwatch_all that represent market-moving news — each object: {"headline": "<title>", "source": "<publication>", "impact": "<1 sentence: what moves and which direction>", "sectors_affected": ["<sector1>", ...]}. Include earnings misses/beats, executive statements, sector contagion, macro shocks, and geopolitical news. Empty array only if no significant news found.>],
  "exposure_ceiling_pct": <integer 0-100 — your recommended max exposure: 100 if BULLISH, 60 if NEUTRAL, 20 if BEARISH; reduce further if active_ftd, tier-1 event today, or major negative market_headlines>,
  "summary": "<2-3 sentences describing today's market setup, key risks from headlines, notable analyst actions and ticker catalysts on Prophet's universe, and any sector-specific warnings>"
}

Use null for any field where the corresponding tool failed. Use [] for analyst_actions and ticker_catalysts if the tools were skipped or returned empty. Do NOT include "as_of" or "stale_after" fields — the scheduler injects those after you write. Write only the JSON — no markdown, no explanation.`;

  await this._runOneshotOpencode(prompt, 'daily_briefing', 10 * 60 * 1000);

  // Post-process: read the LLM-written file, inject as_of + stale_after from
  // the scheduler's clock (single source of truth), and atomically rewrite.
  // A failure here leaves the file without freshness fields — the reader
  // treats that as stale and the next scheduler cycle re-runs the briefing.
  try {
    const raw = await fs.readFile(briefPath, 'utf-8');
    const parsed = JSON.parse(raw);
    const enriched = injectFreshnessFields(parsed, new Date());
    const tmpPath = `${briefPath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(enriched, null, 2), 'utf-8');
    await fs.rename(tmpPath, briefPath);
  } catch (err) {
    this._log(`Daily briefing freshness injection failed: ${err.message}`, 'warn');
  }

  this._log(`Daily briefing complete → data/reports/${DAILY_BRIEF_FILENAME}`, 'success');
  this.emit('scheduler_job_end', { job: 'daily_briefing', date, output: `data/reports/${DAILY_BRIEF_FILENAME}` });
  // dateSlug retained for backwards-compatible log/event payloads if any
  // downstream consumer reads it (none currently — see plan).
  void dateSlug;
}
```

The body of the prompt is identical to the current version (lines 1103–1135) except for:
- The output path now uses `DAILY_BRIEF_FILENAME` (i.e., `data/reports/daily_brief.json`).
- A new sentence at the end instructs the LLM **not** to write `as_of`/`stale_after`.

The post-process block at the bottom is new.

- [ ] **Step 3: Run the existing scheduler tests to confirm no regression**

Run: `node --test agent/analysis-scheduler.test.mjs`
Expected: PASS — all existing tests still green. (They don't exercise the writer body, only pure helpers like `buildRegimeComputeArgv`.)

- [ ] **Step 4: Commit**

```bash
git add agent/analysis-scheduler.js
git commit -m "feat(daily-brief): writer uses stable filename + injects freshness fields"
```

---

## Task 4: Scheduler startup detection — read as_of instead of filename probe

**Files:**
- Modify: `agent/analysis-scheduler.js` (the startup check around lines 360–371)

- [ ] **Step 1: Import the date helper**

Update the import block from Task 3 to also pull in `briefAsOfDate`:

```javascript
import {
  DAILY_BRIEF_FILENAME,
  injectFreshnessFields,
  briefAsOfDate,
} from './daily-brief-freshness.js';
```

- [ ] **Step 2: Rewrite the startup check**

Replace these lines in `agent/analysis-scheduler.js` (currently around 355–371; locate by the comment `// 1. Daily briefing (file-based)`):

```javascript
    const todaySlug = isoDate.replace(/-/g, '');
    const { hour, dayOfWeek } = this._getETInfo();
    const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
    let adaptNeeded = false;

    // 1. Daily briefing (file-based) — skip if market has already closed (≥4 PM ET); will fire at 6 AM ET next weekday
    try { await fs.access(path.join(REPORTS_DIR, `daily_brief_${todaySlug}.json`)); }
    catch {
      if (await this._isLocked(this._getLockKey('daily_briefing', isoDate))) {
        this._log('Daily briefing already running in another process — skipping startup trigger.', 'info');
      } else if (isWeekday && hour < 16) {
        this._log('No daily briefing for today — triggering now...', 'info');
        await this.triggerJob('daily_briefing').catch(() => {});
      } else {
        this._log('No daily briefing for today — skipping (market closed, will run at 6 AM ET next weekday).', 'info');
      }
    }
```

with:

```javascript
    const { hour, dayOfWeek } = this._getETInfo();
    const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
    let adaptNeeded = false;

    // 1. Daily briefing — read the stable daily_brief.json and check its
    // as_of date. If the file is missing, unreadable, or stamped with a
    // different UTC date, treat it as "no briefing for today". Skip if
    // market has already closed (≥4 PM ET); will fire at 6 AM ET next weekday.
    let briefIsCurrent = false;
    try {
      const briefRaw = await fs.readFile(path.join(REPORTS_DIR, DAILY_BRIEF_FILENAME), 'utf-8');
      const briefJson = JSON.parse(briefRaw);
      briefIsCurrent = briefAsOfDate(briefJson) === isoDate;
    } catch {
      briefIsCurrent = false;
    }
    if (!briefIsCurrent) {
      if (await this._isLocked(this._getLockKey('daily_briefing', isoDate))) {
        this._log('Daily briefing already running in another process — skipping startup trigger.', 'info');
      } else if (isWeekday && hour < 16) {
        this._log('No daily briefing for today — triggering now...', 'info');
        await this.triggerJob('daily_briefing').catch(() => {});
      } else {
        this._log('No daily briefing for today — skipping (market closed, will run at 6 AM ET next weekday).', 'info');
      }
    }
```

Note: `todaySlug` was only used by the deleted file probe in this block. If a grep confirms it is unused elsewhere in this method, leave it removed. (It is used inside `_runDailyBriefing` independently — that variable was local to that method and is unaffected.)

- [ ] **Step 3: Verify `todaySlug` removal doesn't break other code in `runStartupAnalyses`**

Run: `node -e "const s = require('fs').readFileSync('agent/analysis-scheduler.js','utf8'); const m = s.match(/async runStartupAnalyses[\s\S]*?\n  \}\n/); if (!m) process.exit(2); if (m[0].includes('todaySlug')) { console.error('todaySlug still referenced in runStartupAnalyses — keep the const'); process.exit(1); }"`
Expected exit code: 0. If exit code 1, restore `const todaySlug = isoDate.replace(/-/g, '');` at the top of the block — it's used by another check further down.

- [ ] **Step 4: Run scheduler tests**

Run: `node --test agent/analysis-scheduler.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/analysis-scheduler.js
git commit -m "feat(daily-brief): startup check reads as_of from stable file"
```

---

## Task 5: MCP reader — staleness-aware `read_latest_report("daily_brief")`

**Files:**
- Modify: `mcp-server.js` (the `read_latest_report` case at lines ~2869–2906)

- [ ] **Step 1: Add the import**

At the top of `mcp-server.js`, alongside existing imports, add:

```javascript
import {
  DAILY_BRIEF_FILENAME,
  parseBriefStaleness,
} from './agent/daily-brief-freshness.js';
```

(If `mcp-server.js` uses CommonJS `require` rather than ESM `import`, use `const { DAILY_BRIEF_FILENAME, parseBriefStaleness } = await import('./agent/daily-brief-freshness.js');` inside the handler instead — confirm the file's module style with a quick `head -20 mcp-server.js` and pick the matching syntax.)

- [ ] **Step 2: Branch the daily_brief path inside the existing case**

The current `read_latest_report` case (around `case 'read_latest_report':` at ~line 2869) uses a single prefix-based readdir flow for all report types. Add an early-return branch for `daily_brief` that reads the stable file and applies staleness. Locate the line:

```javascript
        const prefix = prefixMap[reportType];
        if (!prefix) return { content: [{ type: 'text', text: `Unknown report type: ${reportType}. Valid: ${Object.keys(prefixMap).join(', ')}` }], isError: true };
```

Immediately after that `if (!prefix)` line, insert:

```javascript
        // Daily brief uses the stable-filename + staleness-fields contract.
        // Other report types still follow the lexicographic-newest-file
        // pattern below because they are episodic (scenarios, postmortems,
        // screener results) and don't need a daily freshness gate.
        if (reportType === 'daily_brief') {
          const filePath = path.join(REPORTS_DIR, DAILY_BRIEF_FILENAME);
          let content;
          try {
            content = await fs.readFile(filePath, 'utf-8');
          } catch {
            // Lock-file check preserves the BRIEFING_IN_PROGRESS signal during
            // generation. We check both the new `.running` name and the old
            // prefixed name so a transitional in-flight job is still surfaced.
            const lockFiles = (await fs.readdir(REPORTS_DIR).catch(() => []))
              .filter(f => (f === 'daily_brief.running' || f.startsWith('daily_brief_')) && f.endsWith('.running'));
            if (lockFiles.length > 0) {
              return { content: [{ type: 'text', text: `BRIEFING_IN_PROGRESS: The daily_brief report is currently being generated by another agent. Call wait(60) then retry read_latest_report("daily_brief").` }] };
            }
            return { content: [{ type: 'text', text: `No daily_brief report found in data/reports/. The pre-market briefing scheduler has not produced one yet.` }] };
          }

          let parsed;
          try { parsed = JSON.parse(content); } catch { parsed = null; }
          const staleness = parseBriefStaleness(parsed, new Date());
          let prefixMessage = '';
          if (staleness.isStale) {
            const ageNote = staleness.hasFields
              ? ` (as_of=${staleness.asOf}, stale_after=${staleness.staleAfter}, now=${new Date().toISOString()})`
              : ' (as_of/stale_after fields missing or malformed)';
            prefixMessage = `STALE_BRIEF: Daily brief is older than its staleness window${ageNote}. Treat the content below as historical context only; do not rely on it for today's pre-market reasoning.\n\n`;
          }

          const truncated = content.length > 8000 ? content.slice(0, 8000) + '\n... [truncated]' : content;
          return { content: [{ type: 'text', text: `${prefixMessage}Report: ${DAILY_BRIEF_FILENAME}\n\n${truncated}` }] };
        }
```

The existing prefix-based readdir flow below this insert remains unchanged — it now serves only the non-`daily_brief` report types.

- [ ] **Step 3: Manual smoke test against a stale fixture**

Create a temporary stale fixture and confirm the handler emits the `STALE_BRIEF:` prefix. Run from the project root:

```bash
node -e "
const fs = require('fs');
const path = require('path');
const file = path.join('data', 'reports', 'daily_brief.json');
const stale = {
  date: '2026-05-15',
  summary: 'stale fixture',
  as_of: '2026-05-15T13:00:00.000Z',
  stale_after: '2026-05-16T18:00:00.000Z'
};
fs.writeFileSync(file + '.backup', fs.existsSync(file) ? fs.readFileSync(file) : '');
fs.writeFileSync(file, JSON.stringify(stale, null, 2));
console.log('Stale fixture written. Backup at ' + file + '.backup');
"
```

Then, from an MCP client (or by booting the MCP server and issuing a `read_latest_report` tool call with `{ type: 'daily_brief' }`), confirm the response text begins with `STALE_BRIEF:`. Restore the backup:

```bash
node -e "
const fs = require('fs');
const path = require('path');
const file = path.join('data', 'reports', 'daily_brief.json');
const backup = file + '.backup';
if (fs.existsSync(backup)) {
  const buf = fs.readFileSync(backup);
  if (buf.length > 0) fs.writeFileSync(file, buf); else fs.unlinkSync(file);
  fs.unlinkSync(backup);
  console.log('Restored.');
}
"
```

Expected: the MCP response prefix is `STALE_BRIEF:` for the stale fixture; after restore, real briefs (when present) get no prefix.

- [ ] **Step 4: Commit**

```bash
git add mcp-server.js
git commit -m "feat(daily-brief): read_latest_report flags stale brief with STALE_BRIEF marker"
```

---

## Task 6: Update README + scheduler docblock

**Files:**
- Modify: `README.md`
- Modify: `agent/analysis-scheduler.js` (the file header docblock at the top)

- [ ] **Step 1: README change**

Search `README.md` for `daily_brief`. There should be a small section or bullet that mentions the date-stamped output. Update it to read along the lines of:

> The pre-market briefing scheduler writes a single stable file `data/reports/daily_brief.json` each weekday morning. The file carries `as_of` and `stale_after` ISO-8601 timestamps; `read_latest_report("daily_brief")` prepends a `STALE_BRIEF:` marker when the brief has aged past its 29h staleness window.

Adjust the surrounding prose to match the existing README voice. If `README.md` has no daily-brief content, skip this step and note "no README mention found" in the commit body.

- [ ] **Step 2: Scheduler docblock change**

In `agent/analysis-scheduler.js`, find the comment header at the top of the file (around line 15) that says:

```
 *   daily_briefing               → data/reports/daily_brief_YYYYMMDD.json missing
```

Replace that single line with:

```
 *   daily_briefing               → data/reports/daily_brief.json missing or stamped with a non-today as_of
```

- [ ] **Step 3: Commit**

```bash
git add README.md agent/analysis-scheduler.js
git commit -m "docs(daily-brief): note stable filename + staleness contract"
```

---

## Task 7: Final verification

**Files:** none modified — verification only.

- [ ] **Step 1: Run the full Node test suite**

Run: `npm test` (or, if there is no top-level script, `node --test agent/*.test.mjs mcp-tools/*.test.mjs`)
Expected: all tests pass.

- [ ] **Step 2: Boot the bot locally and confirm the startup log line**

Start the analysis scheduler (whichever entrypoint the operator uses — typically `node agent/server.js`). On startup, look for one of:
- `Daily briefing already running in another process — skipping startup trigger.`
- `No daily briefing for today — triggering now...`
- `No daily briefing for today — skipping (market closed, will run at 6 AM ET next weekday).`

If `data/reports/daily_brief.json` already exists with today's `as_of`, no log line about daily briefing should fire (the check is silent on success).

Expected: one of the above lines, OR silence with the file present and `as_of` matching today's UTC date.

- [ ] **Step 3: Confirm a fresh brief is written end-to-end**

Trigger a manual run if needed: `curl -X POST http://localhost:PORT/api/v1/scheduler/trigger -d '{"job":"daily_briefing"}' -H 'Content-Type: application/json'` (port and exact endpoint depend on `agent/server.js` — check the existing route registration for the trigger handler).

After ~5–10 minutes, confirm:
```bash
node -e "
const j = JSON.parse(require('fs').readFileSync('data/reports/daily_brief.json','utf8'));
console.log('as_of:', j.as_of);
console.log('stale_after:', j.stale_after);
console.log('has_summary:', typeof j.summary === 'string');
"
```

Expected: `as_of` is today's UTC timestamp, `stale_after` is ~29 hours later, `has_summary: true`.

---

## Self-review (already applied)

- **Spec coverage:** Writer (Tasks 2/3), reader (Task 5), startup detection (Task 4), helpers (Tasks 1/2), docs (Task 6), final smoke (Task 7). The stated goal — stable filename + staleness fields + reader-side flag — is covered end-to-end.
- **Placeholders:** None. Every code step shows the actual code or command.
- **Type consistency:** Helper signatures (`injectFreshnessFields(brief, now)`, `parseBriefStaleness(brief, now)`, `briefAsOfDate(brief)`) and the constants (`DAILY_BRIEF_FILENAME`, `STALE_AFTER_HOURS`) are referenced identically across Tasks 1, 2, 3, 4, 5.
- **No Go service needed:** the daily brief never lived in the Go bot; reader and writer are both Node. Matching the *contract* of regime_gate (`as_of`, `stale_after`, 29h window) is sufficient.
