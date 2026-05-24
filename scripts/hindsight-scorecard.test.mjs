// scripts/hindsight-scorecard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateLedger } from './hindsight-scorecard.mjs';

function disc(symbol, cost, { catalyst = 'found', routed = null } = {}) {
  return { symbol, bucket: 'discipline_gap', foregone_pl_usd: cost, catalyst, routed_outcome: routed };
}

test('aggregateLedger: counts buckets, sums discipline cost (bucket 2 only), and unverified subset', () => {
  const records = [
    { date: '2026-05-01', movers_ranked: [disc('NVDA', 400, { catalyst: 'none-found' }), { symbol: 'AVGO', bucket: 'coverage_gap' }] },
    { date: '2026-05-02', movers_ranked: [disc('NVDA', 200, { catalyst: 'found' }), { symbol: 'X', bucket: 'unforeseeable' }] },
  ];
  const agg = aggregateLedger(records);
  assert.equal(agg.sessions, 2);
  assert.equal(agg.buckets.discipline_gap, 2);
  assert.equal(agg.buckets.coverage_gap, 1);
  assert.equal(agg.buckets.unforeseeable, 1);
  assert.equal(agg.disciplineCostUsd, 600);
  assert.equal(agg.catalystUnverifiedUsd, 400); // only the none-found discipline gap
});

test('aggregateLedger: recurrence keyed by symbol:bucket; maxRecurrence is the highest', () => {
  const records = [
    { date: '2026-05-01', movers_ranked: [disc('NVDA', 100)] },
    { date: '2026-05-02', movers_ranked: [disc('NVDA', 100)] },
    { date: '2026-05-03', movers_ranked: [disc('NVDA', 100), { symbol: 'AVGO', bucket: 'coverage_gap' }] },
  ];
  const agg = aggregateLedger(records);
  assert.equal(agg.recurrence['NVDA:discipline_gap'], 3);
  assert.equal(agg.maxRecurrence, 3);
  assert.equal(agg.maxDisciplineRecurrence, 3);
});

test('aggregateLedger: maxDisciplineRecurrence ignores recurring NON-discipline buckets', () => {
  // AVGO recurs 4x as a coverage_gap (no cost); the only discipline gap appears once.
  const records = [
    { date: '2026-05-01', movers_ranked: [{ symbol: 'AVGO', bucket: 'coverage_gap' }, disc('NVDA', 100)] },
    { date: '2026-05-02', movers_ranked: [{ symbol: 'AVGO', bucket: 'coverage_gap' }] },
    { date: '2026-05-03', movers_ranked: [{ symbol: 'AVGO', bucket: 'coverage_gap' }] },
    { date: '2026-05-04', movers_ranked: [{ symbol: 'AVGO', bucket: 'coverage_gap' }] },
  ];
  const agg = aggregateLedger(records);
  assert.equal(agg.maxRecurrence, 4);            // AVGO:coverage_gap
  assert.equal(agg.maxDisciplineRecurrence, 1);  // discipline gaps are one-offs
});

test('aggregateLedger: unknown bucket value is ignored (no count, no recurrence)', () => {
  const records = [
    { date: '2026-05-01', movers_ranked: [{ symbol: 'GARBAGE', bucket: 'schema_drift' }] },
    { date: '2026-05-02', movers_ranked: [{ symbol: 'GARBAGE', bucket: 'schema_drift' }] },
    { date: '2026-05-03', movers_ranked: [{ symbol: 'GARBAGE', bucket: 'schema_drift' }] },
  ];
  const agg = aggregateLedger(records);
  assert.equal(agg.maxRecurrence, 0);
  assert.equal(agg.recurrence['GARBAGE:schema_drift'], undefined);
});

test('aggregateLedger: actionedSurvived counts only survived-holdout', () => {
  const records = [
    { date: '2026-05-01', movers_ranked: [disc('NVDA', 100, { routed: 'survived-holdout' })] },
    { date: '2026-05-02', movers_ranked: [disc('AMD', 100, { routed: 'rejected-holdout' })] },
    { date: '2026-05-03', movers_ranked: [disc('AMD', 100, { routed: 'pending' })] },
  ];
  assert.equal(aggregateLedger(records).actionedSurvived, 1);
});

