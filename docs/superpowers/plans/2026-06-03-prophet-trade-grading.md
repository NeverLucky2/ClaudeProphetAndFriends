# Per-Trade Thesis-vs-Outcome Grading — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-grade each closed trade on whether its thesis played out, separated from whether it made money (process-vs-outcome quadrant), with a free deterministic grade for all agents and a cheap batched Haiku enrichment for Prophet's narrative thesis.

**Architecture:** Mirrors `review-performance` (Node preprocess + LLM skill). A Node script (`scripts/trade-grades.mjs`) builds deterministic outcome cards + grades for every agent's closed trades (reusing `managed-position-repair.mjs` + `apply-friction.mjs` + `trade-ledger.mjs`) and writes a `cards.json` spine + a complete deterministic report. The scheduler runs it daily; only if Prophet closed a trade does it invoke the `trade-grader` Haiku skill to enrich Prophet's entries with catalyst/timing grades. Surface = report file + `GET /api/trade-grades` + a Trades-tab card, mirroring the merged Task-2 reasoning-digest.

**Tech Stack:** Node ESM (`node --test`, `node:sqlite` `DatabaseSync` readOnly), the scheduler's `_runSkill(..., HAIKU_MODEL)` path, a `.claude/skills/trade-grader/SKILL.md`.

**Spec:** `docs/superpowers/specs/2026-06-03-prophet-trade-grading-design.md`

**Commit policy:** One working commit per task on branch `prophet-trade-grading`; Task 8 squashes them (with the spec) into one `feat(trade-grading)` commit. Ask the user before the final squash/merge (audit main first — concurrent session).

**Reuse contracts (existing, verified):**
- `scripts/managed-position-repair.mjs`: `readClosedManagedPositions(dbPath)` → array of `{positionId, symbol, side, agentStrategy, entryPrice, stopLossPrice, takeProfitPrice, exitPrice, realizedPnl, realizedPnlPct, quantity, storedStatus, notes, createdAt, closedAt}`; `deriveExitReason(p)` → `{derived ∈ {stop,target,signal_or_time,reconciled,indeterminate}, mislabeled, basis}`; `resolveSandboxDbPaths(projectRoot, agentId)`; `parseManagedTimestamp(s)` → ms.
- `scripts/trade-ledger.mjs`: `toFrictionAction(position, agentId)` → `{symbol, reasoning, market_data:{entry_price, exit_price, size, unrealized_pl, unrealized_pct}}`.
- `scripts/apply-friction.mjs`: `applyFriction`, `loadFrictionConfig` (sets `market_data.friction_adjusted_pl`).
- Prophet agent id = `'default'`; decisive_actions at `data/sandboxes/<accountId>/decisive_actions/<ts>_<action>[_<symbol>].json` = `{action, symbol?, reasoning, ...}`.

---

## Branch setup (do first)

- [ ] Create the branch off current main:
```bash
git checkout main && git checkout -b prophet-trade-grading
```

---

## File structure

- Create `scripts/trade-grades.mjs` — Node: pure grading core (Task 1) + I/O/assembly (Task 2).
- Create `scripts/trade-grades.test.mjs` — node:test.
- Create `.claude/skills/trade-grader/SKILL.md` — Haiku enrichment skill (Task 3).
- Modify `agent/server.js` — `GET /api/trade-grades` (Task 4).
- Modify `agent/analysis-scheduler.js` — `trade_grading` job + `_runTradeGrading` (Task 5).
- Modify `agent/public/index.html` — Trades-tab grade card (Task 6).

---

## Task 1: Deterministic grading core (pure)

**Files:**
- Create: `scripts/trade-grades.mjs`
- Test: `scripts/trade-grades.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `scripts/trade-grades.test.mjs`:
```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOutcomeCard, gradeMechanical, hasProphetCloses } from './trade-grades.mjs';

const basePos = {
  symbol: 'AAPL', side: 'buy', agentStrategy: 'v2-options',
  entryPrice: 10, exitPrice: 12, stopLossPrice: 8, takeProfitPrice: 12,
  realizedPnl: 200, realizedPnlPct: 0.2, quantity: 1, storedStatus: 'CLOSED',
  notes: '', createdAt: '2026-05-20 14:00:00.000-05:00', closedAt: '2026-05-20 15:30:00.000-05:00',
};

test('buildOutcomeCard composes card with derived exit reason and hold time', () => {
  const card = buildOutcomeCard(basePos, 'Prophet', 180);
  assert.equal(card.agent, 'Prophet');
  assert.equal(card.symbol, 'AAPL');
  assert.equal(card.exitReason, 'target');     // exit==target band
  assert.equal(card.frictionPnl, 180);
  assert.equal(card.holdMinutes, 90);
});

