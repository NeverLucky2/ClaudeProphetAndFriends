# Tips & Influence Ledger — Phase 1a Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the tip store + server endpoints + a minimal Tips tab so the user can log a tip (ticker + thesis + source) *before* the outcome — the pre-outcome record the whole ledger depends on (spec D2) — with zero dependency on the trade-data schema.

**Architecture:** A self-contained Node module (`agent/tips-store.js`) owns a JSON-array store at `data/tips/tips.json` with atomic writes serialized in-process (spec D13). The Express server (`agent/server.js`) exposes flag-gated CRUD endpoints. The dashboard (`agent/public/index.html`) gets a new **Tips** tab with a log form + a list. No scorer, no candidate evaluation, no news feed — those are later plans.

**Tech Stack:** Node 20 ESM, Express (already in `server.js`), `node:test` + `node:assert/strict` for tests, vanilla JS in the single-file dashboard.

**Spec:** `docs/superpowers/specs/2026-05-30-tips-influence-scorecard-design.md` (Phase 1 of Section 10; scorer split out to Phase 1b).

---

## File structure

- **Create `agent/tips-store.js`** — owns `data/tips/tips.json` + `data/tips/sources.json`; pure FS + validation + in-process write serialization. Exports `readUniverse`, `getSources`, `readTips`, `createTip`, `dismissTip`.
- **Create `agent/tips-store.test.mjs`** — `node:test` coverage for the store.
- **Modify `agent/server.js`** — import the store; add four flag-gated routes.
- **Modify `agent/public/index.html`** — Tips tab button, `#panel-tips`, a `switchTab` case, and the `loadTipsPanel` / `submitTip` JS.
- **Modify `.env.example`** — document `ENABLE_TIPS_SCORECARD`.

Conventions mirrored from existing code: `trades-store.js` (FS layout, `_etDate`, `node:fs/promises`), the `/api/v1/costs` flag pattern (`process.env.X` → 404 when disabled), and `switchTab` + `esc()` in `index.html`.

---

## Task 1: Tip store core — `readUniverse`, `createTip`, `readTips`

**Files:**
- Create: `agent/tips-store.js`
- Test: `agent/tips-store.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
// agent/tips-store.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readUniverse, createTip, readTips } from './tips-store.js';

async function tmpRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tips-'));
  await fs.mkdir(path.join(root, 'config'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'config', 'prophet_tradable_universe.txt'),
    '# header\nIBM\nNVDA  # inline comment\n\nAAPL\n',
  );
  return root;
}

test('readUniverse parses tickers, strips comments and blanks', async () => {
  const root = await tmpRoot();
  const uni = await readUniverse(root);
  assert.equal(uni.has('IBM'), true);
  assert.equal(uni.has('NVDA'), true);
  assert.equal(uni.has('AAPL'), true);
  assert.equal(uni.has('HEADER'), false);
});

test('createTip on in-universe ticker is active and actionable now', async () => {
  const root = await tmpRoot();
  const tip = await createTip(root, { ticker: 'ibm', thesis: 'quantum capex', source: 'self' });
  assert.equal(tip.ticker, 'IBM');
  assert.equal(tip.phase, 'active');
  assert.equal(tip.inUniverseAtLog, true);
  assert.equal(tip.actionableAt, tip.surfacedAt);
  assert.equal(tip.dismissed, false);
  assert.equal(tip.origin, 'manual');
  const all = await readTips(root);
  assert.equal(all.length, 1);
  assert.equal(all[0].id, tip.id);
});

test('createTip on out-of-universe ticker is a pending candidate', async () => {
  const root = await tmpRoot();
  const tip = await createTip(root, { ticker: 'SMCI', thesis: 'AI servers', source: 'dad' });
  assert.equal(tip.phase, 'pending_candidate');
  assert.equal(tip.inUniverseAtLog, false);
  assert.equal(tip.actionableAt, null);
});

test('createTip rejects unknown source and blank fields', async () => {
  const root = await tmpRoot();
  await assert.rejects(() => createTip(root, { ticker: 'IBM', thesis: 'x', source: 'stranger' }), /source/);
  await assert.rejects(() => createTip(root, { ticker: '', thesis: 'x', source: 'self' }), /ticker/);
  await assert.rejects(() => createTip(root, { ticker: 'IBM', thesis: '   ', source: 'self' }), /thesis/);
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `node --test agent/tips-store.test.mjs`
Expected: FAIL — `Cannot find module './tips-store.js'`.

- [ ] **Step 3: Implement `agent/tips-store.js`**

```javascript
// agent/tips-store.js
// Tip / candidate store for the Influence Ledger. JSON-array file with atomic
// writes serialized in-process (single-writer; spec D13). Pure FS + validation.
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_SOURCES = ['self', 'dad'];

