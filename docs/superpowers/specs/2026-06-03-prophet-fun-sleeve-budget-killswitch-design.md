# Prophet Fun-Sleeve Budget + Kill-Switch — Design

**Date:** 2026-06-03
**Status:** Design (approved in brainstorm; pending spec review)
**Author:** Claude (Opus) + operator
**Topic:** Real-money safety gate for Prophet's 2% "fun/learning" sleeve, ahead of a (still-unconfirmed) paper→live migration.

---

## 1. Context & goal

Prophet (the fleet's loud agent, `default` sandbox, aggressive long single-leg `v2-options`) has been reframed as a **teaching tool** for the operator, not an alpha engine. When the fleet goes live (off paper, ~Oct 2026), Prophet is to get a **ring-fenced ~2% sleeve** of household deployable capital as a "fun/learning/real-probe" lane.

This thread builds the **coded safety gate** that makes routing real money into that sleeve responsible. It is the binding prerequisite: no live order may route without it. It does **not** confirm the live migration — that remains the operator's explicit call (see §13). It is a brainstorm→spec→plan→build item in its own right.

**Goal:** a self-contained, flag-gated (default OFF), fail-closed pre-trade gate that enforces the sleeve's exposure cap, a separate permanent loss-budget disarm, per-position and concurrency caps, an independent manual kill switch, a pre-registered off-ramp deadline, and a PDT backstop — at the Go broker chokepoint where every order must cross.

## 2. Locked budget semantics (operator-confirmed)

- **"2%" = the EXPOSURE cap** — at most ~2% of household deployable capital deployed at any one moment. Funded **once**, **no top-ups**, **no scaling on wins**. Losses ratchet the deployable size down on their own.
- **The lifetime LOSS budget is SEPARATE and ~1% of household** (≈ half the 2% sleeve). Enforced as a **coded permanent disarm** when cumulative **realized** loss crosses it. Running-sum trigger (deliberately *not* a drawdown/high-water-mark tracker). Requires explicit **manual re-enable**.
- Per-position size cap + concurrency cap on top.
- Do **not** let one "2%" mean both: a 2% *loss* budget would silently ~double the agreed risk.

## 3. Account model (Decision D1)

**Dedicated account = the sleeve.** A separate live Alpaca account, funded **once** with ~2% of household capital, with its **own keys** (separate from paper Alpaca). All caps are **dollar-denominated off a configured baseline constant `B`** (`PROPHET_SLEEVE_BASELINE_USD`), **never** live account equity.

Consequences:
- The "ratchet down on losses / no scaling on wins" semantics are literal and automatic — `B` is a constant, so wins never raise the caps and realized losses lower the available budget.
- **Every open position on the account is the sleeve's** → no per-strategy attribution filtering needed; position count and `Σ CostBasis` are just account totals.
- Cannot be inflated by an accidental over-fund (caps key off `B`, not equity).

## 4. Decisions (from brainstorm, 2026-06-03)

- **D1 — Account model:** dedicated account = sleeve; caps off constant `B`. (§3)
- **D2 — Disarm behavior:** on *any* disarm (auto loss-budget OR manual kill), **halt opens only**; leave open positions to their existing managed exits/stops. Long options have max loss fully paid at entry, so a forced flatten has no protective benefit and risks bad fills. No programmatic flatten path is built. Operator may still manually close in the Alpaca UI.
- **D3 — Kill switch:** layered. Primary = a fail-closed guard kill-flag (file on disk) checked on every open, settable via dashboard button/API **and** by dropping the file directly. Ultimate backstop (documented, not code) = revoke live keys / block the account in the Alpaca dashboard.
- **D4 — Loss source:** broker-derived realized loss on the dedicated account, **latched permanent** once it crosses the threshold. Realized-only (open paper losses excluded). Cross-checked against the per-trade ledger for teaching, but the disarm **gates on the broker number**.
- **D5 — PDT / account type:** fund as a **CASH account** (PDT-exempt, no leverage, fully defined risk) + build a **defensive PDT guard** as belt-and-suspenders in case the account is ever margin.
- **D6 — Location:** approach A — extend the Go `TradeGuard` chokepoint with a self-contained `ProphetSleeveGuard` unit, invoked in the existing opens-only / Prophet-scoped branch of `PlaceOptionsOrder`. Enforced at the Go broker boundary (the Go-native agents bypass Node, so a Node-layer gate would be bypassable).
- **D7 — Paper-testable:** the gate activates on its flag + configured baseline regardless of paper/live, so the full safety machinery can be exercised on the paper account before any live deployment. Default OFF everywhere → the shared-paper fleet is untouched.
- **D8 — Fail policy:** **fail closed** throughout (inverse of the other flag-gated gates, which fail open on missing config). A money gate's safe state is "block." (§9)

## 5. Architecture (approach A)

```
PlaceOptionsOrder (opening && side=="buy" && AgentMain)   ← existing chokepoint
   ├─ CheckOptionsOpen   (existing: universe + spread gates)
   ├─ CheckBuy           (existing: dollar caps + daily-loss breaker)
   └─ ProphetSleeveGuard.EvaluateOpen(ctx, newPremium, now)   ← NEW, last gate before broker
          reads:
            • GetAccount → PortfolioValue (equity), Cash, DayTradeCount, PatternDayTrader
            • ListOptionsPositions (+ GetPositions for safety) → Σ CostBasis (deployed),
              Σ UnrealizedPL, open count
          consults: two on-disk latch files + config (baseline, caps, deadline)
          returns error → controller responds 422, order never reaches the broker
```

- **New unit:** `services/prophet_sleeve_guard.go` (`ProphetSleeveGuard` struct) + `services/prophet_sleeve_guard_test.go`. Kept out of `trade_guard.go` (already large) for isolation; it is the **only** place the sleeve money-logic lives.
- **Invocation:** in `controllers/order_controller.go` `PlaceOptionsOrder`, inside the existing `opening && req.Side == "buy"` block, after `CheckOptionsOpen` + `CheckBuy`. The controller **passes `new_premium` in** — it already computes `notional := optionsNotional(order, quote)` for `CheckBuy`, so the guard takes the dollar figure as a parameter rather than recomputing it (`optionsNotional` is package-private to `controllers`; the guard lives in `services`). The guard does its own account + positions reads.
- **Opens-only, structurally:** invoked solely on opening buys, so closes / exits / expirations are *incapable* of being blocked — same guarantee as every existing cap (`isOpeningOption`).
- **Data-source interface:** define a narrow interface (e.g. account + options-positions reader) alongside the service so tests can stub it without implementing full `interfaces.TradingService` (established pattern, cf. `rvDataSource`).

## 6. The four caps

Let `B = PROPHET_SLEEVE_BASELINE_USD` (constant).

```
equity          = account.PortfolioValue
unrealized      = Σ UnrealizedPL over open positions (options + any equity)
realized_loss   = max(0, B − equity + unrealized)      // see §6.1
Available       = B − realized_loss                    // ratchet; ≤ B, never grows on wins
deployed        = Σ CostBasis over open option positions   // premium currently at risk
new_premium     = optionsNotional(order, quote)        // price × qty × 100 = max loss on a long option
open_count      = number of open option positions
```

| Cap | Rule (block the open when …) | Env (default) |
|---|---|---|
| **Exposure** | `deployed + new_premium > Available` | derived from `B` |
| **Per-position** | `new_premium > MAX_POSITION_FRAC × B` | `PROPHET_SLEEVE_MAX_POSITION_FRAC` (0.25) |
| **Concurrency** | `open_count ≥ MAX_POSITIONS` | `PROPHET_SLEEVE_MAX_POSITIONS` (5) |
| **Loss budget** | `realized_loss ≥ LOSS_BUDGET_FRAC × B` → latch permanent disarm (§7) | `PROPHET_SLEEVE_LOSS_BUDGET_FRAC` (0.50) |

All caps denominated off the constant `B`, never live equity → "no scaling on wins" is automatic. `0.25` per-position ⇒ ≥4 trades to fully deploy (no all-in-one-trade). `0.50` loss-budget ⇒ ~1% of household ⇒ disarm trips with ~half the sleeve intact, well before `Available` reaches 0.

### 6.1 Realized-loss formula (corrected)

On a funded-once account: `equity = B + realized_pnl + unrealized_pnl`, therefore

```
realized_pnl  = equity − B − unrealized
realized_loss = max(0, −realized_pnl) = max(0, B − equity + unrealized)
```

Equivalently `realized_loss = max(0, B − (equity − unrealized))`, where `equity − unrealized` is the account valued with open positions at **cost** (paper gains/losses stripped out). The unrealized term is **added back** (the brainstorm option label's `− Σ unrealized` was a sign slip). Verified against four cases:

| Scenario | equity | unrealized | realized_loss | correct? |
|---|---|---|---|---|
| Buy $200, no move (B=$1000) | 1000 | 0 | 0 | ✓ |
| Open position drops $150 (still open) | 850 | −150 | 0 | ✓ (unrealized, not realized) |
| Closed one for −$150, flat | 850 | 0 | 150 | ✓ |
| Closed −$150 + open winner +$60 | 910 | +60 | 150 | ✓ (only the closed loss) |

## 7. Disarm / kill / deadline state machine

Three independent disarm reasons; **all block opens, none ever block closes**. Two are latched files (survive restart; cleared only by deliberate operator action):

| Reason | Set by | Cleared by (re-arm) | Persistence |
|---|---|---|---|
| **Auto loss-budget** | bot, when `realized_loss ≥ LOSS_BUDGET_FRAC × B` | operator deletes the file | `<DISARM_DIR>/sleeve_disarm.json` (reason, timestamp, tripping realized-loss figure, `B`) |
| **Manual kill** | operator: dashboard button/API **or** `touch` the file | operator deletes the file | `<DISARM_DIR>/KILL_PROPHET_SLEEVE` |
| **Deadline** | config (no file) | operator edits config + restart | `PROPHET_SLEEVE_DEADLINE=YYYY-MM-DD` |

- **Latch, not recompute-gate.** The loss-budget disarm writes its file **once** when crossed; thereafter every open reads the file and blocks. A transient data wobble cannot un-disarm it, and recovery of the number does not auto-rearm (the point of a *permanent* disarm). Re-arming is a conscious file deletion.
- **Dual evaluation.** The auto-latch is checked **pre-trade** (every open) *and* on a **periodic monitor tick** (reuse an existing once/day post-close hook in `MonitorPositions`), so it latches and surfaces promptly even on a day with no open attempts.
- **Two separate files** so clearing a manual kill does not silently clear an auto loss-budget latch (and vice-versa). Each re-arm is its own act.
- **Kill API + deliberate re-arm asymmetry.** The manual kill is *set* easily — `POST /api/v1/sleeve/kill` (the Go bot writes `KILL_PROPHET_SLEEVE`; the dashboard button calls this) **or** the operator drops the file directly. Re-arming is *deliberate*: **file deletion only — there is intentionally no one-click re-arm button/endpoint.** Easy to disarm, conscious to re-arm. Same asymmetry for the auto loss-budget latch (cleared only by deleting `sleeve_disarm.json`).
- **Deadline required when armed:** `ENABLE_PROPHET_SLEEVE=true` with no valid **future** `PROPHET_SLEEVE_DEADLINE` → **fail closed** (block all opens). Forces a pre-registered expiry; renewing the live experiment is a deliberate config change. Recommend ~6 months out.
- **Out-of-band backstop (documented, not code):** revoke the live API keys or block the account in the Alpaca dashboard — works even if the Go bot is wedged.

## 8. PDT backstop

Block a new open when `account.DayTradeCount ≥ 3 AND account.PortfolioValue < 25000`. Belt-and-suspenders: the cash-account recommendation (D5) makes PDT moot, but if the account is ever margin this prevents tripping a pattern-day-trader restriction. Opens-only, so it can never trap a position. Uses fields already on `interfaces.Account` (no new broker plumbing).

## 9. Fail policy (fail-closed, D8)

A money gate's safe state is **block**. When `ENABLE_PROPHET_SLEEVE=true`:

| Condition | Behavior |
|---|---|
| `B ≤ 0` (baseline missing/zero) | block all opens |
| no valid future deadline | block all opens |
| `GetAccount` / positions read error | block the open (don't open new risk while blind to P&L) |
| any latch file present | block the open |
| flag OFF | full no-op (every gate skipped) |

This is the **inverse** of the universe/spread gates (which fail *open* on missing config so a missing floor never halts trading). Articulate both sides explicitly in code comments and the commit message.

## 10. Config / flags / deploy

All in `config/config.go` `Load()`, wired in `cmd/bot/main.go` next to the existing `TradeGuard`. **All default OFF / unset → shared-paper fleet untouched.**

| Env var | Default | Meaning |
|---|---|---|
| `ENABLE_PROPHET_SLEEVE` | `false` | master flag |
| `PROPHET_SLEEVE_BASELINE_USD` | `0` (→ fail closed when armed) | funded baseline `B` |
| `PROPHET_SLEEVE_MAX_POSITION_FRAC` | `0.25` | per-position cap × `B` |
| `PROPHET_SLEEVE_MAX_POSITIONS` | `5` | concurrency cap |
| `PROPHET_SLEEVE_LOSS_BUDGET_FRAC` | `0.50` | loss-budget disarm × `B` |
| `PROPHET_SLEEVE_DEADLINE` | unset (→ fail closed when armed) | off-ramp date `YYYY-MM-DD` |
| `PROPHET_SLEEVE_DISARM_DIR` | `filepath.Dir(DatabasePath)` | where latch files live |

Deploy = rebuild Go bot + restart Node (for the dashboard card/endpoint). Per project convention, the fix must reach **local `main`** to deploy.

## 11. Observability / teaching surface

`ProphetSleeveGuard.Status()` snapshot: `armed` + disarm reason(s), `B`, `Available`, `deployed`, `realized_loss`, `open_count`, `days_to_deadline`, per-cap headroom. Exposed via `GET /api/v1/sleeve/status` + a dashboard card. Makes "why am I blocked / how much runway is left" legible — the teaching point of the sleeve. Read-only; no side effects.

## 12. Testing plan (TDD, `go test ./services/`)

Stub account + options-positions via the narrow data-source interface. RED→GREEN:
- Each cap boundary (just-under / just-over): exposure, per-position, concurrency.
- Realized-loss formula across the four §6.1 cases.
- Loss-budget latch: trips → writes file → "restart" (re-read file) still disarmed → blocks; recovery of the number does **not** re-arm.
- Manual kill-flag file present → blocks; absent → allows.
- Deadline passed → blocks; missing-deadline-when-armed → fails closed; valid future deadline → allows.
- `B ≤ 0` when armed → fails closed.
- Account / positions read error → fails closed.
- **Closes / exits never blocked** under any disarm reason.
- PDT backstop boundary (`DayTradeCount` 2 vs 3, equity 24999 vs 25001).
- Flag OFF → every gate no-op (no reads, no blocks).

## 13. Hard prerequisites before any live order routes (NOT yet operator-confirmed)

The live migration itself is **not** confirmed by this spec — only the safety machinery is designed. Before any real order routes, all must hold:
- Funded options-approved **LIVE cash account** with its **own keys** (separate from paper Alpaca).
- `ENABLE_PROPHET_SLEEVE` default OFF; enabled only in the dedicated live deployment's env.
- Part A lifecycle correctness confirmed **on the live path** (partial-fill race + PENDING-entry timeout).
- Pending-fill reconciliation solid on the live path.
- Independent manual kill switch verified working (§7 D3).
- All-or-none multi-leg if/when spreads are used (never hold a naked leg) — out of scope for the long single-leg sleeve, noted for completeness.
- Sub-$25k PDT posture confirmed (cash account, §8).
- `PROPHET_SLEEVE_DEADLINE` pre-registered in config.
- This lane kept **OUT** of the Foundation edge-measurement / graduation series (it is a teaching probe, not an edge candidate).

## 14. Open tunables (for operator review)

- `MAX_POSITION_FRAC=0.25`, `MAX_POSITIONS=5`, `LOSS_BUDGET_FRAC=0.50` — starting values, tune freely.
- Deadline horizon (~6 months suggested).
- Whether `/sleeve/status` should also render in the existing agent terminal recap (low priority).

## 15. Out of scope

- Programmatic flatten/liquidation on disarm (D2: halt-opens-only).
- Multi-leg / spread sizing (sleeve is long single-leg `v2-options`).
- Edge measurement / graduation (explicitly excluded, §13).
- Task 4 paper-feed / 2%-probe split + `/stress-test-friction` (separate thread).
- Auto-rearm of any disarm latch (always manual, by design).

---

**One squashed commit when built, flag-gated default OFF, TDD throughout.** Rules update: if any agent-facing trading behavior changes, update `TRADING_RULES_V2.md` in the same commit (here the change is a backend gate, not an LLM rule — likely a brief note that live-sleeve opens may be blocked by the budget/kill/deadline guard, so the agent interprets a 422 from those gates correctly).
