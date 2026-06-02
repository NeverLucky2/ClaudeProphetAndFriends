import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as defaultFs from 'node:fs';

import { detectAssetClass, isStopOut } from './apply-friction.mjs';

test('detectAssetClass: OCC + IC marker in reasoning -> iron_condor', () => {
  const action = { symbol: 'SPY260620P00400000', reasoning: 'opened iron condor on SPY' };
  assert.equal(detectAssetClass(action, 'default'), 'iron_condor');
});

test('detectAssetClass: OCC + "IC" abbreviation -> iron_condor', () => {
  const action = { symbol: 'SPY260620P00400000', reasoning: 'IC at 400/410/430/440' };
  assert.equal(detectAssetClass(action, 'default'), 'iron_condor');
});

test('detectAssetClass: OCC + "4-leg" -> iron_condor', () => {
  const action = { symbol: 'SPY260620P00400000', reasoning: '4-leg structure' };
  assert.equal(detectAssetClass(action, 'default'), 'iron_condor');
});

test('detectAssetClass: OCC without IC marker -> single_leg_options', () => {
  const action = { symbol: 'QQQ260515C00712000', reasoning: 'long call' };
  assert.equal(detectAssetClass(action, 'default'), 'single_leg_options');
});

test('detectAssetClass: plain ticker + default agent -> stocks', () => {
  assert.equal(detectAssetClass({ symbol: 'SPY', reasoning: '' }, 'default'), 'stocks');
});

test('detectAssetClass: plain ticker + trend-prophet -> stocks', () => {
  assert.equal(detectAssetClass({ symbol: 'AAPL', reasoning: '' }, 'trend-prophet'), 'stocks');
});

test('detectAssetClass: unrecognized symbol shape -> null (skip)', () => {
  assert.equal(detectAssetClass({ symbol: 'weird-thing-not-a-ticker-or-occ', reasoning: '' }, 'default'), null);
});

test('detectAssetClass: missing symbol -> null', () => {
  assert.equal(detectAssetClass({ reasoning: '' }, 'default'), null);
});

test('isStopOut: "stop hit" + losing P&L -> true', () => {
  const action = { reasoning: 'Position stop hit at -12%', market_data: { unrealized_pct: -12 } };
  assert.equal(isStopOut(action), true);
});

test('isStopOut: "stopped out" + losing P&L -> true', () => {
  const action = { reasoning: 'Position stopped out at -12%', market_data: { unrealized_pct: -12 } };
  assert.equal(isStopOut(action), true);
});

test('isStopOut: "stop triggered" + losing P&L -> true', () => {
  const action = { reasoning: 'Position stop triggered at -12%', market_data: { unrealized_pct: -12 } };
  assert.equal(isStopOut(action), true);
});

test('isStopOut: "hit my stop" + losing P&L -> true', () => {
  const action = { reasoning: 'Position hit my stop at -12%', market_data: { unrealized_pct: -12 } };
  assert.equal(isStopOut(action), true);
});

test('isStopOut: "hit stop" + losing P&L -> true', () => {
  const action = { reasoning: 'Position hit stop at -12%', market_data: { unrealized_pct: -12 } };
  assert.equal(isStopOut(action), true);
});

test('isStopOut: "stop loss fired" + losing P&L -> true', () => {
  const action = { reasoning: 'Position stop loss fired at -12%', market_data: { unrealized_pct: -12 } };
  assert.equal(isStopOut(action), true);
});

test('isStopOut: "SL hit" + losing P&L -> true', () => {
  const action = { reasoning: 'Position SL hit at -12%', market_data: { unrealized_pct: -12 } };
  assert.equal(isStopOut(action), true);
});

test('isStopOut: "stop loss triggered" + losing P&L -> true', () => {
  const action = { reasoning: 'Position stop loss triggered at -12%', market_data: { unrealized_pct: -12 } };
  assert.equal(isStopOut(action), true);
});

test('isStopOut: "forced out" + losing P&L -> true', () => {
  const action = { reasoning: 'Position forced out at -12%', market_data: { unrealized_pct: -12 } };
  assert.equal(isStopOut(action), true);
});

