// agent/tips-store.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readUniverse, createTip, readTips, getSources, dismissTip, promoteCandidate } from './tips-store.js';

const _roots = [];
async function tmpRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tips-'));
  _roots.push(root);
  await fs.mkdir(path.join(root, 'config'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'config', 'prophet_tradable_universe.txt'),
    '# header\nIBM\nNVDA  # inline comment\n\nAAPL\n',
  );
  return root;
}

after(async () => {
  await Promise.all(_roots.map(r => fs.rm(r, { recursive: true, force: true })));
});

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

test('getSources returns custom sources.json when present', async () => {
  const root = await tmpRoot();
  await fs.mkdir(path.join(root, 'data', 'tips'), { recursive: true });
  await fs.writeFile(path.join(root, 'data', 'tips', 'sources.json'), JSON.stringify(['self', 'dad', 'uncle']));
  const sources = await getSources(root);
  assert.deepEqual(sources, ['self', 'dad', 'uncle']);
});

test('getSources falls back to defaults when file missing or empty', async () => {
  const root = await tmpRoot();
  assert.deepEqual(await getSources(root), ['self', 'dad']);
  await fs.mkdir(path.join(root, 'data', 'tips'), { recursive: true });
  await fs.writeFile(path.join(root, 'data', 'tips', 'sources.json'), '[]');
  assert.deepEqual(await getSources(root), ['self', 'dad']);
});

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

test('promoteCandidate flips an OOU candidate to active, anchoring the window to now', async () => {
  const root = await tmpRoot();
  const cand = await createTip(root, { ticker: 'SMCI', thesis: 'AI servers', source: 'dad' });
  assert.equal(cand.phase, 'pending_candidate');
  assert.equal(cand.actionableAt, null);
  const before = Date.now();
  const r = await promoteCandidate(root, cand.id);
  assert.equal(r.ok, true);
  assert.equal(r.tip.phase, 'active');
  assert.ok(r.tip.actionableAt && Date.parse(r.tip.actionableAt) >= before - 1000);
  assert.ok(r.tip.promotedAt);
  const stored = (await readTips(root)).find(t => t.id === cand.id);
  assert.equal(stored.phase, 'active');
  assert.equal(stored.actionableAt, r.tip.actionableAt);
});

test('promoteCandidate refuses a non-candidate or unknown id', async () => {
  const root = await tmpRoot();
  const active = await createTip(root, { ticker: 'IBM', thesis: 'x', source: 'self' }); // in-universe -> active
  assert.equal((await promoteCandidate(root, active.id)).ok, false);
  assert.equal((await promoteCandidate(root, 'nope')).ok, false);
});
