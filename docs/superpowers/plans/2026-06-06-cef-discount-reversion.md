# CEF Discount-Reversion Premium — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pre-registered lab study of a long-only CEF discount-to-NAV mean-reversion premium, with a dual KEEP gate — friction-net holdout edge AND genuine orthogonality to the equity book + existing fleet lanes — to decide whether it fills Subproject 1's equity-selloff ballast gap.

**Architecture:** Pure-function JS modules (`node:test`). Weekly CEFConnect data → discount z-score signal → long-only portfolio sim producing a friction-net weekly **price-change** return series (decomposed NAV-move vs Δdiscount) → hash-locked prereg → edge gate (block-bootstrap) + orthogonality gate (reuse the entire Subproject-1 `fleet-correlate` engine) → KEEP/REJECT. Lab-only, read-only, no deploy.

**Tech Stack:** Node ESM `.mjs`, built-in `node:test`, CEFConnect `pricinghistory` JSON API (free), reused S1 modules on **local main** (`fleet-correlate`, `fleet-align`, `fleet-prereg` pattern, `coil-threshold-metrics`, the S1 lane builders + `fleet-bars`/`fleet-fetch-*`).

**Spec:** `docs/superpowers/specs/2026-06-06-cef-discount-reversion-design.md` (read first).

---

## Execution conventions (read before Task 1)