test('isStopOut: stop phrase but POSITIVE P&L -> false (not really a stop)', () => {
  const action = { reasoning: 'stop hit but ended up positive', market_data: { unrealized_pct: 2 } };
  assert.equal(isStopOut(action), false);
});

test('isStopOut: no stop phrase -> false', () => {
  const action = { reasoning: 'closing for profit', market_data: { unrealized_pct: -5 } };
  assert.equal(isStopOut(action), false);
});

test('isStopOut: case-insensitive matching', () => {
  const action = { reasoning: 'STOPPED OUT at the low', market_data: { unrealized_pct: -8 } };
  assert.equal(isStopOut(action), true);
});

test('isStopOut: missing market_data -> false (cannot confirm losing P&L)', () => {
  assert.equal(isStopOut({ reasoning: 'stop hit' }), false);
});

import { computeStockFriction } from './apply-friction.mjs';

const STOCK_PROFILE = {
  per_share_slippage_usd: 0.02,
  stop_gap_through_pct: 0.003,
  commission_per_share: 0.0,
  regulatory_fee_per_share: 0.0001,
};

test('computeStockFriction: round trip with no stop-out', () => {
  // 100 shares, no stop. Per-side: (0.02 + 0.0001) × 100 = 2.01. Round trip = 4.02.
  const action = { market_data: { entry_price: 100, exit_price: 102, size: 100 } };
  const result = computeStockFriction(action, STOCK_PROFILE, false);
  assert.equal(result.haircut_total_usd, 4.02);
  assert.equal(result.haircut_breakdown.slippage, 4.0);
  assert.equal(result.haircut_breakdown.regulatory_fees, 0.02);
});

test('computeStockFriction: stop-out adds gap-through extra', () => {
  // Base haircut 4.02 (above). Stop adds 0.003 × 100 × 100 = 30.
  const action = { market_data: { entry_price: 100, exit_price: 88, size: 100 } };
  const result = computeStockFriction(action, STOCK_PROFILE, true);
  assert.equal(result.haircut_total_usd, 34.02);
  assert.equal(result.haircut_breakdown.stop_gap_through, 30);
});

test('computeStockFriction: missing size -> throws clear error', () => {
  const action = { market_data: { entry_price: 100, exit_price: 102 } };
  assert.throws(() => computeStockFriction(action, STOCK_PROFILE, false), /size/);
});

import { computeSingleLegOptionFriction } from './apply-friction.mjs';

const OPT_PROFILE = {
  spread_crossing_pct_open: 0.60,
  spread_crossing_pct_close: 0.65,
  spread_crossing_pct_close_when_losing: 0.75,
  assumed_spread_pct_of_mid: 0.04,
  commission_per_contract: 0.65,
  regulatory_fee_per_contract: 0.05,
};

test('computeSingleLegOptionFriction: winning close uses normal close pct', () => {
  // entry 7.50, exit 8.50, 6 contracts. mid = 8.0, spread_dollars = 0.04 × 8 = 0.32.
  // crossing = 0.60 + 0.65 = 1.25. spread_cost = 0.32 × 1.25 × 6 × 100 = 240.
  // fees = (0.65 + 0.05) × 6 × 2 = 8.4. Total = 248.4.
  const action = { market_data: { entry_price: 7.5, exit_price: 8.5, size: 6 } };
  const result = computeSingleLegOptionFriction(action, OPT_PROFILE);
  assert.equal(result.haircut_total_usd, 248.4);
  assert.equal(result.close_was_losing, false);
});

test('computeSingleLegOptionFriction: losing close uses higher close pct', () => {
  // entry 7.50, exit 6.80, 6 contracts. mid = 7.15. spread_dollars = 0.04 × 7.15 = 0.286.
  // crossing = 0.60 + 0.75 = 1.35. spread_cost = 0.286 × 1.35 × 6 × 100 = 231.66.
  // fees = 8.4. Total ≈ 240.06.
  const action = { market_data: { entry_price: 7.5, exit_price: 6.8, size: 6 } };
  const result = computeSingleLegOptionFriction(action, OPT_PROFILE);
  assert.ok(Math.abs(result.haircut_total_usd - 240.06) < 0.01, `got ${result.haircut_total_usd}`);
  assert.equal(result.close_was_losing, true);
});

