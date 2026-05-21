# Prophet Risk-Enforcement Fixes — Design

**Date:** 2026-05-21
**Status:** Draft for review
**Author:** Fresh-eyes review follow-up
**Scope owner decisions captured:** hybrid enforcement, daily-loss fail-closed (buys-only), N-way guard, options stop monitor (phased).

---

## 1. Background

A fresh-eyes review of the Prophet trading agent surfaced a set of risk-control
gaps. The central theme: **for the main Prophet (`v2-options`) agent, almost
every quantitative risk limit is advisory prompt text, not code.** Two
structural gaps discovered *while drafting this spec* make the problem larger
than the initial review reported:

1. **Options orders bypass the guard.** `PlaceOptionsOrder`
   (`controllers/order_controller.go:490`) never calls `guard.CheckBuy` or
   `guard.RecordRawBuy`. Because Prophet is options-only, its real entries never
   touch the `TradeGuard` — so the daily-loss circuit breaker, symbol-overlap,
   and every cap are inert for Prophet today. The guard effectively governs only
   the stock/penny path (`OrderController.Buy`) and managed positions.

2. **Agent attribution is never populated in production.** `agent_source`
   appears only in Go (`order_controller.go`, `position_manager.go`); the MCP
   layer (`mcp-server.js`) and harness never send it — they forward only
   `strategy` / `agent_strategy` (from `OPENPROPHET_STRATEGY`). So `req.AgentSource`
   defaults to `AgentMain` for every order, and the guard's penny-specific caps
   and tag-based ownership (`positionBelongsTo`) are keyed off a value that is
   not set in production. **This must be confirmed with a reproduction test
   before relying on it, but the code paths strongly imply it.**

This design fixes the unambiguous bugs, wires the options path through the
guard, adds two hard backstop caps, makes attribution robust by deriving the
agent from the strategy tag, hardens the daily-loss breaker, and reconciles the
docs. A larger options auto-stop subsystem is scoped as Phase 2.

---

## 2. Goals / Non-goals

### Goals (Phase 1)
- Fix `maxOrderValue` so it accounts for the options 100× contract multiplier.
- Route options orders through `TradeGuard` so caps and the daily-loss breaker
  apply to Prophet's actual trades.
- Add two **hard, code-enforced** backstops: per-position % and whole-account
  deployed %.
- Make the daily-loss breaker **fail closed** on account-fetch error (buys-only;
  no auto-liquidation).
- Derive `AgentSource` from the strategy tag and extend the guard to all six
  strategies with N-way symbol-overlap.
- Fix the heartbeat phase-boundary weekend hole.
- Reconcile strategy docs with enforced reality.

### Non-goals (Phase 1)
- Enforcing the finer caps (V2 40% segment cap, sector caps, position count) —
  these remain advisory per the owner's "hybrid" decision.
- Auto-liquidation on the daily-loss breaker.
- Cross-instrument symbol-overlap (option vs stock on the same underlying) —
  OCC symbols never string-match tickers; tracked OCC symbol only.
- The options auto-stop monitor — see Phase 2.

---

## 3. Fixes

Each fix is an independent, squashable commit unless noted.

### Fix A — `maxOrderValue` options multiplier (MCP layer)

**File:** `mcp-server.js`, `enforcePermissions` (~line 1582).

**Problem:** `orderValue = (limit_price || entry_price || 0) * (quantity || qty || 0)`.
For options, `limit_price` is per *contract*; real outlay is `× 100`.
`place_options_order` carries no `allocation_dollars`, so a 30-lot at $6.00
computes as $180, not $18,000 — the per-order cap silently passes.

**Change:** when `toolName === 'place_options_order'`, multiply the computed
`orderValue` by 100 before the comparison. Use the tool name as the signal (not
the existing `symbol.length > 10` heuristic).

**Option-touching tools (enumerated from `ORDER_TOOLS`, `mcp-server.js:1526`):**
- `place_options_order` — single-leg open *and* close (via `side`/`position_intent`).
  The ×100 applies to both; this is the only tool the ×100 fix covers.
- `open_iron_condor` / `close_iron_condor` — multi-leg credit spreads (Harvest).
  Their economics differ (net credit received; max loss ≈ `wing_width × 100`), so
  a single-leg ×100 multiplier is **wrong** for them. Condors are **out of scope**
  for Fix A: Harvest sizes condors with its own formula
  (`floor(portfolio × 0.015 / (wing_width × 100))`) and `maxOrderValue` is not the
  correct gate for a credit spread. The condor tools keep their current behavior;
  a condor-aware notional is a separate follow-up if `maxOrderValue` must bind there.

