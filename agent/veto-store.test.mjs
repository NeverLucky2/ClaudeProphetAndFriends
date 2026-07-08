// agent/veto-store.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { VALID_REASONS, getReasons, readVetoes, createVeto } from './veto-store.js';

const _roots = [];
async function tmpRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'veto-'));
  _roots.push(root);
  return root;
}

after(async () => {
  await Promise.all(_roots.map(r => fs.rm(r, { recursive: true, force: true })));
});

test('getReasons returns the two fixed reasons (copy, not the original)', () => {
  assert.deepEqual(getReasons(), ['catalyst_driven', 'market_dislocation']);
  const copy = getReasons();
  copy.push('mutated');
  assert.deepEqual(VALID_REASONS, ['catalyst_driven', 'market_dislocation']);
});

test('readVetoes returns [] when the file is missing', async () => {
  const root = await tmpRoot();
  assert.deepEqual(await readVetoes(root), []);
});

test('createVeto stores a valid record and returns it', async () => {
  const root = await tmpRoot();
  const v = await createVeto(root, {
    date: '2026-07-07', ticker: 'amat', coilEntryRef: '552.30',
    reason: 'catalyst_driven', notes: 'Meta excess-capacity, semi capex crack',
  });
  assert.equal(v.ticker, 'AMAT');
  assert.equal(v.date, '2026-07-07');
  assert.equal(v.coilEntryRef, 552.3);          // coerced to number
  assert.equal(v.reason, 'catalyst_driven');
  assert.equal(v.reconciled, false);
  assert.ok(v.id.startsWith('veto_'));
  assert.ok(v.loggedAt);
  const all = await readVetoes(root);
  assert.equal(all.length, 1);
  assert.equal(all[0].id, v.id);
});

test('createVeto rejects bad ticker, bad date, bad ref, and unlisted reason', async () => {
  const root = await tmpRoot();
  const ok = { date: '2026-07-07', ticker: 'AMAT', coilEntryRef: 552.3, reason: 'catalyst_driven' };
  await assert.rejects(() => createVeto(root, { ...ok, ticker: '123' }), /ticker/);
  await assert.rejects(() => createVeto(root, { ...ok, date: '07-07-2026' }), /date/);
  await assert.rejects(() => createVeto(root, { ...ok, coilEntryRef: 0 }), /coilEntryRef/);
  await assert.rejects(() => createVeto(root, { ...ok, coilEntryRef: 'abc' }), /coilEntryRef/);
  await assert.rejects(() => createVeto(root, { ...ok, reason: 'gut_feeling' }), /reason/);
  assert.deepEqual(await readVetoes(root), []); // nothing persisted on rejection
});

test('concurrent createVeto calls do not clobber each other', async () => {
  const root = await tmpRoot();
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      createVeto(root, { date: '2026-07-07', ticker: 'AMAT', coilEntryRef: 500 + i, reason: 'market_dislocation' })),
  );
  assert.equal((await readVetoes(root)).length, 20);
});
