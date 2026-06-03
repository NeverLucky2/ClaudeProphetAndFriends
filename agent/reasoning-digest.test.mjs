import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTurtleReasoning, parseCoilReasoning, buildAgentDigest, renderMarkdown,
  runReasoningDigestForSandbox, readReasoningDigestSummary,
} from './reasoning-digest.js';

test('parseTurtleReasoning reads last_run.reasoning, soft-empty on missing', () => {
  const status = { scheduler_enabled: true, last_run: { reasoning: [
    { ticker: 'TLT', line: 'Turtle TLT ENTER ...', setup_qualified: true, taken: true, blocked_by: '' },
    { ticker: 'GLD', line: 'Turtle GLD PASS ...', setup_qualified: false, taken: false },
  ] } };
  const got = parseTurtleReasoning(status);
  assert.equal(got.length, 2);
  assert.deepEqual(got[0], { ticker: 'TLT', line: 'Turtle TLT ENTER ...', qualified: true, taken: true, blockedBy: '' });
  assert.deepEqual(parseTurtleReasoning(null), []);
  assert.deepEqual(parseTurtleReasoning({ last_run: null }), []);
});

test('parseCoilReasoning maps candidates to entry lines', () => {
  const resp = { candidates: [
    { ticker: 'AAPL', explanation: 'Coil AAPL ENTER ...', rsi_2: 3.1 },
    { ticker: 'MSFT', explanation: 'Coil MSFT ENTER ...', rsi_2: 4.0 },
  ] };
  const got = parseCoilReasoning(resp);
  assert.equal(got.length, 2);
  assert.deepEqual(got[0], { ticker: 'AAPL', line: 'Coil AAPL ENTER ...', qualified: true, taken: true, blockedBy: '' });
  assert.deepEqual(parseCoilReasoning(null), []);
});

test('buildAgentDigest groups turtle into entered/declined/passed', () => {
  const items = [
    { ticker: 'TLT', line: 'L1', qualified: true, taken: true, blockedBy: '' },
    { ticker: 'IWM', line: 'L2', qualified: true, taken: false, blockedBy: 'cluster cap' },
    { ticker: 'GLD', line: 'L3', qualified: false, taken: false, blockedBy: '' },
  ];
  const d = buildAgentDigest('Turtle', 'turtle', items);
  assert.equal(d.entered.length, 1);
  assert.equal(d.declined.length, 1);
  assert.equal(d.passed.length, 1);
  assert.equal(d.entered[0].ticker, 'TLT');
  assert.equal(d.declined[0].ticker, 'IWM');
});

test('buildAgentDigest puts all coil candidates under entered', () => {
  const items = [{ ticker: 'AAPL', line: 'L', qualified: true, taken: true, blockedBy: '' }];
  const d = buildAgentDigest('Coil', 'coil', items);
  assert.equal(d.entered.length, 1);
  assert.equal(d.declined.length, 0);
  assert.equal(d.passed.length, 0);
});

test('renderMarkdown shows the date and each agent section, silent sections omitted', () => {
  const digest = {
    date: '2026-06-03',
    agents: [
      buildAgentDigest('Turtle', 'turtle', [
        { ticker: 'TLT', line: 'Turtle TLT ENTER x', qualified: true, taken: true, blockedBy: '' },
      ]),
    ],
  };
  const md = renderMarkdown(digest);
  assert.match(md, /# Reasoning Digest — 2026-06-03/);
  assert.match(md, /## Turtle/);
  assert.match(md, /Turtle TLT ENTER x/);
});

function fakeFs() {
  const files = new Map();
  const norm = (p) => p.replaceAll('\\', '/');
  return {
    files,
    mkdir: async () => {},
    writeFile: async (p, data) => { files.set(norm(p), data); },
    readFile: async (p) => {
      const np = norm(p);
      if (!files.has(np)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return files.get(np);
    },
    readdir: async (p) => {
      const np = norm(p);
      const prefix = np + '/';
      const sandboxIds = new Set();
      for (const key of files.keys()) {
        if (key.startsWith(prefix)) {
          const rel = key.slice(prefix.length);
          const parts = rel.split('/');
          if (parts.length >= 1) sandboxIds.add(parts[0]);
        }
      }
      if (sandboxIds.size === 0) {
        const e = new Error('ENOENT');
        e.code = 'ENOENT';
        throw e;
      }
      return Array.from(sandboxIds);
    },
  };
}

test('runReasoningDigestForSandbox writes a turtle digest from /turtle/status', async () => {
  const goAxios = { get: async (u) => {
    assert.equal(u, '/api/v1/turtle/status');
    return { data: { scheduler_enabled: true, last_run: { reasoning: [
      { ticker: 'TLT', line: 'Turtle TLT ENTER x', setup_qualified: true, taken: true },
    ] } } };
  } };
  const fs = fakeFs();
  const report = await runReasoningDigestForSandbox({
    goAxios, sandboxId: 'sbx_trend', strategy: 'trend', agentName: 'Turtle',
    isoDate: '2026-06-03', projectRoot: '/proj', fsImpl: fs,
  });
  assert.equal(report.agents[0].entered[0].ticker, 'TLT');
  const md = [...fs.files.keys()].find((k) => k.endsWith('2026-06-03.md'));
  assert.ok(md, 'wrote a markdown file');
});

test('runReasoningDigestForSandbox soft-fails to null on axios error', async () => {
  const goAxios = { get: async () => { throw new Error('bot down'); } };
  const report = await runReasoningDigestForSandbox({
    goAxios, sandboxId: 'sbx_trend', strategy: 'trend', agentName: 'Turtle',
    isoDate: '2026-06-03', projectRoot: '/proj', fsImpl: fakeFs(),
  });
  assert.equal(report, null);
});

test('runReasoningDigestForSandbox skips unknown strategies', async () => {
  const report = await runReasoningDigestForSandbox({
    goAxios: { get: async () => { throw new Error('should not be called'); } },
    sandboxId: 'sbx_x', strategy: 'v2-options', agentName: 'Prophet',
    isoDate: '2026-06-03', projectRoot: '/proj', fsImpl: fakeFs(),
  });
  assert.equal(report, null);
});

test('readReasoningDigestSummary aggregates per-sandbox reports, silent on missing', async () => {
  const fs = fakeFs();
  fs.files.set('/proj/data/reasoning-digest/sbx_trend/2026-06-03.json',
    JSON.stringify({ date: '2026-06-03', sandboxId: 'sbx_trend', agents: [] }));
  const summary = await readReasoningDigestSummary('/proj', { date: '2026-06-03' }, { fs });
  assert.equal(summary.date, '2026-06-03');
  assert.equal(summary.items.length, 1);
  const empty = await readReasoningDigestSummary('/proj', { date: '2026-01-01' }, { fs });
  assert.equal(empty.items.length, 0);
});