import { computeIronCondorFriction } from './apply-friction.mjs';

const IC_PROFILE = {
  spread_crossing_pct_open: 0.55,
  spread_crossing_pct_close: 0.65,
  spread_crossing_pct_close_when_losing: 0.80,
  assumed_spread_pct_of_credit: 0.10,
  leg_count: 4,
  commission_per_contract: 0.65,
  regulatory_fee_per_contract: 0.05,
};

test('computeIronCondorFriction: winning-framing test (exit < entry) with explicit theoretical_credit', () => {
  // 10 contracts, theoretical_credit = 2000. entry 2.0, exit 0.5.
  // close_was_losing = (0.5 < 2.0) = true → multiplier = 0.80 - 0.65 = 0.15.
  // base = 0.10 × 2000 = 200. spread = 200 × 1.15 = 230.
  // fees = (0.65 + 0.05) × 4 × 2 × 10 = 56. Total = 286.
  const action = { market_data: { entry_price: 2.0, exit_price: 0.5, size: 10, theoretical_credit: 2000 } };
  const result = computeIronCondorFriction(action, IC_PROFILE);
  assert.equal(result.haircut_total_usd, 286);
  assert.equal(result.close_was_losing, true);
});

test('computeIronCondorFriction: theoretical_credit estimated from entry × size × 100 when absent', () => {
  // entry 2.0, 10 contracts → estimated credit = 2000. Same numbers as above.
  const action = { market_data: { entry_price: 2.0, exit_price: 0.5, size: 10 } };
  const result = computeIronCondorFriction(action, IC_PROFILE);
  assert.equal(result.haircut_total_usd, 286);
});

test('computeIronCondorFriction: exit > entry skips multiplier', () => {
  // exit 1.5 > entry 1.0 → close_was_losing = false → multiplier = 0.
  // base = 100. spread = 100 × 1 = 100. fees = 56. Total = 156.
  const action = { market_data: { entry_price: 1.0, exit_price: 1.5, size: 10, theoretical_credit: 1000 } };
  const result = computeIronCondorFriction(action, IC_PROFILE);
  assert.equal(result.haircut_total_usd, 156);
  assert.equal(result.close_was_losing, false);
});

import { applyFriction } from './apply-friction.mjs';

const FULL_CONFIG = {
  version: '2026-05-17.1',
  stocks: STOCK_PROFILE,
  single_leg_options: OPT_PROFILE,
  iron_condor: IC_PROFILE,
};

test('applyFriction: stock trade produces augmented action with friction_meta', () => {
  const action = {
    symbol: 'SPY',
    reasoning: 'taking profit at target',
    market_data: { entry_price: 500, exit_price: 505, size: 100, unrealized_pl: 500 },
  };
  const result = applyFriction(action, 'default', FULL_CONFIG);
  assert.equal(result.skip, undefined);
  assert.equal(result.action.market_data.raw_pl, 500);
  assert.equal(result.action.market_data.friction_adjusted_pl, 500 - 4.02);
  assert.equal(result.action.friction_meta.profile_applied, 'stocks');
  assert.equal(result.action.friction_meta.close_was_losing, false);
  assert.equal(result.action.friction_meta.friction_config_version, '2026-05-17.1');
  assert.ok(typeof result.action.friction_meta.friction_config_hash === 'string');
  assert.equal(result.action.friction_meta.friction_config_hash.length, 8);
});

test('applyFriction: unrecognized asset class -> skip with reason', () => {
  const action = { symbol: 'weird-symbol', reasoning: '', market_data: { entry_price: 1, exit_price: 1, size: 1 } };
  const result = applyFriction(action, 'default', FULL_CONFIG);
  assert.equal(result.skip, true);
  assert.match(result.reason, /asset class/);
});

test('applyFriction: missing entry_price -> skip with reason', () => {
  const action = { symbol: 'SPY', reasoning: '', market_data: { exit_price: 100, size: 10 } };
  const result = applyFriction(action, 'default', FULL_CONFIG);
  assert.equal(result.skip, true);
  assert.match(result.reason, /market_data/);
});

