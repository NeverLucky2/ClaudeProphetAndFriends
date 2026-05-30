# Tips & Influence Scorecard — Phase 3 (news + polish) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The final polish phase: (1) a **News-candidate feed** that surfaces only out-of-universe catalyst names from the scans Prophet already runs, as candidate suggestions to approve/dismiss — never an agent trigger, never a scored tip (D14); (2) a **`Tipped · <source>` badge + "tipped only" filter** on the Trades tab; (3) an **editable Tip-sources list** (with `news` reserved/locked). All read-only except the human-clicked, flag-gated writes already established (tip creation, source-list edits, suggestion suppression). Everything behind `ENABLE_TIPS_SCORECARD` (default OFF).

**Architecture:** One new read-only module (`agent/news-candidates.js`) derives OOU suggestions from the persisted `data/reports/daily_brief_*.json` files (the same JSON the scans emit). New single-writer store mutators in `agent/tips-store.js` (`approveSuggestion`, `suppressSuggestion`, `addSource`, `removeSource`) keep the Node server the sole writer (D13). A read-only `matchTippedTrades` in `agent/tips-scorer.js` powers the Trades badge. New flag-gated endpoints + Tips/Trades-tab UI wire it together. The news lane never calls the agent and never creates a scored influenced tip — approved suggestions become `pending_candidate` records (`origin:"recommended"`, `source:"news"`) that still must pass Phase-2 eligibility + a human Add-to-universe before they can ever be traded.

**Tech Stack:** Node 20+ ESM, Express (already in `server.js`), `node:test` + `node:assert/strict`, vanilla JS in the single-file dashboard.

**Spec:** `docs/superpowers/specs/2026-05-30-tips-influence-scorecard-design.md` (§5.3, §5.6, §6; D13/D14). Builds on Phases 1a/1b/2 (all merged to local main).

---

## Design decisions

1. **News source = persisted daily briefs.** `data/reports/daily_brief_YYYYMMDD.json` carries `analyst_actions:[{ticker, firm, action, from, to, date}]` and `ticker_catalysts:[{ticker, event_type, headline, source, url, published}]`. Suggestions are derived from these (read-only). A suggestion is shown only if the ticker is **out-of-universe** (`readUniverse` miss), **not already a tip** (any non-dismissed phase), and **not suppressed**.
2. **Approve ⇒ `pending_candidate`, never a scored tip (D14).** `approveSuggestion` writes a record with `phase:"pending_candidate"`, `origin:"recommended"`, `source:"news"`, `actionableAt:null`, and a `recommendation:{catalyst, feed, feedAt}` block. It does NOT go through `createTip` (which would reject the reserved `news` source). It enters the Phase-2 candidate queue like any OOU tip; only a human Add-to-universe can ever make it tradable. The news lane never calls the agent.
3. **Dismiss ⇒ suppress by ticker.** `suppressSuggestion` appends the ticker to `data/tips/suppressed.json` so it stops appearing in the feed. (Coarse but matches the "Dismiss → suppress" intent; re-surfacing later is a manual file edit — acceptable at these volumes.)
4. **`news` is a reserved system source.** It is never an addable/removable human source and never a dropdown option for a manual tip (Phase 1a already validates manual sources against the human list, which never contains `news`). `addSource`/`removeSource` refuse `news`; `removeSource` also refuses the built-in defaults `self`/`dad` and any source currently in use by a tip (so existing records never orphan).
5. **Tipped badge match = the view-B rule on real trades.** A trade is "influenced" iff it is a `buy` whose `underlyingOf(symbol)` equals an **active** tip's ticker and whose `timestamp` is within `[actionableAt, +TIPS_ATTRIBUTION_WINDOW_DAYS]`. The server returns the matched trades' identity fields + source; the client keys them with its existing `_tradeKey` so the key format stays single-sourced in the page.
6. **Source editor lives in the Tips tab, not the Settings tab.** The spec says "Settings tab," but the entire tips feature is already cohesive and flag-gated inside the Tips tab; adding the editor there (rather than mutating the unrelated, non-flag-gated Settings panel) keeps the blast radius minimal. **Noted deviation.**

---

## File structure

- **Modify `agent/tips-store.js`** — `approveSuggestion`, `suppressSuggestion`, `readSuppressed`, `addSource`, `removeSource` (all single-writer, D13). + tests.
- **Create `agent/news-candidates.js`** — `listNewsCandidates(projectRoot, opts)`: read briefs → OOU suggestions, minus existing tips & suppressed. Read-only. + tests.
- **Modify `agent/tips-scorer.js`** — `matchTippedTrades(tips, trades, opts)` (read-only). + tests.
- **Modify `agent/server.js`** — flag-gated routes: `GET/POST /api/tips/sources`, `DELETE /api/tips/sources/:name`, `GET /api/tips/news-candidates`, `POST /api/tips/news-candidates/approve`, `POST /api/tips/news-candidates/dismiss`, `GET /api/tips/influenced`.
- **Modify `agent/public/index.html`** — News-candidates section + source editor in the Tips tab; `Tipped · source` badge + "tipped only" filter on the Trades tab.
- **Modify `.env.example`** — note the news feed reads `data/reports/daily_brief_*.json` (no new flags).

Conventions mirrored: the Phase-1/2 store (`serialize`, `_atomicWriteTips`, `getSources`, `readUniverse`, `readTips`), the scorer (`underlyingOf`, `addTradingDays`/`isTradingDay`/`nextTradingDay`, `etDateString`), the `/api/tips` flag pattern, and the Tips/Trades-tab JS (`esc`, `addTradeCard`, `_tradeKey`, `applyTradesFilterToCard`, `loadTipsPanel`). All commits local-only; squash-merge to local `main` at the end.

