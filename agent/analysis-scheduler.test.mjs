// Tests for the regime_gate_compute scheduler hook. Only exercises the pure
// argv builder — the spawn side is integration territory and would couple
// the test to platform-specific Python launching.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

import {
  buildRegimeComputeArgv,
  buildMacroRegimeArgv,
  buildFetchBreadthArgv,
  breadthResultToRegimeInput,
  resolveOpencodeModel,
  isTradingDay,
  buildBreadthSkillAppendix,
  buildMarketTopSkillAppendix,
  buildBubbleSkillAppendix,
  shouldTriggerWeeklyScreenerOnStartup,
  weeklyReportIsForDate,
  isLockStale,
  STALE_LOCK_MS,
  prophetAutoAnalysesEnabled,
  AnalysisScheduler,
} from './analysis-scheduler.js';

// Path separators differ across platforms (\ on Windows, / on POSIX).
// Use path.join in expectations so this suite passes on both.
const p = (...parts) => path.join(...parts);

test('buildRegimeComputeArgv: picks latest of each prefix lexicographically', () => {
  // Skills emit timestamped filenames (e.g., macro_regime_2026-05-14_083000.json).
  // Lexicographic order matches chronological order for these formats, so the
  // last-sorted file is the latest. No mtime stats needed (cheaper, deterministic).
  const files = [
    'macro_regime_2026-05-13_083000.json',
    'macro_regime_2026-05-14_083000.json',
    'market_top_20260513.json',
    'market_top_20260514.json',
    'breadth_20260514.json',
    'bubble_20260514.json',
    'daily_brief_20260514.json',   // unrelated file — must be ignored
    'random_other.json',           // unrelated file — must be ignored
  ];
  const argv = buildRegimeComputeArgv(
    'data/reports',
    'scripts/compute_daily_regime_score.py',
    'data/reports/regime_gate.json',
    files,
  );

  // Script path is the first non-flag argument; node:child_process.spawn
  // receives this plus the flags.
  assert.equal(argv[0], 'scripts/compute_daily_regime_score.py');

  // Output flag is always present.
  const outIdx = argv.indexOf('--output');
  assert.notEqual(outIdx, -1, 'argv must include --output');
  assert.equal(argv[outIdx + 1], 'data/reports/regime_gate.json');

  // Each input flag must point to the LATEST file of that prefix.
  function valueOf(flag) {
    const i = argv.indexOf(flag);
    return i === -1 ? null : argv[i + 1];
  }
  assert.equal(valueOf('--breadth'), p('data/reports', 'breadth_20260514.json'));
  assert.equal(valueOf('--macro'), p('data/reports', 'macro_regime_2026-05-14_083000.json'));
  assert.equal(valueOf('--top'), p('data/reports', 'market_top_20260514.json'));
  assert.equal(valueOf('--bubble'), p('data/reports', 'bubble_20260514.json'));
});

test('buildRegimeComputeArgv: omits flags for prefixes with no matching files', () => {
  // The Python script fails soft on absent inputs (neutral 50). The scheduler
  // mirrors that by simply not passing the flag, rather than passing a fake
  // path that would emit a "file not found" warning to stderr.
  const files = [
    'macro_regime_2026-05-14_083000.json',
    'daily_brief_20260514.json',
  ];
  const argv = buildRegimeComputeArgv(
    'data/reports',
    'scripts/compute_daily_regime_score.py',
    '/tmp/regime_gate.json',
    files,
  );

  assert.equal(argv.includes('--breadth'), false, '--breadth flag must be absent when no breadth file');
  assert.equal(argv.includes('--top'), false);
  assert.equal(argv.includes('--bubble'), false);
  assert.equal(argv.includes('--macro'), true, '--macro must be present when a macro file exists');
});

test('buildRegimeComputeArgv: works with empty file list', () => {
  // On a fresh install with no reports yet, the script still runs (writes
  // neutral 50 across all components). Verify argv is well-formed in that
  // degenerate case.
  const argv = buildRegimeComputeArgv(
    'data/reports',
    'scripts/compute_daily_regime_score.py',
    '/tmp/regime_gate.json',
    [],
  );
  assert.equal(argv[0], 'scripts/compute_daily_regime_score.py');
  assert.deepEqual(
    argv.filter((v) => v.startsWith('--')),
    ['--output'],
  );
});