test('applyFriction: option uses single_leg_options profile (close_was_losing surfaced)', () => {
  const action = {
    symbol: 'QQQ260515C00712000',
    reasoning: 'thesis broken, cutting',
    market_data: { entry_price: 7.5, exit_price: 6.8, size: 6, unrealized_pl: -420 },
  };
  const result = applyFriction(action, 'default', FULL_CONFIG);
  assert.equal(result.action.friction_meta.profile_applied, 'single_leg_options');
  assert.equal(result.action.friction_meta.close_was_losing, true);
});

test('applyFriction: sign-flip warning surfaced when small winner becomes loser', () => {
  // Stock: raw +$3, haircut $4.02 → -1.02.
  const action = {
    symbol: 'SPY',
    reasoning: 'small win',
    market_data: { entry_price: 100, exit_price: 100.03, size: 100, unrealized_pl: 3 },
  };
  const result = applyFriction(action, 'default', FULL_CONFIG);
  assert.equal(result.action.market_data.friction_adjusted_pl < 0, true);
  assert.equal(result.sign_flip_warning, true);
});

test('applyFriction: raw_pl falls back to (exit-entry)×size when unrealized_pl absent (stocks)', () => {
  const action = { symbol: 'SPY', reasoning: '', market_data: { entry_price: 100, exit_price: 105, size: 100 } };
  const result = applyFriction(action, 'default', FULL_CONFIG);
  assert.equal(result.action.market_data.raw_pl, 500);
});

test('applyFriction: raw_pl falls back to (exit-entry)×size×100 for options', () => {
  const action = {
    symbol: 'QQQ260515C00712000',
    reasoning: '',
    market_data: { entry_price: 5.0, exit_price: 6.0, size: 2 },
  };
  const result = applyFriction(action, 'default', FULL_CONFIG);
  assert.equal(result.action.market_data.raw_pl, 200);
});

import { loadFrictionConfig } from './apply-friction.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX_DIR = join(__dirname, 'test-fixtures');

test('loadFrictionConfig: valid file returns parsed config with all profiles', () => {
  const cfg = loadFrictionConfig(join(FIX_DIR, 'friction-valid.json'));
  assert.equal(cfg.version, '2026-05-17.1');
  assert.ok(cfg.stocks);
  assert.ok(cfg.single_leg_options);
  assert.ok(cfg.iron_condor);
});

test('loadFrictionConfig: missing file throws with clear message', () => {
  assert.throws(
    () => loadFrictionConfig(join(FIX_DIR, 'nonexistent.json')),
    /friction config.*not found/i,
  );
});

test('loadFrictionConfig: malformed file (missing profiles) throws', () => {
  assert.throws(
    () => loadFrictionConfig(join(FIX_DIR, 'friction-malformed.json')),
    /missing required profile/i,
  );
});

import { writeAtomic } from './apply-friction.mjs';

function makeMockFs(opts = {}) {
  const writes = [];
  const renames = [];
  const removes = [];
  const writeFileSync = (path, content) => {
    if (opts.writeShouldThrow) throw new Error('disk full');
    writes.push({ path, content });
  };
  const renameSync = (from, to) => {
    if (opts.renameShouldThrow) throw new Error('rename failed');
    renames.push({ from, to });
  };
  const unlinkSync = (path) => { removes.push(path); };
  const existsSync = () => false; // No leftover tmp at start
  return { mock: { writeFileSync, renameSync, unlinkSync, existsSync }, writes, renames, removes };
}

test('writeAtomic: writes to .tmp then renames', () => {
  const { mock, writes, renames } = makeMockFs();
  writeAtomic('/path/to/file.json', '{"a":1}', mock);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, '/path/to/file.json.tmp');
  assert.equal(writes[0].content, '{"a":1}');
  assert.equal(renames.length, 1);
  assert.deepEqual(renames[0], { from: '/path/to/file.json.tmp', to: '/path/to/file.json' });
});