**MCP-layer market-order note:** a *market* options order has no `limit_price` →
the MCP `orderValue` computes to 0 and passes *at this layer*. This is no longer a
silent hole: the Go guard (Fix B) now **blocks** unpriceable options orders
(fail-closed), so the end-to-end path is covered. The MCP layer stays size-only
because it cannot cheaply fetch quotes.

**Tests:** extend `enforcePermissions` coverage — options limit order over/under
cap with the ×100 applied; stock order unchanged; confirm condor tools are not
subjected to the single-leg ×100.

---

### Fix B — Route options through the guard + hybrid caps (Go) — *backbone*

**Files:** `controllers/order_controller.go` (`PlaceOptionsOrder`, `Buy`),
`services/trade_guard.go`, `config/config.go`, `cmd/bot/main.go`.

#### B1. Wire options through the guard
- `PlaceOptionsOrder` computes notional and calls `guard.CheckBuy(ctx, agent,
  req.Symbol, notional)` before placing; on success calls `RecordRawBuy(agent,
  req.Symbol)`. The options *sell/close* path calls `CheckSell` + `RecordRawSell`.
- Notional = `*req.LimitPrice * req.Qty * 100`. For market orders (`LimitPrice
  == nil`), fetch an options quote (mid or ask) × `Qty` × 100. If no price is
  obtainable, notional is unknown (see fail policy below).
- `agent` is derived via the new `AgentForStrategy(req.Strategy)` (Fix D), not
  `req.AgentSource`.

#### B2. Compute `allocationDollars` for all agents in `Buy`
Today `order_controller.go:94` computes `allocationDollars` only for
`AgentPenny`. Compute it for every agent (quote × qty for stocks) so the
per-position % cap and sector cap can ever fire on a non-penny buy.

#### B3. New caps in `TradeGuardConfig`
- `MaxPositionPct float64` — a single new trade's notional must satisfy
  `notional ≤ MaxPositionPct × PortfolioValue`.
- `MaxDeployedPct float64` — a **whole-account** ceiling. Current deployed
  fraction is derived from account fields: `(PortfolioValue − Cash) /
  PortfolioValue`. The gate is **projected, not current-only**: a buy is rejected
  if `currentDeployedFraction + notional/PortfolioValue > MaxDeployedPct`. This
  is a crude but strictly-conservative projection that needs no buying-power /
  margin modeling — it treats the order's notional as cash deployed (exact for
  long-premium options buys, conservative elsewhere). Rationale for projecting:
  a current-only gate lets a single 100×-notional lot overshoot the cap badly
  (e.g. 49% deployed + one large lot → well past 50%), which is unacceptable for
  an options-only agent where one lot can be large relative to the account.
- `EnablePositionCaps bool` — flag-gate, consistent with
  `EnableSectorAggregation` / `EnableRegimeGate`.

#### B4. Config + wiring
`config/config.go`: `ENABLE_POSITION_CAPS` (default `true` — these are paper
backstops; tunable), `MAX_POSITION_PCT` (default `0.12`), `MAX_DEPLOYED_PCT`
(default `0.50`). Wire into `NewTradeGuard` in `cmd/bot/main.go:154`.

**Default rationale:** `0.12` mirrors `TRADING_RULES_V2.md`'s "max 12% of
portfolio per position"; `0.50` is the conservative end of the V2 "maintain
50–70% cash" rule (≤50% deployed). Both are owner-tunable via env, not tuned
from data — they are deliberate backstops set at the documented advisory levels.

#### B5. Fail policy
- **Sizing caps fail CLOSED when notional cannot be determined and caps are
  enabled.** An order whose dollar size is unknowable (e.g. an unpriceable market
  options order — no `limit_price` and no obtainable quote) is **rejected**. For
  an options-only agent this is the primary path, so an unpriceable order is an
  execution-quality red flag, not benign missing data; failing open here would
  rebuild the exact gap this redesign closes. A `guard_notional_indeterminate`
  metric/log is emitted on each such block so a spike is visible to the operator.
- **Genuinely-no-data paths still fail OPEN:** `tradingService == nil` (tests)
  and `PortfolioValue ≤ 0` (uninitialized/new account). These are "no account
  context," distinct from "couldn't size a real order against a real account."
- Consistency with the daily-loss breaker (Fix C, also fail-closed on a real
  fetch error): both block when they cannot evaluate a risk signal against a live
  account, and both no-op only when there is no account context at all.

**Behavior change to call out:** once B1 lands, Prophet's options entries begin
respecting the daily-loss breaker and the new caps for the first time. This is
desirable and rule-aligned but is a real change to live behavior.

