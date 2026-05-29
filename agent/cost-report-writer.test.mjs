import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computePerAgentSummary,
  computeNotableShifts,
  renderDailyReportMarkdown,
} from './cost-report-writer.js';

const fixtureAgg = {
  default: {
    agentName: 'Prophet', model: 'sonnet',
    dates: {
      '2026-05-22': { cost: 4.50, tokens: 500000, beatCount: 100,
        phases: { midday: { cost: 2.0, tokens: 250000, beatCount: 50 },
                  pre_market: { cost: 0.7, tokens: 60000, beatCount: 12 } } },
      '2026-05-23': { cost: 4.20, tokens: 480000, beatCount: 95,
        phases: { midday: { cost: 1.9, tokens: 240000, beatCount: 48 } } },
      '2026-05-28': { cost: 3.18, tokens: 412000, beatCount: 95,
        phases: { midday: { cost: 1.34, tokens: 180000, beatCount: 42 },
                  pre_market: { cost: 0.42, tokens: 38000, beatCount: 12 } } },
    },
  },
};

test('computePerAgentSummary derives today, 7d avg, delta %', () => {
  const summary = computePerAgentSummary(fixtureAgg, '2026-05-28');
  const prophet = summary.find(s => s.agentId === 'default');
  assert.equal(prophet.today.cost, 3.18);
  assert.equal(prophet.today.beatCount, 95);
  // 7-day basis includes 2026-05-22..2026-05-27. Only 22, 23 have data;
  // missing days count as 0 toward the average over 7 days.
  // Sum = 4.50 + 4.20 = 8.70; avg = 8.70 / 7 ≈ 1.2429
  assert.ok(Math.abs(prophet.sevenDayAvg.cost - (8.70 / 7)) < 0.001);
  // delta = (3.18 - 1.2429) / 1.2429 * 100 ≈ 156%
  assert.ok(prophet.delta.costPct > 100);
});

test('computePerAgentSummary delta is null when basis is zero', () => {
  const noHistory = {
    default: { agentName: 'Prophet', model: 'm', dates: {
      '2026-05-28': { cost: 1.0, tokens: 0, beatCount: 1, phases: {} },
    }},
  };
  const summary = computePerAgentSummary(noHistory, '2026-05-28');
  assert.equal(summary[0].delta.costPct, null);
});

test('computeNotableShifts flags phases with |delta| >= threshold', () => {
  const shifts = computeNotableShifts(fixtureAgg, '2026-05-28', { thresholdPct: 15 });
  // Prophet midday today $1.34 vs 7-day-avg (sum 2.0 + 1.9 = 3.9 over 7 days)
  // = $0.557. delta = (1.34 - 0.557) / 0.557 = +140%. Should flag.
  assert.ok(shifts.some(s => s.agentId === 'default' && s.phase === 'midday'));
});

test('renderDailyReportMarkdown produces sections with table + notable shifts', () => {
  const md = renderDailyReportMarkdown(fixtureAgg, '2026-05-28', { thresholdPct: 15 });
  assert.match(md, /# Daily Cost Report — 2026-05-28/);
  assert.match(md, /## Per-agent totals/);
  assert.match(md, /\| Prophet \|/);
  assert.match(md, /\| \*\*TOTAL\*\* \|/);
  assert.match(md, /## Notable shifts/);
  assert.match(md, /## Per-phase × per-agent breakdown/);
});

test('renderDailyReportMarkdown emits explanatory placeholder when no shifts found', () => {
  const flat = {
    default: { agentName: 'Prophet', model: 'm', dates: {
      '2026-05-28': { cost: 1.0, tokens: 0, beatCount: 1,
        phases: { midday: { cost: 1.0, tokens: 0, beatCount: 1 } } },
    }},
  };
  const md = renderDailyReportMarkdown(flat, '2026-05-28', { thresholdPct: 15 });
  assert.match(md, /No shifts above the .* threshold/);
});