test('writeAtomic: if rename throws, attempts to clean up the tmp file', () => {
  // existsSync needs to return true for the unlink to be attempted.
  const fs = {
    writeFileSync: () => {},
    renameSync: () => { throw new Error('rename failed'); },
    existsSync: () => true,
    unlinkSync: () => {},
  };
  const removes = [];
  fs.unlinkSync = (p) => { removes.push(p); };
  assert.throws(() => writeAtomic('/path/to/file.json', '{}', fs), /rename failed/);
  assert.deepEqual(removes, ['/path/to/file.json.tmp']);
});

test('writeAtomic: if write throws, does not rename and does not leave stale tmp', () => {
  const { mock, renames, removes } = makeMockFs({ writeShouldThrow: true });
  assert.throws(() => writeAtomic('/path/to/file.json', '{}', mock), /disk full/);
  assert.equal(renames.length, 0);
  // Write failed before tmp existed → no cleanup needed (existsSync returned false in mock)
  assert.equal(removes.length, 0);
});

import { resolveSandboxesForAgent } from './apply-friction.mjs';

const AGENT_CFG = join(FIX_DIR, 'agent-config-sample.json');

test('resolveSandboxesForAgent: returns accountIds for matching sandboxes', () => {
  const ids = resolveSandboxesForAgent(AGENT_CFG, 'default');
  assert.deepEqual(ids.sort(), ['aaa111', 'bbb222']);
});

test('resolveSandboxesForAgent: returns single match', () => {
  assert.deepEqual(resolveSandboxesForAgent(AGENT_CFG, 'harvest'), ['ddd444']);
});

test('resolveSandboxesForAgent: returns empty array for agent with no sandboxes', () => {
  assert.deepEqual(resolveSandboxesForAgent(AGENT_CFG, 'trend-prophet'), []);
});

test('resolveSandboxesForAgent: throws if agent-config missing', () => {
  assert.throws(
    () => resolveSandboxesForAgent('/nope.json', 'default'),
    /agent-config.*not found/i,
  );
});

import { processSandboxes } from './apply-friction.mjs';
import { rmSync } from 'node:fs';

test('processSandboxes: end-to-end on integration fixtures', () => {
  const tmpRoot = join(FIX_DIR, '__tmp_integration__');
  rmSync(tmpRoot, { recursive: true, force: true });

  const { mkdirSync, cpSync } = defaultFs;
  mkdirSync(join(tmpRoot, 'config'), { recursive: true });
  cpSync(join(FIX_DIR, 'friction-valid.json'), join(tmpRoot, 'config', 'friction.json'));
  mkdirSync(join(tmpRoot, 'data'), { recursive: true });
  cpSync(join(FIX_DIR, 'integration-agent-config.json'), join(tmpRoot, 'data', 'agent-config.json'));
  cpSync(
    join(FIX_DIR, 'integration-sandbox'),
    join(tmpRoot, 'data', 'sandboxes', 'integration-sandbox'),
    { recursive: true },
  );

  const result = processSandboxes({ agentId: 'default', projectRoot: tmpRoot });
  // BUY: entry=exit=500 → raw_pl = 0, friction adjusted = -4.02.
  // SELL: raw_pl = 500, friction adjusted = 495.98.
  // Both have full market_data, both process.
  assert.equal(result.processed, 2);
  assert.equal(result.skipped, 0);

  const sellFriction = JSON.parse(defaultFs.readFileSync(
    join(tmpRoot, 'data', 'sandboxes', 'integration-sandbox', 'decisive_actions', '2026-05-11_SELL_SPY.friction.json'),
    'utf8',
  ));
  assert.equal(sellFriction.market_data.friction_adjusted_pl, 495.98);
  assert.equal(sellFriction.friction_meta.profile_applied, 'stocks');

  rmSync(tmpRoot, { recursive: true, force: true });
});

