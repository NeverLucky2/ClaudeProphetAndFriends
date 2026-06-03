# Coil/Turtle Reasoning Digest — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface a daily, human-readable "why we did / didn't enter" digest for the two mechanical agents (Turtle, Coil) at near-zero token cost, by wiring the already-committed `Explain*` formatters into their decision paths and a Node after-close report job.

**Architecture:** Two **always-on** Go emit changes (Turtle attaches per-ticker rationale to `HeartbeatResult`, surfaced via the existing `/api/v1/turtle/status`; Coil's candidates service stamps an `Explanation` on each `MeanRevSignal`, surfaced via the existing `/api/v1/meanrev/candidates` + `/signal`). One **flag-gated** Node job (`REASONING_DIGEST_ENABLED`, default OFF) runs after close, pulls both Go endpoints per sandbox, and writes `data/reasoning-digest/<sandboxId>/<date>.{md,json}` plus a read endpoint and a small dashboard section.

**Tech Stack:** Go (services + gin controllers, `go test`), Node ESM (`node --test`), existing `goAxios` per-runtime HTTP client, the `analysis-scheduler.js` cron-like `_checkSchedule` loop.

**Commit policy:** Per the one-commit-per-backlog-item rule, each task below ends with a working commit on branch `coil-turtle-reasoning-digest`; Task 9 squashes them (with the already-present core commit `62bdbb4`) into a single `feat(reasoning-digest)` commit before merge. Ask the user before the final squash/merge.

**Reference types (already committed in `services/agent_reasoning_digest.go`):**
- `ExplainMeanRevEntry(sig MeanRevSignal) string`
- `ExplainTrendEntry(sig TrendSignal, entered bool, blockReason string) string`

---

## File structure

- Modify `services/meanrev_signal_service.go` — add `Explanation` field to `MeanRevSignal`; stamp it in `computeCandidates` + `GetSignalForTicker` after the final `EntrySignal` is known. (Controller needs NO change — it returns the service's signals.)
- Modify `services/meanrev_signal_service_test.go` — one new test.
- Modify `services/turtle_executor.go` — add `TickerRationale` type + `Reasoning []TickerRationale` on `HeartbeatResult`; capture per-ticker in `runEntries`, finalize after the loop. (Controller needs NO change — `/turtle/status` already returns `scheduler.LastResult()`.)
- Modify `services/turtle_executor_test.go` — one new test.
- Create `agent/reasoning-digest.js` — pure parsers/builders/renderer + injected-dep I/O.
- Create `agent/reasoning-digest.test.mjs` — node tests.
- Modify `agent/server.js` — import, `runReasoningDigestAllSandboxes`, scheduler injection, `GET /api/reasoning-digest`.
- Modify `agent/analysis-scheduler.js` — `validJobs`, dispatch branch, constructor injection, `_checkSchedule` trigger (16:55 ET), `_runReasoningDigest`.
- Modify `agent/public/index.html` — small reasoning-digest section mirroring the reconciliation banner.

---

## Task 1: Coil emits `Explanation` (Go)

**Files:**
- Modify: `services/meanrev_signal_service.go:24-35` (struct), `:380` (computeCandidates), `:405` (GetSignalForTicker)
- Test: `services/meanrev_signal_service_test.go`

- [ ] **Step 1: Write the failing test**

Append to `services/meanrev_signal_service_test.go` (add `"strings"` to the import block at the top):

```go
func TestGetSignalForTicker_SetsEnterExplanation(t *testing.T) {
	bars := map[string][]*interfaces.Bar{
		"AAA": makeMeanRevBars(pullbackCloses()),
	}
	sig := NewMeanRevSignalService(&stubBarFetcher{bars: bars})
	svc := NewMeanRevCandidatesService(sig, nil, []string{"AAA"}, "normal")
	svc.SetRefreshInterval(-1)

	got, err := svc.GetSignalForTicker(context.Background(), "AAA")
	if err != nil {
		t.Fatalf("GetSignalForTicker: %v", err)
	}
	if !got.EntrySignal {
		t.Fatalf("precondition: AAA should be an entry signal with pullbackCloses()")
	}
	if got.Explanation == "" {
		t.Fatal("Explanation should be populated")
	}
	if !strings.HasPrefix(got.Explanation, "Coil AAA ") {
		t.Errorf("Explanation = %q, want prefix \"Coil AAA \"", got.Explanation)
	}
	if !strings.Contains(got.Explanation, "ENTER") {
		t.Errorf("Explanation = %q, want ENTER for a qualifying signal", got.Explanation)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./services/ -run TestGetSignalForTicker_SetsEnterExplanation -v`
Expected: FAIL — `got.Explanation` is `""` (field doesn't exist yet → actually a compile error: `Explanation` undefined). Compile failure counts as the failing state.

- [ ] **Step 3: Add the struct field**

In `services/meanrev_signal_service.go`, add to the `MeanRevSignal` struct (after `SignalVersion`):

```go
	SignalVersion     string  `json:"signal_version"`
	Explanation       string  `json:"explanation,omitempty"`
```

- [ ] **Step 4: Stamp it where the final signal is known**

In `computeCandidates`, immediately before `resp.Candidates = append(resp.Candidates, *sig)`:

```go
		sig.Explanation = ExplainMeanRevEntry(*sig)
		resp.Candidates = append(resp.Candidates, *sig)
```

In `GetSignalForTicker`, immediately before `return sig, nil`:

```go
	sig.Explanation = ExplainMeanRevEntry(*sig)
	return sig, nil
```

- [ ] **Step 5: Run test to verify it passes**

Run: `go test ./services/ -run TestGetSignalForTicker_SetsEnterExplanation -v`
Expected: PASS

- [ ] **Step 6: Full package + build + vet**

Run: `go test ./services/ ; go build ./... ; go vet ./services/`
Expected: all green (existing 5 formatter tests + everything else still pass).

- [ ] **Step 7: Commit**

```bash
git add services/meanrev_signal_service.go services/meanrev_signal_service_test.go
git commit -m "feat(reasoning-digest): Coil stamps Explanation on meanrev signals"
```

---

## Task 2: Turtle emits `Reasoning` (Go)

**Files:**
- Modify: `services/turtle_executor.go:69-79` (HeartbeatResult + new type), `:runEntries` (capture + finalize)
- Test: `services/turtle_executor_test.go`

- [ ] **Step 1: Write the failing test**

Append to `services/turtle_executor_test.go` (the file already imports `strings`? if not, add it):

```go
func TestRunEntries_PopulatesReasoningForEntry(t *testing.T) {
	sigs, bars, trader, seg, regime, guard := fullStubs()
	universeIneligibleExcept(sigs, bars, "TLT")
	sigs.signals["TLT"] = goodEntrySignal("TLT")
	bars.bars["TLT"] = &interfaces.Bar{Open: 99, Close: 100}
	exe, _ := newTestExecutor(t, sigs, bars, trader, seg, regime, guard)

	res, err := exe.RunHeartbeat(context.Background(), at1700(t, "2026-05-15"))
	if err != nil {
		t.Fatalf("RunHeartbeat: %v", err)
	}

	var tlt *TickerRationale
	for i := range res.Reasoning {
		if res.Reasoning[i].Ticker == "TLT" {
			tlt = &res.Reasoning[i]
			break
		}
	}
	if tlt == nil {
		t.Fatalf("expected a TLT rationale, got %d entries", len(res.Reasoning))
	}
	if !tlt.SetupQualified {
		t.Error("TLT SetupQualified = false, want true")
	}
	if !tlt.Taken {
		t.Error("TLT Taken = false, want true")
	}
	if !strings.Contains(tlt.Line, "ENTER") {
		t.Errorf("TLT Line = %q, want it to contain ENTER", tlt.Line)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./services/ -run TestRunEntries_PopulatesReasoningForEntry -v`
Expected: FAIL (compile error: `TickerRationale` / `res.Reasoning` undefined).

- [ ] **Step 3: Add the type and field**

In `services/turtle_executor.go`, add the type just above `type HeartbeatResult struct` and a field inside it:

```go
// TickerRationale is the per-ticker teaching line for the daily reasoning
// digest. SetupQualified is the signal-level verdict (evaluateEntry); Taken is
// whether an order was actually placed; BlockedBy names the portfolio gate that
// declined a qualified setup (empty when taken or when the setup didn't qualify).
type TickerRationale struct {
	Ticker         string `json:"ticker"`
	Line           string `json:"line"`
	SetupQualified bool   `json:"setup_qualified"`
	Taken          bool   `json:"taken"`
	BlockedBy      string `json:"blocked_by,omitempty"`
}
```

Add to `HeartbeatResult` (after `MissedEntries`):

```go
	MissedEntries  []MissedEntry     `json:"missed_entries,omitempty"`
	Reasoning      []TickerRationale `json:"reasoning,omitempty"`
```

- [ ] **Step 4: Capture each evaluated ticker, finalize after the loop**

In `runEntries`, declare an accumulator before the ticker `for` loop:

```go
	type evaluatedTicker struct {
		ticker   string
		sig      *TrendSignal
		qual, _  bool
		evReason string
	}
	var evaluated []evaluatedTicker
```

Immediately after `ev := evaluateEntry(sig, coldStart)` (currently `turtle_executor.go:494`), record the evaluation (this fires for every ticker that reaches the signal gate, for both the pass and the continue-onward paths):

```go
		ev := evaluateEntry(sig, coldStart)
		evaluated = append(evaluated, evaluatedTicker{ticker: ticker, sig: sig, qual: ev.Eligible, evReason: ev.Reason})
		if !ev.Eligible {
			res.Skips = append(res.Skips, fmt.Sprintf("%s: %s", ticker, ev.Reason))
			continue
		}
```

(Replace the `qual, _ bool` placeholder field with a single `qual bool` — shown verbatim: the struct is `{ ticker string; sig *TrendSignal; qual bool; evReason string }`.)

After the ticker loop closes (just before `runEntries` returns), build `res.Reasoning`:

```go
	// Build the per-ticker teaching lines from the evaluated set + final outcomes.
	taken := make(map[string]bool, len(res.Entries))
	for _, tk := range res.Entries {
		taken[tk] = true
	}
	for _, et := range evaluated {
		wasTaken := taken[et.ticker]
		blockedBy := ""
		blockReason := et.evReason
		if et.qual && !wasTaken {
			blockedBy = skipReasonFor(et.ticker, res.Skips)
			blockReason = blockedBy
		}
		res.Reasoning = append(res.Reasoning, TickerRationale{
			Ticker:         et.ticker,
			Line:           ExplainTrendEntry(*et.sig, wasTaken, blockReason),
			SetupQualified: et.qual,
			Taken:          wasTaken,
			BlockedBy:      blockedBy,
		})
	}
```

Add the helper at file scope (near `evaluateEntry`):

```go
// skipReasonFor extracts the reason text for `ticker` from res.Skips entries,
// which are formatted "TICKER: reason". Returns "" if no matching skip.
func skipReasonFor(ticker string, skips []string) string {
	prefix := ticker + ": "
	for _, s := range skips {
		if strings.HasPrefix(s, prefix) {
			return strings.TrimPrefix(s, prefix)
		}
	}
	return ""
}
```

Ensure `services/turtle_executor.go` imports `"strings"` (add to the import block if absent).

- [ ] **Step 5: Run test to verify it passes**

Run: `go test ./services/ -run TestRunEntries_PopulatesReasoningForEntry -v`
Expected: PASS

- [ ] **Step 6: Full package + build + vet**

Run: `go test ./services/ ; go build ./... ; go vet ./services/`
Expected: all green (the ~50 existing `TestRunEntries_*` tests still pass — `Reasoning` is additive).

- [ ] **Step 7: Commit**

```bash
git add services/turtle_executor.go services/turtle_executor_test.go
git commit -m "feat(reasoning-digest): Turtle attaches per-ticker rationale to HeartbeatResult"
```

---

## Task 3: Node digest — pure parsers/builders/renderer

**Files:**
- Create: `agent/reasoning-digest.js`
- Test: `agent/reasoning-digest.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `agent/reasoning-digest.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTurtleReasoning, parseCoilReasoning, buildAgentDigest, renderMarkdown,
} from './reasoning-digest.js';

test('parseTurtleReasoning reads last_run.reasoning, soft-empty on missing', () => {
  const status = { scheduler_enabled: true, last_run: { reasoning: [
    { ticker: 'TLT', line: 'Turtle TLT ENTER ...', setup_qualified: true, taken: true, blocked_by: '' },
    { ticker: 'GLD', line: 'Turtle GLD PASS ...', setup_qualified: false, taken: false },
  ] } };
  const got = parseTurtleReasoning(status);
  assert.equal(got.length, 2);
  assert.deepEqual(got[0], { ticker: 'TLT', line: 'Turtle TLT ENTER ...', qualified: true, taken: true, blockedBy: '' });
  assert.deepEqual(parseTurtleReasoning(null), []);
  assert.deepEqual(parseTurtleReasoning({ last_run: null }), []);
});

test('parseCoilReasoning maps candidates to entry lines', () => {
  const resp = { candidates: [
    { ticker: 'AAPL', explanation: 'Coil AAPL ENTER ...', rsi_2: 3.1 },
    { ticker: 'MSFT', explanation: 'Coil MSFT ENTER ...', rsi_2: 4.0 },
  ] };
  const got = parseCoilReasoning(resp);
  assert.equal(got.length, 2);
  assert.deepEqual(got[0], { ticker: 'AAPL', line: 'Coil AAPL ENTER ...', qualified: true, taken: true, blockedBy: '' });
  assert.deepEqual(parseCoilReasoning(null), []);
});

test('buildAgentDigest groups turtle into entered/declined/passed', () => {
  const items = [
    { ticker: 'TLT', line: 'L1', qualified: true, taken: true, blockedBy: '' },
    { ticker: 'IWM', line: 'L2', qualified: true, taken: false, blockedBy: 'cluster cap' },
    { ticker: 'GLD', line: 'L3', qualified: false, taken: false, blockedBy: '' },
  ];
  const d = buildAgentDigest('Turtle', 'turtle', items);
  assert.equal(d.entered.length, 1);
  assert.equal(d.declined.length, 1);
  assert.equal(d.passed.length, 1);
  assert.equal(d.entered[0].ticker, 'TLT');
  assert.equal(d.declined[0].ticker, 'IWM');
});

test('buildAgentDigest puts all coil candidates under entered', () => {
  const items = [{ ticker: 'AAPL', line: 'L', qualified: true, taken: true, blockedBy: '' }];
  const d = buildAgentDigest('Coil', 'coil', items);
  assert.equal(d.entered.length, 1);
  assert.equal(d.declined.length, 0);
  assert.equal(d.passed.length, 0);
});

test('renderMarkdown shows the date and each agent section, silent sections omitted', () => {
  const digest = {
    date: '2026-06-03',
    agents: [
      buildAgentDigest('Turtle', 'turtle', [
        { ticker: 'TLT', line: 'Turtle TLT ENTER x', qualified: true, taken: true, blockedBy: '' },
      ]),
    ],
  };
  const md = renderMarkdown(digest);
  assert.match(md, /# Reasoning Digest — 2026-06-03/);
  assert.match(md, /## Turtle/);
  assert.match(md, /Turtle TLT ENTER x/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test agent/reasoning-digest.test.mjs`
Expected: FAIL — `Cannot find module './reasoning-digest.js'`.

- [ ] **Step 3: Implement the pure functions**

Create `agent/reasoning-digest.js`:

```javascript
// Coil/Turtle reasoning digest. Pure parsers/builders/renderer (Task 3) +
// injected-dep I/O (Task 4). Consumes ONLY the Go-computed Explain lines from
// /api/v1/turtle/status and /api/v1/meanrev/candidates — never re-derives a
// verdict, so a digest line can never contradict the agent.

import path from 'node:path';
import nodeFs from 'node:fs/promises';

// parseTurtleReasoning normalizes /api/v1/turtle/status → array of
// { ticker, line, qualified, taken, blockedBy }. Soft-empty on any missing shape.
export function parseTurtleReasoning(status) {
  const list = status && status.last_run && Array.isArray(status.last_run.reasoning)
    ? status.last_run.reasoning : [];
  return list.map((r) => ({
    ticker: String(r.ticker || ''),
    line: String(r.line || ''),
    qualified: !!r.setup_qualified,
    taken: !!r.taken,
    blockedBy: String(r.blocked_by || ''),
  }));
}

// parseCoilReasoning normalizes /api/v1/meanrev/candidates → entry-side items.
// Every candidate is an entry signal (the endpoint filters non-qualifiers).
export function parseCoilReasoning(resp) {
  const list = resp && Array.isArray(resp.candidates) ? resp.candidates : [];
  return list.map((c) => ({
    ticker: String(c.ticker || ''),
    line: String(c.explanation || ''),
    qualified: true,
    taken: true,
    blockedBy: '',
  }));
}

// buildAgentDigest groups normalized items. Turtle splits entered / qualified-
// but-declined / passed; Coil (kind 'coil') puts every candidate under entered.
export function buildAgentDigest(agentName, kind, items) {
  const all = Array.isArray(items) ? items : [];
  if (kind === 'coil') {
    return { agentName, kind, entered: all.slice(), declined: [], passed: [], all };
  }
  return {
    agentName, kind, all,
    entered: all.filter((i) => i.taken),
    declined: all.filter((i) => i.qualified && !i.taken),
    passed: all.filter((i) => !i.qualified && !i.taken),
  };
}

function section(title, items) {
  if (!items.length) return [];
  return [`### ${title} (${items.length})`, ...items.map((i) => `- ${i.line}`), ''];
}

// renderMarkdown turns a digest { date, agents:[buildAgentDigest...] } into a
// human-readable report. Empty sections are omitted (silent when nothing to say).
export function renderMarkdown(digest) {
  const lines = [`# Reasoning Digest — ${digest.date}`, ''];
  for (const a of digest.agents || []) {
    lines.push(`## ${a.agentName} (${a.kind})`, '');
    if (a.kind === 'coil') {
      lines.push(...section('Candidates', a.entered));
    } else {
      lines.push(...section('Entered', a.entered));
      lines.push(...section('Qualified but declined', a.declined));
      lines.push(...section('Passed', a.passed));
    }
    if (a.entered.length + a.declined.length + a.passed.length === 0) {
      lines.push('No evaluations.', '');
    }
  }
  return lines.join('\n') + '\n';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test agent/reasoning-digest.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add agent/reasoning-digest.js agent/reasoning-digest.test.mjs
git commit -m "feat(reasoning-digest): Node pure parsers/builders/renderer"
```

---

## Task 4: Node digest — injected-dep I/O (per-sandbox runner + report + summary reader)

**Files:**
- Modify: `agent/reasoning-digest.js`
- Test: `agent/reasoning-digest.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `agent/reasoning-digest.test.mjs`:

```javascript
import {
  runReasoningDigestForSandbox, readReasoningDigestSummary,
} from './reasoning-digest.js';

function fakeFs() {
  const files = new Map();
  return {
    files,
    mkdir: async () => {},
    writeFile: async (p, data) => { files.set(p, data); },
    readFile: async (p) => { if (!files.has(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return files.get(p); },
    readdir: async () => ['sbx_trend'],
  };
}

test('runReasoningDigestForSandbox writes a turtle digest from /turtle/status', async () => {
  const goAxios = { get: async (u) => {
    assert.equal(u, '/api/v1/turtle/status');
    return { data: { scheduler_enabled: true, last_run: { reasoning: [
      { ticker: 'TLT', line: 'Turtle TLT ENTER x', setup_qualified: true, taken: true },
    ] } } };
  } };
  const fs = fakeFs();
  const report = await runReasoningDigestForSandbox({
    goAxios, sandboxId: 'sbx_trend', strategy: 'trend', agentName: 'Turtle',
    isoDate: '2026-06-03', projectRoot: '/proj', fsImpl: fs,
  });
  assert.equal(report.agents[0].entered[0].ticker, 'TLT');
  const md = [...fs.files.keys()].find((k) => k.endsWith('2026-06-03.md'));
  assert.ok(md, 'wrote a markdown file');
});

test('runReasoningDigestForSandbox soft-fails to null on axios error', async () => {
  const goAxios = { get: async () => { throw new Error('bot down'); } };
  const report = await runReasoningDigestForSandbox({
    goAxios, sandboxId: 'sbx_trend', strategy: 'trend', agentName: 'Turtle',
    isoDate: '2026-06-03', projectRoot: '/proj', fsImpl: fakeFs(),
  });
  assert.equal(report, null);
});

test('runReasoningDigestForSandbox skips unknown strategies', async () => {
  const report = await runReasoningDigestForSandbox({
    goAxios: { get: async () => { throw new Error('should not be called'); } },
    sandboxId: 'sbx_x', strategy: 'v2-options', agentName: 'Prophet',
    isoDate: '2026-06-03', projectRoot: '/proj', fsImpl: fakeFs(),
  });
  assert.equal(report, null);
});

test('readReasoningDigestSummary aggregates per-sandbox reports, silent on missing', async () => {
  const fs = fakeFs();
  fs.files.set('/proj/data/reasoning-digest/sbx_trend/2026-06-03.json',
    JSON.stringify({ date: '2026-06-03', sandboxId: 'sbx_trend', agents: [] }));
  const summary = await readReasoningDigestSummary('/proj', { date: '2026-06-03' }, { fs });
  assert.equal(summary.date, '2026-06-03');
  assert.equal(summary.items.length, 1);
  const empty = await readReasoningDigestSummary('/proj', { date: '2026-01-01' }, { fs });
  assert.equal(empty.items.length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test agent/reasoning-digest.test.mjs`
Expected: FAIL — `runReasoningDigestForSandbox`/`readReasoningDigestSummary` not exported.

- [ ] **Step 3: Implement the I/O**

Append to `agent/reasoning-digest.js`:

```javascript
const STRATEGY_KIND = { 'trend': 'turtle', 'mean-rev-rsi2': 'coil' };

// runReasoningDigestForSandbox pulls the right Go endpoint for the agent's
// strategy, builds the per-agent digest, and writes
// data/reasoning-digest/<sandboxId>/<date>.{json,md}. Soft-fail: returns null
// (no report) on unknown strategy or any axios error, so the surface stays silent.
export async function runReasoningDigestForSandbox({
  goAxios, sandboxId, strategy, agentName, isoDate, projectRoot, fsImpl = nodeFs,
}) {
  const kind = STRATEGY_KIND[strategy];
  if (!kind) return null;

  let items;
  try {
    if (kind === 'turtle') {
      const resp = await goAxios.get('/api/v1/turtle/status', { timeout: 5000 });
      items = parseTurtleReasoning(resp && resp.data);
    } else {
      const resp = await goAxios.get('/api/v1/meanrev/candidates', { timeout: 5000 });
      items = parseCoilReasoning(resp && resp.data);
    }
  } catch {
    return null; // bot unreachable — soft-fail to silent
  }

  const agent = buildAgentDigest(agentName || sandboxId, kind, items);
  const report = { date: isoDate, sandboxId, agentName, strategy, generatedAt: new Date().toISOString(), agents: [agent] };

  const dir = path.join(projectRoot, 'data', 'reasoning-digest', sandboxId);
  await fsImpl.mkdir(dir, { recursive: true });
  await fsImpl.writeFile(path.join(dir, `${isoDate}.json`), JSON.stringify(report, null, 2), 'utf-8');
  await fsImpl.writeFile(path.join(dir, `${isoDate}.md`), renderMarkdown(report), 'utf-8');
  return report;
}

// readReasoningDigestSummary reads one sandbox's report or aggregates across all
// sandbox dirs for the date. Missing/unparseable reports contribute nothing.
export async function readReasoningDigestSummary(projectRoot, { date, sandboxId } = {}, { fs = nodeFs } = {}) {
  const root = path.join(projectRoot, 'data', 'reasoning-digest');
  let sandboxIds;
  if (sandboxId) {
    sandboxIds = [sandboxId];
  } else {
    try { sandboxIds = await fs.readdir(root); }
    catch { return { date, items: [] }; }
  }
  const items = [];
  for (const sid of sandboxIds) {
    let raw;
    try { raw = await fs.readFile(path.join(root, sid, `${date}.json`), 'utf-8'); }
    catch { continue; }
    try { items.push(JSON.parse(raw)); } catch { continue; }
  }
  return { date, items };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test agent/reasoning-digest.test.mjs`
Expected: PASS (9 tests total).

- [ ] **Step 5: Commit**

```bash
git add agent/reasoning-digest.js agent/reasoning-digest.test.mjs
git commit -m "feat(reasoning-digest): Node per-sandbox runner + report + summary reader"
```

---

## Task 5: server.js — cross-sandbox runner, scheduler injection, read endpoint

**Files:**
- Modify: `agent/server.js:45` (import), `:169-204` (runner + scheduler), `:961-975` (endpoint area)

- [ ] **Step 1: Add the import**

After the existing reconciliation import (`agent/server.js:45`):

```javascript
import { runReconciliationForSandbox, readReconciliationSummary } from './trade-reconciliation.js';
import { runReasoningDigestForSandbox, readReasoningDigestSummary } from './reasoning-digest.js';
```

- [ ] **Step 2: Add the cross-sandbox runner**

After `runTradeReconciliationAllSandboxes` (ends `agent/server.js:193`), add:

```javascript
// Cross-sandbox reasoning-digest runner injected into the scheduler. Iterates
// running sandboxes, resolves each one's strategy + goAxios, and writes a daily
// teaching digest for the mechanical agents (Turtle, Coil). Other strategies are
// skipped by runReasoningDigestForSandbox. Gated by REASONING_DIGEST_ENABLED
// (default OFF). Soft-fail per sandbox.
async function runReasoningDigestAllSandboxes(isoDate) {
  if (process.env.REASONING_DIGEST_ENABLED !== 'true') return; // default OFF
  for (const runtime of orchestrator.runtimes.values()) {
    try {
      const sandboxId = runtime?.harness?.sandboxId;
      if (!sandboxId) continue;
      const resolved = getResolvedAgentForSandbox(sandboxId);
      const strategy = resolved?.strategyId;
      const goAxios = runtime.goAxios;
      if (!strategy || !goAxios) continue;
      await runReasoningDigestForSandbox({
        goAxios, sandboxId, strategy, agentName: resolved?.name,
        isoDate, projectRoot: PROJECT_ROOT, fsImpl: nodeFs,
      });
    } catch {
      // soft-fail per sandbox — one bot down must not abort the rest
    }
  }
}
```

- [ ] **Step 3: Inject into the scheduler**

In the `new AnalysisScheduler({ ... })` options (`agent/server.js:196-204`), add the callback alongside `runTradeReconciliation`:

```javascript
  runTradeReconciliation: runTradeReconciliationAllSandboxes,
  runReasoningDigest: runReasoningDigestAllSandboxes,
});
```

- [ ] **Step 4: Add the read endpoint**

After the `/api/reconciliation` handler (`agent/server.js:975`), add:

```javascript
// GET /api/reasoning-digest?date=&sandboxId= — the day's Coil/Turtle teaching
// digest. Silent (empty items) when no report exists. Report-only.
app.get('/api/reasoning-digest', async (req, res) => {
  const _etFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
  const today = _etFmt.format(new Date());
  const date = String(req.query.date || today);
  const sandboxId = req.query.sandboxId ? String(req.query.sandboxId) : undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  }
  try {
    const summary = await readReasoningDigestSummary(PROJECT_ROOT, { date, sandboxId }, { fs: nodeFs });
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 5: Verify the server parses**

Run: `node --check agent/server.js`
Expected: no output (syntax OK).

- [ ] **Step 6: Commit**

```bash
git add agent/server.js
git commit -m "feat(reasoning-digest): server runner, scheduler injection, read endpoint"
```

---

## Task 6: analysis-scheduler.js — job registration, trigger, runner method

**Files:**
- Modify: `agent/analysis-scheduler.js:277` (inject), `:300` (state), `:344-351` (validJobs), `:419-421` (dispatch), `:1033-1035` (trigger), `:1099-1106` (method)

- [ ] **Step 1: Inject the callback + add state**

After `this._runTradeReconciliationFn = options.runTradeReconciliation || null;` (`:277`):

```javascript
    this._runTradeReconciliationFn = options.runTradeReconciliation || null;
    this._runReasoningDigestFn = options.runReasoningDigest || null;
```

After `this._lastTradeReconcileDate = null;` (`:300`):

```javascript
    this._lastTradeReconcileDate = null; // YYYY-MM-DD (daily after-close reconciliation)
    this._lastReasoningDigestDate = null; // YYYY-MM-DD (daily after-close reasoning digest)
```

- [ ] **Step 2: Register the job name**

In the `validJobs` array (`:344-351`), add `'reasoning_digest'`:

```javascript
      'trade_reconciliation',
      'reasoning_digest',
    ];
```

- [ ] **Step 3: Add the dispatch branch**

After the `trade_reconciliation` dispatch branch (`:419-421`):

```javascript
      } else if (jobName === 'trade_reconciliation') {
        this._lastTradeReconcileDate = isoDate;
        await this._runTradeReconciliation(isoDate);
      } else if (jobName === 'reasoning_digest') {
        this._lastReasoningDigestDate = isoDate;
        await this._runReasoningDigest(isoDate);
```

- [ ] **Step 4: Add the schedule trigger (16:55 ET)**

After the cost-report block (`:1050`), before the Sunday block (`:1052`):

```javascript
    // Daily Coil/Turtle reasoning digest — 4:55 PM ET, after reconciliation +
    // cost report settle. No-op unless REASONING_DIGEST_ENABLED=true (the runner
    // self-gates). Idempotent per ET day.
    if (isWeekday && hour === 16 && minute === 55 && this._lastReasoningDigestDate !== isoDate) {
      await this.triggerJob('reasoning_digest').catch(() => {});
    }
```

- [ ] **Step 5: Add the runner method**

After `_runTradeReconciliation` (`:1106`):

```javascript
  // reasoning_digest: delegates to the injected cross-sandbox runner (it needs
  // per-sandbox goAxios the scheduler does not hold). Soft-fail: the runner
  // self-gates on REASONING_DIGEST_ENABLED and reports per-sandbox.
  async _runReasoningDigest(isoDate) {
    this._log(`Starting reasoning_digest for ${isoDate}...`, 'info');
    this.emit('scheduler_job_start', { job: 'reasoning_digest', date: isoDate });
    if (typeof this._runReasoningDigestFn === 'function') {
      await this._runReasoningDigestFn(isoDate);
    }
    this._log(`reasoning_digest complete for ${isoDate}.`, 'success');
  }
```

- [ ] **Step 6: Verify parse + existing scheduler tests**

Run: `node --check agent/analysis-scheduler.js ; node --test agent/analysis-scheduler.test.mjs`
Expected: parse OK; existing scheduler tests still pass.

- [ ] **Step 7: Commit**

```bash
git add agent/analysis-scheduler.js
git commit -m "feat(reasoning-digest): scheduler job at 16:55 ET (flag-gated runner)"
```

---

## Task 7: Dashboard section

**Files:**
- Modify: `agent/public/index.html` (near the reconciliation fetch at `:3161`)

- [ ] **Step 1: Add a fetch + render for the digest**

Locate the reconciliation banner fetch (`agent/public/index.html:3161`, `fetch('/api/reconciliation?date=' + ...)`). Immediately after that function/block, add a sibling loader. Use the same `date` variable in scope; render into a container appended near the reconciliation banner:

```javascript
    // Reasoning digest (Coil/Turtle teaching lines) — silent when absent.
    try {
      const rdRes = await fetch('/api/reasoning-digest?date=' + encodeURIComponent(date));
      const rd = await rdRes.json();
      const host = document.getElementById('reasoning-digest');
      if (host) {
        const reports = (rd.items || []).filter((r) => (r.agents || []).some((a) =>
          a.entered.length + a.declined.length + a.passed.length > 0));
        if (!reports.length) {
          host.innerHTML = '';
        } else {
          const parts = [`<details class="reasoning-digest"><summary>Reasoning digest — ${rd.date}</summary>`];
          for (const r of reports) {
            for (const a of r.agents) {
              const rows = [...a.entered, ...a.declined, ...a.passed];
              if (!rows.length) continue;
              parts.push(`<div class="rd-agent"><strong>${a.agentName}</strong><ul>` +
                rows.map((i) => `<li>${i.line.replace(/</g, '&lt;')}</li>`).join('') + '</ul></div>');
            }
          }
          parts.push('</details>');
          host.innerHTML = parts.join('');
        }
      }
    } catch { /* silent — dashboard never breaks on the digest */ }
```

- [ ] **Step 2: Add the container element**

Add an empty host element next to the reconciliation banner container in the Trades-tab markup:

```html
<div id="reasoning-digest"></div>
```

- [ ] **Step 3: Manual verification (no jsdom in repo)**

Run: `node --check` is N/A for HTML. Verify by grep that the element id and fetch are present:
Run: `rg "reasoning-digest" agent/public/index.html`
Expected: both the `<div id="reasoning-digest">` and the `fetch('/api/reasoning-digest...` lines appear.
Note in the commit body that browser-render eyeballing is pending (consistent with the reconciliation banner, which also had no jsdom test).

- [ ] **Step 4: Commit**

```bash
git add agent/public/index.html
git commit -m "feat(reasoning-digest): dashboard section (silent when absent)"
```

---

## Task 8: Full integration verification

**Files:** none (verification only)

- [ ] **Step 1: Go — build, vet, test**

Run: `go build ./... ; go vet ./services/ ; go test ./services/`
Expected: all green.

- [ ] **Step 2: Node — checks + targeted tests**

Run: `node --check agent/server.js ; node --check agent/analysis-scheduler.js ; node --test agent/reasoning-digest.test.mjs`
Expected: parse OK; 9 digest tests pass.

- [ ] **Step 3: Node — full suite (no regressions)**

Run: `node --test agent/*.test.mjs`
Expected: full suite green (the prior baseline was ~575+ passing).

- [ ] **Step 4: Commit any fixups** (only if Steps 1-3 required changes)

```bash
git add -A
git commit -m "test(reasoning-digest): integration fixups"
```

---

## Task 9: Squash to one commit (ask user first)

**Files:** none (git history only)

- [ ] **Step 1: Confirm with the user** before rewriting branch history.

- [ ] **Step 2: Squash all branch commits (incl. core `62bdbb4`) into one**

```bash
git reset --soft $(git merge-base coil-turtle-reasoning-digest main)
git commit -m "feat(reasoning-digest): daily Coil/Turtle teaching digest

Always-on Go emit (Turtle HeartbeatResult.Reasoning via /turtle/status; Coil
Explanation on meanrev signals) + a flag-gated Node after-close job
(REASONING_DIGEST_ENABLED, default OFF) that writes
data/reasoning-digest/<sandbox>/<date>.{md,json}, a read endpoint, and a
dashboard section. Formatters consume authoritative signal verdicts and never
re-derive. Spec + plan under docs/superpowers/.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 3: Verify the squashed tree still builds + tests**

Run: `go build ./... ; go test ./services/ ; node --test agent/reasoning-digest.test.mjs`
Expected: all green.

- [ ] **Step 4:** Hand back to the user for merge-to-main decision (do NOT merge without approval; audit main first per the concurrent-session rule).

---

## Self-review

**Spec coverage:** Unit 1 Turtle emit → Task 2 (+ `/turtle/status` already returns it, verified). Unit 2 Coil emit → Task 1 (+ controller unchanged, verified). Unit 3 Node job → Tasks 3-4. Surface (scheduler 4:5x ET + read endpoint + dashboard) → Tasks 5-7. Flag default OFF → Task 5 Step 2 (`!== 'true'`). Squash-at-end → Task 9. Testing plan → tests in Tasks 1-4 + integration Task 8. All spec sections mapped.

**Placeholder scan:** No TBD/TODO/"handle edge cases". The one struct-field caveat in Task 2 Step 4 (`qual, _ bool` → `qual bool`) is called out explicitly with the verbatim final struct. Dashboard task notes the genuine no-jsdom limitation (matches the reconciliation banner precedent), not a placeholder.

**Type consistency:** Go `TickerRationale` json tags (`ticker`/`line`/`setup_qualified`/`taken`/`blocked_by`) match the Node `parseTurtleReasoning` reads. `MeanRevSignal.Explanation` json `explanation` matches `parseCoilReasoning`'s `c.explanation`. Strategy IDs `'trend'`/`'mean-rev-rsi2'` match `STRATEGY_KIND` and `config-store.js`. `runReasoningDigestForSandbox` / `readReasoningDigestSummary` names consistent across server.js wiring and tests. Scheduler `runReasoningDigest` option key matches server.js injection and `_runReasoningDigestFn`.