import { computeVerdict } from './hindsight-scorecard.mjs';

const TH = { minSessions: 15, minDisciplineFindings: 8, costPctThreshold: 0.25, recurrenceThreshold: 3, unverifiedShareThreshold: 0.5 };
// A baseline aggregate that clears the data floor; override fields per test.
function agg(over = {}) {
  return {
    sessions: 20, buckets: { discipline_gap: 10 }, maxRecurrence: 1, maxDisciplineRecurrence: 1,
    disciplineCostUsd: 0, catalystUnverifiedUsd: 0, actionedSurvived: 0, ...over,
  };
}

test('computeVerdict: below session floor -> INSUFFICIENT_DATA', () => {
  const v = computeVerdict({ agg: agg({ sessions: 14 }), realizedPlPeriod: 10000, thresholds: TH, reviewEnabled: true });
  assert.equal(v.verdict, 'INSUFFICIENT_DATA');
});

test('computeVerdict: below discipline-findings floor -> INSUFFICIENT_DATA', () => {
  const v = computeVerdict({ agg: agg({ buckets: { discipline_gap: 7 } }), realizedPlPeriod: 10000, thresholds: TH, reviewEnabled: true });
  assert.equal(v.verdict, 'INSUFFICIENT_DATA');
});

test('computeVerdict: actionedSurvived>=1 -> KEEP_STRONG regardless of cost/recurrence', () => {
  const v = computeVerdict({ agg: agg({ actionedSurvived: 1 }), realizedPlPeriod: 10000, thresholds: TH, reviewEnabled: true });
  assert.equal(v.verdict, 'KEEP_STRONG');
});

test('computeVerdict: cost>25% AND recurrence>=3 AND unverified<0.5 -> KEEP_PROVISIONAL', () => {
  const v = computeVerdict({
    agg: agg({ disciplineCostUsd: 3000, catalystUnverifiedUsd: 500, maxDisciplineRecurrence: 3 }),
    realizedPlPeriod: 10000, thresholds: TH, reviewEnabled: true,
  });
  assert.equal(v.verdict, 'KEEP_PROVISIONAL');
});

test('computeVerdict: same but unverified>=0.5 -> REVIEW (not a block)', () => {
  const v = computeVerdict({
    agg: agg({ disciplineCostUsd: 3000, catalystUnverifiedUsd: 2000, maxDisciplineRecurrence: 3 }),
    realizedPlPeriod: 10000, thresholds: TH, reviewEnabled: true,
  });
  assert.equal(v.verdict, 'REVIEW');
});

test('computeVerdict: reviewEnabled=false collapses REVIEW back to KEEP_PROVISIONAL', () => {
  const v = computeVerdict({
    agg: agg({ disciplineCostUsd: 3000, catalystUnverifiedUsd: 2000, maxDisciplineRecurrence: 3 }),
    realizedPlPeriod: 10000, thresholds: TH, reviewEnabled: false,
  });
  assert.equal(v.verdict, 'KEEP_PROVISIONAL');
});

test('computeVerdict: recurrence>=3 but cost<=25% -> RETIRE (recurrence alone cannot keep)', () => {
  const v = computeVerdict({
    agg: agg({ disciplineCostUsd: 1000, maxDisciplineRecurrence: 5 }),
    realizedPlPeriod: 10000, thresholds: TH, reviewEnabled: true,
  });
  assert.equal(v.verdict, 'RETIRE');
});

test('computeVerdict: cost>25% but discipline-recurrence<3 -> RETIRE (cost alone cannot keep)', () => {
  const v = computeVerdict({
    agg: agg({ disciplineCostUsd: 9000, maxDisciplineRecurrence: 2 }),
    realizedPlPeriod: 10000, thresholds: TH, reviewEnabled: true,
  });
  assert.equal(v.verdict, 'RETIRE');
});