test('processSandboxes: idempotent (two runs produce byte-identical output)', () => {
  const tmpRoot = join(FIX_DIR, '__tmp_idempotent__');
  rmSync(tmpRoot, { recursive: true, force: true });
  const { mkdirSync, cpSync, readFileSync: rfs } = defaultFs;
  mkdirSync(join(tmpRoot, 'config'), { recursive: true });
  cpSync(join(FIX_DIR, 'friction-valid.json'), join(tmpRoot, 'config', 'friction.json'));
  mkdirSync(join(tmpRoot, 'data'), { recursive: true });
  cpSync(join(FIX_DIR, 'integration-agent-config.json'), join(tmpRoot, 'data', 'agent-config.json'));
  cpSync(
    join(FIX_DIR, 'integration-sandbox'),
    join(tmpRoot, 'data', 'sandboxes', 'integration-sandbox'),
    { recursive: true },
  );

  processSandboxes({ agentId: 'default', projectRoot: tmpRoot });
  const firstRun = rfs(
    join(tmpRoot, 'data', 'sandboxes', 'integration-sandbox', 'decisive_actions', '2026-05-11_SELL_SPY.friction.json'),
    'utf8',
  );
  processSandboxes({ agentId: 'default', projectRoot: tmpRoot });
  const secondRun = rfs(
    join(tmpRoot, 'data', 'sandboxes', 'integration-sandbox', 'decisive_actions', '2026-05-11_SELL_SPY.friction.json'),
    'utf8',
  );
  assert.equal(firstRun, secondRun, 'idempotent runs must produce byte-identical output');

  rmSync(tmpRoot, { recursive: true, force: true });
});

test('processSandboxes: stale pre-existing .friction.json is overwritten (no mtime skip)', () => {
  const tmpRoot = join(FIX_DIR, '__tmp_stale_overwrite__');
  rmSync(tmpRoot, { recursive: true, force: true });
  const { mkdirSync, cpSync, writeFileSync, readFileSync: rfs } = defaultFs;
  mkdirSync(join(tmpRoot, 'config'), { recursive: true });
  cpSync(join(FIX_DIR, 'friction-valid.json'), join(tmpRoot, 'config', 'friction.json'));
  mkdirSync(join(tmpRoot, 'data'), { recursive: true });
  cpSync(join(FIX_DIR, 'integration-agent-config.json'), join(tmpRoot, 'data', 'agent-config.json'));
  cpSync(
    join(FIX_DIR, 'integration-sandbox'),
    join(tmpRoot, 'data', 'sandboxes', 'integration-sandbox'),
    { recursive: true },
  );

  const frictionPath = join(
    tmpRoot, 'data', 'sandboxes', 'integration-sandbox', 'decisive_actions',
    '2026-05-11_SELL_SPY.friction.json',
  );

  const staleContent = JSON.stringify({
    symbol: 'STALE',
    market_data: { raw_pl: 999, friction_adjusted_pl: 999 },
    friction_meta: { profile_applied: 'stocks', friction_config_version: '0.0.0-stale' },
  }, null, 2);
  writeFileSync(frictionPath, staleContent);
  assert.equal(rfs(frictionPath, 'utf8'), staleContent, 'precondition: stale file is in place');

  processSandboxes({ agentId: 'default', projectRoot: tmpRoot });

  const afterRun = rfs(frictionPath, 'utf8');
  assert.notEqual(afterRun, staleContent, 'stale .friction.json must be overwritten by processSandboxes');
  const parsed = JSON.parse(afterRun);
  assert.equal(parsed.symbol, 'SPY', 'overwritten file must reflect the raw decisive action (symbol SPY), not the stale STALE');
  assert.equal(parsed.friction_meta.friction_config_version, '2026-05-17.1', 'overwritten file must carry current config version');
  assert.equal(parsed.market_data.friction_adjusted_pl, 495.98, 'overwritten file must carry recomputed P&L (495.98), not stale 999');

  rmSync(tmpRoot, { recursive: true, force: true });
});