function tipsDir(projectRoot) { return path.join(projectRoot, 'data', 'tips'); }
function tipsFile(projectRoot) { return path.join(tipsDir(projectRoot), 'tips.json'); }
function sourcesFile(projectRoot) { return path.join(tipsDir(projectRoot), 'sources.json'); }
function universeFile(projectRoot) {
  return path.join(projectRoot, 'config', 'prophet_tradable_universe.txt');
}

// readUniverse mirrors the Go services.LoadTradableUniverse parser: one ticker
// per line, '#' starts a comment (inline trimmed), blanks dropped, upper-cased.
export async function readUniverse(projectRoot) {
  let raw;
  try {
    raw = await fs.readFile(universeFile(projectRoot), 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return new Set();
    throw err;
  }
  const out = new Set();
  for (let line of raw.split('\n')) {
    const hash = line.indexOf('#');
    if (hash >= 0) line = line.slice(0, hash);
    const t = line.trim().toUpperCase();
    if (t) out.add(t);
  }
  return out;
}

export async function getSources(projectRoot) {
  try {
    const raw = await fs.readFile(sourcesFile(projectRoot), 'utf-8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.length) return arr;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return [...DEFAULT_SOURCES];
}

export async function readTips(projectRoot) {
  try {
    const raw = await fs.readFile(tipsFile(projectRoot), 'utf-8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

// In-process write serialization: every read-modify-write chains off the last,
// so concurrent createTip/dismissTip calls can't clobber each other (D13).
let _writeChain = Promise.resolve();
function serialize(task) {
  const run = _writeChain.then(task, task);
  // Keep the chain alive even if a task throws.
  _writeChain = run.then(() => {}, () => {});
  return run;
}

async function _atomicWriteTips(projectRoot, tips) {
  const dir = tipsDir(projectRoot);
  await fs.mkdir(dir, { recursive: true });
  const tmp = tipsFile(projectRoot) + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(tips, null, 2));
  await fs.rename(tmp, tipsFile(projectRoot));
}

export async function createTip(projectRoot, { ticker, thesis, source } = {}) {
  const t = String(ticker || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z.]*$/.test(t)) throw new Error('invalid ticker');
  const th = String(thesis || '').trim();
  if (!th) throw new Error('thesis is required');
  const sources = await getSources(projectRoot);
  if (!sources.includes(source)) throw new Error(`unknown source: ${source}`);

  const inUni = (await readUniverse(projectRoot)).has(t);
  const surfacedAt = new Date().toISOString();
  const tip = {
    id: `tip_${Date.now()}_${t}`,
    ticker: t,
    thesis: th,
    source,
    phase: inUni ? 'active' : 'pending_candidate',
    origin: 'manual',
    surfacedAt,
    actionableAt: inUni ? surfacedAt : null,
    inUniverseAtLog: inUni,
    dismissed: false,
  };

  return serialize(async () => {
    const tips = await readTips(projectRoot);
    tips.push(tip);
    await _atomicWriteTips(projectRoot, tips);
    return tip;
  });
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `node --test agent/tips-store.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add agent/tips-store.js agent/tips-store.test.mjs
git commit -m "feat(tips): tip store core — readUniverse, createTip, readTips"
```

---

## Task 2: `dismissTip` + serialized-concurrency test

**Files:**
- Modify: `agent/tips-store.js`
- Test: `agent/tips-store.test.mjs`

- [ ] **Step 1: Write the failing tests (append to the test file)**

```javascript
import { dismissTip } from './tips-store.js'; // add to the existing import line

test('dismissTip marks the tip dismissed', async () => {
  const root = await tmpRoot();
  const a = await createTip(root, { ticker: 'IBM', thesis: 'x', source: 'self' });
  const ok = await dismissTip(root, a.id);
  assert.equal(ok, true);
  const tips = await readTips(root);
  assert.equal(tips.find(t => t.id === a.id).dismissed, true);
});

test('dismissTip returns false for unknown id', async () => {
  const root = await tmpRoot();
  assert.equal(await dismissTip(root, 'nope'), false);
});

test('concurrent createTip calls do not clobber each other', async () => {
  const root = await tmpRoot();
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      createTip(root, { ticker: 'IBM', thesis: `t${i}`, source: 'self' })),
  );
  const tips = await readTips(root);
  assert.equal(tips.length, 20);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `node --test agent/tips-store.test.mjs`
Expected: FAIL — `dismissTip is not a function` (and the concurrency test would lose writes without the lock).

- [ ] **Step 3: Implement `dismissTip` (append to `tips-store.js`)**

```javascript
export async function dismissTip(projectRoot, id) {
  return serialize(async () => {
    const tips = await readTips(projectRoot);
    const tip = tips.find(t => t.id === id);
    if (!tip) return false;
    tip.dismissed = true;
    await _atomicWriteTips(projectRoot, tips);
    return true;
  });
}
```

- [ ] **Step 4: Run, verify pass**

Run: `node --test agent/tips-store.test.mjs`
Expected: PASS (7 tests). The concurrency test confirms all 20 writes survive (the in-process chain serializes them).

- [ ] **Step 5: Commit**

```bash
git add agent/tips-store.js agent/tips-store.test.mjs
git commit -m "feat(tips): dismissTip + serialized-write coverage"
```

---

## Task 3: Flag-gated server endpoints

**Files:**
- Modify: `agent/server.js` (import near line 33 with the other store imports; routes near the `/api/trades` block ~line 823)

- [ ] **Step 1: Add the import**

At the top with the other store imports (next to `import { appendTrade, readTrades } from './trades-store.js';`):

```javascript
import { readTips, createTip, dismissTip, getSources } from './tips-store.js';
```

- [ ] **Step 2: Add the routes** (after the `/api/trades` handler, before `/api/reconciliation`)

```javascript
// ── Tips & Influence Ledger (flag-gated, default OFF) ───────────────────────
// All routes 404 when ENABLE_TIPS_SCORECARD !== 'true', mirroring /api/v1/costs.
function tipsEnabled() { return process.env.ENABLE_TIPS_SCORECARD === 'true'; }

app.get('/api/tips/sources', async (req, res) => {
  if (!tipsEnabled()) return res.status(404).json({ error: 'tips ledger disabled' });
  try {
    res.json({ sources: await getSources(PROJECT_ROOT) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/tips', async (req, res) => {
  if (!tipsEnabled()) return res.status(404).json({ error: 'tips ledger disabled' });
  try {
    const all = await readTips(PROJECT_ROOT);
    const tips = req.query.includeDismissed === 'true' ? all : all.filter(t => !t.dismissed);
    tips.sort((a, b) => (b.surfacedAt || '').localeCompare(a.surfacedAt || ''));
    res.json({ count: tips.length, tips });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tips', async (req, res) => {
  if (!tipsEnabled()) return res.status(404).json({ error: 'tips ledger disabled' });
  const { ticker, thesis, source } = req.body || {};
  try {
    const tip = await createTip(PROJECT_ROOT, { ticker, thesis, source });
    res.status(201).json({ tip });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/tips/:id/dismiss', async (req, res) => {
  if (!tipsEnabled()) return res.status(404).json({ error: 'tips ledger disabled' });
  try {
    const ok = await dismissTip(PROJECT_ROOT, req.params.id);
    if (!ok) return res.status(404).json({ error: 'tip not found' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
```

- [ ] **Step 3: Verify the import path and `PROJECT_ROOT` exist**

Run: `node -e "import('./agent/server.js').then(()=>console.log('loads')).catch(e=>{console.error(e);process.exit(1)})"`
Expected: prints `loads` (server module parses; `PROJECT_ROOT` is already defined in `server.js` and used by `/api/trades`). If it prints a `ReferenceError: PROJECT_ROOT`, grep `server.js` for the exact constant name (it is used at the `/api/trades` handler) and match it.

- [ ] **Step 4: Manual smoke test**

```bash
ENABLE_TIPS_SCORECARD=true AGENT_PORT=3939 node agent/server.js &
sleep 1
curl -s localhost:3939/api/tips                                  # {"count":0,"tips":[]}
curl -s -XPOST localhost:3939/api/tips -H 'content-type: application/json' \
  -d '{"ticker":"ibm","thesis":"quantum","source":"self"}'      # {"tip":{...,"phase":"active"}}
curl -s localhost:3939/api/tips                                  # count:1
curl -s localhost:3939/api/tips/sources                          # {"sources":["self","dad"]}
kill %1
```
Expected: the JSON shown in the comments. With the flag unset, every route returns HTTP 404 `{"error":"tips ledger disabled"}`.

- [ ] **Step 5: Commit**

```bash
git add agent/server.js
git commit -m "feat(tips): flag-gated /api/tips endpoints (create, list, dismiss, sources)"
```

---

## Task 4: Tips tab in the dashboard

**Files:**
- Modify: `agent/public/index.html` (tab bar ~line 1146; panels ~after `#panel-trades` line 1201; `switchTab` line 1741; add JS near the other panel loaders)

- [ ] **Step 1: Add the tab button** (in the tab bar, after the Costs tab at line 1148)

```html
    <button class="tab" data-tab="tips" onclick="switchTab('tips')">Tips</button>
```

- [ ] **Step 2: Add the panel** (immediately after the closing `</div>` of `#panel-trades`, i.e. after line 1201)

```html
    <!-- Tips Panel -->
    <div class="panel" id="panel-tips">
      <div class="settings-content">
        <h2>Tips &amp; Influence Ledger</h2>
        <p class="subtitle">Log a call before it plays out. Prophet still only trades its universe — this is the honest record.</p>
        <div id="tips-disabled" class="no-data" style="display:none">
          Tips ledger is off. Set <code>ENABLE_TIPS_SCORECARD=true</code> and restart to enable.
        </div>
        <div id="tips-form-wrap" style="display:none; margin-bottom:16px;">
          <div style="display:flex; gap:10px; align-items:flex-end; flex-wrap:wrap;">
            <label>Ticker<br><input id="tip-ticker" maxlength="8" style="text-transform:uppercase; width:90px;"></label>
            <label>Thesis (one line)<br><input id="tip-thesis" style="width:320px;"></label>
            <label>Source<br><select id="tip-source"></select></label>
            <button id="tip-submit" onclick="submitTip()">Log Tip</button>
          </div>
          <div id="tip-error" style="color:var(--error); font-size:12px; margin-top:6px;"></div>
        </div>
        <div id="tips-list"><div class="no-data">No tips yet.</div></div>
      </div>
    </div>
```

- [ ] **Step 3: Add the `switchTab` hook** (inside `switchTab`, after the `costs` line 1747)

```javascript
  if (id === 'tips') loadTipsPanel();
```

- [ ] **Step 4: Add the panel JS** (after the costs-tab helpers block, e.g. after `deltaColor` ~line 1780)

```javascript
// ── Tips Tab ───────────────────────────────
async function loadTipsPanel() {
  const disabled = document.getElementById('tips-disabled');
  const formWrap = document.getElementById('tips-form-wrap');
  const list = document.getElementById('tips-list');
  try {
    const srcRes = await fetch('/api/tips/sources');
    if (srcRes.status === 404) { disabled.style.display = ''; formWrap.style.display = 'none'; list.innerHTML = ''; return; }
    disabled.style.display = 'none';
    formWrap.style.display = '';
    const { sources } = await srcRes.json();
    const sel = document.getElementById('tip-source');
    sel.innerHTML = sources.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');

    const res = await fetch('/api/tips');
    const { tips } = await res.json();
    if (!tips.length) { list.innerHTML = '<div class="no-data">No tips yet.</div>'; return; }
    list.innerHTML = tips.map(t => `
      <div class="trade-card">
        <div class="trade-header">
          <span><span class="trade-symbol">${esc(t.ticker)}</span>
            <span class="trade-agent-badge">${esc(t.source)}</span>
            <span class="trade-agent-badge">${t.phase === 'active' ? 'active' : 'candidate · OOU'}</span></span>
          <span class="trade-time">${esc((t.surfacedAt || '').replace('T', ' ').slice(0, 16))}</span>
        </div>
        <div class="trade-details">${esc(t.thesis)}</div>
      </div>`).join('');
  } catch (err) {
    list.innerHTML = '<div class="no-data">Failed to load tips.</div>';
    console.warn('loadTipsPanel failed:', err);
  }
}

async function submitTip() {
  const ticker = document.getElementById('tip-ticker').value;
  const thesis = document.getElementById('tip-thesis').value;
  const source = document.getElementById('tip-source').value;
  const errEl = document.getElementById('tip-error');
  errEl.textContent = '';
  try {
    const res = await fetch('/api/tips', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticker, thesis, source }),
    });
    if (!res.ok) { const e = await res.json().catch(() => ({})); errEl.textContent = e.error || ('error ' + res.status); return; }
    document.getElementById('tip-ticker').value = '';
    document.getElementById('tip-thesis').value = '';
    loadTipsPanel();
  } catch (err) { errEl.textContent = String(err); }
}
```

- [ ] **Step 5: Manual verification in the browser**

```bash
ENABLE_TIPS_SCORECARD=true node agent/server.js
```
Open the dashboard, click **Tips**. Expected: the log form renders with `self`/`dad` in the dropdown; logging `IBM` / a thesis / `self` adds an `active` card; logging `SMCI` adds a `candidate · OOU` card. Restart without the flag → the tab shows the "Tips ledger is off" message.

- [ ] **Step 6: Commit**

```bash
git add agent/public/index.html
git commit -m "feat(tips): Tips tab — log form + list (flag-gated)"
```

---

## Task 5: Document the flag

**Files:**
- Modify: `.env.example` (near the other `ENABLE_*` Prophet flags, ~line 147)

- [ ] **Step 1: Add the flag documentation**

```bash
# ── Tips & Influence Ledger (Prophet) ──────────────────────────────────────
# Read-only ledger of human "tips" (calls) logged before the outcome, measured
# against Prophet's autonomous trades. Phase 1a ships logging only; the scorer
# arrives in Phase 1b. Default OFF.
# Spec: docs/superpowers/specs/2026-05-30-tips-influence-scorecard-design.md
ENABLE_TIPS_SCORECARD=false
```

- [ ] **Step 2: Run the full store test suite once more**

Run: `node --test agent/tips-store.test.mjs`
Expected: PASS (7 tests).

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "docs(tips): document ENABLE_TIPS_SCORECARD flag (default off)"
```

---

## Self-review (completed during planning)

- **Spec coverage (Phase 1a slice):** tip store + atomic single-writer (D13) ✓ Task 1–2; flag-gated default OFF (§7) ✓ Tasks 3,5; phase/`actionableAt`/`inUniverseAtLog` rules (D7, §4.1) ✓ Task 1; source list default `self`/`dad` (§4.3) ✓ Task 1; Tips tab log + list (§5.6) ✓ Task 4. **Deferred to Phase 1b/2/3 (out of scope here):** scorer views A/B/C, `agentSurfaced` split, benchmarks, candidate evaluation, Add-to-universe, news feed, Trades-tab badge, Settings source editor, review-performance integration.
- **Placeholder scan:** no TBD/TODO; every code step is complete and runnable.
- **Type consistency:** the tip record shape (`id, ticker, thesis, source, phase, origin, surfacedAt, actionableAt, inUniverseAtLog, dismissed`) is identical across the store, the endpoints, and the UI render. Store exports used by the server (`readTips, createTip, dismissTip, getSources`) match the import in Task 3.

## Note for Phase 1b (scorer) — schema spike first
Before writing the scorer plan, pin from a real `decisive_actions/*.friction.json` sample (run `node scripts/apply-friction.mjs --agent default` on live data): the action-type field name, entry-vs-close timestamp, and how to extract the **underlying** from an option symbol. Confirmed so far: `action.symbol`, `action.reasoning`, `action.market_data.{size,entry_price,exit_price,raw_pl,friction_adjusted_pl}` (see `scripts/apply-friction.mjs`). Benchmark price source (underlying + SPY forward returns) also TBD — `bar-cache` vs FMP — per spec §11.