---

## Task 1: Source-list editor in the store (`addSource` / `removeSource`)

**Files:**
- Modify: `agent/tips-store.js`
- Test: `agent/tips-store.test.mjs`

- [ ] **Step 1: Write the failing tests** (append to `agent/tips-store.test.mjs`; add `addSource, removeSource` and the already-exported `getSources` to the imports as needed)

```javascript
import { addSource, removeSource, getSources } from './tips-store.js';

test('addSource adds a custom human source; refuses dup, blank, and reserved news', async () => {
  const root = await tmpRoot();
  const r = await addSource(root, 'broker-x');
  assert.equal(r.ok, true);
  assert.ok((await getSources(root)).includes('broker-x'));
  assert.equal((await addSource(root, 'broker-x')).ok, false);     // dup
  await assert.rejects(() => addSource(root, '  '), /source/);      // blank
  await assert.rejects(() => addSource(root, 'news'), /reserved/);  // reserved
});

test('removeSource removes a custom source but refuses defaults, news, and in-use sources', async () => {
  const root = await tmpRoot();
  await addSource(root, 'broker-x');
  assert.equal((await removeSource(root, 'broker-x')).ok, true);
  assert.equal((await getSources(root)).includes('broker-x'), false);
  assert.equal((await removeSource(root, 'self')).ok, false);   // default protected
  await assert.rejects(() => removeSource(root, 'news'), /reserved/);
  // in-use guard:
  await addSource(root, 'broker-y');
  await createTip(root, { ticker: 'IBM', thesis: 'x', source: 'broker-y' });
  assert.equal((await removeSource(root, 'broker-y')).ok, false); // in use -> refused
});
```

- [ ] **Step 2: Run, verify failure**

Run: `node --test agent/tips-store.test.mjs`
Expected: FAIL — `addSource is not a function`.

- [ ] **Step 3: Implement** (append to `agent/tips-store.js`; reuse the in-file `serialize`, `getSources`, `readTips`, and add a sources writer)

```javascript
const RESERVED_SOURCES = ['news'];

async function _writeSources(projectRoot, sources) {
  const dir = tipsDir(projectRoot);
  await fs.mkdir(dir, { recursive: true });
  const tmp = sourcesFile(projectRoot) + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(sources, null, 2));
  await fs.rename(tmp, sourcesFile(projectRoot));
}

// addSource: append a custom human source. Refuses blanks, duplicates, and the
// reserved system source `news` (which is never a human-selectable source).
export async function addSource(projectRoot, name) {
  const n = String(name || '').trim();
  if (!n) throw new Error('source name is required');
  if (RESERVED_SOURCES.includes(n.toLowerCase())) throw new Error(`'${n}' is reserved`);
  return serialize(async () => {
    const sources = await getSources(projectRoot);
    if (sources.includes(n)) return { ok: false, reason: 'duplicate', sources };
    const next = [...sources, n];
    await _writeSources(projectRoot, next);
    return { ok: true, sources: next };
  });
}

// removeSource: drop a custom source. Refuses the reserved `news`, the built-in
// defaults (self/dad), and any source currently attached to a tip (no orphans).
export async function removeSource(projectRoot, name) {
  const n = String(name || '').trim();
  if (RESERVED_SOURCES.includes(n.toLowerCase())) throw new Error(`'${n}' is reserved`);
  return serialize(async () => {
    if (DEFAULT_SOURCES.includes(n)) return { ok: false, reason: 'default_protected' };
    const sources = await getSources(projectRoot);
    if (!sources.includes(n)) return { ok: false, reason: 'not_found' };
    const inUse = (await readTips(projectRoot)).some(t => t.source === n);
    if (inUse) return { ok: false, reason: 'in_use' };
    const next = sources.filter(s => s !== n);
    await _writeSources(projectRoot, next);
    return { ok: true, sources: next };
  });
}
```

- [ ] **Step 4: Run, verify pass**

Run: `node --test agent/tips-store.test.mjs`
Expected: PASS (prior store tests + 2 new).

- [ ] **Step 5: Commit**

```bash
git add agent/tips-store.js agent/tips-store.test.mjs
git commit -m "feat(tips): editable source list — addSource/removeSource (news reserved, no orphans)"
```

---

## Task 2: Suggestion approve/suppress in the store

**Files:**
- Modify: `agent/tips-store.js`
- Test: `agent/tips-store.test.mjs`

- [ ] **Step 1: Write the failing tests** (append; add `approveSuggestion, suppressSuggestion, readSuppressed`)

