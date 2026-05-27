import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  ALL_TOOLS,
  STRATEGY_TOOL_ALLOWLISTS,
  MANAGER_TOOLS,
  resolveAllowedTools,
  _internals,
} from './tool-allowlists.js';
import { regimeAndGuardTools } from '../mcp-tools/regime-and-guard.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

// Reproduce the live MCP catalog the same way mcp-server.js builds it: the tool
// objects declared in mcp-server.js plus the spread-in regimeAndGuardTools.
async function liveCatalog() {
  const src = await fs.readFile(path.join(REPO_ROOT, 'mcp-server.js'), 'utf-8');
  const re = /^\s{4,8}name:\s*'([a-z0-9_]+)'/gm;
  const names = new Set();
  let m;
  while ((m = re.exec(src))) names.add(m[1]);
  for (const t of regimeAndGuardTools) names.add(t.name);
  return names;
}

const STRATEGY_IDS = Object.keys(STRATEGY_TOOL_ALLOWLISTS);

// Owner -> the signal/order endpoints that must appear on exactly that agent.
const EXCLUSIVE = {
  'penny-momentum': _internals.PENNY_SIGNALS,
  'harvest': _internals.HARVEST_TOOLS,
  'trend': _internals.TREND_SIGNALS,
  'mean-rev-rsi2': _internals.MEANREV_SIGNALS,
  'earnings-drift': _internals.DRIFT_SIGNALS,
};

test('ALL_TOOLS exactly matches the live mcp-server catalog', async () => {
  const live = await liveCatalog();
  const declared = new Set(ALL_TOOLS);

  const missingFromMap = [...live].filter(t => !declared.has(t)).sort();
  const staleInMap = [...declared].filter(t => !live.has(t)).sort();

  assert.deepEqual(missingFromMap, [], `tools in mcp-server.js missing from ALL_TOOLS: ${missingFromMap.join(', ')}`);
  assert.deepEqual(staleInMap, [], `tools in ALL_TOOLS not found in mcp-server.js: ${staleInMap.join(', ')}`);
});

test('ALL_TOOLS has no duplicates', () => {
  assert.equal(ALL_TOOLS.length, new Set(ALL_TOOLS).size);
});

test('every tool in every strategy list is a real catalog tool', () => {
  for (const [strat, list] of Object.entries(STRATEGY_TOOL_ALLOWLISTS)) {
    for (const tool of list) {
      assert.ok(_internals.ALL_SET.has(tool), `${strat} references unknown tool "${tool}"`);
    }
  }
});

test('no strategy list contains duplicates', () => {
  for (const [strat, list] of Object.entries(STRATEGY_TOOL_ALLOWLISTS)) {
    assert.equal(list.length, new Set(list).size, `${strat} has duplicate tool entries`);
  }
});

test('BASE tools appear in every strategy list', () => {
  for (const [strat, list] of Object.entries(STRATEGY_TOOL_ALLOWLISTS)) {
    const set = new Set(list);
    for (const base of _internals.BASE) {
      assert.ok(set.has(base), `${strat} is missing base tool "${base}"`);
    }
  }
});

test('manager/orchestration tools are absent from every strategy list', () => {
  for (const [strat, list] of Object.entries(STRATEGY_TOOL_ALLOWLISTS)) {
    const set = new Set(list);
    for (const mgr of MANAGER_TOOLS) {
      assert.ok(!set.has(mgr), `${strat} must not expose manager tool "${mgr}"`);
    }
  }
});

test('each exclusive signal endpoint appears on exactly its owning agent', () => {
  for (const [owner, tools] of Object.entries(EXCLUSIVE)) {
    for (const tool of tools) {
      for (const strat of STRATEGY_IDS) {
        const has = new Set(STRATEGY_TOOL_ALLOWLISTS[strat]).has(tool);
        if (strat === owner) {
          assert.ok(has, `owner ${owner} should expose its tool "${tool}"`);
        } else {
          assert.ok(!has, `${strat} must NOT expose ${owner}'s exclusive tool "${tool}" (cross-strategy leak)`);
        }
      }
    }
  }
});

test('penny does not see mean-reversion tools (the reported bug)', () => {
  const penny = new Set(STRATEGY_TOOL_ALLOWLISTS['penny-momentum']);
  assert.ok(!penny.has('get_mean_reversion_signal'));
  assert.ok(!penny.has('get_mean_reversion_candidates'));
});

test('Prophet (v2-options) is broad but excludes other strategies signals + manager tools', () => {
  const prophet = new Set(STRATEGY_TOOL_ALLOWLISTS['v2-options']);
  // Excludes every other strategy's exclusive endpoints.
  for (const tools of Object.values(EXCLUSIVE)) {
    for (const tool of tools) {
      assert.ok(!prophet.has(tool), `Prophet must not expose exclusive tool "${tool}"`);
    }
  }
  // Excludes manager tools.
  for (const mgr of MANAGER_TOOLS) {
    assert.ok(!prophet.has(mgr), `Prophet must not expose manager tool "${mgr}"`);
  }
  // Keeps the discretionary kit (its mandated news path, options, scalping,
  // reports, heartbeat control). get_market_news is the one general news fallback
  // kept after the PROPHET_TRIM cut.
  for (const tool of ['get_market_news', 'get_quick_market_intelligence', 'get_marketwatch_bulletins', 'get_options_chain', 'place_options_order', 'get_intraday_signals', 'read_latest_report', 'set_heartbeat', 'apply_heartbeat_profile']) {
    assert.ok(prophet.has(tool), `Prophet should expose discretionary tool "${tool}"`);
  }
  // Excludes the PROPHET_TRIM cost redundancies (duplicate news feeds + foreign
  // equity-swing screeners) — these are now exposed to no agent.
  for (const tool of _internals.PROPHET_TRIM) {
    assert.ok(!prophet.has(tool), `Prophet must not expose trimmed tool "${tool}"`);
  }
  // Size sanity: catalog - 15 exclusive - 8 manager - PROPHET_TRIM. Computed off
  // ALL_TOOLS.length so it tracks catalog growth (e.g. a new generic Prophet tool).
  assert.equal(STRATEGY_TOOL_ALLOWLISTS['v2-options'].length, ALL_TOOLS.length - 15 - MANAGER_TOOLS.length - _internals.PROPHET_TRIM.length);
});

test('resolveAllowedTools: non-empty sandbox override wins', () => {
  const override = ['get_account', 'get_quote'];
  assert.deepEqual(resolveAllowedTools(override, 'penny-momentum'), override);
});

test('resolveAllowedTools: empty sandbox list falls back to strategy default', () => {
  assert.deepEqual(resolveAllowedTools([], 'mean-rev-rsi2'), STRATEGY_TOOL_ALLOWLISTS['mean-rev-rsi2']);
});

test('resolveAllowedTools: sandbox list of only falsy values is treated as empty', () => {
  assert.deepEqual(resolveAllowedTools(['', null, undefined], 'trend'), STRATEGY_TOOL_ALLOWLISTS['trend']);
});

test('resolveAllowedTools: unknown or absent strategyId resolves to [] (no filtering)', () => {
  assert.deepEqual(resolveAllowedTools([], 'no-such-strategy'), []);
  assert.deepEqual(resolveAllowedTools(undefined, undefined), []);
  assert.deepEqual(resolveAllowedTools(null, null), []);
});

test('every strategyId in the map has a non-empty list', () => {
  for (const [strat, list] of Object.entries(STRATEGY_TOOL_ALLOWLISTS)) {
    assert.ok(Array.isArray(list) && list.length > 0, `${strat} has an empty allowlist`);
  }
});