test('buildMacroRegimeArgv includes script, output-dir, and api-key when key provided', () => {
  const argv = buildMacroRegimeArgv(
    '/abs/path/to/macro_regime_detector.py',
    'data/reports',
    'fmp_test_key',
  );
  assert.equal(argv[0], '/abs/path/to/macro_regime_detector.py');
  // --output-dir and --api-key both present, with their values.
  assert.deepEqual(
    argv.filter((v) => v.startsWith('--')).sort(),
    ['--api-key', '--output-dir'],
  );
  assert.equal(argv[argv.indexOf('--output-dir') + 1], 'data/reports');
  assert.equal(argv[argv.indexOf('--api-key') + 1], 'fmp_test_key');
});

test('buildMacroRegimeArgv omits --api-key when key is null/undefined', () => {
  // We still call the script — it falls back to the FMP_API_KEY env var inside
  // the python process. The scheduler-level guard logs a warning before reaching
  // the builder if the env var is also missing.
  const argv = buildMacroRegimeArgv('/script.py', 'data/reports', null);
  assert.ok(!argv.includes('--api-key'), `argv should not contain --api-key, got ${argv}`);
  assert.ok(argv.includes('--output-dir'), 'argv must still contain --output-dir');
});

// ── Commit 1: breadth → python spawn, market_top/bubble → Haiku ─────

test('resolveOpencodeModel prefixes bare ids and passes through qualified ids', () => {
  assert.equal(resolveOpencodeModel('anthropic/claude-haiku-4-5'), 'anthropic/claude-haiku-4-5');
  assert.equal(resolveOpencodeModel('claude-haiku-4-5'), 'anthropic/claude-haiku-4-5');
  assert.equal(resolveOpencodeModel(null), null);
  assert.equal(resolveOpencodeModel(''), null);
});

test('buildFetchBreadthArgv passes the script path and --json', () => {
  assert.deepEqual(
    buildFetchBreadthArgv('/abs/fetch_breadth_csv.py'),
    ['/abs/fetch_breadth_csv.py', '--json'],
  );
});

test('breadthResultToRegimeInput derives integer current_value_percent from uptrend_ratio', () => {
  // compute_daily_regime_score.py extracts the top-level integer
  // current_value_percent (its EXTRACTION_PATHS["breadth"]).
  const parsed = { uptrend_ratio: 63.4, breadth_200ma: 55.12, uptrend_class: 'neutral_bullish' };
  const out = breadthResultToRegimeInput(parsed);
  assert.equal(out.current_value_percent, 63);
  assert.equal(Number.isInteger(out.current_value_percent), true);
  // Forensic fields preserved alongside the derived value.
  assert.equal(out.breadth_200ma, 55.12);
  assert.equal(out.uptrend_class, 'neutral_bullish');
});

test('breadthResultToRegimeInput rounds to the nearest integer', () => {
  assert.equal(breadthResultToRegimeInput({ uptrend_ratio: 36.5 }).current_value_percent, 37);
  assert.equal(breadthResultToRegimeInput({ uptrend_ratio: 36.49 }).current_value_percent, 36);
});

test('breadthResultToRegimeInput throws on missing/non-numeric uptrend_ratio', () => {
  // Throwing leaves _lastBreadthDate unadvanced so the catch-up retries — the
  // pure-python equivalent of the old LLM path's throwOnFailure=true.
  assert.throws(() => breadthResultToRegimeInput({}), /uptrend_ratio/);
  assert.throws(() => breadthResultToRegimeInput({ uptrend_ratio: 'NaN' }), /uptrend_ratio/);
  assert.throws(() => breadthResultToRegimeInput(null), /uptrend_ratio/);
});

// ── Commit 2: holiday-gate the regime-input chain ──────────────────

test('isTradingDay is true only on a non-holiday weekday', () => {
  assert.equal(isTradingDay({ isWeekday: true, isHoliday: false }), true);
  assert.equal(isTradingDay({ isWeekday: true, isHoliday: true }), false);   // market holiday
  assert.equal(isTradingDay({ isWeekday: false, isHoliday: false }), false); // weekend
  assert.equal(isTradingDay({ isWeekday: false, isHoliday: true }), false);
});

