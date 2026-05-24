# Prophet Tradable-Universe Boundary + Options Spread Gate — Design

**Date:** 2026-05-24
**Status:** Draft for review
**Author:** Brainstorm follow-up (multi-session owner review)
**Scope owner decisions captured:** static floor = tradable / dynamic top-up = news-watch only; the boundary must be code-enforced and physically unreachable by trade selection (not prose); spread gate is the central programmatic options-liquidity check (load-bearing for the static floor too, not just leak-through); fail-closed in steady state via a 3-step observe→bound→enforce rollout; auto-pushed watchlist samples the tradable floor (~12 deepest-chain names), not the surveillance set.

---

## 1. Background

Prophet (the `v2-options` agent) has **no enforced tradable universe**. `place_options_order` forwards any `symbol`/`underlying` to the broker (`mcp-server.js:2236`, `controllers/order_controller.go:535`); the `TradeGuard` enforces sizing/daily-loss/sector caps but never a symbol-membership check. The only "universe" Prophet has is *soft*: a 6-name auto-pushed intraday watchlist, the rule examples in `TRADING_RULES_V2.md`, and a ~50-name catalyst list (`.claude/skills/analyst-actions/universe.txt`).

Two findings from the brainstorm reframe the work:

1. **The catalyst universe is screened on *equity* liquidity, not options liquidity — and only half of it is curated at all.** `universe.txt` = a hand-curated static floor (~45 mega-caps, options liquidity asserted by a human, never programmatically verified) + a daily FMP top-up of ~10–15 names screened purely on `marketCap>$5B / price>$20 / volume>5M shares` (`universe_builder.py:37-50`, `fmp_client.py:114-129`). The top-up has **no options-liquidity criterion** — an equity-liquid name with wide/thin options can enter it.

2. **`universe.txt` does not reach trade selection by a file read — it reaches it through the daily brief.** The file is consumed only by `analyst-actions` and `catalyst-news` (`fetch_analyst_actions.py:237`, `fetch_catalyst_news.py:196`), which emit catalysts into the daily brief; Prophet reads the brief and is then free to trade any name it sees. So the leak path is *brief → free-trading model*, and the only way to make the top-up "physically unreachable by trade selection" is a **code-enforced underlying allowlist at order time** — which does not exist today.

The current programmatic options-liquidity check in the order path is **nothing**: the trading service's `GetOptionsQuote` is a stub returning `"options quote not implemented yet"` (`alpaca_trading.go:602-608`), and the notional cap derives size from the operator-supplied limit price, never from market data.

This design (a) splits the single catalyst file into a **bot-owned tradable floor** (trade-eligible) and a **surveillance universe** (floor + top-up, news only); (b) adds a **code-enforced underlying allowlist** so only floor names are tradable; (c) builds the **first real options-data path** and a **spread gate** as the residual liquidity check; and (d) reconciles the watchlist and rules to the tradable floor. The allowlist is the "universe boundary first"; the spread gate is the "residual check" — defense in depth.

---

## 2. Goals / Non-goals

### Goals
- Make the tradable universe a **single bot-owned source** that the FMP top-up cannot write to.
- **Code-enforce** the tradable boundary on Prophet's options *opens* (reject opens whose underlying ∉ floor), flag-gated, observe-first.
- Build the **first implemented options quote path** (`GetOptionSnapshot`-backed), one fetch per options open, shared between notional sizing and the spread gate.
- Add a **code-enforced spread gate** (`(ask−bid)/mid < 10%`) on options opens, fail-closed in steady state, with a **defined 3-step observe→bound→enforce rollout** and a **fixed exit criterion** for the observe phase.
- Log **quote-unavailable rejections distinctly from genuine wide-spread rejections** (named requirement, not an implementation detail).
- Reconcile the auto-pushed watchlist (~12 deepest-chain floor names) and `TRADING_RULES_V2.md` examples so the de facto and de jure universes match.

