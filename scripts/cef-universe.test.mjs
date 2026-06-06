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