test('processSandboxes: respects frictionConfigPath option', () => {
  const tmpRoot = join(FIX_DIR, '__tmp_alt_config__');
  rmSync(tmpRoot, { recursive: true, force: true });
  const { mkdirSync, cpSync, writeFileSync, readFileSync: rfs } = defaultFs;
  mkdirSync(join(tmpRoot, 'config'), { recursive: true });
  cpSync(join(FIX_DIR, 'friction-valid.json'), join(tmpRoot, 'config', 'friction.json'));
  // Alt config: bump stocks slippage 10x → easy to detect in output.
  const alt = JSON.parse(rfs(join(FIX_DIR, 'friction-valid.json'), 'utf8'));
  alt.version = 'alt-test';
  alt.stocks.per_share_slippage_usd = 0.20;
  writeFileSync(join(tmpRoot, 'config', 'friction-alt.json'), JSON.stringify(alt, null, 2));
  mkdirSync(join(tmpRoot, 'data'), { recursive: true });
  cpSync(join(FIX_DIR, 'integration-agent-config.json'), join(tmpRoot, 'data', 'agent-config.json'));
  cpSync(
    join(FIX_DIR, 'integration-sandbox'),
    join(tmpRoot, 'data', 'sandboxes', 'integration-sandbox'),
    { recursive: true },
  );

  processSandboxes({
    agentId: 'default', projectRoot: tmpRoot,
    frictionConfigPath: join(tmpRoot, 'config', 'friction-alt.json'),
  });

  const friction = JSON.parse(rfs(
    join(tmpRoot, 'data', 'sandboxes', 'integration-sandbox', 'decisive_actions', '2026-05-11_SELL_SPY.friction.json'),
    'utf8',
  ));
  assert.equal(friction.friction_meta.friction_config_version, 'alt-test');
  // Slippage is now 0.20 × 100 × 2 = 40 (vs baseline 0.02 × 100 × 2 = 4)
  assert.equal(friction.friction_meta.haircut_breakdown.slippage, 40);

  rmSync(tmpRoot, { recursive: true, force: true });
});

test('processSandboxes: config with output_suffix writes *.friction-stress.json', () => {
  const tmpRoot = join(FIX_DIR, '__tmp_suffix__');
  rmSync(tmpRoot, { recursive: true, force: true });
  const { mkdirSync, cpSync, writeFileSync, existsSync: ex } = defaultFs;
  mkdirSync(join(tmpRoot, 'config'), { recursive: true });
  const stressCfg = JSON.parse(defaultFs.readFileSync(join(FIX_DIR, 'friction-valid.json'), 'utf8'));
  stressCfg.output_suffix = 'friction-stress';
  stressCfg.version = '2026-05-18.1-stress';
  writeFileSync(join(tmpRoot, 'config', 'friction-stress.json'), JSON.stringify(stressCfg, null, 2));
  mkdirSync(join(tmpRoot, 'data'), { recursive: true });
  cpSync(join(FIX_DIR, 'integration-agent-config.json'), join(tmpRoot, 'data', 'agent-config.json'));
  cpSync(
    join(FIX_DIR, 'integration-sandbox'),
    join(tmpRoot, 'data', 'sandboxes', 'integration-sandbox'),
    { recursive: true },
  );

  processSandboxes({
    agentId: 'default', projectRoot: tmpRoot,
    frictionConfigPath: join(tmpRoot, 'config', 'friction-stress.json'),
  });

  const stressPath = join(tmpRoot, 'data', 'sandboxes', 'integration-sandbox', 'decisive_actions', '2026-05-11_SELL_SPY.friction-stress.json');
  const baselinePath = join(tmpRoot, 'data', 'sandboxes', 'integration-sandbox', 'decisive_actions', '2026-05-11_SELL_SPY.friction.json');
  assert.equal(ex(stressPath), true, 'stress config must write *.friction-stress.json');
  assert.equal(ex(baselinePath), false, 'stress config must NOT write *.friction.json');

  rmSync(tmpRoot, { recursive: true, force: true });
});

test('loadFrictionConfig: accepts optional output_suffix string field', () => {
  const tmpRoot = join(FIX_DIR, '__tmp_suffix_load__');
  rmSync(tmpRoot, { recursive: true, force: true });
  defaultFs.mkdirSync(tmpRoot, { recursive: true });
  const cfg = JSON.parse(defaultFs.readFileSync(join(FIX_DIR, 'friction-valid.json'), 'utf8'));
  cfg.output_suffix = 'friction-stress';
  defaultFs.writeFileSync(join(tmpRoot, 'cfg.json'), JSON.stringify(cfg));
  const loaded = loadFrictionConfig(join(tmpRoot, 'cfg.json'));
  assert.equal(loaded.output_suffix, 'friction-stress');
  rmSync(tmpRoot, { recursive: true, force: true });
});