test('buildBreadthSkillAppendix directs LLM to write breadth_<date>.json with current_value_percent', () => {
  const appendix = buildBreadthSkillAppendix('2026-05-15');
  // The dateslug form (no dashes) matches the daily_briefing convention used
  // elsewhere in the file (data/reports/daily_brief_YYYYMMDD.json).
  assert.match(appendix, /data\/reports\/breadth_20260515\.json/, 'appendix must name the target filename');
  assert.match(appendix, /current_value_percent/, 'appendix must require the current_value_percent key');
  assert.match(appendix, /AUTOMATED RUN/, 'appendix must mark itself as an automated run override');
});

test('buildMarketTopSkillAppendix directs LLM to write market_top_<date>.json with composite.composite_score', () => {
  const appendix = buildMarketTopSkillAppendix('2026-05-15');
  assert.match(appendix, /data\/reports\/market_top_20260515\.json/);
  // The key path the regime-gate writer extracts: nested under "composite".
  assert.match(appendix, /composite_score/);
  assert.match(appendix, /composite/);
  assert.match(appendix, /AUTOMATED RUN/);
});

test('buildBubbleSkillAppendix directs LLM to write bubble_<date>.json with percentage', () => {
  const appendix = buildBubbleSkillAppendix('2026-05-15');
  assert.match(appendix, /data\/reports\/bubble_20260515\.json/);
  assert.match(appendix, /percentage/);
  // The bubble scorer is run with --scores '<json>' --output json — the appendix
  // must reference the script so the LLM doesn't skip the scoring step.
  assert.match(appendix, /bubble_scorer\.py/);
  assert.match(appendix, /AUTOMATED RUN/);
});

test('getStatus exposes the four new regime-skill last-run dates', () => {
  const scheduler = new AnalysisScheduler();
  const status = scheduler.getStatus();
  // All four start null on a fresh instance — no state file loaded.
  assert.equal(status.lastBreadthDate, null);
  assert.equal(status.lastMacroRegimeDate, null);
  assert.equal(status.lastMarketTopDate, null);
  assert.equal(status.lastBubbleDate, null);
});

test('_getLockKey produces stable dateslug-suffixed keys for each new job', () => {
  const scheduler = new AnalysisScheduler();
  assert.equal(scheduler._getLockKey('macro_regime_skill', '2026-05-15'), 'macro_regime_skill_20260515');
  assert.equal(scheduler._getLockKey('breadth_skill', '2026-05-15'),      'breadth_skill_20260515');
  assert.equal(scheduler._getLockKey('market_top_skill', '2026-05-15'),   'market_top_skill_20260515');
  assert.equal(scheduler._getLockKey('bubble_skill', '2026-05-15'),       'bubble_skill_20260515');
});

test('shouldTriggerWeeklyScreenerOnStartup: true on Sunday when not yet run today', () => {
  assert.equal(
    shouldTriggerWeeklyScreenerOnStartup({
      dayOfWeek: 0,
      isoDate: '2026-05-17',
      lastWeeklyScreenDate: '2026-05-10',
      weeklyReportPresent: false,
    }),
    true,
  );
});

test('shouldTriggerWeeklyScreenerOnStartup: true on Sunday when state is null (fresh install)', () => {
  // Cold start with no persisted state must still trigger.
  assert.equal(
    shouldTriggerWeeklyScreenerOnStartup({
      dayOfWeek: 0,
      isoDate: '2026-05-17',
      lastWeeklyScreenDate: null,
      weeklyReportPresent: false,
    }),
    true,
  );
});

test('shouldTriggerWeeklyScreenerOnStartup: false on Sunday when already run today', () => {
  // Idempotency guard — running twice on the same Sunday would double-fire.
  assert.equal(
    shouldTriggerWeeklyScreenerOnStartup({
      dayOfWeek: 0,
      isoDate: '2026-05-17',
      lastWeeklyScreenDate: '2026-05-17',
    }),
    false,
  );
});

