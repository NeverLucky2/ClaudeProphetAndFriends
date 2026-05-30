// agent/universe-store.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { addToUniverse } from './universe-store.js';
import { readUniverse } from './tips-store.js';

async function tmpRoot(initial = '# header\nSPY\nQQQ\n') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'uni-'));
  await fs.mkdir(path.join(root, 'config'), { recursive: true });
  await fs.writeFile(path.join(root, 'config', 'prophet_tradable_universe.txt'), initial);
  return root;
}

test('addToUniverse appends a new ticker and is visible to readUniverse', async () => {
  const root = await tmpRoot();
  const r = await addToUniverse(root, 'smci', { today: '2026-05-30' });
  assert.equal(r.added, true);
  assert.equal(r.alreadyPresent, false);
  assert.equal(r.ticker, 'SMCI');
  const uni = await readUniverse(root);
  assert.equal(uni.has('SMCI'), true);
  const raw = await fs.readFile(path.join(root, 'config', 'prophet_tradable_universe.txt'), 'utf-8');
  assert.match(raw, /SMCI {2}# added via tips ledger 2026-05-30/);
});

test('addToUniverse is idempotent for an existing ticker (case-insensitive)', async () => {
  const root = await tmpRoot();
  const r = await addToUniverse(root, 'spy');
  assert.equal(r.added, false);
  assert.equal(r.alreadyPresent, true);
});

test('addToUniverse appends a newline first when the file lacks a trailing one', async () => {
  const root = await tmpRoot('# header\nSPY'); // no trailing newline
  await addToUniverse(root, 'NVDA', { today: '2026-05-30' });
  const uni = await readUniverse(root);
  assert.equal(uni.has('SPY'), true); // not merged into the prior line
  assert.equal(uni.has('NVDA'), true);
});

test('addToUniverse rejects an invalid ticker', async () => {
  const root = await tmpRoot();
  await assert.rejects(() => addToUniverse(root, '123!'), /invalid ticker/);
});