test('computeVerdict: cost>25% but recurrence is in a NON-discipline bucket -> RETIRE', () => {
  // A recurring coverage gap (maxRecurrence high) must NOT qualify the cost gate;
  // only discipline-gap recurrence counts (spec §7).
  const v = computeVerdict({
    agg: agg({ disciplineCostUsd: 9000, maxRecurrence: 9, maxDisciplineRecurrence: 1 }),
    realizedPlPeriod: 10000, thresholds: TH, reviewEnabled: true,
  });
  assert.equal(v.verdict, 'RETIRE');
});

test('computeVerdict: realizedPlPeriod<=0 disables provisional/REVIEW, leaves RETIRE here', () => {
  const v = computeVerdict({
    agg: agg({ disciplineCostUsd: 9000, catalystUnverifiedUsd: 0, maxDisciplineRecurrence: 5 }),
    realizedPlPeriod: 0, thresholds: TH, reviewEnabled: true,
  });
  assert.equal(v.verdict, 'RETIRE');
  assert.equal(v.conditions.costPathAvailable, false);
});

test('computeVerdict: realizedPlPeriod<=0 still allows KEEP_STRONG', () => {
  const v = computeVerdict({
    agg: agg({ actionedSurvived: 2 }), realizedPlPeriod: -500, thresholds: TH, reviewEnabled: true,
  });
  assert.equal(v.verdict, 'KEEP_STRONG');
});

import { realizedPlFromActivity, loadLedgerWindow } from './hindsight-scorecard.mjs';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

test('realizedPlFromActivity: sums total_pnl for dates within [from,to]', () => {
  const logs = [
    { date: '2026-05-01', summary: { total_pnl: 100 } },
    { date: '2026-05-10', summary: { total_pnl: -40 } },
    { date: '2026-04-01', summary: { total_pnl: 999 } }, // out of window
  ];
  assert.equal(realizedPlFromActivity(logs, '2026-05-01', '2026-05-31'), 60);
});

const __dirname_t = dirname(fileURLToPath(import.meta.url));
const TMP = join(__dirname_t, '__tmp_scorecard__');

test('loadLedgerWindow: reads hindsight_*.json within the window, sorted', () => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  writeFileSync(join(TMP, 'hindsight_2026-05-01.json'), JSON.stringify({ date: '2026-05-01', movers_ranked: [] }));
  writeFileSync(join(TMP, 'hindsight_2026-05-09.json'), JSON.stringify({ date: '2026-05-09', movers_ranked: [] }));
  writeFileSync(join(TMP, 'hindsight_2026-04-01.json'), JSON.stringify({ date: '2026-04-01', movers_ranked: [] }));
  writeFileSync(join(TMP, 'notes.txt'), 'ignore me');
  const recs = loadLedgerWindow(TMP, '2026-05-01', '2026-05-31');
  assert.deepEqual(recs.map((r) => r.date), ['2026-05-01', '2026-05-09']);
  rmSync(TMP, { recursive: true, force: true });
});

test('loadLedgerWindow: skips corrupt JSON and records lacking a date string', () => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  writeFileSync(join(TMP, 'hindsight_2026-05-02.json'), JSON.stringify({ date: '2026-05-02', movers_ranked: [] }));
  writeFileSync(join(TMP, 'hindsight_2026-05-03.json'), '{ this is not valid json');           // corrupt
  writeFileSync(join(TMP, 'hindsight_2026-05-04.json'), JSON.stringify({ movers_ranked: [] })); // no date field
  const recs = loadLedgerWindow(TMP, '2026-05-01', '2026-05-31');
  assert.deepEqual(recs.map((r) => r.date), ['2026-05-02']);
  rmSync(TMP, { recursive: true, force: true });
});

import { realizedPlForAgent } from './hindsight-scorecard.mjs';

test('realizedPlForAgent: missing agent-config soft-fails to 0', () => {
  const result = realizedPlForAgent({
    projectRoot: TMP,
    agentConfigPath: join(TMP, 'does-not-exist', 'agent-config.json'),
    agentId: 'default', from: '2026-05-01', to: '2026-05-31',
  });
  assert.equal(result, 0);
});