- **Isolated worktree off LOCAL main** (S1 just landed at `b0943f2`; the reused modules live on local main, not origin). Create via `superpowers:using-git-worktrees` (native `EnterWorktree` defaults to origin/main — branch from local HEAD instead, as in S1). Copy the uncommitted spec + this plan into the worktree (they're untracked in root). Re-assert the branch before any git mutation.
- **Pure modules → full TDD by Haiku subagents**; **data-coupled CLIs + orchestrator → controller-authored** (the documented ORB/S1 pattern; contracts fully specified here).
- **Return-series shape** (study-wide, matches S1): `{ date:'YYYY-MM-DD', ret:number, active:boolean }` ascending, weekly. `ret` = friction-net **price-change** return.
- **Weekly bar shape** (post-load): `{ date:'YYYY-MM-DD', price, nav, discount }` where `discount` is a fraction (negative = trades below NAV). Ascending.
- `data/lab/*` git-ignored; only `docs/lab/cef-discount-reversion-RESULTS.md` + `-RUNBOOK.md` committed.
- No FMP key needed for the CEF data (CEFConnect is keyless); the orthogonality gate's QQQ/lane regeneration reuses S1's FMP caches (source root `.env`).

---

## Task 1: Universe + bar loader + CEFConnect fetch (+ distribution spike)

**Files:** Create `scripts/cef-universe.mjs` (+`.test.mjs`), `scripts/cef-bars.mjs` (+`.test.mjs`), `scripts/cef-fetch.mjs` (CLI, controller-authored).

- [ ] **Step 1: Write failing test for `cef-universe.mjs`**

```javascript
// scripts/cef-universe.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CEF_UNIVERSE, tierOf, allCefTickers } from './cef-universe.mjs';

test('universe is a curated liquid list with {ticker,type,tier} and >=40 names', () => {
  assert.ok(CEF_UNIVERSE.length >= 40);
  for (const c of CEF_UNIVERSE) {
    assert.match(c.ticker, /^[A-Z]{2,5}$/);
    assert.ok(['fixed_income', 'equity', 'muni', 'multi_asset'].includes(c.type));
    assert.ok(['liquid', 'mid', 'thin'].includes(c.tier));
  }
});
test('tierOf returns the liquidity tier (case-insensitive), "" if unknown', () => {
  assert.equal(tierOf('pdi'), 'liquid');
  assert.equal(tierOf('NOPE'), '');
});
test('allCefTickers is the deduped ticker list', () => {
  const all = allCefTickers();
  assert.equal(all.length, new Set(all).size);
  assert.ok(all.includes('PDI'));
});
```

- [ ] **Step 2: Run → FAIL.** `node --test scripts/cef-universe.test.mjs`

- [ ] **Step 3: Implement `cef-universe.mjs`** — a curated list of liquid CEFs (survivorship-biased to currently-listed names — a known, loudly-caveated limitation per spec §10). Tiers assign the friction half-spread. Author this list (≈50 names across types; tiers from rough AUM/volume — large flagship CEFs = liquid, smaller = mid, niche = thin):

```javascript
// scripts/cef-universe.mjs
// Curated liquid CEF universe for the discount-reversion study. SURVIVORSHIP-BIASED by
// construction (current-snapshot; funds liquidated/merged by 2026 are invisible) — a loud
// RESULTS caveat per spec §10. tier drives the friction half-spread (cef-friction.mjs).
export const CEF_UNIVERSE = [
  // fixed income / credit (flagship = liquid)
  { ticker: 'PDI', type: 'fixed_income', tier: 'liquid' }, { ticker: 'PTY', type: 'fixed_income', tier: 'liquid' },
  { ticker: 'PDO', type: 'fixed_income', tier: 'liquid' }, { ticker: 'PCN', type: 'fixed_income', tier: 'mid' },
  { ticker: 'PCM', type: 'fixed_income', tier: 'thin' }, { ticker: 'DSL', type: 'fixed_income', tier: 'liquid' },
  { ticker: 'RA', type: 'fixed_income', tier: 'mid' }, { ticker: 'EIC', type: 'fixed_income', tier: 'mid' },
  { ticker: 'ECC', type: 'fixed_income', tier: 'mid' }, { ticker: 'OXLC', type: 'fixed_income', tier: 'mid' },
  { ticker: 'BGT', type: 'fixed_income', tier: 'thin' }, { ticker: 'JQC', type: 'fixed_income', tier: 'mid' },
  { ticker: 'NCV', type: 'fixed_income', tier: 'thin' }, { ticker: 'NCZ', type: 'fixed_income', tier: 'thin' },
  { ticker: 'PFN', type: 'fixed_income', tier: 'mid' }, { ticker: 'PFL', type: 'fixed_income', tier: 'thin' },
  { ticker: 'FAX', type: 'fixed_income', tier: 'thin' }, { ticker: 'AWF', type: 'fixed_income', tier: 'mid' },
  { ticker: 'BHK', type: 'fixed_income', tier: 'mid' }, { ticker: 'BTZ', type: 'fixed_income', tier: 'liquid' },
  // muni
  { ticker: 'NAD', type: 'muni', tier: 'liquid' }, { ticker: 'NEA', type: 'muni', tier: 'mid' },
  { ticker: 'NZF', type: 'muni', tier: 'liquid' }, { ticker: 'NVG', type: 'muni', tier: 'mid' },
  { ticker: 'PML', type: 'muni', tier: 'mid' }, { ticker: 'PMX', type: 'muni', tier: 'thin' },
  { ticker: 'BLE', type: 'muni', tier: 'thin' }, { ticker: 'MUB', type: 'muni', tier: 'mid' },
  { ticker: 'VKQ', type: 'muni', tier: 'thin' }, { ticker: 'MQY', type: 'muni', tier: 'thin' },
  // equity / covered-call
  { ticker: 'ADX', type: 'equity', tier: 'liquid' }, { ticker: 'USA', type: 'equity', tier: 'mid' },
  { ticker: 'GAB', type: 'equity', tier: 'mid' }, { ticker: 'ETV', type: 'equity', tier: 'mid' },
  { ticker: 'ETY', type: 'equity', tier: 'mid' }, { ticker: 'ETB', type: 'equity', tier: 'thin' },
  { ticker: 'QQQX', type: 'equity', tier: 'mid' }, { ticker: 'BST', type: 'equity', tier: 'liquid' },
  { ticker: 'BSTZ', type: 'equity', tier: 'mid' }, { ticker: 'BME', type: 'equity', tier: 'mid' },
  { ticker: 'BMEZ', type: 'equity', tier: 'mid' }, { ticker: 'STK', type: 'equity', tier: 'thin' },
  { ticker: 'EOS', type: 'equity', tier: 'thin' }, { ticker: 'EOI', type: 'equity', tier: 'thin' },
  // multi-asset / infrastructure / real-asset
  { ticker: 'UTF', type: 'multi_asset', tier: 'liquid' }, { ticker: 'UTG', type: 'multi_asset', tier: 'liquid' },
  { ticker: 'RNP', type: 'multi_asset', tier: 'mid' }, { ticker: 'RQI', type: 'multi_asset', tier: 'mid' },
  { ticker: 'AOD', type: 'multi_asset', tier: 'thin' }, { ticker: 'HTD', type: 'multi_asset', tier: 'thin' },
  { ticker: 'PEO', type: 'multi_asset', tier: 'thin' }, { ticker: 'BCAT', type: 'multi_asset', tier: 'mid' },
];

export function tierOf(ticker) {
  const t = String(ticker).toUpperCase().trim();
  const hit = CEF_UNIVERSE.find((c) => c.ticker === t);
  return hit ? hit.tier : '';
}
export function allCefTickers() { return [...new Set(CEF_UNIVERSE.map((c) => c.ticker))]; }
```

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Write failing test for `cef-bars.mjs`**

```javascript
// scripts/cef-bars.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCefBars, CEF_CACHE_SUBDIR } from './cef-bars.mjs';

test('loadCefBars parses weekly {date,price,nav,discount}, ascending, discount as a fraction', () => {
  const root = mkdtempSync(join(tmpdir(), 'cef-'));
  mkdirSync(join(root, CEF_CACHE_SUBDIR), { recursive: true });
  writeFileSync(join(root, CEF_CACHE_SUBDIR, 'PDI.json'), JSON.stringify({
    written_at: '2026-06-06T00:00:00Z',
    weekly: [
      { date: '2025-06-13', price: 19.0, nav: 16.9, discount: 0.1243 },
      { date: '2025-06-06', price: 18.97, nav: 16.84, discount: 0.1265 },
    ],
  }));
  const bars = loadCefBars(root, 'PDI');
  assert.equal(bars.length, 2);
  assert.deepEqual(bars.map((b) => b.date), ['2025-06-06', '2025-06-13']); // ascending
  assert.ok(Math.abs(bars[0].discount - 0.1265) < 1e-9);
});
test('loadCefBars returns [] for a missing ticker', () => {
  const root = mkdtempSync(join(tmpdir(), 'cef-'));
  assert.deepEqual(loadCefBars(root, 'NOPE'), []);
});
```

- [ ] **Step 6: Run → FAIL.**

- [ ] **Step 7: Implement `cef-bars.mjs`**

```javascript
// scripts/cef-bars.mjs
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CEF_CACHE_SUBDIR = join('data', 'lab', 'cef-cache');

export function loadCefBars(projectRoot, ticker) {
  const path = join(projectRoot, CEF_CACHE_SUBDIR, `${ticker.toUpperCase()}.json`);
  let obj;
  try { obj = JSON.parse(readFileSync(path, 'utf8')); } catch { return []; }
  const rows = (obj.weekly || [])
    .filter((r) => r && r.date && typeof r.price === 'number' && typeof r.nav === 'number')
    .map((r) => ({ date: r.date, price: r.price, nav: r.nav, discount: r.discount }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return rows;
}
```

- [ ] **Step 8: Run → PASS.**

- [ ] **Step 9: Controller-author `scripts/cef-fetch.mjs`** (CLI). Contract: for each `allCefTickers()`, GET `https://www.cefconnect.com/api/v3/pricinghistory/{T}/5Y` (header `User-Agent: Mozilla/5.0`); from `Data.PriceHistory[]` map each row → `{ date: DataDateJs.replaceAll('/','-'), price: Data, nav: NAVData, discount: DiscountData/100 }`; write `data/lab/cef-cache/{T}.json` = `{ written_at, weekly:[...] }` (ascending). Throttle ~250ms between tickers (rate-limit safety). Print `{T}: {n} weeks`. Tolerate per-ticker errors (log, continue; drop empty-history names with a warning). **Distribution spike (non-blocking):** also try `GET .../distributionhistory/{T}` and a couple of variants for ONE ticker (PDI); if any returns JSON, log the shape for a later total-return add — if all 404, log "distributions unavailable; price-change basis stands" and proceed.

- [ ] **Step 10: Run the fetch** — `node scripts/cef-fetch.mjs`. Expected: ~50 cache files, each ~245 weekly rows (2021→2026). Note any tickers that returned empty (drop from the effective universe; record in RESULTS).

- [ ] **Step 11: Commit** — `git add scripts/cef-universe.* scripts/cef-bars.* scripts/cef-fetch.mjs && git commit -m "feat(cef): universe + weekly bar loader + CEFConnect fetch"`

---

## Task 2: Discount z-score signal

**Files:** Create `scripts/cef-signal.mjs` (+`.test.mjs`).

- [ ] **Step 1: Write failing tests**

```javascript
// scripts/cef-signal.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discountZ, entryFires, exitFires } from './cef-signal.mjs';

test('discountZ = (D_t − trailingMean) / trailingStd over the prior L weeks (excludes t)', () => {
  // discounts: 10 weeks at -0.10, then a wide -0.16 at t. mean=-0.10,std=0 over flat -> guard returns null
  const flat = Array.from({ length: 11 }, () => -0.10);
  assert.equal(discountZ(flat, 10, 10), null); // zero std -> undefined z
  // varied series
  const d = [-0.08, -0.10, -0.12, -0.10, -0.09, -0.11, -0.13, -0.10, -0.10, -0.12, -0.18];
  const z = discountZ(d, 10, 10);
  assert.ok(z < -1.5); // -0.18 is well below the trailing-10 norm
});

test('entryFires when z <= -zEnter (unusually wide discount = unusually cheap)', () => {
  assert.equal(entryFires(-1.6, 1.5), true);
  assert.equal(entryFires(-1.4, 1.5), false);
  assert.equal(entryFires(null, 1.5), false); // undefined z never enters
});

test('exitFires when z >= 0 (reverted to norm) OR weeks held >= timeStop', () => {
  assert.equal(exitFires(0.1, 5, 26), true);  // reverted
  assert.equal(exitFires(-0.5, 26, 26), true); // time stop
  assert.equal(exitFires(-0.5, 5, 26), false); // still wide, not timed out
  assert.equal(exitFires(null, 5, 26), false); // missing z holds (until time stop)
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `cef-signal.mjs`**

```javascript
// scripts/cef-signal.mjs
// Discount z-score vs the fund's own trailing norm. `discounts` is the ascending discount
// fraction series; index t is the latest. z uses the L weeks STRICTLY BEFORE t (no look-ahead).
export function discountZ(discounts, t, L = 52) {
  if (t < L) return null;
  const win = discounts.slice(t - L, t); // prior L, excludes t
  const m = win.reduce((a, b) => a + b, 0) / win.length;
  let v = 0; for (const x of win) v += (x - m) * (x - m);
  const sd = Math.sqrt(v / win.length);
  if (sd === 0) return null;
  return (discounts[t] - m) / sd;
}
export function entryFires(z, zEnter = 1.5) { return z != null && z <= -zEnter; }
export function exitFires(z, weeksHeld, timeStop = 26) {
  if (weeksHeld >= timeStop) return true;
  return z != null && z >= 0;
}
```

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** — `git commit -am "feat(cef): discount z-score signal (entry/exit, no look-ahead)"`

---

## Task 3: Friction model (tiered half-spread + 2× stress)

**Files:** Create `scripts/cef-friction.mjs` (+`.test.mjs`).

- [ ] **Step 1: Write failing tests**

```javascript
// scripts/cef-friction.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { halfSpreadOf, roundTripCost } from './cef-friction.mjs';

test('halfSpreadOf maps tier -> pinned half-spread fraction (liquid 25 / mid 50 / thin 100 bps)', () => {
  assert.ok(Math.abs(halfSpreadOf('liquid') - 0.0025) < 1e-12);
  assert.ok(Math.abs(halfSpreadOf('mid') - 0.0050) < 1e-12);
  assert.ok(Math.abs(halfSpreadOf('thin') - 0.0100) < 1e-12);
  assert.ok(Math.abs(halfSpreadOf('unknown') - 0.0100) < 1e-12); // unknown -> most conservative
});

test('roundTripCost = 2x half-spread, x stressMult', () => {
  assert.ok(Math.abs(roundTripCost('liquid', 1) - 0.0050) < 1e-12); // 2*0.0025
  assert.ok(Math.abs(roundTripCost('liquid', 2) - 0.0100) < 1e-12); // 2x stress
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `cef-friction.mjs`**

```javascript
// scripts/cef-friction.mjs
// Pinned per-tier half-spreads (spec §10). Round-trip = entry half-spread + exit half-spread.
// commission ~ $0 retail. stressMult=2 is the robustness check.
const HALF_SPREAD = { liquid: 0.0025, mid: 0.0050, thin: 0.0100 };
export function halfSpreadOf(tier) { return HALF_SPREAD[tier] ?? HALF_SPREAD.thin; }
export function roundTripCost(tier, stressMult = 1) { return 2 * halfSpreadOf(tier) * stressMult; }
```

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** — `git commit -am "feat(cef): tiered friction model (25/50/100bps half-spread + 2x stress)"`

---

## Task 4: Portfolio sim → weekly sleeve series (price-change, friction-net, decomposed)

**Files:** Create `scripts/cef-sim.mjs` (+`.test.mjs`).

Long-only sim: each week, free slots whose exit fired; admit new z≤−1.5 names **most-negative-z first** up to ≤10, one per CEF. A held position's weekly return = its price-change return; the round-trip friction is charged at exit. Output the **weekly sleeve series** (equal-weight of active positions) `{date,ret,active}` plus a decomposition (NAV-move vs Δdiscount) and a per-trade ledger.

- [ ] **Step 1: Write failing tests**

```javascript
// scripts/cef-sim.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weeklyPriceReturn, decomposeReturn, simulateCef } from './cef-sim.mjs';

test('weeklyPriceReturn = price_t/price_{t-1} - 1', () => {
  assert.ok(Math.abs(weeklyPriceReturn(19.0, 18.97) - (19.0 / 18.97 - 1)) < 1e-12);
});

test('decomposeReturn splits price-change into NAV-move + Δdiscount (approx, multiplicative-exact)', () => {
  // price = nav*(1+discount) with discount signed (premium +, discount -)
  const a = { price: 100, nav: 100, discount: 0 };       // par
  const b = { price: 99 * 1.02, nav: 99, discount: 0.02 }; // nav fell to 99, premium rose to +2%
  const d = decomposeReturn(a, b);
  // total price return:
  assert.ok(Math.abs(d.total - (b.price / a.price - 1)) < 1e-9);
  // navMove = 99/100 - 1; discountChange picks up the rest (multiplicative)
  assert.ok(Math.abs(d.navMove - (-0.01)) < 1e-9);
  assert.ok(Math.abs((1 + d.navMove) * (1 + d.discountChange) - (1 + d.total)) < 1e-9);
});

test('simulateCef enters most-negative-z first, caps positions, charges round-trip at exit; emits {date,ret,active}', () => {
  const bars = makeTwoCefWideThenRevert(); // helper: 60 weekly bars/ticker, a clean widen->revert episode
  const series = simulateCef(bars, { L: 52, zEnter: 1.5, timeStop: 26, maxPositions: 10, tierByTicker: { AAA: 'liquid', BBB: 'liquid' } });
  assert.ok(series.weekly.every((p) => typeof p.ret === 'number' && typeof p.active === 'boolean'));
  assert.ok(series.weekly.some((p) => p.active));     // entered
  assert.ok(series.trades.length >= 1);               // a completed trade
  assert.ok(series.trades[0].netReturn < series.trades[0].grossReturn); // friction charged
});
```
(Helper `makeTwoCefWideThenRevert` builds ≥53 warmup weeks at a stable discount then a widening to z≤−1.5 then reversion to z≥0 for one ticker; controller authors it inline so the episode reliably fires.)

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `cef-sim.mjs`** — core logic:

```javascript
// scripts/cef-sim.mjs
import { discountZ, entryFires, exitFires } from './cef-signal.mjs';
import { roundTripCost } from './cef-friction.mjs';

export function weeklyPriceReturn(prevPrice, price) { return price / prevPrice - 1; }

// price = nav*(1+discount). total = (1+navMove)*(1+discountChange)-1.
export function decomposeReturn(a, b) {
  const total = b.price / a.price - 1;
  const navMove = b.nav / a.nav - 1;
  const discountChange = (1 + total) / (1 + navMove) - 1;
  return { total, navMove, discountChange };
}

// barsByTicker: Map<ticker, bars[]> ascending {date,price,nav,discount}. Returns
// { weekly:[{date,ret,active}], trades:[{ticker,entryDate,exitDate,grossReturn,netReturn,navMove,discountChange}] }.
export function simulateCef(barsByTicker, { L = 52, zEnter = 1.5, timeStop = 26, maxPositions = 10, stressMult = 1, tierByTicker = {} } = {}) {
  const tickers = [...barsByTicker.keys()];
  const idx = {}; for (const t of tickers) idx[t] = new Map(barsByTicker.get(t).map((b, i) => [b.date, i]));
  const allDates = [...new Set(tickers.flatMap((t) => barsByTicker.get(t).map((b) => b.date)))].sort();
  const open = new Map(); // ticker -> { entryIdx, entryDate, weeksHeld }
  const weekly = []; const trades = [];

  for (let w = 0; w < allDates.length; w += 1) {
    const d = allDates[w];
    // (a) per-position weekly price-change for marking + exits
    let sumRet = 0, nActive = 0;
    for (const [t, pos] of [...open]) {
      const bars = barsByTicker.get(t); const i = idx[t].get(d); if (i == null || i === 0) continue;
      const r = weeklyPriceReturn(bars[i - 1].price, bars[i].price);
      pos.weeksHeld += 1;
      const z = discountZ(bars.map((b) => b.discount), i, L);
      let ret = r;
      if (exitFires(z, pos.weeksHeld, timeStop)) {
        ret -= roundTripCost(tierByTicker[t] || 'thin', stressMult); // charge friction at exit week
        const entryBar = bars[pos.entryIdx]; const exitBar = bars[i];
        const dec = decomposeReturn(entryBar, exitBar);
        const gross = exitBar.price / entryBar.price - 1;
        trades.push({ ticker: t, entryDate: pos.entryDate, exitDate: d, grossReturn: gross,
          netReturn: gross - roundTripCost(tierByTicker[t] || 'thin', stressMult),
          navMove: dec.navMove, discountChange: dec.discountChange });
        open.delete(t);
      }
      sumRet += ret; nActive += 1;
    }
    weekly.push({ date: d, ret: nActive ? sumRet / nActive : 0, active: nActive > 0 });

    // (b) entries — most-negative-z first, fill to cap, one per ticker
    if (open.size < maxPositions) {
      const cands = [];
      for (const t of tickers) {
        if (open.has(t)) continue;
        const bars = barsByTicker.get(t); const i = idx[t].get(d); if (i == null) continue;
        const z = discountZ(bars.map((b) => b.discount), i, L);
        if (entryFires(z, zEnter)) cands.push({ t, z, i });
      }
      cands.sort((a, b) => a.z - b.z); // most-negative-z first
      for (const c of cands) { if (open.size >= maxPositions) break; open.set(c.t, { entryIdx: c.i, entryDate: d, weeksHeld: 0 }); }
    }
  }
  return { weekly, trades };
}
```

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** — `git commit -am "feat(cef): long-only portfolio sim -> friction-net weekly price-change series + decomposition"`

---

## Task 5: Pre-registration (hash-locked)

**Files:** Create `scripts/cef-prereg.mjs` (+`.test.mjs`). Mirrors `fleet-prereg.mjs` (canonical sorted-key sha256).

- [ ] **Step 1: Write failing test**

```javascript
// scripts/cef-prereg.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrereg, hashPrereg } from './cef-prereg.mjs';

test('prereg pins every committed methodology key', () => {
  const p = buildPrereg();
  for (const k of ['window', 'signal', 'return_basis', 'friction', 'edge_gate', 'orthogonality_gate', 'checks', 'acceptable_findings'])
    assert.ok(k in p, `missing ${k}`);
  assert.equal(p.signal.L, 52); assert.equal(p.signal.z_enter, 1.5); assert.equal(p.signal.admission, 'most_negative_z_first');
  assert.equal(p.return_basis, 'price_change_decomposed_navmove_vs_discountchange');
  assert.deepEqual(p.friction.half_spread_bps, { liquid: 25, mid: 50, thin: 100 });
  assert.equal(p.edge_gate.block_weeks, 8);
  assert.equal(p.orthogonality_gate.lane_rho_max, 0.3);
});
test('hashPrereg is deterministic sha256 over canonical JSON', () => {
  assert.equal(hashPrereg(buildPrereg()), hashPrereg(buildPrereg()));
  assert.match(hashPrereg(buildPrereg()), /^[0-9a-f]{64}$/);
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `cef-prereg.mjs`** — `buildPrereg()` returns the §10 commitments: window (2021–2026 weekly, midpoint split, regime caveat), signal (L=52, z_enter=1.5, exit z≥0/26w, ≤10, most_negative_z_first), return_basis ('price_change_decomposed_navmove_vs_discountchange', yield descriptive-only), friction ({half_spread_bps:{liquid:25,mid:50,thin:100}}, stress 2×), edge_gate ({basis:'weekly_sleeve_price_change', bootstrap_block_weeks:8, ci_lower>0}), orthogonality_gate ({qqq_beta_ci_near_0:true, crisis_mean_ci_not_below_0:true, lane_rho_max:0.3}), checks (['regime_chase','train_half_reported','episode_count']), acceptable_findings (friction-death / beta-or-co-crash / nav-drift-or-yield-not-reversion / orthogonal-no-edge / survivorship-false-keep). `hashPrereg` = canonical (recursively sorted keys) → `createHash('sha256')` (copy the `canonical` helper from `fleet-prereg.mjs`).

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** — `git commit -am "feat(cef): hash-locked pre-registration block"`

---

## Task 6: Orchestrator — train/holdout, dual gate, RESULTS

**Files:** Create `scripts/cef-score.mjs` (CLI orchestrator, controller-authored). Reuses S1 + the new modules.

- [ ] **Step 1: Controller-author `cef-score.mjs`.** Orchestration contract (no new pure logic — wiring + the verdict):
  1. `buildPrereg`+`hashPrereg` → write `data/lab/cef-prereg.json` FIRST.
  2. Build `barsByTicker` from `loadCefBars` over `allCefTickers()` (drop empties); `tierByTicker` from `cef-universe`.
  3. `simulateCef` on the **full** window, and separately restricted to **train** (≤ mid-2023) and **holdout** (> mid-2023) by slicing the weekly series at the pinned boundary.
  4. **Edge gate (holdout):** block-bootstrap the holdout weekly sleeve `ret` (8-week blocks; reuse the `mulberry32`+block idiom from `coil-threshold-metrics`/`fleet-correlate`) → mean + CI; report train mean alongside; count independent discount-widening episodes (weeks where ≥3 names newly fire). Run at 1× and 2× friction.
  5. **Orthogonality gate:** align the full-window weekly sleeve to QQQ + regenerated Coil/Turtle/Drift weekly series (reuse `fleet-align.toWeekly`/`alignDaily`, and the S1 builders `simulateTurtle`/`buildCoilSeries`/`buildDriftSeries` + `fleet-fetch-bars`/`-earnings` caches) → `fleet-correlate`: QQQ β + `bootstrapBetaCI`; crisis cut (`crisisWeeks`/`crisisMean`/`crisisMeanCI` + `rotationBand` descriptive); `pearson` to each lane.
  6. **Verdict:** KEEP iff edge-gate CI-lower>0 (net, holdout) AND β-CI near/brackets 0 AND crisis-mean-CI not entirely<0 AND |ρ|<0.3 to each lane; else REJECT, with the binding reason.
  7. Decomposition (mean navMove vs discountChange across trades) + regime-chase (entry-week histogram by year; mean netReturn of trades entered in 2022–2023 vs rest).
  8. Render `docs/lab/cef-discount-reversion-RESULTS.md` (prereg hash; edge table 1×/2× + train/holdout; orthogonality table; decomposition; regime-chase; **loud survivorship + regime caveats**; KEEP/REJECT + reason). Flags `--root`.

- [ ] **Step 2: Run** — source root `.env` (for the lane regeneration's FMP caches; reuse S1's `data/lab/fleet-bar-cache` + `fleet-earnings.json` if present, else run `fleet-fetch-bars`/`-earnings` first). `node scripts/cef-score.mjs --root .` → prereg written first; RESULTS produced.

- [ ] **Step 3: Sanity-read RESULTS** — prereg hash present; edge CI on net (1× + 2×); train + holdout both shown; orthogonality β/crisis/lane-ρ present; decomposition shows reversion vs nav-drift; survivorship + regime caveats loud; KEEP/REJECT has a named binding reason. If the sleeve is degenerate (no trades), debug the sim/universe, not the gate.

- [ ] **Step 4: Commit** — `git add scripts/cef-score.mjs docs/lab/cef-discount-reversion-RESULTS.md && git commit -m "feat(cef): orchestrator + dual-gate verdict + RESULTS"`

---

## Task 7: RUNBOOK + final suite + squash

- [ ] **Step 1: Write `docs/lab/cef-discount-reversion-RUNBOOK.md`** — re-run steps (cef-fetch → [fleet-fetch-bars/-earnings if lane caches absent] → cef-score), module map, prereg hash, the loud limits (price-change basis excludes yield = conservative; 5Y weekly no-COVID; survivorship bias upward; regime split; CEFConnect-only distributions unavailable), and deferred items (NAV-hedge overlay if edge-but-beta; total-return if the distribution endpoint is later found; cross-sectional/short variants).
- [ ] **Step 2: Full test suite** — `node --test scripts/cef-*.test.mjs` → all PASS.
- [ ] **Step 3: Final commit** — `git commit -am "docs(cef): RUNBOOK"`.
- [ ] **Step 4: Squash-merge to local main** per `finishing-a-development-branch` (one squashed commit; include the spec+plan copied in at setup). Confirm `data/lab/*` stayed git-ignored (only the two `docs/lab/*.md` tracked). Do NOT push unless asked.

---

## Self-review notes (spec coverage)

- §2 return basis → price-change + decomposition (Task 4 `decomposeReturn`/`simulateCef`); yield descriptive (RESULTS); distribution spike non-blocking (Task 1 Step 9).
- §4 signal → Task 2 (z, entry/exit) + Task 4 (admission most-negative-z, cap, exit). §5 universe+tiers → Task 1. §6 friction → Task 3 (pinned 25/50/100 + 2×); dual gate → Task 6 (edge 8-week bootstrap holdout; orthogonality reuse `fleet-correlate`; |ρ|<0.3).
- §10 hash → Task 5 (all keys: window/regime, signal/admission, return_basis, friction, edge_gate block=8, orthogonality lane_rho_max=0.3, checks, acceptable_findings incl survivorship). Regime-chase + train-half + episode-count → Task 5 `checks` + Task 6 Steps 4/7.
- §7 reuse → Task 6 (fleet-correlate / fleet-align / lane builders / coil-threshold-metrics bootstrap). §9 scope (no shorting/hedge/options/daily/cross-sectional) honored. Survivorship + regime + price-change-conservative caveats → Task 6 RESULTS + Task 7 RUNBOOK.
- Open items (§11): distribution spike (Task 1 Step 9, non-blocking); DiscountData sign (resolved: signed premium%, discount = negative → `/100` fraction, Task 1 Step 9); universe (Task 1 hardcoded curated list); rate-limit (Task 1 Step 9 throttle); half-spread floors (Task 3 pinned).