test("shouldTriggerWeeklyScreenerOnStartup: false on Sunday when today's report file already exists (restart idempotency)", () => {
  // The real bug: _lastWeeklyScreenDate is in-memory only and resets to null
  // on restart, so the date check alone re-fires the whole pipeline on every
  // Sunday restart. The durable guard is the presence of today's
  // weekly_regime report file — when it's already on disk, do NOT re-run even
  // though in-memory state looks like a cold start.
  assert.equal(
    shouldTriggerWeeklyScreenerOnStartup({
      dayOfWeek: 0,
      isoDate: '2026-05-17',
      lastWeeklyScreenDate: null,
      weeklyReportPresent: true,
    }),
    false,
  );
});

test('shouldTriggerWeeklyScreenerOnStartup: false on non-Sunday regardless of state', () => {
  // Verify the day gate dominates: even with stale state, weekdays/Saturday skip.
  for (const dayOfWeek of [1, 2, 3, 4, 5, 6]) {
    assert.equal(
      shouldTriggerWeeklyScreenerOnStartup({
        dayOfWeek,
        isoDate: '2026-05-16',
        lastWeeklyScreenDate: '2026-05-10',
      }),
      false,
      `dayOfWeek=${dayOfWeek} must not trigger`,
    );
  }
});

// weeklyReportIsForDate is the pure core of the Sunday-restart idempotency
// guard: given the (possibly null) contents of today's weekly_regime file, is
// it a valid report stamped for today? Every "treat as absent → re-run" path
// (missing file, unreadable, malformed JSON, wrong/absent date) must collapse
// to false here so the fs.readFile wrapper in runStartupChecks stays trivial.
test('weeklyReportIsForDate: true when the JSON date matches today', () => {
  assert.equal(weeklyReportIsForDate('{"date":"2026-05-24","breadth_score":32}', '2026-05-24'), true);
});

test('weeklyReportIsForDate: false when the JSON is stamped for a different day', () => {
  // A lingering prior-week file must not suppress this week's run.
  assert.equal(weeklyReportIsForDate('{"date":"2026-05-17"}', '2026-05-24'), false);
});

test('weeklyReportIsForDate: false on null (file missing / read failed)', () => {
  assert.equal(weeklyReportIsForDate(null, '2026-05-24'), false);
});

test('weeklyReportIsForDate: false on malformed JSON', () => {
  assert.equal(weeklyReportIsForDate('{not valid json', '2026-05-24'), false);
});

test('weeklyReportIsForDate: false when the date field is absent', () => {
  assert.equal(weeklyReportIsForDate('{"breadth_score":32}', '2026-05-24'), false);
});

// Stub the side-effects so triggerJob can run in-process without touching the
// filesystem or spawning python/opencode. Returns the stubbed scheduler so
// tests can inspect _lastXxxDate fields directly.
function _stubScheduler({ runnerThrows = false } = {}) {
  const scheduler = new AnalysisScheduler();
  scheduler._acquireLock = async () => true;
  scheduler._releaseLock = async () => {};
  scheduler._saveState = async () => {};
  // Silence logs/events in the test harness.
  scheduler._log = () => {};
  scheduler.emit = () => true;
  const failure = new Error('simulated runner failure');
  const stub = async () => { if (runnerThrows) throw failure; };
  scheduler._runRegimeGateCompute = stub;
  scheduler._runMacroRegimeSkill   = stub;
  scheduler._runBreadthSkill       = stub;
  scheduler._runMarketTopSkill     = stub;
  scheduler._runBubbleSkill        = stub;
  return scheduler;
}

// 2026-05-18 regression: triggerJob used to set _lastXxxDate BEFORE awaiting the
// runner. A silent runner failure (e.g., Python crashing on a UTF-8 input file
// while node treated the non-zero exit as "completed") left state claiming the
// job ran for today, which permanently masked the failure: the catch-up at
// _checkSchedule short-circuits on `_lastRegimeGateDate === isoDate`. These
// tests pin the new ordering — state advances ONLY after the runner returns
// successfully — so a future refactor doesn't quietly revert the fix.
test('triggerJob(regime_gate_compute): does NOT advance _lastRegimeGateDate when runner throws', async () => {
  const scheduler = _stubScheduler({ runnerThrows: true });
  scheduler._lastRegimeGateDate = '2026-05-15';   // pretend last successful run was Friday
  await assert.rejects(
    () => scheduler.triggerJob('regime_gate_compute', '2026-05-18'),
    /simulated runner failure/,
  );
  // The whole point: failure must leave state at the pre-run value so the
  // catch-up loop retries on the next heartbeat instead of marking today done.
  assert.equal(scheduler._lastRegimeGateDate, '2026-05-15');
});