```javascript
import { approveSuggestion, suppressSuggestion, readSuppressed } from './tips-store.js';

test('approveSuggestion creates a recommended news candidate (never active, never news in human sources)', async () => {
  const root = await tmpRoot();
  const tip = await approveSuggestion(root, { ticker: 'smci', catalyst: 'AI server demand', feed: 'Bloomberg', feedAt: '2026-05-29T13:00:00Z' });
  assert.equal(tip.ticker, 'SMCI');
  assert.equal(tip.phase, 'pending_candidate');
  assert.equal(tip.origin, 'recommended');
  assert.equal(tip.source, 'news');
  assert.equal(tip.actionableAt, null);
  assert.equal(tip.recommendation.feed, 'Bloomberg');
  // does not leak into the human source list:
  assert.equal((await getSources(root)).includes('news'), false);
  assert.equal((await readTips(root)).length, 1);
});

test('suppressSuggestion records a ticker and readSuppressed returns it (idempotent)', async () => {
  const root = await tmpRoot();
  await suppressSuggestion(root, 'tsla');
  await suppressSuggestion(root, 'TSLA'); // idempotent, case-insensitive
  const s = await readSuppressed(root);
  assert.deepEqual([...s], ['TSLA']);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `node --test agent/tips-store.test.mjs`
Expected: FAIL — `approveSuggestion is not a function`.

- [ ] **Step 3: Implement** (append to `agent/tips-store.js`)

```javascript
function suppressedFile(projectRoot) { return path.join(tipsDir(projectRoot), 'suppressed.json'); }

export async function readSuppressed(projectRoot) {
  try {
    const arr = JSON.parse(await fs.readFile(suppressedFile(projectRoot), 'utf-8'));
    return new Set(Array.isArray(arr) ? arr : []);
  } catch (err) {
    if (err.code === 'ENOENT') return new Set();
    throw err;
  }
}

// approveSuggestion: turn a news-feed suggestion into a pending_candidate record.
// Bypasses createTip's human-source validation because `news` is the reserved
// system source. Never active, never scored as an influenced tip until a human
// promotes it via the Phase-2 Add-to-universe flow (D14).
export async function approveSuggestion(projectRoot, { ticker, catalyst, feed, feedAt } = {}) {
  const t = String(ticker || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z.]*$/.test(t)) throw new Error('invalid ticker');
  const surfacedAt = new Date().toISOString();
  const tip = {
    id: `tip_${Date.now()}_${t}_${Math.random().toString(36).slice(2, 6)}`,
    ticker: t,
    thesis: String(catalyst || '').trim() || 'news catalyst',
    source: 'news',
    phase: 'pending_candidate',
    origin: 'recommended',
    surfacedAt,
    actionableAt: null,
    inUniverseAtLog: false,
    dismissed: false,
    recommendation: { catalyst: String(catalyst || ''), feed: String(feed || ''), feedAt: feedAt || surfacedAt },
  };
  return serialize(async () => {
    const tips = await readTips(projectRoot);
    tips.push(tip);
    await _atomicWriteTips(projectRoot, tips);
    return tip;
  });
}

// suppressSuggestion: stop a ticker from reappearing in the news feed.
export async function suppressSuggestion(projectRoot, ticker) {
  const t = String(ticker || '').trim().toUpperCase();
  if (!t) throw new Error('ticker is required');
  return serialize(async () => {
    const set = await readSuppressed(projectRoot);
    set.add(t);
    const dir = tipsDir(projectRoot);
    await fs.mkdir(dir, { recursive: true });
    const tmp = suppressedFile(projectRoot) + '.tmp';
    await fs.writeFile(tmp, JSON.stringify([...set], null, 2));
    await fs.rename(tmp, suppressedFile(projectRoot));
    return { ok: true, ticker: t };
  });
}
```

- [ ] **Step 4: Run, verify pass**

Run: `node --test agent/tips-store.test.mjs`
Expected: PASS (+2).

- [ ] **Step 5: Commit**

```bash
git add agent/tips-store.js agent/tips-store.test.mjs
git commit -m "feat(tips): approveSuggestion (recommended news candidate) + suppressSuggestion"
```

---

## Task 3: `news-candidates.js` — derive OOU suggestions from briefs

**Files:**
- Create: `agent/news-candidates.js`
- Test: `agent/news-candidates.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
// agent/news-candidates.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listNewsCandidates } from './news-candidates.js';

async function tmpRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'news-'));
  await fs.mkdir(path.join(root, 'config'), { recursive: true });
  await fs.writeFile(path.join(root, 'config', 'prophet_tradable_universe.txt'), '# h\nIBM\nNVDA\n');
  await fs.mkdir(path.join(root, 'data', 'reports'), { recursive: true });
  await fs.mkdir(path.join(root, 'data', 'tips'), { recursive: true });
  return root;
}
async function brief(root, ymd, obj) {
  await fs.writeFile(path.join(root, 'data', 'reports', `daily_brief_${ymd}.json`), JSON.stringify(obj));
}

test('listNewsCandidates surfaces only OUT-OF-UNIVERSE catalyst names', async () => {
  const root = await tmpRoot();
  await brief(root, '20260529', {
    date: '2026-05-29',
    analyst_actions: [{ ticker: 'NVDA', firm: 'GS', action: 'raised', from: 200, to: 300, date: '2026-05-29T11:00:00Z' }], // in-universe -> excluded
    ticker_catalysts: [{ ticker: 'SMCI', event_type: 'ma', headline: 'AI server demand', source: 'Bloomberg', published: '2026-05-29T12:00:00Z' }],
  });
  const out = await listNewsCandidates(root);
  assert.equal(out.length, 1);
  assert.equal(out[0].ticker, 'SMCI');
  assert.equal(out[0].catalyst, 'AI server demand');
  assert.equal(out[0].feed, 'Bloomberg');
});