#### B6. Ownership consistency & concurrency
- **Record timing (existing model, made explicit):** `OrderController.Buy:142`
  records ownership *after a successful broker submission*, not after fill.
  `PlaceOptionsOrder` will follow the same model (record on submission success).
  Consequence under Fix D's N-way overlap: an order accepted-then-rejected, or
  never filled, leaves a stale symbol that now blocks *all* other agents (not just
  penny as today). Mitigations: (a) `RecordRawSell` clears on the close path;
  (b) `ManagedPositions` remain the authoritative ownership source (raw tracking
  is best-effort and lost on restart, per the existing guard doc comment);
  (c) **follow-up:** extend the existing broker reconciliation
  (`PositionManager.reconcileWithBroker`) to expire raw-symbol entries that have
  no corresponding broker position after N minutes. The follow-up is noted, not
  required for Phase 1, but the staleness is called out so "why is trend blocked
  from X" is diagnosable.
- **Concurrency / TOCTOU (limitation, documented):** the guard's `sync.RWMutex`
  guards only `rawSymbols`; `CheckBuy` reads account + computes exposure, and
  `RecordRawBuy` runs separately in the controller *after* the broker round-trip.
  So two concurrent buys can both pass the aggregate `MaxDeployedPct` gate against
  the same headroom before either records. We deliberately do **not** hold a guard
  lock across the broker call (it would serialize all order placement behind
  network latency and risk request timeouts). The deployed-% cap is therefore a
  **coarse backstop, not a precise budget** — acceptable for paper trading at the
  current low order rate across six strategies. A precise reserve-then-commit
  headroom accounting is possible but out of scope; flagged for revisit if order
  rates rise or this moves off paper.

**Behavior change to call out:** once B1 lands, Prophet's options entries begin
respecting the daily-loss breaker and the new caps for the first time. This is
desirable and rule-aligned but is a real change to live behavior.

**Tests (mock-based, exercising the executor — not just predicates):**
- `CheckBuy` rejects an options notional over `MaxPositionPct`; accepts under.
- `CheckBuy` rejects when projected deployed fraction exceeds `MaxDeployedPct`;
  accepts when current is near the cap but the order keeps the projection under it.
- Caps skipped when `EnablePositionCaps=false`.
- Fail-CLOSED on indeterminate notional with caps enabled; fail-OPEN no-data
  paths (nil trading service, zero portfolio).
- `PlaceOptionsOrder` calls `CheckBuy` with the ×100 notional and records the
  symbol on success; does **not** record when `CheckBuy` rejects or the broker
  submission fails (mock guard + mock trading service; assert the calls).
- `Buy` computes `allocationDollars` for a non-penny agent.

---

### Fix C — Daily-loss breaker fail-closed (Go)

**Files:** `services/trade_guard.go` (`CheckBuy`, `checkDailyLoss`).

**Problem:** `dailyAcct, _ := getAcct()` discards the fetch error;
`checkDailyLoss(nil)` is a no-op → the breaker silently disables on a flaky API
call, while the penny capital cap fails closed on the identical error.

**Change:** thread the fetch error into the daily-loss check. On account-fetch
**error**, return a blocking error (mirrors `checkPennyCapCap`). Preserve
fail-open for `tradingService == nil` (tests) and legitimately-zero
`LastEquity`/`PortfolioValue` (new account) — those are "no data," not "can't
read." Signature becomes `checkDailyLoss(acct *interfaces.Account, acctErr error)`.

**Recovery / self-DOS behavior (explicit):** the block is **per-`CheckBuy`**,
evaluated fresh each call — there is no persistent lock or latch. So the moment
the account API recovers, buys resume on the next beat; a transient error pauses
at most one beat's new entries. A *sustained* outage keeps new-entry buys paused
for its duration, which is the **intended** posture: trading new risk while blind
to intraday P&L is exactly what the breaker exists to prevent. Sells/exits are
never gated by this check, so positions remain manageable during an outage.
To keep this visible, the block logs a structured `daily_loss_check_unavailable`
warning (with `operator_review_required`) so sustained fetch failures surface
rather than silently pausing entries.

**Rejected alternative — cache last-known equity:** considered and declined. A
cached equity reading can mask a real intraday drawdown (the API could be failing
*because* something is wrong), which defeats the breaker's entire purpose. Pausing
new entries on a real fetch error is the safer failure mode than trading against
stale equity.

**Tests:** fetch error → buy blocked + warning logged; nil trading service →
allowed; zero last-equity → allowed; normal -6% → blocked; normal -2% → allowed;
two sequential calls (error then success) → blocked then allowed (proves no latch).

