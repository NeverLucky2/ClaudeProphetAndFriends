// scripts/overlay-universe.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHoldings, OVERLAY_CACHE_SUBDIR, CANDIDATES } from './overlay-universe.mjs';

const SAMPLE = [
  '"COB Date","Security #","Symbol","CUSIP #","Security Description","Account Nickname","Account Registration","Account #","Quantity","Price ($)","Value ($)","Unrealized Gain/Loss ($)","Unrealized Gain/Loss (%)","Cumulative Investment Return ($)","Cumulative Investment Return (%)","Accrued Interest ($)"',
  '"5/18/2026","00415","AMD","007903107","ADVNCD MICRO D INC","--","CMA-Edge","27Z-89R00","10","420.99","4,209.90","3,003.25","248.89","--","--","--"',
  '"5/18/2026","9T2U4","VFIAX","922908710","VANGUARD 500 INDEX FUND","--","CMA-Edge","27Z-89R00","3.124","684.05","2,136.98","620.02","40.87","668.23","45.50","--"',
  '"5/18/2026","94SX0","--","990156937","ML DIRECT DEPOSIT PROGRM","--","CMA-Edge","27Z-89R00","774","1.00","774.00","--","--","--","--","--"',
].join('\n');

test('parseHoldings extracts symbol+value, maps VFIAX→VOO, drops cash row', () => {
  const h = parseHoldings(SAMPLE);
  assert.equal(h.length, 2);
  const amd = h.find((x) => x.symbol === 'AMD');
  assert.equal(amd.value, 4209.90);
  assert.ok(h.find((x) => x.symbol === 'VOO')); // VFIAX remapped
  assert.ok(!h.find((x) => x.symbol === '--'));
});

test('CANDIDATES + cache subdir are defined', () => {
  assert.match(OVERLAY_CACHE_SUBDIR, /overlay-cache/);
  assert.deepEqual(CANDIDATES.map((c) => c.id).sort(), ['def_prophet', 'gld', 'tlt', 'vixm']);
});