test('triggerJob(regime_gate_compute): DOES advance _lastRegimeGateDate when runner succeeds', async () => {
  const scheduler = _stubScheduler({ runnerThrows: false });
  scheduler._lastRegimeGateDate = '2026-05-15';
  const result = await scheduler.triggerJob('regime_gate_compute', '2026-05-18');
  assert.equal(result.success, true);
  assert.equal(scheduler._lastRegimeGateDate, '2026-05-18');
});

test('triggerJob: failure leaves state unadvanced for all 4 upstream regime skills', async () => {
  // Same fail-then-retry contract applies to macro_regime/breadth/market_top/bubble.
  // If any one of them silently swallows a failure, regime_gate_compute downstream
  // re-uses a stale upstream input and the >36h freshness guard is what saves us
  // — too late to be the primary defense.
  const cases = [
    { job: 'macro_regime_skill', field: '_lastMacroRegimeDate' },
    { job: 'breadth_skill',      field: '_lastBreadthDate' },
    { job: 'market_top_skill',   field: '_lastMarketTopDate' },
    { job: 'bubble_skill',       field: '_lastBubbleDate' },
  ];
  for (const { job, field } of cases) {
    const scheduler = _stubScheduler({ runnerThrows: true });
    // macro_regime_skill has the FMP_API_KEY guard that early-returns before
    // the runner — set the env var so we exercise the throwing path.
    const prevKey = process.env.FMP_API_KEY;
    process.env.FMP_API_KEY = 'test_key';
    try {
      scheduler[field] = '2026-05-15';
      await assert.rejects(
        () => scheduler.triggerJob(job, '2026-05-18'),
        /simulated runner failure/,
        `${job} must propagate runner errors`,
      );
      assert.equal(scheduler[field], '2026-05-15', `${job}: ${field} must stay at pre-run value`);
    } finally {
      if (prevKey === undefined) delete process.env.FMP_API_KEY; else process.env.FMP_API_KEY = prevKey;
    }
  }
});

// Lock staleness: a `.running` lock is released only in triggerJob's finally.
// A killed process (e.g., a bot restart mid-job) leaks the file permanently,
// and because lock keys are date-stamped, a stale lock from today blocks that
// job's self-heal for the rest of the day. isLockStale lets _acquireLock /
// _isLocked reclaim a lock left by a dead process.
test('STALE_LOCK_MS comfortably exceeds the longest job timeout (15 min)', () => {
  // The longest scheduler job timeout is 15 min (e.g. parameter reviews). The
  // staleness window must clear that with margin so a legitimately long-running
  // job is never reclaimed out from under itself.
  assert.ok(STALE_LOCK_MS > 15 * 60 * 1000, `STALE_LOCK_MS (${STALE_LOCK_MS}) must exceed 15 min`);
});

test('isLockStale: a just-created lock is fresh', () => {
  const now = 1_000_000_000_000;
  assert.equal(isLockStale(now, now), false);
});

test('isLockStale: a lock just under the window is fresh', () => {
  const now = 1_000_000_000_000;
  const mtime = now - (STALE_LOCK_MS - 1000);
  assert.equal(isLockStale(mtime, now), false);
});

test('isLockStale: a lock older than the window is stale', () => {
  const now = 1_000_000_000_000;
  const mtime = now - (STALE_LOCK_MS + 1000);
  assert.equal(isLockStale(mtime, now), true);
});

test('isLockStale: a future mtime (clock skew) is treated as fresh, not stale', () => {
  // Defensive: never reclaim a lock whose mtime is ahead of now.
  const now = 1_000_000_000_000;
  assert.equal(isLockStale(now + 60_000, now), false);
});