### Non-goals
- Adding an options-liquidity screen to the FMP top-up (FMP's stock screener cannot express it; the spread gate is the liquidity check instead).
- Applying the universe allowlist to the other agents (penny/trend/meanrev/drift/harvest have their own universes; this gate is `AgentMain`-scoped).
- Applying the spread gate to the equity/penny stock path (penny stocks legitimately run wider spreads; out of scope — options opens only).
- Gating *closes/exits* — both new gates run on opens only, so neither can ever trap a position (consistent with the existing caps' opens-only scope, `order_controller.go:573-586`).
- Hot-reload of the tradable floor (it changes on a 6–12 month cadence; startup load + restart is acceptable).
- Dynamic top-up names becoming tradable (explicitly rejected by owner: boundary does the bulk of the liquidity work, gate catches the residue).

---

## 3. Workstreams

Each workstream is an independent, squashable commit unless noted. While both flags default off, **none of this changes live behavior** — it builds the machinery and observes.

### Workstream A — Tradable-universe split + code-enforced underlying allowlist

#### A1. Single bot-owned tradable floor
**Files:** new `config/prophet_tradable_universe.txt`; `.claude/skills/analyst-actions/scripts/universe_builder.py`, `.claude/skills/catalyst-news/scripts/universe_builder.py` (repoint `DEFAULT_STATIC_PATH`); `.claude/skills/analyst-actions/universe.txt` (becomes derived/removed — see below).

- Move the curated static floor to `config/prophet_tradable_universe.txt` (bot-owned, repo-relative, read by the Go guard at startup). This is the **single source of truth** for trade eligibility.
- The two catalyst `universe_builder.py` modules read this same file as their static base, then append their FMP surveillance top-up **in memory only**. The top-up never writes back to the floor file. (Today's `universe.txt` was already the shared "single source of truth"; this moves that source to a bot-owned path and renames its role to *floor*.)
- The catalyst skills keep full surveillance breadth (floor + top-up) — we *want* news coverage of transient high-volume names; we only forbid *trading* them.

**Result:** the top-up is structurally unable to reach trade selection — it exists only as transient in-memory surveillance, never in the file the guard loads. The boundary is a property of the data topology, not a filter that a bug could defeat.

#### A2. Code-enforced underlying allowlist in the guard
**Files:** `services/trade_guard.go`, `config/config.go`, `cmd/bot/main.go`, `controllers/order_controller.go`.

- Load the floor file once at startup into `TradeGuardConfig` as a `map[string]bool` (`TradableUnderlyings`). Empty/missing file → gate disabled (fail-safe: never block when unconfigured).
- **Fail direction — deliberate, and opposite to the spread gate (C3):** the allowlist fails **open** on a missing/empty floor file, while the spread gate fails **closed** on a missing runtime quote. This is consistent, not contradictory: a missing *config file* means "not configured yet" (a deploy/setup state — blocking all trades on it would let someone halt Prophet just by flipping `ENABLE_PROPHET_UNIVERSE_GATE` before the file exists), whereas a missing *quote during live trading* means "I can't verify liquidity right now" (a runtime degradation). Missing configuration fails safe (open); missing runtime data fails closed.
- New flag `EnableUniverseGate bool` (`ENABLE_PROPHET_UNIVERSE_GATE`, default **off**).
- New check in the options-open path: reject when `EnableUniverseGate && agent == AgentMain && opening && side=="buy"` and the order's **underlying** ∉ `TradableUnderlyings`.
- **Underlying derivation (robust, since `underlying` is an *optional* request field — only `symbol`/`quantity`/`side`/`order_type` are required in the MCP schema):** prefer `order.Underlying` when non-empty; otherwise parse the OCC root from `order.Symbol` (OCC format = underlying root + `YYMMDD` + `C`/`P` + 8-digit strike; the root is the leading alpha run before the 6-digit date). Only fail closed (reject when the gate is on) if **neither** yields an underlying — a blank optional field alone must not block a trade whose OCC symbol clearly names a floor member.
- **Scope:** `AgentMain` only. Other agents pass through untouched.
- **Ordering:** the universe allowlist runs **before** the spread gate (Workstream C). "Is this underlying tradable at all?" precedes "are its options liquid right now?"
- Distinct rejection reason: `guard_universe_not_tradable` (so operator can see "agent tried an off-floor name").

**Tests (mock-based, exercise the executor):** floor-member underlying passes; non-member rejected with `guard_universe_not_tradable`; gate off → all pass; non-main agent → not gated; **blank `Underlying` but OCC symbol root is a floor member → passes (OCC fallback)**; **blank `Underlying` and OCC root is off-floor → rejected**; OCC root parsing across roots of differing length (e.g. `F`, `NVDA`, `GOOGL`); close/sell of an off-floor name (existing position) → never blocked.

---

### Workstream B — Watchlist + rules coherence

**Files:** `agent/harness.js` (`PROPHET_INTRADAY_WATCHLIST`, line 18), `TRADING_RULES_V2.md`.

- Set `PROPHET_INTRADAY_WATCHLIST` to ~12 **deepest-chain** names sampled from the tradable floor (proposed: `SPY, QQQ, NVDA, TSLA, AAPL, MSFT, AMZN, META, AMD, AVGO, GOOGL, MSTR`). Owner-tunable; the selection criterion is "deepest options chains within the floor," not sector coverage of the surveillance set. Names without a mapped sector ETF simply omit the `sec%` field (existing behavior).
- `TRADING_RULES_V2.md`: update the "Intraday Context Block" symbol list (line 166), update the Position-Sizing/Portfolio-Construction sector *examples* so they reference the floor rather than implying an 8-name universe, and add a sentence stating the watchlist is **a context sample of the tradable floor, not the tradable universe** — the tradable universe is `config/prophet_tradable_universe.txt`, enforced by the guard when `ENABLE_PROPHET_UNIVERSE_GATE` is on.
- Note the crypto-cluster concentration (MSTR/COIN/MARA are largely one bitcoin-beta bet) as advisory guidance; a code-enforced crypto sector bucket is **out of scope** here (sector aggregation is separately flag-gated and currently off).

**Tests:** Node test asserting the watchlist constant is a subset of the floor file (guards against watchlist drift off the tradable set).

---

### Workstream C — Code-enforced options spread gate (3-step rollout)

#### C1. Build the options quote path + observe (no gating)
**Files:** `services/alpaca_trading.go` (`GetOptionsQuote`), `controllers/order_controller.go` (`optionsNotional` / `PlaceOptionsOrder`), `services/alpaca_options_data.go`.

- Implement `GetOptionsQuote` to delegate to `AlpacaOptionsDataService.GetOptionSnapshot` (`alpaca_options_data.go:97-145`) — live Alpaca REST (`/v1beta1/options/snapshots/{symbol}`), returning `Bid`, `Ask`, and the quote's **own exchange timestamp** (`AlpacaQuote.Timestamp`, the `"t"` field).
- **One fetch per options open**, reused for both notional sizing and the spread gate — do not double-call Alpaca (cross-agent call-budget / 429 discipline).
- In this step the gate **does not block**. It computes `spread_pct = (ask−bid)/mid` and `quote_age = now − quote.t` and logs both on every options open, regardless of value.

**Exit criterion for the observe phase (named, so it cannot become permanent):**
> Observe until **both** conditions hold: **≥5 trading sessions** have elapsed **and ≥30 option-open quote samples** have been collected. Then decide N from the observed `quote_age` distribution:
> - p95 age **< ~5s** → real-time OPRA feed → set N tight (~30s).
> - p95 age **clusters near ~15min (~900s)** → delayed (free) OPRA feed → set N just above the delay band (~960–1020s) and document that, on a delayed feed, the gate validates a delayed spread (acceptable: spread *width* is far more stable than price; flagged as a known limitation and a reason to consider upgrading the OPRA subscription).

This settles the OPRA-tier question empirically before any gating, and prevents "observe first" silently becoming "never enforced" — which would leave the gate built but inert, i.e. back to zero programmatic liquidity checks.

#### C2. Spread predicate + staleness bound (behind flag, default off)
**Files:** `services/trade_guard.go` (or a guard helper invoked from the controller where the quote is already fetched), `config/config.go`, `cmd/bot/main.go`.

- Config: `SPREAD_MAX_PCT` (default `0.10`, matching the existing advisory rule), `OPTIONS_QUOTE_MAX_AGE_SEC` (N, set from C1), `ENABLE_PROPHET_OPTIONS_SPREAD` (default **off**).
- **Absolute ceiling on N regardless of the observed distribution:** real-time feed → N ≤ 60s; delayed feed → N ≤ ~1020s. Even on a real-time feed a halted/frozen contract can emit a stale "latest quote"; the ceiling stops that passing.
- Predicate (opens only, `AgentMain`): reject if `spread_pct ≥ SPREAD_MAX_PCT`.
- Runs **after** the universe allowlist (A2).

#### C3. Fail-closed enforcement + distinct logging (the named requirement)
- When `ENABLE_PROPHET_OPTIONS_SPREAD` is on and the quote is **unavailable / stale (`age > N`) / error**, the options open is **rejected (fail closed)**.
- **Quote-unavailable rejections MUST log a distinct reason code from genuine wide-spread rejections** — this is a requirement, not an implementation detail:
  - `guard_options_quote_unavailable` — quote missing, stale, or API error.
  - `guard_options_spread_exceeded` — a fresh quote showed `spread_pct ≥ SPREAD_MAX_PCT`.
  - Rationale: on a flaky-feed day the two counters are the difference between *"the market is full of illiquid options today"* (alarming and wrong) and *"Alpaca's feed is degraded today"* (the actual situation). A shared reason code makes the operator misread their own system.
- **Fail-closed justification (settles the time-criticality concern):** both gates run on opens only — closes/exits are never gated (`order_controller.go:573-586`). So fail-closed can **never** trap Prophet in a position or block a manageable exit; the worst case is a *missed entry*. A missed scalp is a foregone opportunity; an unmanaged illiquid position is a realized loss. The asymmetry favors fail-closed even for time-critical scalps.
- **Relationship to the notional cap (correction of an earlier premise):** `checkPositionCaps` is **already** fail-closed on indeterminate input (`trade_guard.go:568-572`) — there is no fail-open fallback to fix. The spread gate simply **adopts the same fail-closed-on-missing-input stance**, so the two guards agree: both reject when their required input is missing and their flag is on.

**Tests (mock-based):** fresh quote under 10% → pass; ≥10% → `guard_options_spread_exceeded`; quote error/stale/`age>N` with flag on → `guard_options_quote_unavailable` (rejected); flag off → all pass; close path → never gated; non-main agent → not gated; single Alpaca fetch asserted (no double-call); ceiling caps N even if config sets it higher.

---

## 4. Sequencing

One implementation plan, commits in this order (dependencies noted). Flags default off throughout, so merge order is low-risk.

1. **A1** — move floor to `config/prophet_tradable_universe.txt`, repoint both catalyst builders. No behavior change (skills still read the same names).
2. **A2** — universe allowlist gate in the guard (`ENABLE_PROPHET_UNIVERSE_GATE` default off).
3. **B** — watchlist + `TRADING_RULES_V2.md` reconciliation (depends on A1's floor existing).
4. **C1** — implement quote path + observe logging (no gating). *Begin the observe window here.*
5. **C2** — spread predicate + staleness config (`ENABLE_PROPHET_OPTIONS_SPREAD` default off).
6. **C3** — fail-closed enforcement + distinct logging.

**Operational rollout (post-merge, not code commits):** run C1's observe window to the defined exit criterion → set `OPTIONS_QUOTE_MAX_AGE_SEC` (N) → flip `ENABLE_PROPHET_OPTIONS_SPREAD` on, then `ENABLE_PROPHET_UNIVERSE_GATE` on, watching the distinct rejection counters.

---

## 5. Open items to confirm during implementation

- **OPRA subscription tier** (real-time vs 15-min delayed) — resolved empirically by C1's observe phase; sets N.
- **Exact 12 watchlist names** — owner to confirm the deepest-chain subset of the floor.
- **Floor file location** — spec proposes `config/prophet_tradable_universe.txt`; confirm the Go bot's working directory resolves it (CWD per `cmd/bot/main.go`).
- **Should the universe allowlist ever cover the stock buy path for main?** Prophet is options-only, so spec scopes it to the options-open path; revisit only if Prophet starts trading equities.
- **`universe.txt` disposition** — once both builders read `config/prophet_tradable_universe.txt`, the old `.claude/skills/analyst-actions/universe.txt` should be deleted (not left as a stale second copy).

---

## 6. Testing strategy

- **Go:** table-driven unit tests in `services/trade_guard_test.go` and `controllers/order_controller_test.go`; mock `TradingService` (return canned snapshots with controllable bid/ask/timestamp) and a stub guard to assert side-effecting calls — test the executor, not just the predicate (project convention).
- **Integration test (validates the central thesis):** POST to the real `/options/order` handler with `strategy="v2-options"`, backed by a mock guard + mock options-data service, asserting (a) the universe allowlist rejects an off-floor underlying, (b) a single snapshot fetch feeds both notional and spread, (c) a wide-spread quote yields `guard_options_spread_exceeded` while a stale quote yields `guard_options_quote_unavailable`, (d) a close of an off-floor name is never blocked, and (e) **a blank `Underlying` with an OCC symbol whose parsed root is off-floor is rejected through the real handler** — exercising the OCC-root fallback (A2) end-to-end, not just at the unit level. The fallback (parse "leading alpha run before the 6-digit date") is the most fragile part of A2 and the path most likely to hit a broker edge case (roots containing digits, mini-option/non-standard OCC formats); the integration test must prove the fallback *rejects* off-floor, not only that it *passes* on-floor.
- **Python:** `universe_builder` tests already cover floor load + top-up merge; add a test that the top-up never mutates the floor file and that both builders resolve the new `config/` path.
- **Node:** assert `PROPHET_INTRADAY_WATCHLIST ⊆` floor.
- Run `go test ./...`, `node --test`, and the Python skill tests before each commit; no success claim without green output.
