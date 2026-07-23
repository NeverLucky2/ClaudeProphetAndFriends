import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDayPnl } from './day-pnl.js';

// Day P&L = equity - last_equity, but only when Alpaca gives a prior-session
// close to measure against. Alpaca returns last_equity=0 when it has none
// (brand-new or freshly-reset paper account). The old code computed
// equity - 0 and displayed the FULL PORTFOLIO VALUE as if it were the day's
// gain — the bug this module exists to prevent. Every other consumer
// (server.js daily-loss guard, Go TradeGuard) already treats last_equity<=0
// as "unavailable"; this makes the dashboard + Slack summary consistent.

test('normal gain: pnl and pct are the intraday change, not portfolio value', () => {
  const r = computeDayPnl({ PortfolioValue: 101000, LastEquity: 100000 });
  assert.equal(r.available, true);
  assert.equal(r.pnl, 1000);
  assert.equal(r.pnlPct, 1);
});

test('normal loss', () => {
  const r = computeDayPnl({ PortfolioValue: 99000, LastEquity: 100000 });
  assert.equal(r.available, true);
  assert.equal(r.pnl, -1000);
  assert.equal(r.pnlPct, -1);
});

test('THE BUG: last_equity=0 is unavailable, never the portfolio value', () => {
  // The exact live payload that triggered the report.
  const r = computeDayPnl({ PortfolioValue: 108154.43, Cash: 103940.86, LastEquity: 0 });
  assert.equal(r.available, false);
  assert.equal(r.pnl, null);
  assert.equal(r.pnlPct, null);
  // equity is still surfaced for callers that want to show the portfolio total
  // in its own (correctly-labelled) field.
  assert.equal(r.equity, 108154.43);
});

test('last_equity absent entirely is unavailable (not equity - 0)', () => {
  const r = computeDayPnl({ PortfolioValue: 50000 });
  assert.equal(r.available, false);
  assert.equal(r.pnl, null);
});

test('snake_case fields (portfolio_value / last_equity) are honored', () => {
  const r = computeDayPnl({ portfolio_value: 100500, last_equity: 100000 });
  assert.equal(r.available, true);
  assert.equal(r.pnl, 500);
});

test('negative last_equity is treated as unavailable, not a huge fake gain', () => {
  const r = computeDayPnl({ PortfolioValue: 50000, LastEquity: -100 });
  assert.equal(r.available, false);
  assert.equal(r.pnl, null);
});

test('string-encoded numbers coerce', () => {
  const r = computeDayPnl({ PortfolioValue: '101000', LastEquity: '100000' });
  assert.equal(r.available, true);
  assert.equal(r.pnl, 1000);
});

test('a real -100% day (equity 0, baseline positive) is representable', () => {
  const r = computeDayPnl({ PortfolioValue: 0, LastEquity: 100000 });
  assert.equal(r.available, true);
  assert.equal(r.pnl, -100000);
  assert.equal(r.pnlPct, -100);
});

test('nullish / empty account never throws and is unavailable', () => {
  for (const acc of [null, undefined, {}, { Cash: 5 }]) {
    const r = computeDayPnl(acc);
    assert.equal(r.available, false, `unavailable for ${JSON.stringify(acc)}`);
    assert.equal(r.pnl, null);
  }
});