// Integration: exercise the real fs-touching lock methods, not just the
// predicate. REPORTS_DIR is module-private; reconstruct it the same way the
// module does (this test file is also in agent/).
const REPORTS_DIR_FOR_TEST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'reports');

test('_acquireLock + _isLocked reclaim a stale lock left by a killed process', async () => {
  const scheduler = new AnalysisScheduler();
  scheduler._log = () => {};
  const key = '__test_stale_lock__';
  const lockPath = path.join(REPORTS_DIR_FOR_TEST, `${key}.running`);
  await fs.mkdir(REPORTS_DIR_FOR_TEST, { recursive: true });
  try {
    await fs.writeFile(lockPath, '', 'utf-8');
    // Back-date the lock past the staleness window (simulate a dead process).
    const old = new Date(Date.now() - (STALE_LOCK_MS + 60_000));
    await fs.utimes(lockPath, old, old);

    assert.equal(await scheduler._isLocked(key), false, 'a stale lock must not read as locked');
    assert.equal(await scheduler._acquireLock(key), true, 'acquire must reclaim a stale lock');
  } finally {
    await fs.unlink(lockPath).catch(() => {});
  }
});

test('_acquireLock + _isLocked respect a fresh lock held by a live job', async () => {
  const scheduler = new AnalysisScheduler();
  scheduler._log = () => {};
  const key = '__test_fresh_lock__';
  const lockPath = path.join(REPORTS_DIR_FOR_TEST, `${key}.running`);
  await fs.mkdir(REPORTS_DIR_FOR_TEST, { recursive: true });
  try {
    await fs.writeFile(lockPath, '', 'utf-8'); // mtime = now → fresh
    assert.equal(await scheduler._isLocked(key), true, 'a fresh lock must read as locked');
    assert.equal(await scheduler._acquireLock(key), false, 'acquire must not steal a fresh lock');
  } finally {
    await fs.unlink(lockPath).catch(() => {});
  }
});

// ── PROPHET_ANALYSES_ENABLED gate ─────────────────────────────────────
// Prophet's discretionary LLM analyses (daily briefing, weekly screeners,
// scenario analysis, performance review + adapt, postmortem, mid-session news
// scan) auto-ran on a schedule to feed the now-defensive/dormant Prophet agent.
// The gate (default OFF) suppresses ONLY those auto-triggers; the load-bearing
// regime pipeline, trend parameter review, reasoning digest, trade grading,
// reconciliation, and the manual triggerJob/API path stay live.

// CUT jobs the gate must suppress when OFF.
const CUT_JOBS = [
  'daily_briefing', 'weekly_screeners', 'scenario_analysis',
  'review_performance', 'postmortem', 'adapt_strategy',
];

test('prophetAutoAnalysesEnabled: true only when PROPHET_ANALYSES_ENABLED === "true"', () => {
  assert.equal(prophetAutoAnalysesEnabled({ PROPHET_ANALYSES_ENABLED: 'true' }), true);
  assert.equal(prophetAutoAnalysesEnabled({ PROPHET_ANALYSES_ENABLED: 'false' }), false);
  assert.equal(prophetAutoAnalysesEnabled({ PROPHET_ANALYSES_ENABLED: '1' }), false);
  assert.equal(prophetAutoAnalysesEnabled({}), false, 'absent env var → disabled (CUT by default)');
});

// Build a scheduler with every trigger spied and every branch input controlled,
// so a run records exactly which jobs the gate let through. Real fs reads inside
// runStartupChecks (daily_brief.json, weekly_regime_*.json) ENOENT harmlessly.
function _gateScheduler({ et, lossInfo = null } = {}) {
  const scheduler = new AnalysisScheduler();
  const triggered = [];
  scheduler.triggerJob = async (job) => { triggered.push(job); return { success: true }; };
  scheduler._isLocked = async () => false;
  scheduler._detectLossConditions = async () => lossInfo;
  scheduler._getETInfo = () => et;
  scheduler._saveState = async () => {};
  scheduler._log = () => {};
  scheduler.emit = () => true;
  scheduler._running = true;
  scheduler._activeJob = null;
  scheduler.triggered = triggered;
  return scheduler;
}

