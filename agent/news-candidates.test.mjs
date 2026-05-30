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
    analyst_actions: [{ ticker: 'NVDA', firm: 'GS', action: 'raised', from: 200, to: 300, date: '2026-05-29T11:00:00Z' }],
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
  assert.equal(out.length, 0);
});