test('gradeMechanical maps all five exit-reason states', () => {
  const mk = (exitReason, pnl) => gradeMechanical({ exitReason, frictionPnl: pnl });
  assert.equal(mk('target', 180).thesisPlayedOut, 'played');
  assert.equal(mk('target', 180).quadrant, 'earned_win');
  assert.equal(mk('stop', -50).thesisPlayedOut, 'broke');
  assert.equal(mk('stop', -50).quadrant, 'clean_miss');
  assert.equal(mk('stop', 30).quadrant, 'lucky');       // broke but green
  assert.equal(mk('target', -10).quadrant, 'unlucky');  // played but red
  assert.equal(mk('signal_or_time', 40).thesisPlayedOut, 'inconclusive');
  assert.equal(mk('signal_or_time', 40).quadrant, 'inconclusive_win');
  assert.equal(mk('reconciled', -5).thesisPlayedOut, 'inconclusive');
  assert.equal(mk('reconciled', -5).quadrant, 'inconclusive_loss');
  assert.match(mk('reconciled', -5).lesson, /reconciliation/i);
  assert.equal(mk('indeterminate', 0).thesisPlayedOut, 'inconclusive');
});

test('hasProphetCloses counts only the Prophet (default) cards', () => {
  const cards = [
    { agent: 'Prophet', agentId: 'default' },
    { agent: 'Turtle', agentId: 'trend' },
  ];
  assert.equal(hasProphetCloses(cards), 1);
  assert.equal(hasProphetCloses([{ agent: 'Turtle', agentId: 'trend' }]), 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/trade-grades.test.mjs`
Expected: FAIL — `Cannot find module './trade-grades.mjs'`.

- [ ] **Step 3: Implement the pure core**

Create `scripts/trade-grades.mjs`:
```javascript
// Per-trade thesis-vs-outcome grading. Deterministic core (Task 1) + assembly/IO
// (Task 2). Reuses managed-position-repair + apply-friction + trade-ledger — never
// re-derives. The LLM `trade-grader` skill enriches Prophet cards afterward.

import {
  readClosedManagedPositions, deriveExitReason, resolveSandboxDbPaths, parseManagedTimestamp,
} from './managed-position-repair.mjs';
import { toFrictionAction } from './trade-ledger.mjs';
import { applyFriction, loadFrictionConfig } from './apply-friction.mjs';
import path from 'node:path';
import nodeFs from 'node:fs/promises';

// buildOutcomeCard — pure. `frictionPnl` is the friction-adjusted dollar P&L
// (computed by the caller via toFrictionAction+applyFriction). exitReason and
// holdMinutes are derived from the stored position.
export function buildOutcomeCard(position, agent, frictionPnl) {
  const exitReason = deriveExitReason(position).derived;
  const openMs = parseManagedTimestamp(position.createdAt);
  const closeMs = parseManagedTimestamp(position.closedAt);
  const holdMinutes = (Number.isFinite(openMs) && Number.isFinite(closeMs))
    ? Math.round((closeMs - openMs) / 60000) : null;
  return {
    agent,
    symbol: position.symbol,
    side: position.side,
    entryPrice: position.entryPrice,
    exitPrice: position.exitPrice,
    holdMinutes,
    frictionPnl: Number.isFinite(frictionPnl) ? frictionPnl : position.realizedPnl,
    frictionPnlPct: position.realizedPnlPct,
    exitReason,
  };
}

// Map an exit reason to the signal-level thesis verdict (Tier-1: all five states).
const PLAYED_OUT_BY_REASON = {
  target: 'played',
  stop: 'broke',
  signal_or_time: 'inconclusive',
  reconciled: 'inconclusive',
  indeterminate: 'inconclusive',
};

// gradeMechanical — pure. exitReason + P&L sign → {thesisPlayedOut, quadrant, lesson}.
// Quadrant is one of the 8 cells in the spec grade table.
export function gradeMechanical(card) {
  const played = PLAYED_OUT_BY_REASON[card.exitReason] || 'inconclusive';
  const green = Number(card.frictionPnl) >= 0;
  let quadrant, lesson;
  if (played === 'played') {
    quadrant = green ? 'earned_win' : 'unlucky';
    lesson = green ? 'Thesis hit its target and paid — repeatable.'
                   : 'Target logic was right but the trade still lost — process over outcome; keep it.';
  } else if (played === 'broke') {
    quadrant = green ? 'lucky' : 'clean_miss';
    lesson = green ? 'Stopped out yet green — luck, not skill; do not reinforce.'
                   : 'Thesis broke and it cost money — the clean miss to learn from.';
  } else { // inconclusive
    quadrant = green ? 'inconclusive_win' : 'inconclusive_loss';
    lesson = card.exitReason === 'reconciled'
      ? 'Closed by reconciliation, not a strategy decision — no read on the thesis.'
      : 'Exited on time/signal before the thesis resolved — no clean read on process.';
  }
  return { thesisPlayedOut: played, quadrant, lesson };
}

// hasProphetCloses — the cost-gate. Counts cards from the Prophet (`default`) agent.
export function hasProphetCloses(cards) {
  return (cards || []).filter((c) => c.agentId === 'default').length;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/trade-grades.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**
```bash
git add scripts/trade-grades.mjs scripts/trade-grades.test.mjs
git commit -m "feat(trade-grading): deterministic outcome-card + quadrant core"
```
(End commit body with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`)

---

## Task 2: Assembly + thesis gathering + report I/O + CLI

**Files:**
- Modify: `scripts/trade-grades.mjs`
- Test: `scripts/trade-grades.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `scripts/trade-grades.test.mjs`:
```javascript
import {
  gatherProphetTheses, renderMarkdown, writeTradeGradesReport, readTradeGradesSummary,
} from './trade-grades.mjs';

test('gatherProphetTheses scopes decisive actions to the card symbol', () => {
  const actions = [
    { action: 'buy', symbol: 'AAPL', reasoning: 'earnings catalyst Friday' },
    { action: 'buy', symbol: 'TSLA', reasoning: 'unrelated' },
    { action: 'close', symbol: 'AAPL', reasoning: 'took profit' },
  ];
  const got = gatherProphetTheses({ symbol: 'AAPL' }, actions);
  assert.equal(got.length, 2);
  assert.deepEqual(got.map((a) => a.action), ['buy', 'close']);
});

test('renderMarkdown shows the quadrant per trade, silent when empty', () => {
  const report = { date: '2026-06-03', sandboxId: 's', agentName: 'Prophet', grades: [
    { agent: 'Prophet', symbol: 'AAPL', exitReason: 'target', thesisPlayedOut: 'played',
      quadrant: 'earned_win', frictionPnl: 180, lesson: 'L' },
  ] };
  const md = renderMarkdown(report);
  assert.match(md, /# Trade Grades — 2026-06-03/);
  assert.match(md, /AAPL/);
  assert.match(md, /earned_win/);
});

test('writeTradeGradesReport + readTradeGradesSummary round-trip', async () => {
  const files = new Map();
  const fs = {
    mkdir: async () => {},
    writeFile: async (p, d) => files.set(p.replaceAll('\\\\', '/'), d),
    readFile: async (p) => { const k = p.replaceAll('\\\\', '/'); if (!files.has(k)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return files.get(k); },
    readdir: async () => ['sbx_a'],
  };
  const report = { date: '2026-06-03', sandboxId: 'sbx_a', agentName: 'Prophet', grades: [] };
  await writeTradeGradesReport('/proj', report, { fs });
  const summary = await readTradeGradesSummary('/proj', { date: '2026-06-03' }, { fs });
  assert.equal(summary.items.length, 1);
  assert.equal(summary.items[0].sandboxId, 'sbx_a');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/trade-grades.test.mjs`
Expected: FAIL — the four new exports are undefined.

- [ ] **Step 3: Implement assembly + I/O**

Append to `scripts/trade-grades.mjs`:
```javascript
// gatherProphetTheses — pure. Returns the decisive_actions whose symbol matches the
// card's symbol (the skill does final pairing + judgment; this only scopes input).
export function gatherProphetTheses(card, decisiveActions) {
  const sym = String(card.symbol || '').toUpperCase();
  return (decisiveActions || []).filter((a) => String(a.symbol || '').toUpperCase() === sym);
}

function quadrantLabel(q) {
  return ({
    earned_win: 'Earned win', lucky: 'Lucky', unlucky: 'Unlucky', clean_miss: 'Clean miss',
    partial_win: 'Partial (green)', partial_loss: 'Partial (red)',
    inconclusive_win: 'Inconclusive (green)', inconclusive_loss: 'Inconclusive (red)',
  })[q] || q;
}

// renderMarkdown — pure. One line per graded trade, grouped by agent. Empty → a stub.
export function renderMarkdown(report) {
  const lines = [`# Trade Grades — ${report.date}`, ''];
  const grades = report.grades || [];
  if (!grades.length) return lines.concat(['No closed trades graded.', '']).join('\\n') + '\\n';
  const byAgent = new Map();
  for (const g of grades) { if (!byAgent.has(g.agent)) byAgent.set(g.agent, []); byAgent.get(g.agent).push(g); }
  for (const [agent, gs] of byAgent) {
    lines.push(`## ${agent}`, '');
    for (const g of gs) {
      const pnl = Number(g.frictionPnl) >= 0 ? `+$${Number(g.frictionPnl).toFixed(0)}` : `-$${Math.abs(Number(g.frictionPnl)).toFixed(0)}`;
      lines.push(`- **${g.symbol}** ${quadrantLabel(g.quadrant)} (${g.exitReason}, ${pnl}) — ${g.lesson}`);
    }
    lines.push('');
  }
  return lines.join('\\n') + '\\n';
}

// writeTradeGradesReport — injected-fs I/O. Writes data/trade-grades/<sandbox>/<date>.{json,md}.
export async function writeTradeGradesReport(projectRoot, report, { fs = nodeFs } = {}) {
  const dir = path.join(projectRoot, 'data', 'trade-grades', report.sandboxId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${report.date}.json`), JSON.stringify(report, null, 2), 'utf-8');
  await fs.writeFile(path.join(dir, `${report.date}.md`), renderMarkdown(report), 'utf-8');
  return report;
}

// readTradeGradesSummary — aggregates reports across sandbox dirs for a date. Missing/
// unparseable → contribute nothing (silent-when-clean). Mirrors readReasoningDigestSummary.
export async function readTradeGradesSummary(projectRoot, { date, sandboxId } = {}, { fs = nodeFs } = {}) {
  const root = path.join(projectRoot, 'data', 'trade-grades');
  let ids;
  if (sandboxId) ids = [sandboxId];
  else { try { ids = await fs.readdir(root); } catch { return { date, items: [] }; } }
  const items = [];
  for (const sid of ids) {
    let raw;
    try { raw = await fs.readFile(path.join(root, sid, `${date}.json`), 'utf-8'); } catch { continue; }
    try { items.push(JSON.parse(raw)); } catch { continue; }
  }
  return { date, items };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/trade-grades.test.mjs`
Expected: PASS (6 tests total).

- [ ] **Step 5: Add the CLI entrypoint (preprocessor + cost-gate signal)**

Append to `scripts/trade-grades.mjs`. This is the scheduler's preprocessor: it reads each Prophet+mechanical sandbox's closed positions, builds cards + deterministic grades, writes `cards.json` + the deterministic report, and prints the cost-gate line `PROPHET_CLOSES=<n>` for the scheduler.
```javascript
// readDecisiveActions — read a sandbox's decisive_actions/*.json (best-effort).
async function readDecisiveActions(sandboxDir, { fs = nodeFs } = {}) {
  const dir = path.join(sandboxDir, 'decisive_actions');
  let names; try { names = await fs.readdir(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    try { out.push(JSON.parse(await fs.readFile(path.join(dir, n), 'utf-8'))); } catch { /* skip */ }
  }
  return out;
}

// AGENTS maps the strategy/agent id → display + whether it is the LLM-graded Prophet.
const ET_DAY = (s) => { const ms = parseManagedTimestamp(s); return Number.isFinite(ms)
  ? new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) : null; };

// runForSandbox — build the cards + deterministic report for one sandbox+agent and the
// given ET date. agentId 'default' ⇒ Prophet (theses gathered); else mechanical.
export async function runForSandbox({ projectRoot, sandboxId, dbPath, sandboxDir, agentId, agentName, date, fs = nodeFs }) {
  let positions; try { positions = readClosedManagedPositions(dbPath); } catch { return null; }
  const closedToday = positions.filter((p) => ET_DAY(p.closedAt) === date);
  if (!closedToday.length) return null;
  const frictionCfg = await loadFrictionConfig();
  const decisive = agentId === 'default' ? await readDecisiveActions(sandboxDir, { fs }) : [];
  const grades = closedToday.map((p) => {
    const action = toFrictionAction(p, agentId);
    applyFriction(action, frictionCfg);
    const fpnl = action.market_data?.friction_adjusted_pl;
    const card = buildOutcomeCard(p, agentName, fpnl);
    const det = gradeMechanical(card);
    const g = { ...card, ...det, agentId };
    if (agentId === 'default') g.candidateTheses = gatherProphetTheses(card, decisive);
    return g;
  });
  const report = { date, sandboxId, agentName, agentId, generatedAt: new Date().toISOString(), grades };
  await writeTradeGradesReport(projectRoot, report, { fs });
  // cards.json spine for the skill (same content; separate name so the skill never races the .md)
  const dir = path.join(projectRoot, 'data', 'trade-grades', sandboxId);
  await fs.writeFile(path.join(dir, `${date}.cards.json`), JSON.stringify(report, null, 2), 'utf-8');
  return report;
}

// CLI: node scripts/trade-grades.mjs --date YYYY-MM-DD  (defaults to today ET)
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('trade-grades.mjs')) {
  const dateArg = (process.argv.find((a) => a.startsWith('--date=')) || '').split('=')[1];
  const date = dateArg || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const projectRoot = process.cwd();
  // Resolve sandboxes per agent and run. resolveSandboxDbPaths returns [{sandboxId, dbPath, sandboxDir}].
  const AGENTS = [
    { agentId: 'default', agentName: 'Prophet' },
    { agentId: 'trend', agentName: 'Turtle' },
    { agentId: 'mean-rev-rsi2', agentName: 'Coil' },
  ];
  const all = [];
  for (const a of AGENTS) {
    let sandboxes; try { sandboxes = resolveSandboxDbPaths(projectRoot, a.agentId); } catch { sandboxes = []; }
    for (const s of sandboxes) {
      const r = await runForSandbox({ projectRoot, sandboxId: s.sandboxId, dbPath: s.dbPath, sandboxDir: s.sandboxDir, agentId: a.agentId, agentName: a.agentName, date });
      if (r) all.push(...r.grades);
    }
  }
  process.stdout.write(`PROPHET_CLOSES=${hasProphetCloses(all)}\\n`);
}
```
NOTE: confirm `resolveSandboxDbPaths` return shape during this step (it must yield `{sandboxId, dbPath, sandboxDir}`; if it returns only db paths, derive `sandboxDir = path.dirname(dbPath)` and `sandboxId` from that dir name). Adjust the destructuring to the real shape — do not invent fields.

- [ ] **Step 6: Run the suite + a real dry-run**

Run: `node --test scripts/trade-grades.test.mjs` (expect 6 pass)
Run: `node scripts/trade-grades.mjs --date=2026-05-20` (expect it to print `PROPHET_CLOSES=<n>` and not throw; writes under `data/trade-grades/` if any sandbox had closes that day)

- [ ] **Step 7: Commit**
```bash
git add scripts/trade-grades.mjs scripts/trade-grades.test.mjs
git commit -m "feat(trade-grading): sandbox assembly, thesis scoping, report IO, CLI cost-gate"
```

---

## Task 3: `trade-grader` Haiku skill (Prophet enrichment)

**Files:**
- Create: `.claude/skills/trade-grader/SKILL.md`

- [ ] **Step 1: Write the skill**

Create `.claude/skills/trade-grader/SKILL.md`:
```markdown
---
name: trade-grader
description: Enrich Prophet's per-trade grades with a thesis-vs-outcome read (catalyst/timing played out?), batched over one ET day's closed trades. Reads the deterministic cards.json the scheduler already wrote; never re-derives outcomes; never invents data the card lacks.
allowed-tools: Read Glob Write
---

You grade Prophet's CLOSED trades for one ET day on whether the entry THESIS played out —
separate from whether the trade made money. Process over outcome.

## Step 1 — Load the prepared cards
The scheduler has already run `scripts/trade-grades.mjs --date <DATE>`. For every Prophet
sandbox (agent id `default`), read `data/trade-grades/<sandboxId>/<DATE>.cards.json`. Each
file has `grades[]`; the Prophet entries carry `candidateTheses[]` (decisive_actions with
`reasoning`). Only grade entries where `agentId === 'default'`. If no such file or no Prophet
grades, output "No Prophet trades to grade for <DATE>." and STOP (write nothing).

## Step 2 — For each Prophet trade, judge the thesis
Using the trade's `candidateTheses` reasoning (the entry thesis) and the outcome card
(`exitReason`, `frictionPnl`, `holdMinutes`, entry/exit price), decide:
- `catalyst`: played | partial | failed — did the named catalyst in the thesis actually
  materialize, judged against the price move + exit reason? If the thesis names no catalyst,
  use `not_assessed`.
- `timing`: played | partial | failed — did it resolve within the window the thesis implied
  (use holdMinutes vs any stated horizon)? If none stated, `not_assessed`.
- `iv`: **`not_assessed`** unless the card carries explicit entry AND exit IV (it does not
  today). NEVER invent an IV verdict. Do not infer IV from P&L.
- Keep the deterministic `thesisPlayedOut`/`quadrant` from the card UNLESS the narrative
  clearly contradicts it; if you change it, it must stay one of the 8 spec quadrants and you
  must say why in the lesson.
- `lesson`: one sentence, specific to this trade, process-focused.

## Step 3 — Write the enriched report
For each Prophet sandbox, overwrite `data/trade-grades/<sandboxId>/<DATE>.json` with the same
shape the deterministic report had, but each Prophet grade now also has
`{ catalyst, timing, iv, lesson }` (mechanical agents' grades pass through unchanged). Also
overwrite `<DATE>.md` re-rendering the same lines plus, for Prophet trades, a sub-line
`catalyst=<>, timing=<>, iv=<>`.

Report-only. Never edit rules, never place orders, never touch any file outside
`data/trade-grades/`.
```

- [ ] **Step 2: Verify the no-fabrication guard is present (contract check)**

Run: `grep -n "not_assessed\\|NEVER invent" .claude/skills/trade-grader/SKILL.md`
Expected: both the `iv` default and the "NEVER invent an IV verdict" instruction appear (the Tier-1 grounding fix). There is no automated test for an LLM skill; this grep is the contract check.

- [ ] **Step 3: Commit**
```bash
git add .claude/skills/trade-grader/SKILL.md
git commit -m "feat(trade-grading): trade-grader Haiku skill (grounded, no fabricated IV)"
```

---

## Task 4: Read endpoint (`agent/server.js`)

**Files:**
- Modify: `agent/server.js` (import near the reasoning-digest import; endpoint after `/api/reasoning-digest`)

- [ ] **Step 1: Add the import**

Find:
```javascript
import { runReasoningDigestForSandbox, readReasoningDigestSummary } from './reasoning-digest.js';
```
Insert immediately after:
```javascript
import { readTradeGradesSummary } from '../scripts/trade-grades.mjs';
```

- [ ] **Step 2: Add the endpoint**

Find the `app.get('/api/reasoning-digest', …)` handler and its closing `});`. Insert immediately after:
```javascript

// GET /api/trade-grades?date=&sandboxId= — per-trade thesis-vs-outcome grades. Silent
// (empty items) when no report exists. Report-only.
app.get('/api/trade-grades', async (req, res) => {
  const _etFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
  const today = _etFmt.format(new Date());
  const date = String(req.query.date || today);
  const sandboxId = req.query.sandboxId ? String(req.query.sandboxId) : undefined;
  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  }
  try {
    const summary = await readTradeGradesSummary(PROJECT_ROOT, { date, sandboxId }, { fs: nodeFs });
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 3: Verify**

Run: `node --check agent/server.js` (expect no output)
Run: `grep -n "/api/trade-grades\\|trade-grades.mjs" agent/server.js` (expect import + endpoint)

- [ ] **Step 4: Commit**
```bash
git add agent/server.js
git commit -m "feat(trade-grading): GET /api/trade-grades read endpoint"
```

---

## Task 5: Scheduler job (`agent/analysis-scheduler.js`)

**Files:**
- Modify: `agent/analysis-scheduler.js` (validJobs ~line 350; dispatch ~422; trigger ~1055; method after `_runReasoningDigest`)

Context: `HAIKU_MODEL` and `_runSkill(skillName, date, target, timeoutMs, appendix, throwOnFailure, modelOverride)` already exist. The script spawn pattern follows `_runMacroRegimeSkill` (uses `spawn` from `node:child_process`, already imported). The reasoning-digest job (16:55) is the sibling to mirror.

- [ ] **Step 1: Register the job name**

In the `validJobs` array, after `'reasoning_digest',`:
```javascript
      'reasoning_digest',
      'trade_grading',
    ];
```

- [ ] **Step 2: Dispatch branch**

After the `reasoning_digest` dispatch branch:
```javascript
      } else if (jobName === 'reasoning_digest') {
        this._lastReasoningDigestDate = isoDate;
        await this._runReasoningDigest(isoDate);
      } else if (jobName === 'trade_grading') {
        this._lastTradeGradingDate = isoDate;
        await this._runTradeGrading(isoDate);
```

- [ ] **Step 3: State field**

After `this._lastReasoningDigestDate = null; …`:
```javascript
    this._lastReasoningDigestDate = null; // YYYY-MM-DD (daily after-close reasoning digest)
    this._lastTradeGradingDate = null; // YYYY-MM-DD (daily after-close trade grading)
```

- [ ] **Step 4: Schedule trigger (17:00 ET)**

After the reasoning-digest 16:55 trigger block, before the Sunday block:
```javascript

    // Daily per-trade thesis-vs-outcome grading — 5:00 PM ET, after the digest. No-op
    // unless TRADE_GRADING_ENABLED=true (the method self-gates). Idempotent per ET day.
    if (isWeekday && hour === 17 && minute === 0 && this._lastTradeGradingDate !== isoDate) {
      await this.triggerJob('trade_grading').catch(() => {});
    }
```

- [ ] **Step 5: The runner method (preprocessor spawn → cost-gate → conditional Haiku skill)**

After the `_runReasoningDigest(isoDate)` method's closing `}`:
```javascript

  // trade_grading: deterministic Node preprocessor (free) writes cards + a complete
  // deterministic report for all agents; only if Prophet actually closed a trade do we
  // invoke the Haiku trade-grader skill to enrich Prophet's narrative grade. Self-gated
  // by TRADE_GRADING_ENABLED (default OFF). Mirrors _runMacroRegimeSkill's spawn shape.
  async _runTradeGrading(isoDate) {
    if (process.env.TRADE_GRADING_ENABLED !== 'true') return; // default OFF
    this._log(`Starting trade_grading for ${isoDate}...`, 'info');
    this.emit('scheduler_job_start', { job: 'trade_grading', date: isoDate });
    let prophetCloses = 0;
    await new Promise((resolve) => {
      const child = spawn(PYTHON_BIN ? process.execPath : process.execPath,
        ['scripts/trade-grades.mjs', `--date=${isoDate}`], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (c) => { out += c.toString(); });
      child.on('error', () => resolve());
      child.on('close', () => {
        const m = out.match(/PROPHET_CLOSES=(\\d+)/);
        prophetCloses = m ? Number(m[1]) : 0;
        resolve();
      });
    });
    if (prophetCloses > 0) {
      await this._runSkill('trade-grader', isoDate, null, 10 * 60 * 1000, null, false, HAIKU_MODEL);
    }
    this._log(`trade_grading complete for ${isoDate} (prophet_closes=${prophetCloses}).`, 'success');
  }
```
NOTE: the preprocessor is a Node script, so spawn it with `process.execPath` (the node binary) + the script path — do NOT use `PYTHON_BIN`. (The ternary above resolves to `process.execPath` either way; simplify to `spawn(process.execPath, ['scripts/trade-grades.mjs', \`--date=${isoDate}\`], …)` — write it that way, the ternary is shown only to flag that this is NOT a python spawn.)

- [ ] **Step 6: Verify**

Run: `node --check agent/analysis-scheduler.js`
Run: `node --test agent/analysis-scheduler.test.mjs` (existing suite still green)
Run: `grep -n "trade_grading\\|_runTradeGrading\\|_lastTradeGradingDate" agent/analysis-scheduler.js`

- [ ] **Step 7: Commit**
```bash
git add agent/analysis-scheduler.js
git commit -m "feat(trade-grading): scheduler job at 17:00 ET (preprocessor + cost-gated Haiku)"
```

---

## Task 6: Dashboard card (`agent/public/index.html`)

**Files:**
- Modify: `agent/public/index.html` (mirror the `loadReasoningDigest()` sibling + its container)

- [ ] **Step 1: Add the container**

Find `<div id="reasoning-digest"></div>` and insert immediately after:
```html
<div id="trade-grades"></div>
```

- [ ] **Step 2: Add the loader + call**

Find `loadReasoningDigest();` (inside `seedTodayTrades()`) and insert after it:
```javascript
  loadTradeGrades();
```
Find the `async function loadReasoningDigest() { … }` definition and insert this sibling after its closing `}`:
```javascript

async function loadTradeGrades() {
  const host = document.getElementById('trade-grades');
  if (!host) return;
  try {
    const date = _todayEt();
    const r = await fetch('/api/trade-grades?date=' + encodeURIComponent(date));
    if (!r.ok) return;
    const data = await r.json();
    const reports = (data.items || []).filter((it) => (it.grades || []).length > 0);
    if (!reports.length) { host.innerHTML = ''; return; }
    const cell = (q) => q.replace(/_/g, ' ');
    const parts = [`<details class="trade-grades"><summary>Trade grades — ${data.date}</summary>`];
    for (const it of reports) {
      parts.push(`<div class="tg-agent"><strong>${it.agentName}</strong><ul>` +
        it.grades.map((g) => `<li>${(g.symbol || '').replace(/</g, '&lt;')} — <em>${cell(g.quadrant || '')}</em>: ${(g.lesson || '').replace(/</g, '&lt;')}</li>`).join('') +
        '</ul></div>');
    }
    parts.push('</details>');
    host.innerHTML = parts.join('');
  } catch { /* silent — dashboard never breaks on grades */ }
}
```

- [ ] **Step 3: Verify**

Run: `grep -n "trade-grades\\|loadTradeGrades" agent/public/index.html` (expect the div, the call, and the function)
Read ~10 lines around each insertion to confirm valid HTML/JS. Browser eyeball pending (no jsdom) — note in commit.

- [ ] **Step 4: Commit**
```bash
git add agent/public/index.html
git commit -m "feat(trade-grading): Trades-tab grade card (silent when absent)"
```

---

## Task 7: Integration verification (run inline, not a subagent)

- [ ] **Step 1: Node checks + unit tests**

Run: `node --check agent/server.js ; node --check agent/analysis-scheduler.js ; node --check scripts/trade-grades.mjs`
Run: `node --test scripts/trade-grades.test.mjs` (expect 6 pass)

- [ ] **Step 2: Full Node suite (no regressions)**

Run: `node --test agent/*.test.mjs scripts/*.test.mjs`
Expected: no NEW failures vs the baseline. (Known pre-existing: server-boot test-file concurrency failures when many server-booting files run together — confirm any failures are those same files by running them in isolation, exactly as established for the Task-2 digest.)

- [ ] **Step 3: Real dry-run of the preprocessor**

Run: `node scripts/trade-grades.mjs --date=<a date with known closes>`
Expected: prints `PROPHET_CLOSES=<n>`; if any sandbox closed trades that day, `data/trade-grades/<sandbox>/<date>.{json,md,cards.json}` exist and the md shows quadrant lines.

---

## Task 8: Squash to one commit (ask user first)

- [ ] **Step 1:** Stage the spec doc (`docs/superpowers/specs/2026-06-03-prophet-trade-grading-design.md`) and this plan; confirm with the user before rewriting history.
- [ ] **Step 2:** Squash all branch commits + docs into one:
```bash
git add docs/superpowers/specs/2026-06-03-prophet-trade-grading-design.md docs/superpowers/plans/2026-06-03-prophet-trade-grading.md
git reset --soft $(git merge-base prophet-trade-grading main)
git commit -m "feat(trade-grading): per-trade thesis-vs-outcome grades (deterministic + cost-gated Haiku)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```
- [ ] **Step 3:** Audit main (concurrent session), rebase onto main, verify build+tests, then hand back to the user for the merge decision (do NOT merge without approval).

---

## Self-review

**Spec coverage:** Unit 1 deterministic core → Tasks 1–2. Unit 2 Haiku skill → Task 3. Unit 3 surface → Tasks 4 (endpoint) + 6 (dashboard). Scheduler + cost-gate → Task 5. Grade schema incl. 8-cell quadrant + all-5 exit states + grounded/`not_assessed` IV → Task 1 (`gradeMechanical`, `PLAYED_OUT_BY_REASON`) + Task 3 (skill Step 2 guard). Flag default OFF → Task 5 Step 5 (`!== 'true'`). Graceful degradation (Node always writes a complete report; skill only enriches) → Task 2 `runForSandbox` + Task 5 conditional skill. Friction reuse → Task 2 (`toFrictionAction`+`applyFriction`). Testing (all-5-state truth table + no-IV guard) → Task 1 test + Task 3 Step 2. All spec sections mapped.

**Placeholder scan:** No TBD/TODO. Two explicit "confirm the real shape" NOTES (Task 2 `resolveSandboxDbPaths` return shape; Task 5 `process.execPath` not `PYTHON_BIN`) are deliberate guardrails against inventing an API, each naming the exact thing to verify and the fallback — not vague placeholders.

**Type consistency:** Card fields (`agent, agentId, symbol, exitReason, frictionPnl, frictionPnlPct, holdMinutes, quadrant, thesisPlayedOut, lesson, candidateTheses`) are consistent across `buildOutcomeCard`/`gradeMechanical`/`runForSandbox`/`renderMarkdown`/the skill/the dashboard. `hasProphetCloses` keys on `agentId === 'default'` consistently (core + CLI). Report shape `{date, sandboxId, agentName, agentId, generatedAt, grades}` consistent across `runForSandbox`/`writeTradeGradesReport`/`readTradeGradesSummary`/endpoint/dashboard. `PROPHET_CLOSES=` contract consistent between the CLI (Task 2) and the scheduler parse (Task 5).