// Run runStartupChecks twice (gate OFF, then ON) over identical inputs. The
// real holiday status (isMarketHoliday(new Date())) is the same for both runs,
// so any job that fires under ON but not OFF was suppressed by the gate alone —
// and any job that fires identically in both is provably untouched by the gate.
async function _runStartupOffThenOn(make) {
  const prev = process.env.PROPHET_ANALYSES_ENABLED;
  try {
    delete process.env.PROPHET_ANALYSES_ENABLED;
    const off = make(); await off.runStartupChecks();
    process.env.PROPHET_ANALYSES_ENABLED = 'true';
    const on = make(); await on.runStartupChecks();
    return { off: off.triggered, on: on.triggered };
  } finally {
    if (prev === undefined) delete process.env.PROPHET_ANALYSES_ENABLED;
    else process.env.PROPHET_ANALYSES_ENABLED = prev;
  }
}

test('runStartupChecks: gate OFF suppresses every CUT job; ON restores them (weekday)', async () => {
  const make = () => _gateScheduler({
    et: { hour: 8, minute: 0, isoDate: '2026-06-22', dayOfWeek: 1 }, // Monday morning
    lossInfo: { significantLoss: true, lossDate: '2026-06-19', lossPercent: -5, consecutiveLossDays: 1 },
  });
  const { off, on } = await _runStartupOffThenOn(make);
  // Weekday-gated CUT jobs that this scenario exercises (weekly_screeners is
  // Sunday-only and covered separately).
  for (const job of ['daily_briefing', 'scenario_analysis', 'review_performance', 'postmortem', 'adapt_strategy']) {
    assert.ok(!off.includes(job), `gate OFF must suppress ${job}`);
    assert.ok(on.includes(job), `gate ON must restore ${job}`);
  }
});

test('runStartupChecks: gate does NOT touch trend_parameter_review or the regime pipeline', async () => {
  const make = () => _gateScheduler({
    et: { hour: 8, minute: 0, isoDate: '2026-06-22', dayOfWeek: 1 },
    lossInfo: null,
  });
  const { off, on } = await _runStartupOffThenOn(make);
  // KEEP jobs must fire identically regardless of the gate (equality cancels
  // out the real-date holiday status the regime sections gate on).
  for (const job of ['trend_parameter_review', 'macro_regime_skill', 'breadth_skill', 'market_top_skill', 'bubble_skill', 'regime_gate_compute']) {
    assert.equal(off.includes(job), on.includes(job), `${job} must be unaffected by the gate`);
  }
  // trend_parameter_review has no holiday gate, so it must actually fire — proves
  // the method ran past the CUT block to the KEEP work after it.
  assert.ok(off.includes('trend_parameter_review'), 'trend_parameter_review must still fire when gate is OFF');
});

test('runStartupChecks: gate OFF suppresses the Sunday weekly_screeners catch-up; ON restores it', async () => {
  const make = () => _gateScheduler({
    et: { hour: 8, minute: 0, isoDate: '2026-06-21', dayOfWeek: 0 }, // Sunday
    lossInfo: null,
  });
  const { off, on } = await _runStartupOffThenOn(make);
  assert.ok(!off.includes('weekly_screeners'), 'gate OFF must suppress the Sunday weekly_screeners catch-up');
  assert.ok(on.includes('weekly_screeners'), 'gate ON must restore the Sunday weekly_screeners catch-up');
});

// _checkSchedule fires time-of-day triggers. Run OFF then ON over the same et.
async function _checkScheduleOffThenOn(make) {
  const prev = process.env.PROPHET_ANALYSES_ENABLED;
  try {
    delete process.env.PROPHET_ANALYSES_ENABLED;
    const off = make(); await off._checkSchedule();
    process.env.PROPHET_ANALYSES_ENABLED = 'true';
    const on = make(); await on._checkSchedule();
    return { off: off.triggered, on: on.triggered };
  } finally {
    if (prev === undefined) delete process.env.PROPHET_ANALYSES_ENABLED;
    else process.env.PROPHET_ANALYSES_ENABLED = prev;
  }
}

