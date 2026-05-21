# Prophet Options Auto-Stop Monitor — Design (Phase 2)

**Date:** 2026-05-21
**Status:** Draft for review
**Author:** Risk-enforcement follow-up (Phase 2)
**Depends on:** Phase 1 (PR #52, merged into `main`) — strategy-derived attribution
(`AgentForStrategy`), options routed through `TradeGuard`, `rawSymbols` per agent.
**Branch:** `prophet-options-auto-stop` (off `main`).

---

## 1. Background & motivation

Prophet (the `v2-options` agent) trades **long single-leg options premium**. It has
**no automated stop today.** Alpaca stop / GTC orders are stock-only, so every
loss-cut depends on the LLM heartbeat noticing the loss on a beat. Overnight the
heartbeat interval is ~8h, so an option that closes the session down 20% and gaps
to −70% can sit unmanaged until hours into the next session.

This subsystem adds a **flag-gated Go polling service** — modeled on
`services/harvest_exit_monitor.go` — that, when enabled, reads Prophet's options
positions each tick, computes since-entry unrealized %, and auto-flattens any
position past a **deep catastrophic floor**.

### Reframing what it actually protects (important)

Standard equity options trade **regular hours only** (~09:30–16:00 ET). The monitor
therefore **cannot act overnight** — the market is closed. Its real value is:

1. Reacting within ~1 minute **at/after the open** to an overnight gap-down, instead
   of waiting for the LLM's next beat hours later.
2. Catching a fast intraday move **between sparse daytime beats**.

This reframing drives the cadence (RTH-only) and the "beats-observed" startup grace
(§5) — both follow from "the monitor only ever acts while the market is open."

---

## 2. Goals / Non-goals

### Goals
- A flag-gated (`ENABLE_PROPHET_OPTIONS_STOP`, default **OFF**) Go goroutine that
  flattens Prophet options positions past a hard floor.
- Strictly scope to Prophet's own positions; **never** touch a Harvest condor leg
  or any other agent's position.
- Coexist with — never fight — the LLM's discretionary exits.
- Guarantee the flatten executes (a stop that can't fill isn't a stop) **without**
  dumping at a price "the book only briefly invented."
- Idempotency / double-send protection that survives both repeated ticks **and a
  process restart**.

### Non-goals
- **Take-profit.** Stop-only. A hard TP would fight the LLM's discretionary upside
  management; the monitor is a downside floor, nothing more.
- **Multi-leg / condor handling.** Harvest owns its own exit monitor; this monitor
  excludes condor legs and never manages spreads.
- **Short-premium positions.** Prophet buys premium; the monitor only acts on
  `Side=="long"` positions.
- **Acting outside RTH.** Options don't trade extended hours; the monitor idles when
  the market is not `open`.
- **Replacing the LLM's normal ~−15% discretionary stop.** The floor sits far below
  that and exists only as a catastrophic backstop.

---

## 3. Architecture & lifecycle

New file `services/prophet_options_stop_monitor.go`, structured like
`harvest_exit_monitor.go`:

- A `ProphetOptionsStopMonitor` struct with narrow injected dependencies (interfaces),
  each fakeable in tests without booting Alpaca.
- `Start(ctx, interval, idleInterval, marketIsOpen)` tick loop identical in shape to
  Harvest's: tick every `interval` while `marketIsOpen()`, sleep `idleInterval`
  otherwise, return on `ctx.Done()`.
- Launched from `cmd/bot/main.go` as `go monitor.Start(...)` **only when**
  `ENABLE_PROPHET_OPTIONS_STOP=true`, beside the Harvest-monitor wiring block
  (`main.go:301`). `marketIsOpen` = `services.StaticMarketPhase(now, nyLoc)=="open"`,
  matching the Harvest monitor.
- Cadence: **1 min while open, 5 min idle** (mirrors Harvest; ample for a deep floor).

### Injected dependencies (interfaces, defined in this file)

| Interface | Production impl | Used for |
|---|---|---|
| `optionsPositionLister` | `*AlpacaTradingService` | `ListOptionsPositions(ctx)` |
| `condorLegLister` | `*LocalStorage` | `ListOpenHarvestCondors()` — leg exclusion set |
| `optionsPricer` | `AlpacaOptionsDataService` (via a thin pricer) | bid/ask for flatten limit + reference mid |
| `optionsFlattener` | `*AlpacaTradingService` | `PlaceOptionsOrder` (raw broker path), `GetOrder`, `CancelOrder`, `ListOrders` |
| `rawOwnershipChecker` | `*TradeGuard` | read-only `rawSymbols[AgentMain]` membership for the unattributed-log flag |
| `beatObserver` | shared timestamp written by `BeatContextController` | beats-observed startup grace |

> Following Harvest's precedent, optional wiring (`rawOwnershipChecker`, `beatObserver`)
> is injected via `Set*` methods so the core constructor stays minimal and tests can
> omit them.

---

## 4. Position scoping — "act only if confidently Prophet's"

The broker's position list is **agent-agnostic**: both Harvest condor legs (incl. the
long protective legs) and Prophet's single-leg longs appear as `AssetClass=="us_option"`.
Scoping is solved by **structural signature**, valid because the options-agent universe
is *closed and disjoint*: only Harvest and Prophet trade options, Harvest places only
multi-leg combo orders (legs tracked in `DBHarvestCondor`), Prophet only single-leg
long premium.

