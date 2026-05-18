import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderBeatContextBlock } from './beat-context.js';

test('renders all sections when present', () => {
  const block = renderBeatContextBlock({
    account: { portfolio_value: 100000, cash: 50000, buying_power: 200000 },
    positions: [{ symbol: 'TLT', qty: 100, unrealized_pnl: 250, unrealized_pnl_pct: 1.2 }],
    econ_blackout: { is_blackout: false, reason: '' },
    regime_gate: { tier: 'NORMAL', score: 55, sizing_multiplier: 0.8, block_new_entries: false },
    segment_pnl: { unrealized_pnl_percent: 0.5, deployed_percent: 12.0, strategy: 'trend' },
  });
  assert.match(block, /## Beat Context/);
  assert.match(block, /Portfolio: \$100,000/);
  assert.match(block, /TLT.*100.*\+1\.2%/);
  assert.match(block, /Regime: NORMAL/);
  assert.match(block, /Segment trend.*deployed 12\.0%/);
});

// On 2026-05-18 Spark misread an unlabeled "Positions:" header as a generic
// broker positions list and walked away from LAND, a penny-momentum position
// it had opened itself. When the request included a strategy filter (visible
// via segment_pnl.strategy), the rendered header must spell out that the
// positions list is the agent's OWN strategy-attributed positions.
test('positions header names the strategy when filter is in effect', () => {
  const block = renderBeatContextBlock({
    account: { portfolio_value: 100000 },
    positions: [{ symbol: 'LAND', qty: 216, unrealized_pnl: 27, unrealized_pnl_pct: 0.01 }],
    segment_pnl: { unrealized_pnl_percent: 0, deployed_percent: 2.0, strategy: 'penny-momentum' },
  });
  assert.match(block, /Positions \(your penny-momentum positions, attributed via order tag\):/);
  assert.match(block, /LAND.*216/);
});

test('positions header stays plain when no strategy filter context is present', () => {
  const block = renderBeatContextBlock({
    account: { portfolio_value: 100000 },
    positions: [{ symbol: 'AAPL', qty: 10, unrealized_pnl: 50, unrealized_pnl_pct: 0.5 }],
  });
  // Multi-strategy / unfiltered callers don't get the strategy-tagged label.
  assert.match(block, /^Positions:$/m);
});

test('renders block when downstream returned errors', () => {
  const block = renderBeatContextBlock({
    account: { portfolio_value: 100000 },
    errors: ['regime: timeout'],
  });
  assert.match(block, /errors:.*regime: timeout/i);
});

test('returns empty string when payload is null', () => {
  assert.equal(renderBeatContextBlock(null), '');
});

test('returns empty string when payload has no usable fields', () => {
  assert.equal(renderBeatContextBlock({}), '');
});