---

### Fix D — Strategy-derived attribution + N-way guard (Go) — *backbone*

**Files:** `services/trade_guard.go`, `controllers/order_controller.go`,
`services/position_manager.go`, `services/turtle_executor.go`.

**Problem:** (a) `AgentSource` is never sent by the MCP/harness, so production
attribution defaults to `AgentMain` for everything; (b) `AgentSource` defines
only `main`/`penny`/`harvest` and `opponentOf` is binary, so trend/meanrev/drift
aren't representable and turtle is mislabeled `AgentMain`.

**Changes:**
- Add `AgentTrend`, `AgentMeanRev`, `AgentDrift` constants.
- Add `func AgentForStrategy(strategyId string) AgentSource` mapping:
  `v2-options→main`, `penny-momentum→penny`, `harvest→harvest`, `trend→trend`,
  `mean-rev-rsi2→meanrev`, `earnings-drift→drift`; unknown/empty → `main`
  (preserves legacy default).
- All order entry points derive the agent from the strategy tag they already
  forward (`req.Strategy` / `req.AgentStrategy`) via `AgentForStrategy`, instead
  of reading the never-populated `req.AgentSource`. Keep `req.AgentSource` as an
  explicit override when present (back-compat + tests).
- Replace binary `opponentOf` with an N-way check: a buy/sell is rejected if the
  symbol is held by **any other** agent. Implementation: iterate all agents ≠
  self, reuse `agentOwnsSymbol`.
- `turtle_executor.go:479` passes `AgentTrend` instead of `AgentMain`.

**Scope of protection (honest framing — do not oversell):** the N-way check is
**exact-symbol-string** based. It meaningfully protects the same-instrument-format
agents from doubling up on a literal symbol (the equity agents penny / trend /
meanrev / drift, and the stock side of main). It does **not** protect against
Prophet (options, OCC symbols) and a stock agent both concentrating in the same
*underlying*, because an OCC string (`NVDA251219C…`) never matches a ticker
(`NVDA`). For the options-only main agent specifically, N-way overlap is therefore
mostly inert — the real cross-agent concentration control for options is the
sector-bucket aggregation (separate, flag-gated) and the per-position/deployed
caps (Fix B), not this symbol check. Underlying-level overlap (mapping an OCC
symbol to its underlying for the overlap test) is a candidate follow-up, tracked
under the cross-instrument non-goal. Fix F's doc update states this plainly so
the guard's protection is not overstated to operators.

**First implementation step:** add a failing test reproducing production
attribution (an order with `strategy="penny-momentum"` and no `agent_source`
must attribute to `AgentPenny`). This confirms gap #2 before the fix.

**Tests:** `AgentForStrategy` table; N-way overlap (main holds X → trend buy of X
blocked, and vice-versa); penny attribution via strategy tag; legacy
`agent_source` override still honored.

---

### Fix E — Heartbeat phase-boundary weekend hole (Node)

**File:** `agent/harness.js` (`_getSecondsToNextPhaseBoundary`, ~line 639).

**Problem:** returns `null` on weekends and after the last weekday boundary, so a
closed-phase beat that lands late Sunday schedules a full 8h sleep that can
overshoot Monday's 04:00 pre-market open. The boundary snap can't wake the agent
for the first phase of a new trading day.

**Change:** look ahead to the next *trading session's* first boundary (next
weekday 04:00 ET = 240 min) when no boundary remains today, mirroring the
multi-day lookahead already in `_getSecondsToNextScheduledBeat` (8-day horizon,
weekend skipping). Always return a positive seconds value. DST self-corrects
because `_scheduleNext` re-runs each beat. The existing `secsToBoundary < seconds`
clamp ensures this only ever *shortens* the next sleep.

**Tests (drive with arbitrary timestamps, no global Date mock):** Sunday 23:00 →
seconds to Monday 04:00; Friday 16:30 → seconds to Monday 04:00; weekday
03:30 → seconds to 04:00 (unchanged behavior).

---

### Fix F — Doc reconciliation

**Files:** `TRADING_RULES.md`, `TRADING_RULES_V2.md`, `agent/harness.js`
(`buildSystemPrompt`, ~line 97), `config/config.go` comments.

- Mark `TRADING_RULES.md` (V1) deprecated with a header pointing to V2, or delete
  it once confirmed unused as a fallback. (It is only loaded when no strategy
  rules file resolves — `harness.js:87`.)
- Reconcile the penny capital cap: doc says 30%, `config.go:66` defaults to 20%.
  Pick one; document the deployed value.