Each tick:

1. `ListOptionsPositions(ctx)` → keep only `Side=="long"`.
2. Build the exclusion set: every leg symbol (`ShortPutSymbol`, `LongPutSymbol`,
   `ShortCallSymbol`, `LongCallSymbol`) of every **non-CLOSED** Harvest condor
   (`ListOpenHarvestCondors`). Subtract these from the candidate set.
3. The remainder = **Prophet's positions by structural signature**.

### Unattributed-log early-warning (the "assumption is rotting" signal)

`rawSymbols[AgentMain]` (populated by Phase 1's `RecordRawBuy`) is a *positive* record
of Prophet ownership — but it's in-memory and lost on restart, so it is **never used as
a gate**. It is used only for observability: when the monitor acts on a candidate that
has **no** `rawSymbols[AgentMain]` entry, it logs `prophet_options_stop_unattributed`
loudly. That log is the early-warning that the structural signature has stopped being a
clean proxy for "Prophet's" — e.g. the day a third options agent is added, or a manual
human options trade appears. **Same revisit trigger applies: if this log starts firing
in steady state, the structural-signature assumption must be re-examined.**

> Honest limitation: a stray *manual* long option (not Harvest, not Prophet) would be
> flattened if it breached the floor. On this 2-agent paper account this is near-zero,
> and every such action is logged. If a third options agent is ever added, this scoping
> must be revisited (the `_unattributed` log surfaces exactly that).

---

## 5. Coexistence with the LLM

### 5a. Stop policy — deep catastrophic floor

- Fires when **since-entry** unrealized ≤ `−PROPHET_OPTIONS_STOP_PCT` (**default 0.50**,
  i.e. premium down 50%).
- Computed from `UnrealizedPL / CostBasis`, **not** the position struct's
  `UnrealizedPLPC` field — that field is mapped to Alpaca's *intraday* PLPC
  (`UnrealizedIntradayPLPC`), which is since-open, not since-entry. The floor must be
  since-entry.
- Skip + log (`prophet_options_stop_no_basis`) when `CostBasis <= 0` (can't size the %).
- The default 0.50 is a deliberate backstop far below the LLM's documented ~−15%
  discretionary stop; owner-tunable via env, not data-derived.

### 5b. Startup grace — beats-observed (not wall-clock)

The floor stays **dormant** until the monitor has observed Prophet take a beat **since
the monitor booted**. This defers to the LLM's next actual decision after a
restart/deploy, rather than instantly stomping a position it hasn't yet seen the LLM
act on.

- Signal source: `BeatContextController.HandleGet` already runs **every beat** (the
  harness fetches `/api/v1/beat-context?strategy=…` each cycle). When `strategy`
  matches the v2-options strategy id, the controller stamps a shared
  `lastProphetBeatAt` (a small thread-safe holder the monitor reads via `beatObserver`).
- The grace is a **one-time latch**: once the first post-boot Prophet beat is observed,
  the floor is live for the rest of the process lifetime. (After that, a beat where the
  LLM chooses to *hold* an underwater position does **not** re-arm the grace — the floor
  overrides a bad hold; that's the whole point.)
- **Fallback** — beats-observed is the committed primary (task 2 builds the
  beat-observer stamp as an enabler). The fallback is reached **only if task 2 proves
  intractable mid-implementation**, not chosen at ship time: a wall-clock grace **capped
  to expire by 09:30 ET**, so protection is always live at the open (when a gap-down is
  most dangerous). This degradation is safe by construction — even the fallback cannot
  nap through the open.
- While suppressed by grace, log `prophet_options_stop_grace_suppressed` so the state
  is visible.

### 5c. Cool-off (the deletable part)

Before flattening a triggered position, check whether the LLM **acted on that exact
OCC symbol** within the last `PROPHET_OPTIONS_STOP_COOLOFF_MIN` minutes (default 7).

- Source: **broker order history** (`ListOrders`), filtered to `v2-options`-tagged
  orders (via `ParseStrategyFromClientOrderID`) on that symbol; take the most recent
  `submitted_at`. Durable across restart, decoupled from the controller — chosen over a
  new in-memory registry the controller would write to (which would add coupling and be
  lost on restart). "Action" = an order; a passive hold is not an action and does not
  arm the cool-off (matches the intent: defer to *active* management).
- If a recent action exists → **suppress this tick** and log
  `prophet_options_stop_cooloff_suppressed`. A recent LLM action thus delays the floor
  by at most one cool-off window; if the position is still past the floor after it
  expires, the next tick flattens.
- Per the owner decision: the deep floor is the real mechanism; the cool-off is the
  part most willing to be deleted. **Every suppression is logged** so that, after an
  observation window, the cool-off can be removed with evidence (never fired) or kept
  (fired on a legitimate hold).

---

## 6. Flatten execution

A ladder that guarantees the fill but never at an invented price, and never twice.

### 6a. Rungs

- **Rung 0 — aggressive marketable-limit.** `sell_to_close` limit priced **through the
  bid** (crosses the spread to fill on the normal path). Reference quote via
  `optionsPricer` (bid/ask from `OptionDataService.GetOptionSnapshot`; the
  `TradingService.GetOptionsQuote` path is a stub).
- **Rung 1 — terminal wide marketable-limit with a sanity floor.** At rung-1 pricing
  time, read a **fresh** quote → `fresh_mid = (bid + ask) / 2`. Compute an aggressive
  through-the-bid price (`aggressive_limit`, e.g. `bid` minus a small buffer) for
  near-certain fill, bounded below by
  `sanity_floor = PROPHET_OPTIONS_STOP_SANITY_FLOOR_FRAC × fresh_mid` (default frac 0.50).
  Final limit = `max(aggressive_limit, sanity_floor)`.
  - When `aggressive_limit ≥ sanity_floor` (the normal stressed-but-legitimate case),
    the limit crosses the bid and **fills**.
  - When the entire bid has collapsed **below** the sanity floor (a phantom/air-pocket
    print), `final_limit = sanity_floor > bid`, so the order **rests at the floor**
    rather than dumping into the vacuum; log `prophet_options_stop_sanity_floor_hit`,
    leave it working, and re-evaluate next tick.
- **Why fresh mid, not first-trigger mid (decided on the dollars, not the round
  number):** the sanity floor's job is **anti-phantom-print**, so it must anchor to a
  *current* mark. Worked example — entry $2.00, stop fires at mid ≤ $1.00; a fast gap
  leaves a legitimate stressed quote of bid $0.40 / ask $0.80 (`fresh_mid` $0.60) by
  rung-1 time. Anchoring to the **first-trigger** mid ($1.00) gives floor $0.50 > the
  $0.40 bid → the monitor would **refuse the only available fill and ride the position
  down** — the exact failure it exists to prevent. Anchoring to the **fresh** mid ($0.60)
  gives floor $0.30 < $0.40 bid → **fills**; while a phantom bid of $0.05 (mid still
  $0.60, floor $0.30) is correctly **refused**. Fresh anchoring also removes any need to
  persist a trigger-time `reference_mid` across a restart — it is recomputed each time.
  `SANITY_FLOOR_FRAC` (0.50) is therefore "refuse to sell more than 50% below the current
  mid"; tunable lower (0.30–0.40) to fill more air-pocket cases at the cost of more
  slippage tolerance.
- **Never a naked market order** — this whole rung is a bounded limit, so a momentarily
  invented bid can never be hit. (A floor that occasionally rests-unfilled in a true
  air-pocket is the accepted cost of "never at a price the book only briefly invented.")

### 6b. Timing & escalation

- Escalation window: **short fixed wall-clock**, `PROPHET_OPTIONS_STOP_ESCALATION_SEC`
  (default 60). In fast-moving conditions this may be a **single attempt** (rung 0 →
  straight to rung 1 on the next tick).
- **Cancel-confirmed-before-replace:** before placing rung 1, cancel the rung-0 order
  and **confirm** via `GetOrder` that it is `canceled` or `filled`. Only then place the
  replacement. Never have two working flatten orders for one symbol.
- **Size against remaining quantity:** rung 1 quantity = position qty minus any
  partial fill of rung 0 (read from the order). Partial-fill safe — never over-sell.

### 6c. Idempotency / durability ("never twice", across ticks and restart)

The durable in-flight flag is **the broker itself** — no new persistence layer:

- Before placing on a symbol, query open orders (`ListOrders(ctx, "open")`) for a
  `v2-options`-tagged `sell_to_close` working order on that symbol. If one exists, the
  monitor **manages** it (poll for fill / escalate per §6b) instead of sending a new
  one. This survives a restart: a flatten placed before the crash is rediscovered.
- Belt-and-suspenders: extend `PlaceOptionsOrder` to honor a **caller-supplied
  deterministic `ClientOrderID`** (e.g. `v2-options-stop:{symbol}:{yyyymmdd}`) instead
  of always generating `{strategy}:{uuid}`. Alpaca rejects a duplicate
  `client_order_id`, giving broker-enforced single-send even under a race. (Today
  `PlaceOptionsOrder` overwrites any caller `ClientOrderID`; the change is: use the
  caller's value when non-empty, else keep the existing `{strategy}:{uuid}` behavior.)

---

## 7. Sell-side guard interaction

The monitor calls `tradingService.PlaceOptionsOrder` (the **raw broker path**) directly,
**not** the controller's HTTP handler — so it bypasses the controller's `CheckSell`
N-way ownership check entirely. A flatten can therefore never be refused by the guard.
This is safe: Prophet's own OCC symbol is held by no other agent, so the guard's check
would pass anyway, but bypassing removes any possibility of a refused stop. (The monitor
also does not record `RecordRawSell` itself; raw ownership is best-effort and the next
tick's broker read is authoritative for what's still open.)

---

## 8. Error handling & fail policy

Following the Harvest monitor's model:

- Per-position errors (pricer, quote, place, cancel, get-order) are **non-fatal**:
  log and continue the loop so other positions are still evaluated; the next tick
  retries the failed one.
- A failure to **list positions** or **list condor legs** skips the whole tick (we
  cannot safely scope without both — listing positions but failing the condor-leg
  fetch must **not** proceed, or we could flatten a condor leg). Log and return.
- No double-send: an error after a successful place but before state update is covered
  by the broker-in-flight query on the next tick (§6c).
- The monitor never auto-liquidates on *missing* data — only on a *confirmed* breach of
  the floor against real position data.

### Structured logs (enumerated)

`prophet_options_stop_triggered`, `prophet_options_stop_flattened`,
`prophet_options_stop_unattributed`, `prophet_options_stop_cooloff_suppressed`,
`prophet_options_stop_grace_suppressed`, `prophet_options_stop_sanity_floor_hit`,
`prophet_options_stop_escalated`, `prophet_options_stop_no_basis`,
`prophet_options_stop_inflight_managed`.

---

## 9. Config / flags

Added to `config/config.go` and wired in `cmd/bot/main.go`:

| Env var | Default | Meaning |
|---|---|---|
| `ENABLE_PROPHET_OPTIONS_STOP` | `false` | Master flag (observe before enforcing). |
| `PROPHET_OPTIONS_STOP_PCT` | `0.50` | Floor: flatten when since-entry loss ≥ this fraction. |
| `PROPHET_OPTIONS_STOP_COOLOFF_MIN` | `7` | Suppress flatten if LLM acted on the symbol within N min. |
| `PROPHET_OPTIONS_STOP_ESCALATION_SEC` | `60` | Window before escalating rung 0 → rung 1. |
| `PROPHET_OPTIONS_STOP_SANITY_FLOOR_FRAC` | `0.50` | Terminal limit floor as a fraction of the **fresh rung-1 mid** (anti-phantom-print bound; see §6a). |

All owner-tunable; defaults are deliberate backstops, not data-tuned.

---

## 10. Testing strategy (TDD, executor-not-predicate)

Go table-driven tests in `services/prophet_options_stop_monitor_test.go` with mock
`optionsPositionLister`, `condorLegLister`, `optionsPricer`, `optionsFlattener`,
`rawOwnershipChecker`, `beatObserver`. Assert the **side-effecting calls** (place /
cancel / get-order), not just classification predicates.

Cases:
- **Scoping:** Prophet long kept; Harvest condor legs (all four, incl. long legs)
  excluded; short positions ignored; CLOSED condor's legs not excluded; candidate with
  no `rawSymbols` entry emits `_unattributed` but still acts.
- **Floor classify:** computes from `UnrealizedPL/CostBasis`; fires at/below threshold,
  not above; `CostBasis<=0` → `_no_basis` skip.
- **Grace:** floor dormant until first post-boot Prophet beat observed; suppressed
  state logged; live thereafter even if a later beat holds an underwater position.
- **Cool-off:** recent `v2-options` order on the symbol → `_cooloff_suppressed`; stale
  order → flatten proceeds; non-Prophet recent order on the symbol does not suppress.
- **Escalation:** rung 0 placed; within window, no escalation; past window, cancel is
  **confirmed** before rung 1 is placed; rung 1 sized against remaining qty after a
  partial fill.
- **Sanity floor:** rung 1 limit = `max(aggressive_limit, frac × fresh_mid)`; a
  stressed-but-legitimate bid above the floor fills; a phantom bid below the floor
  → order rests at the floor (no sell below it) and `_sanity_floor_hit` is logged.
  Uses the **fresh** rung-1 mid, not the trigger-time mid.
- **Idempotency / restart:** existing `v2-options` working `sell_to_close` order on the
  symbol → monitor manages it, does **not** place a second; deterministic
  `ClientOrderID` set on placement.
- **Fail policy:** condor-leg list error → whole tick skipped (no flatten); per-position
  pricer error → that position skipped, others still evaluated.

Also extend `PlaceOptionsOrder` tests (Go) to confirm a caller-supplied `ClientOrderID`
is honored and the `{strategy}:{uuid}` default is preserved when it's empty.

Run `go test ./...` (and `node --test` if any JS touched) green before each commit.
No success claim without real test output.

---

## 11. Sequencing (one squashed commit per task)

1. **`PlaceOptionsOrder` caller-supplied `ClientOrderID`** — small, enables §6c
   idempotency. Independent.
2. **`BeatContextController` beat-observer stamp** + shared holder — enables §5b grace.
   Independent.
3. **Monitor core: scoping + floor classify** (no order placement yet) — the read path
   and §4/§5a logic with tests.
4. **Flatten ladder + cancel-confirm-replace + sanity floor + idempotency** — the
   write path (§6).
5. **Grace + cool-off integration** (§5b/§5c) into `EvaluateTick`.
6. **Config + `main.go` wiring** behind `ENABLE_PROPHET_OPTIONS_STOP` (§9, §3).
7. **Docs:** note the monitor + flag in `TRADING_RULES_V2.md` (and the memory).

Final whole-branch review before any PR (Phase 1's final review caught a critical
nil-map panic — not skipped here).