test('_checkSchedule: gate OFF suppresses the 6:00 AM daily_briefing; ON restores it', async () => {
  const make = () => _gateScheduler({ et: { hour: 6, minute: 0, isoDate: '2026-06-22', dayOfWeek: 1 } });
  const { off, on } = await _checkScheduleOffThenOn(make);
  assert.ok(!off.includes('daily_briefing'), 'gate OFF must suppress the 6:00 daily_briefing');
  assert.ok(on.includes('daily_briefing'), 'gate ON must restore the 6:00 daily_briefing');
});

test('_checkSchedule: gate OFF suppresses the Monday 6:05 review_performance + adapt_strategy; ON restores them', async () => {
  const make = () => _gateScheduler({ et: { hour: 6, minute: 5, isoDate: '2026-06-22', dayOfWeek: 1 } });
  const { off, on } = await _checkScheduleOffThenOn(make);
  assert.ok(!off.includes('review_performance') && !off.includes('adapt_strategy'), 'gate OFF must suppress the Monday review + adapt');
  assert.ok(on.includes('review_performance') && on.includes('adapt_strategy'), 'gate ON must restore the Monday review + adapt');
});

test('_checkSchedule: gate OFF suppresses the Sunday 18:00 weekly_screeners; ON restores it', async () => {
  const make = () => _gateScheduler({ et: { hour: 18, minute: 0, isoDate: '2026-06-21', dayOfWeek: 0 } });
  const { off, on } = await _checkScheduleOffThenOn(make);
  assert.ok(!off.includes('weekly_screeners'), 'gate OFF must suppress the Sunday 18:00 weekly_screeners');
  assert.ok(on.includes('weekly_screeners'), 'gate ON must restore the Sunday 18:00 weekly_screeners');
});

test('_checkSchedule: gate OFF suppresses the 16:30 loss-driven postmortem + adapt_strategy; ON restores them', async () => {
  const make = () => _gateScheduler({
    et: { hour: 16, minute: 30, isoDate: '2026-06-22', dayOfWeek: 1 },
    lossInfo: { significantLoss: true, lossDate: '2026-06-22', lossPercent: -6, consecutiveLossDays: 3 },
  });
  const { off, on } = await _checkScheduleOffThenOn(make);
  assert.ok(!off.includes('postmortem') && !off.includes('adapt_strategy'), 'gate OFF must suppress the loss-driven postmortem + adapt');
  assert.ok(on.includes('postmortem') && on.includes('adapt_strategy'), 'gate ON must restore the loss-driven postmortem + adapt');
});

test('_checkSchedule: the 16:45 trade_reconciliation fires regardless of the gate (KEEP)', async () => {
  const make = () => _gateScheduler({ et: { hour: 16, minute: 45, isoDate: '2026-06-22', dayOfWeek: 1 } });
  const { off, on } = await _checkScheduleOffThenOn(make);
  assert.ok(off.includes('trade_reconciliation'), 'trade_reconciliation must fire when gate is OFF (KEEP)');
  assert.ok(on.includes('trade_reconciliation'), 'trade_reconciliation must fire when gate is ON');
});

test('_startScanLoop: gate OFF installs no scan timer; ON installs one', () => {
  const prev = process.env.PROPHET_ANALYSES_ENABLED;
  try {
    const off = new AnalysisScheduler();
    off._log = () => {};
    off._runMidSessionScan = async () => {}; // avoid the immediate scan side-effects
    delete process.env.PROPHET_ANALYSES_ENABLED;
    off._startScanLoop();
    assert.equal(off._scanTimer, null, 'gate OFF must not install the mid-session scan timer');

    const on = new AnalysisScheduler();
    on._log = () => {};
    on._runMidSessionScan = async () => {};
    process.env.PROPHET_ANALYSES_ENABLED = 'true';
    on._startScanLoop();
    assert.ok(on._scanTimer != null, 'gate ON must install the mid-session scan timer');
    on._stopScanLoop();
  } finally {
    if (prev === undefined) delete process.env.PROPHET_ANALYSES_ENABLED;
    else process.env.PROPHET_ANALYSES_ENABLED = prev;
  }
});