test('listNewsCandidates excludes already-tipped and suppressed tickers', async () => {
  const root = await tmpRoot();
  await brief(root, '20260529', {
    date: '2026-05-29',
    ticker_catalysts: [
      { ticker: 'SMCI', headline: 'x', source: 'B', published: '2026-05-29T12:00:00Z' },
      { ticker: 'AMD', headline: 'y', source: 'B', published: '2026-05-29T12:00:00Z' },
    ],
  });
  await fs.writeFile(path.join(root, 'data', 'tips', 'tips.json'),
    JSON.stringify([{ id: 't1', ticker: 'SMCI', phase: 'pending_candidate', dismissed: false }]));
  await fs.writeFile(path.join(root, 'data', 'tips', 'suppressed.json'), JSON.stringify(['AMD']));
  const out = await listNewsCandidates(root);
  assert.equal(out.length, 0); // SMCI already a tip, AMD suppressed
});
```

- [ ] **Step 2: Run, verify failure**

Run: `node --test agent/news-candidates.test.mjs`
Expected: FAIL — `Cannot find module './news-candidates.js'`.

- [ ] **Step 3: Implement `agent/news-candidates.js`**

```javascript
// agent/news-candidates.js
// Read-only: derive out-of-universe catalyst SUGGESTIONS from the persisted daily
// briefs (data/reports/daily_brief_*.json) — the same JSON the catalyst-news /
// analyst-actions scans emit. In-universe hits get no lane entry (the agent
// already trades + news-scans those). Suggestions exclude names already tipped or
// suppressed. This NEVER triggers the agent and is NOT a scored tip (D14).
import fs from 'node:fs/promises';
import path from 'node:path';
import { readUniverse, readTips, readSuppressed } from './tips-store.js';