- Fix the framing contradiction: the wrapper calls the rules "hard rules you MUST
  follow" (`harness.js:97`) while the body says "guidelines, not hard
  constraints." Reword to distinguish **code-enforced** limits (daily-loss,
  per-position %, deployed %, maxOrderValue, live/options/0DTE gates) from
  **discretionary** guidance — now accurate since some caps are enforced.
- Update `TRADING_RULES_V2.md` to note which caps are now hard-enforced and the
  `ENABLE_POSITION_CAPS` flag.
- State the **N-way guard's scope limit** honestly in the cross-agent sections of
  `TRADING_RULES_V2.md`: symbol-overlap is exact-string and does not catch
  options-vs-stock concentration on the same underlying. Avoid implying the guard
  prevents all cross-agent doubling-up.

---

## 4. Phase 2 (separate spec + plan) — Prophet options auto-stop monitor

A flag-gated Go polling service modeled on `services/harvest_exit_monitor.go`.

**Contract:**
- Scope strictly to `v2-options` options positions (never Harvest/penny/other).
- Each tick: read options positions, compute unrealized % vs entry, auto-flatten
  at a hard stop (`PROPHET_OPTIONS_STOP_PCT`) and optionally a hard take-profit.
- Flag: `ENABLE_PROPHET_OPTIONS_STOP` (default off until observed).
- Flatten order quality: aggressive marketable-limit, not naked market, to limit
  stress-fill slippage.

**Risks to resolve in the Phase 2 spec:**
- Must not fight the LLM's discretionary exits (e.g., respect a recent manual
  action / cool-off; or treat the monitor as a hard floor only, far below the
  LLM's typical -15% discretionary stop).
- Strategy-scoping correctness (attribution must be reliable — depends on Fix D).
- Idempotency / double-send protection on the flatten order.
- **Sell-side guard interaction:** the monitor's flatten is a *sell*, so confirm
  it is not blocked by `CheckSell`'s N-way ownership check. For Prophet flattening
  its own OCC-symbol option this is safe (no other agent holds that exact symbol),
  but the monitor must either call the broker close path directly or be explicitly
  exempt from sell-side guarding so a flatten can never be refused.

**Owner note:** acknowledged this may span multiple sessions.

---

## 5. Sequencing

Phase 1 as one implementation plan, commits in this order (dependencies noted):

1. **Fix E** (heartbeat) — independent, lowest risk.
2. **Fix A** (maxOrderValue ×100) — independent, MCP-only.
3. **Fix D** (attribution + N-way) — prerequisite for B's agent derivation.
4. **Fix C** (daily-loss fail-closed) — small, guard-local.
5. **Fix B** (options through guard + caps) — depends on D (agent derivation).
6. **Fix F** (docs) — last, reflects the enforced reality.

Phase 2 ships as its own spec → plan after Phase 1 merges.

---

## 6. Open items to confirm during implementation

- **Confirm gap #2** (production attribution defaults to main) with a
  reproduction test before relying on the strategy-derived fix.
- **`ENABLE_POSITION_CAPS` default:** spec sets `true`; flip to observation-mode
  (`false`) first if the owner prefers the house rollout pattern.
- **Penny cap value** (20% vs 30%) — owner to confirm canonical number.

(Resolved during review: `MaxDeployedPct` now uses a projected gate, not
current-only — see B3. Sizing caps now fail closed on indeterminate notional —
see B5.)

---

## 7. Testing strategy

- Go: table-driven unit tests in `services/trade_guard_test.go` and
  `controllers/order_controller_test.go`; mock `TradingService` and a stub guard
  to assert side-effecting calls (per project convention: test the executor, not
  just the predicate).
- Node: pure-function tests in `agent/harness.test.mjs` driving
  `_getSecondsToNextPhaseBoundary` with explicit timestamps; MCP enforcement
  tests for Fix A.
- **Integration test (validates the central thesis — gaps #1 + #2 compounding):**
  a Go-level test that POSTs to the real `/options/order` handler with
  `strategy="v2-options"` and **no** `agent_source`, backed by a mock guard +
  mock trading service, asserting that (a) `CheckBuy` is invoked at all (gap #1:
  options were ungated), (b) with the ×100 notional, and (c) attributed to
  `AgentMain` via `AgentForStrategy` (gap #2: attribution from the strategy tag).
  This is the one test that exercises the full path Prophet actually uses, not
  just the units. Precedent: `services/regime_gate_python_integration_test.go`.
- Run `go test ./...` and `node --test` before each commit; no success claim
  without green output.