export async function listNewsCandidates(projectRoot) {
  const dir = path.join(projectRoot, 'data', 'reports');
  let files;
  try {
    files = await fs.readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const universe = await readUniverse(projectRoot);
  const tipped = new Set((await readTips(projectRoot)).filter(t => !t.dismissed).map(t => t.ticker));
  const suppressed = await readSuppressed(projectRoot);

  // newest brief date wins per ticker
  const byTicker = new Map();
  const consider = (ticker, catalyst, feed, feedAt) => {
    const t = String(ticker || '').toUpperCase();
    if (!t || universe.has(t) || tipped.has(t) || suppressed.has(t)) return;
    const prev = byTicker.get(t);
    if (!prev || String(feedAt) > String(prev.feedAt)) {
      byTicker.set(t, { ticker: t, catalyst: String(catalyst || ''), feed: String(feed || ''), feedAt: feedAt || '' });
    }
  };
  for (const f of files) {
    if (!/^daily_brief_\d{8}\.json$/.test(f)) continue;
    let b;
    try { b = JSON.parse(await fs.readFile(path.join(dir, f), 'utf-8')); } catch { continue; }
    for (const a of b.analyst_actions || []) {
      const cat = `${a.firm || 'analyst'} ${a.action || 'update'}${a.to != null ? ` PT→${a.to}` : ''}`;
      consider(a.ticker, cat, a.firm || 'analyst', a.date || b.date);
    }
    for (const c of b.ticker_catalysts || []) {
      consider(c.ticker, c.headline || c.event_type || 'catalyst', c.source || 'news', c.published || b.date);
    }
  }
  return [...byTicker.values()].sort((a, b) => String(b.feedAt).localeCompare(String(a.feedAt)));
}
```

- [ ] **Step 4: Run, verify pass**

Run: `node --test agent/news-candidates.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add agent/news-candidates.js agent/news-candidates.test.mjs
git commit -m "feat(tips): news-candidates — OOU suggestions from daily briefs (read-only, D14)"
```

---

## Task 4: `matchTippedTrades` in the scorer (Trades-badge data)

**Files:**
- Modify: `agent/tips-scorer.js`
- Test: `agent/tips-scorer.test.mjs`

- [ ] **Step 1: Write the failing test** (append; add `matchTippedTrades` to the import line)

```javascript
import { matchTippedTrades } from './tips-scorer.js';

test('matchTippedTrades flags buys on an active tip underlying within the window', () => {
  const tips = [{ id: 't1', ticker: 'AMD', source: 'self', phase: 'active', actionableAt: '2026-05-20T14:00:00-04:00', dismissed: false }];
  const trades = [
    { sandboxId: 'sbx_6e4f26af', tool: 'place_options_order', symbol: 'AMD260717C00460000', side: 'buy', timestamp: '2026-05-20T15:00:00Z' }, // in window -> tipped
    { sandboxId: 'sbx_6e4f26af', tool: 'place_options_order', symbol: 'AMD260717C00460000', side: 'sell', timestamp: '2026-05-21T15:00:00Z' }, // sell -> not flagged
    { sandboxId: 'sbx_6e4f26af', tool: 'place_options_order', symbol: 'NVDA260717C00230000', side: 'buy', timestamp: '2026-05-20T15:00:00Z' }, // different underlying
    { sandboxId: 'sbx_6e4f26af', tool: 'place_options_order', symbol: 'AMD260717C00460000', side: 'buy', timestamp: '2026-07-01T15:00:00Z' }, // out of window
  ];
  const out = matchTippedTrades(tips, trades, { windowDays: 3 });
  assert.equal(out.length, 1);
  assert.equal(out[0].symbol, 'AMD260717C00460000');
  assert.equal(out[0].source, 'self');
  assert.equal(out[0].timestamp, '2026-05-20T15:00:00Z');
});
```

- [ ] **Step 2: Run, verify failure**

Run: `node --test agent/tips-scorer.test.mjs`
Expected: FAIL — `matchTippedTrades is not a function`.

- [ ] **Step 3: Implement** (append to `agent/tips-scorer.js`; reuses in-file `underlyingOf`, `etDateString`, `isTradingDay`, `nextTradingDay`, `addTradingDays`)

```javascript
// matchTippedTrades — for the Trades-tab badge. A trade is "influenced" iff it is
// a BUY whose underlying matches an active tip and whose timestamp is within that
// tip's window. Returns the matched trades' identity fields + the tip source.
// Read-only; operates on already-loaded tips + trades.
export function matchTippedTrades(tips, trades, opts = {}) {
  const windowDays = opts.windowDays ?? 3;
  const active = tips.filter(t => !t.dismissed && t.phase === 'active' && t.actionableAt);
  const out = [];
  for (const tr of trades) {
    if (String(tr.side || '').toLowerCase() !== 'buy') continue;
    const u = underlyingOf(tr.symbol);
    const tradeEt = tr.timestamp ? etDateString(new Date(tr.timestamp)) : null;
    if (!tradeEt) continue;
    let matchedSource = null;
    for (const tip of active) {
      if (tip.ticker !== u) continue;
      const startEt = etDateString(new Date(tip.actionableAt));
      const anchored = isTradingDay(startEt) ? startEt : nextTradingDay(startEt);
      const endEt = addTradingDays(anchored, windowDays);
      if (tradeEt >= anchored && tradeEt <= endEt) { matchedSource = tip.source; break; }
    }
    if (matchedSource) {
      out.push({ sandboxId: tr.sandboxId, timestamp: tr.timestamp, tool: tr.tool, symbol: tr.symbol, source: matchedSource });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run, verify pass**

Run: `node --test agent/tips-scorer.test.mjs`
Expected: PASS (+1).

- [ ] **Step 5: Commit**

```bash
git add agent/tips-scorer.js agent/tips-scorer.test.mjs
git commit -m "feat(tips): matchTippedTrades — influenced-trade identities for the Trades badge"
```

---

## Task 5: Flag-gated endpoints (sources, news-candidates, influenced)

**Files:**
- Modify: `agent/server.js`

- [ ] **Step 1: Add imports** (extend the existing tips-store import and add news-candidates + readTrades if needed)

```javascript
import { addSource, removeSource, approveSuggestion, suppressSuggestion } from './tips-store.js';
import { listNewsCandidates } from './news-candidates.js';
import { matchTippedTrades } from './tips-scorer.js';
```

(`readTrades` is already imported in server.js for `/api/trades`; reuse it. If not, add `import { readTrades } from './trades-store.js';`.)

- [ ] **Step 2: Add the routes** (after the Phase-2 `app.post('/api/tips/:id/promote', ...)` handler)

```javascript
// Editable tip-source list (news reserved). GET already exists from Phase 1a.
app.post('/api/tips/sources', async (req, res) => {
  if (!tipsEnabled()) return res.status(404).json({ error: 'tips ledger disabled' });
  try {
    const r = await addSource(PROJECT_ROOT, (req.body || {}).name);
    res.status(r.ok ? 201 : 409).json(r);
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.delete('/api/tips/sources/:name', async (req, res) => {
  if (!tipsEnabled()) return res.status(404).json({ error: 'tips ledger disabled' });
  try {
    const r = await removeSource(PROJECT_ROOT, req.params.name);
    res.status(r.ok ? 200 : 409).json(r);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// News-candidate feed (D14) — OOU suggestions only; approve -> candidate queue;
// dismiss -> suppress. Never triggers the agent, never a scored tip.
app.get('/api/tips/news-candidates', async (req, res) => {
  if (!tipsEnabled()) return res.status(404).json({ error: 'tips ledger disabled' });
  try { res.json({ candidates: await listNewsCandidates(PROJECT_ROOT) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/tips/news-candidates/approve', async (req, res) => {
  if (!tipsEnabled()) return res.status(404).json({ error: 'tips ledger disabled' });
  try {
    const { ticker, catalyst, feed, feedAt } = req.body || {};
    const tip = await approveSuggestion(PROJECT_ROOT, { ticker, catalyst, feed, feedAt });
    res.status(201).json({ tip });
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.post('/api/tips/news-candidates/dismiss', async (req, res) => {
  if (!tipsEnabled()) return res.status(404).json({ error: 'tips ledger disabled' });
  try {
    const r = await suppressSuggestion(PROJECT_ROOT, (req.body || {}).ticker);
    res.json(r);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Influenced trades for the Trades-tab badge.
app.get('/api/tips/influenced', async (req, res) => {
  if (!tipsEnabled()) return res.status(404).json({ error: 'tips ledger disabled' });
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from and to required' });
    const tips = await readTips(PROJECT_ROOT);
    const { trades } = await readTrades(PROJECT_ROOT, { from: String(from), to: String(to) });
    res.json({ influenced: matchTippedTrades(tips, trades, {}) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
```

- [ ] **Step 3: Verify the server parses**

Run: `node -e "import('./agent/server.js').then(()=>console.log('loads')).catch(e=>{console.error(e);process.exit(1)})"`
Expected: prints `loads`.

- [ ] **Step 4: Smoke (read-only paths; do NOT approve/dismiss against real data)** — Bash tool:

```bash
ENABLE_TIPS_SCORECARD=true AGENT_PORT=3949 node agent/server.js > /tmp/p3_on.log 2>&1 &
sleep 3
echo "sources:    $(curl -s -o /dev/null -w '%{http_code}' localhost:3949/api/tips/sources)"           # 200
echo "news-cand:  $(curl -s -o /dev/null -w '%{http_code}' localhost:3949/api/tips/news-candidates)"    # 200
echo "influenced: $(curl -s -o /dev/null -w '%{http_code}' 'localhost:3949/api/tips/influenced?from=2026-05-01&to=2026-05-30')" # 200
echo "infl no-range: $(curl -s -o /dev/null -w '%{http_code}' localhost:3949/api/tips/influenced)"      # 400
kill %1
AGENT_PORT=3950 node agent/server.js > /tmp/p3_off.log 2>&1 &
sleep 3
echo "sources flag-off: $(curl -s -o /dev/null -w '%{http_code}' localhost:3950/api/tips/sources)"      # 404
kill %1
```
Expected: 200 / 200 / 200 / 400 (flag on), 404 (flag off). Do NOT POST approve/dismiss or DELETE in the smoke (those mutate data/tips/*). Report the codes.

- [ ] **Step 5: Commit**

```bash
git add agent/server.js
git commit -m "feat(tips): flag-gated endpoints — sources edit, news candidates, influenced trades"
```

---

## Task 6: News-candidates section in the Tips tab

**Files:**
- Modify: `agent/public/index.html`

- [ ] **Step 1: Add a container** — inside `#panel-tips`, immediately BEFORE the existing `<div id="tips-candidates"></div>` (added in Phase 2), insert:

```html
        <div id="tips-news"></div>
```

- [ ] **Step 2: Call the loader** — inside `loadTipsPanel()`, immediately after the existing `loadTipsCandidates();` line, add:

```javascript
    loadTipsNews();
```

- [ ] **Step 3: Add the JS** — paste after the `promoteCandidate` function (added in Phase 2):

```javascript
async function loadTipsNews() {
  const host = document.getElementById('tips-news');
  if (!host) return;
  let cands;
  try {
    const res = await fetch('/api/tips/news-candidates');
    if (!res.ok) { host.innerHTML = ''; return; }
    cands = (await res.json()).candidates || [];
  } catch { host.innerHTML = ''; return; }
  if (!cands.length) { host.innerHTML = ''; return; }
  host.innerHTML = `
    <div class="settings-content" style="margin-bottom:18px;">
      <h3>News candidates <span style="opacity:.6;font-weight:normal;">— out-of-universe catalyst names from the scans (suggestions only; never auto-traded)</span></h3>
      ${cands.map(c => `
        <div class="trade-card" id="news-${esc(c.ticker)}">
          <div class="trade-header">
            <span><span class="trade-symbol">${esc(c.ticker)}</span>
              <span class="trade-agent-badge">${esc(c.feed || 'news')}</span></span>
            <span class="trade-time">${esc((c.feedAt || '').slice(0, 10))}</span>
          </div>
          <div class="trade-details">${esc(c.catalyst || '')}</div>
          <div style="margin-top:6px; display:flex; gap:8px;">
            <button onclick='approveNewsCandidate(${JSON.stringify(c).replace(/'/g, "&#39;")})'>Approve → candidate</button>
            <button onclick="dismissNewsCandidate('${esc(c.ticker)}')">Dismiss</button>
          </div>
        </div>`).join('')}
    </div>`;
}

async function approveNewsCandidate(c) {
  try {
    const res = await fetch('/api/tips/news-candidates/approve', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticker: c.ticker, catalyst: c.catalyst, feed: c.feed, feedAt: c.feedAt }),
    });
    if (!res.ok) { const e = await res.json().catch(() => ({})); alert('Approve failed: ' + (e.error || res.status)); return; }
    loadTipsPanel(); // suggestion becomes a pending_candidate in the queue
  } catch (err) { alert(String(err)); }
}

async function dismissNewsCandidate(ticker) {
  try {
    const res = await fetch('/api/tips/news-candidates/dismiss', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticker }),
    });
    if (!res.ok) { alert('Dismiss failed: ' + res.status); return; }
    loadTipsNews();
  } catch (err) { alert(String(err)); }
}
```

- [ ] **Step 4: Counts check + commit**

Run: `node -e "const s=require('fs').readFileSync('agent/public/index.html','utf8'); console.log('loadTipsNews:',(s.match(/loadTipsNews/g)||[]).length,'approveNewsCandidate:',(s.match(/approveNewsCandidate/g)||[]).length,'dismissNewsCandidate:',(s.match(/dismissNewsCandidate/g)||[]).length,'tips-news id:',(s.match(/id=\"tips-news\"/g)||[]).length);"`
Expect: loadTipsNews 2, approveNewsCandidate 2, dismissNewsCandidate 2, tips-news id 1. Confirm functions are top-level (same scope as loadTipsCandidates) and `esc` not redefined.

```bash
git add agent/public/index.html
git commit -m "feat(tips): Tips-tab news-candidates feed — approve/dismiss (D14)"
```

---

## Task 7: Source editor in the Tips tab

**Files:**
- Modify: `agent/public/index.html`

- [ ] **Step 1: Add a container** — inside `#panel-tips`, immediately AFTER the existing `<div id="tips-ledger"></div>` line, insert:

```html
        <div id="tips-sources"></div>
```

- [ ] **Step 2: Call the loader** — inside `loadTipsPanel()`, immediately after the existing `loadTipsLedger();` line, add:

```javascript
    loadTipsSources();
```

- [ ] **Step 3: Add the JS** — paste after `loadTipsNews` (from Task 6):

```javascript
const TIPS_DEFAULT_SOURCES = ['self', 'dad'];
async function loadTipsSources() {
  const host = document.getElementById('tips-sources');
  if (!host) return;
  let sources;
  try {
    const res = await fetch('/api/tips/sources');
    if (!res.ok) { host.innerHTML = ''; return; }
    sources = (await res.json()).sources || [];
  } catch { host.innerHTML = ''; return; }
  host.innerHTML = `
    <div class="settings-content" style="margin-bottom:18px;">
      <h3>Tip sources <span style="opacity:.6;font-weight:normal;">— whose call was it? (news is reserved)</span></h3>
      <div style="display:flex; flex-wrap:wrap; gap:6px; margin-bottom:8px;">
        ${sources.map(s => `<span class="trade-agent-badge">${esc(s)}${TIPS_DEFAULT_SOURCES.includes(s) ? '' : ` <a href="#" onclick="removeTipSource('${esc(s)}');return false;" style="text-decoration:none;">&times;</a>`}</span>`).join('')}
      </div>
      <div style="display:flex; gap:8px; align-items:center;">
        <input id="new-source-name" maxlength="24" placeholder="add a source…" style="width:160px;">
        <button onclick="addTipSource()">Add source</button>
        <span id="source-edit-error" style="color:var(--error); font-size:12px;"></span>
      </div>
    </div>`;
}

async function addTipSource() {
  const name = (document.getElementById('new-source-name').value || '').trim();
  const err = document.getElementById('source-edit-error');
  if (err) err.textContent = '';
  if (!name) return;
  try {
    const res = await fetch('/api/tips/sources', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { if (err) err.textContent = j.error || j.reason || ('error ' + res.status); return; }
    loadTipsSources();
  } catch (e) { if (err) err.textContent = String(e); }
}

async function removeTipSource(name) {
  try {
    const res = await fetch('/api/tips/sources/' + encodeURIComponent(name), { method: 'DELETE' });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { alert('Remove failed: ' + (j.reason || j.error || res.status)); return; }
    loadTipsSources();
  } catch (e) { alert(String(e)); }
}
```

- [ ] **Step 4: Counts check + commit**

Run: `node -e "const s=require('fs').readFileSync('agent/public/index.html','utf8'); console.log('loadTipsSources:',(s.match(/loadTipsSources/g)||[]).length,'addTipSource:',(s.match(/addTipSource/g)||[]).length,'removeTipSource:',(s.match(/removeTipSource/g)||[]).length,'tips-sources id:',(s.match(/id=\"tips-sources\"/g)||[]).length);"`
Expect: loadTipsSources 2, addTipSource 2, removeTipSource 2, tips-sources id 1.

```bash
git add agent/public/index.html
git commit -m "feat(tips): Tips-tab source editor — add/remove (news reserved, defaults locked)"
```

---

## Task 8: `Tipped · source` badge + "tipped only" filter on the Trades tab

**Files:**
- Modify: `agent/public/index.html`

The Trades panel renders cards via `addTradeCard(trade)` (~line 2863), keyed by `_tradeKey(t) = [sandboxId, timestamp, tool, symbol].join('|')` (~line 2855), and filters with `applyTradesFilterToCard(card)` (~line 3104). You will: load an influenced-trade index, badge matching cards, and add a "tipped only" checkbox.

- [ ] **Step 1: Add the checkbox** — in the trades filter row (after the existing `trades-historic-toggle` label, ~line 1188), insert:

```html
          <label class="trades-historic-toggle">
            <input type="checkbox" id="trades-tipped-toggle" onchange="applyTradesFilter()" />
            Tipped only
          </label>
```

- [ ] **Step 2: Add the influenced index + loader** — near the other trades globals (after `const _renderedTradeKeys = new Set();`, ~line 2853), add:

```javascript
const _tippedIndex = new Map(); // _tradeKey -> source
async function loadInfluencedTrades(from, to) {
  try {
    const res = await fetch('/api/tips/influenced?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to));
    if (!res.ok) return; // flag off or error -> no badges
    const { influenced } = await res.json();
    for (const it of influenced || []) _tippedIndex.set(_tradeKey(it), it.source);
  } catch { /* no badges */ }
}
```

- [ ] **Step 3: Badge matching cards in `addTradeCard`** — inside `addTradeCard`, after the line `const key = _tradeKey(trade);` already computed near the top, capture the source; then add the badge into the header and a dataset flag. Specifically:

(a) After the existing `card.dataset.sandboxId = sandboxId;` line, add:

```javascript
  const tippedSource = _tippedIndex.get(key);
  if (tippedSource) card.dataset.tipped = tippedSource;
```

(b) In `headerHtml`, add the badge right after the agent badge span — change the agent-badge line so the header includes, immediately after `'<span class="trade-agent-badge">' + esc(agentName) + '</span>' +`:

```javascript
        (tippedSource ? '<span class="trade-agent-badge" title="influenced by a logged tip">Tipped &middot; ' + esc(tippedSource) + '</span>' : '') +
```

- [ ] **Step 4: Honor the filter** — in `applyTradesFilterToCard(card)` (~line 3104), make the "tipped only" checkbox hide non-tipped cards. Read the function, and add at the start of its visibility computation a check: when `document.getElementById('trades-tipped-toggle')?.checked` is true, a card is hidden unless `card.dataset.tipped` is set. Combine with the existing agent filter (a card shows only if it passes BOTH). Concretely, find where the function sets the card's shown/hidden state and AND-in:

```javascript
  const tippedOnly = document.getElementById('trades-tipped-toggle')?.checked;
  const passesTipped = !tippedOnly || !!card.dataset.tipped;
```
then incorporate `passesTipped` into the existing show/hide decision (the card is visible only if it already passed the agent filter AND `passesTipped`).

- [ ] **Step 5: Load the index before rendering** — find where trades are fetched and rendered (`seedTodayTrades` ~line 2965 and the historic apply path ~line 3045 that calls `renderTradesBulk`). Before each `renderTradesBulk(...)` call, `await loadInfluencedTrades(from, to)` for the same range so the index is populated when cards render. For `seedTodayTrades`, the range is `today, today`. For the historic apply path, use the same `from`/`to` it fetches. (Add the `await` calls; keep them inside the existing `try`.)

- [ ] **Step 6: Verify + commit**

Run: `ENABLE_TIPS_SCORECARD=true node agent/server.js` and open the dashboard → **Trades**. With at least one active tip whose window covers a real buy on that underlying, the matching trade card shows a `Tipped · <source>` badge, and ticking **Tipped only** hides the rest. With the flag off, no badges and the toggle simply yields an empty set (all hidden when ticked) — acceptable. Also run the counts check:
`node -e "const s=require('fs').readFileSync('agent/public/index.html','utf8'); console.log('loadInfluencedTrades:',(s.match(/loadInfluencedTrades/g)||[]).length,'_tippedIndex:',(s.match(/_tippedIndex/g)||[]).length,'trades-tipped-toggle:',(s.match(/trades-tipped-toggle/g)||[]).length);"`
Expect: loadInfluencedTrades ≥ 3 (def + 2 calls), _tippedIndex ≥ 3, trades-tipped-toggle ≥ 2 (checkbox + filter read).

```bash
git add agent/public/index.html
git commit -m "feat(tips): Trades-tab Tipped·source badge + tipped-only filter"
```

---

## Task 9: Document + full suite green

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Append to the Tips block in `.env.example`** (after the Phase-2 block)

```bash
# Phase 3 (news + polish): the News-candidate feed reads persisted daily briefs
# (data/reports/daily_brief_*.json) and surfaces ONLY out-of-universe catalyst
# names as suggestions — it never triggers the agent and never creates a scored
# tip (approved suggestions enter the candidate queue as pending_candidate). The
# Tipped·source badge + source editor live in the dashboard. No new flags.
```

- [ ] **Step 2: Run the full suite**

Run: `node --test agent/market-calendar.test.mjs agent/bar-cache-reader.test.mjs agent/tips-store.test.mjs agent/tips-scorer.test.mjs agent/universe-store.test.mjs agent/options-eligibility.test.mjs agent/news-candidates.test.mjs`
Expected: ALL pass, 0 fail.

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "docs(tips): document Phase 3 news feed + polish (no new flags)"
```

---

## Self-review (completed during planning)

**Spec coverage (Phase 3 slice of §10):**
- News-candidate feed surfacing OOU-only suggestions (§5.3, D14) ✓ Tasks 3,5,6; in-universe hits get no lane entry ✓ (`listNewsCandidates` excludes `universe.has`); approve → `pending_candidate`/`origin:recommended`/`source:news` ✓ Task 2; dismiss → suppress ✓ Task 2; never triggers the agent / never a scored tip ✓ (no agent call anywhere; recommended candidates only enter the queue).
- Trades-tab `Tipped · <source>` badge + "tipped only" filter (§5.6) ✓ Tasks 4,5,8.
- Settings/source editor with `news` reserved/locked (§5.6, §4.3) ✓ Tasks 1,5,7 (placed in the Tips tab — noted deviation, decision #6).
- Single-writer (D13): all new mutators (`addSource`/`removeSource`/`approveSuggestion`/`suppressSuggestion`) serialized in the store; `news-candidates` + `matchTippedTrades` are read-only ✓.
- Flag-gated default OFF ✓ Task 5 (every route 404s when disabled).
- **Deferred (correctly out of scope):** the `review-performance` read-only scorecard summary (spec §5.7 — a separate, optional follow-up, not part of "news + polish"); re-surfacing a suppressed ticker via UI (manual file edit suffices at these volumes).

**Placeholder scan:** no TBD/TODO; every code step is complete and runnable. Task 8 steps (3a/3b/4/5) describe edits to an existing function by quoting the exact anchor lines and the exact code to insert — the implementer must read `addTradeCard`/`applyTradesFilterToCard` and weave them in, which is appropriate for modifying existing JS.

**Type consistency:** `listNewsCandidates` → `[{ticker, catalyst, feed, feedAt}]`, consumed by the approve endpoint (`{ticker,catalyst,feed,feedAt}`) and `approveSuggestion` (same), rendered by `loadTipsNews`. `matchTippedTrades` → `[{sandboxId, timestamp, tool, symbol, source}]`, which the influenced endpoint returns as `{influenced}` and the client keys via `_tradeKey({sandboxId,timestamp,tool,symbol})` — identical field set to the page's `_tradeKey`. `addSource`/`removeSource` → `{ok, sources?, reason?}`. Store record shape for recommended candidates matches the spec §4.1 (`recommendation:{catalyst,feed,feedAt}`).

**Safety:** the only writes are human-clicked + flag-gated (approve/dismiss/add-source/remove-source); the smoke test exercises only the read-only GETs and the flag-off 404s, and explicitly does NOT POST/DELETE against real data; `removeSource` refuses to orphan in-use sources; the news lane has no path to the agent.
