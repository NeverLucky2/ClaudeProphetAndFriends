# Prophet options stop-monitor — ownership scoping (safety fix)

- **Date:** 2026-06-17 (revised after a max-effort design review)
- **Status:** Design approved (awaiting spec review)
- **Component:** `services/prophet_options_stop_monitor.go`, `services/occ.go`
- **Flag:** none (strictly-more-conservative bug fix; ships on)
- **Related:** [[prophet-debit-verticals]] (this fix makes that feature's stop-monitor exclusion real), `docs/superpowers/specs/2026-05-21-prophet-options-auto-stop-monitor-design.md` (the monitor's original design), [[defensive-prophet-project]] (its hedge spreads are protected by the same change), [[user-personal-options-trading]] (the incident), [[close-managed-position-fail-open-orphan]] (the fail-closed/fail-safe pattern).

## Problem

`ProphetOptionsStopMonitor` flattens catastrophically-losing long single-leg options. Its position-scoping (`prophetPositions`, `prophet_options_stop_monitor.go:126-139`) keeps **every** long option position in the shared Alpaca account, filtering only on `Side == "long"`. It has no way to tell Prophet's own positions from anything else in the shared account.

Consequence (observed): the operator opened a **manual CEG bull-put spread** by hand. Its long (protective) put dropped >50%, the monitor treated it as one of Prophet's own naked longs and sold it, leaving a **naked short put** the operator believed was a defined-risk spread. The existing ownership signal (`HasRawSymbol`) is only used to *log a warning* (`prophet_options_stop_monitor.go:216-218`), never to skip.

The same bug class would break Prophet's **own** future debit verticals (long leg tagged `v2-vertical`) and **DefensiveProphet's** hedge put-spreads (long leg tagged `prophet-defensive`): the monitor scopes by position side, not by order tag, so it would flatten one leg of a spread regardless of who built it. The debit-verticals feature's design *assumed* the monitor "filters on exactly `v2-options`" (`prophet_vertical_constants.go:9-11`) — that assumption is currently false. **This fix makes it true**, and is therefore a prerequisite for the verticals feature to be safe.

## Goals

- The monitor flattens a long option **only if** it is positively attributable to Prophet's `v2-options` single-leg strategy.
- The monitor **never** breaks a spread — manual, Prophet vertical, or DefensiveProphet hedge.
- Fail-safe: when ownership or structure is uncertain, leave the position alone.
- Durable across Go-bot restarts (the operator restarts frequently).

## Non-goals

- No change to *how* the monitor flattens (rungs, escalation, cool-off, stuck-exit). Only *which* positions it is allowed to touch. The stuck-exit takeover path inherits the tighter scope for free (it iterates the same scoped set), which is a desirable side benefit — it too will no longer act on a non-Prophet position.
- Not building the debit-verticals feature (Phases 3–4) — that is the next, separate cycle.
- No wall-clock grace fallback, no new env knobs, no new DB dependency for the monitor.

## Behavior contract

Per long option position, the monitor decides **flatten** or **leave alone**. Two mandatory gates, evaluated **A then C** so the skip diagnostic can name the cause:

> **Gate A (attribution).** Among orders for that exact OCC contract that are *opening buys* (`Side == "buy"`, `FilledQty > 0`), there is ≥1 tagged `v2-options` **and zero** tagged anything else. (Prophet single-leg never does `buy_to_close`, so a `v2-options` buy is always an open.)
>
> **Gate C (paired-short backstop).** No short position in the account positively parses to the **same `(underlying, expiration, option-type)`** as this long.
>
> Flatten **only if both gates pass.** A failure in either gate → leave alone.

| Position | Today | After fix | Gate that protects it |
|---|---|---|---|
| Manual spread long leg | flattened → naked short ❌ | **skipped** | A (no `v2-options` tag) |
| Manual naked long | flattened ❌ | **skipped** | A |
| Prophet vertical leg (`v2-vertical`) | would be flattened ❌ | **skipped** | A (and C catches the pair) |
| DefensiveProphet hedge long put (`prophet-defensive`) | would be flattened ❌ | **skipped** | A (and C catches the pair) |
| Prophet genuine naked single-leg (`v2-options`) | flattened ✓ | **flattened** ✓ | passes both |
| Opening order aged out of history | flattened | **skipped** | A fails closed |
| `v2-options` long that *also* has a same-class short | flattened | **skipped** | C |

**Role of each gate.** Gate A is the real owner check and on its own handles every manual and every non-`v2-options` spread leg. Gate C runs only on Gate-A survivors (i.e. `v2-options`-attributed longs), so its job is narrow and it will be near-silent in practice: it is the backstop for the pathological case where the tag attribution is wrong, or where Prophet legitimately holds a single-leg that happens to pair with a short on the same underlying/expiry/type. It is the belt to Gate A's suspenders — the operator chose A+C for exactly this.

## Mechanism

All changes in `services/prophet_options_stop_monitor.go` plus an OCC-parser extension in `services/occ.go`. `prophetPositions` has exactly **one** production caller (`EvaluateTick:320`) and one test caller, so the rewrite is contained. The two predicates are pure free functions; the scoping method composes them.

### EvaluateTick reordering

Today `EvaluateTick` (`:312`) fetches positions, then orders. Change to:

1. Fetch `orders` via `ListOrders(ctx, "all")` **first**. On error, **skip the entire tick** (the current behavior at `:325-328`) — without orders there is no attribution, so flatten nothing. This fail-safe is now load-bearing, not just a convenience.
2. Fetch the **full** options positions list (long *and* short — Gate C needs the shorts; today `prophetPositions` discards shorts at `:133`).
3. Scope to eligible longs by applying Gate A then Gate C.
4. Loop the eligible longs exactly as today (loss-fraction → cool-off → flatten / stuck-exit).

`ListOrders(ctx, "all")` builds `GetOrdersRequest{Limit: 500}` and sets `req.Status = status` (the caller passes `"all"`) — up to 500 recent orders of **all** statuses (`alpaca_trading.go:283-290`). For a low-volume fun-money agent that is a long lookback in both count and wall-clock, so a held position's opening buy is almost always present.

### Gate A — `attributedToProphetSingleLeg(symbol string, orders []*interfaces.Order) bool`

Pure. Scan orders where `o.Symbol == symbol`, `o.Side == "buy"`, `o.FilledQty > 0` (this uniformly covers `filled` and `partially_filled` — a real acquisition). For each, take `interfaces.ParseStrategyFromClientOrderID(o.ClientOrderID)`. Return:

- `true` iff ≥1 such buy parses to `"v2-options"` **and** none parses to anything else (`""` for a manual/UI order, `v2-vertical`, `prophet-defensive`, or any other tag);
- `false` otherwise — including the no-opening-buy-found case (aged out / sells only), which fails closed.

This reuses `interfaces.ParseStrategyFromClientOrderID`, the same attribution the cool-off (`llmActedRecently`, `:166`) already trusts for Prophet orders. The monitor's own flatten sells are tagged `v2-options-stop` and are sells, so they never contaminate Gate A.

### Gate C — `hasPairedShort(longSymbol string, all []*interfaces.OptionsPosition) bool`

Pure. `ParseOCC(longSymbol)`; if `!ok`, return `false` (a long whose symbol cannot be parsed contributes no positive pairing — Gate C must only ever *add* a skip on a **positively found** pair, never on uncertainty). Otherwise return `true` iff some `all[i]` with `Side == "short"` parses (`ok`) to the same `(underlying, expiration, optType)`.

Matching on `optType` (both calls or both puts) catches every vertical — bull-put, bear-put, call-debit, call-credit, and DefensiveProphet's put spread — while avoiding false-skips when an unrelated *opposite-type* short shares an underlying. Cross-expiry structures (calendars/diagonals) are out of Gate C's scope by design; manual ones are already fully handled by Gate A, and neither Prophet nor DefensiveProphet builds them.

### OCC parser extension (`services/occ.go`)

Add a pure parser that reuses the existing format validation:

```go
// ParseOCC splits an OCC option symbol (ROOT + YYMMDD + C/P + 8-digit strike)
// into its parts. ok is false for non-option symbols (delegates the format
// check to IsOptionSymbol, so the two stay in lockstep).
func ParseOCC(symbol string) (underlying, expiration string, optType byte, ok bool)
```

Implementation: `if !IsOptionSymbol(symbol) { return ..., false }`; then `root := ParseOCCUnderlying(symbol)`, `rest := symbol[len(root):]` (root is ASCII so byte-len == rune-count, per `occ.go:36`), `expiration = rest[0:6]`, `optType = rest[6]`, `underlying = root`. Strike (`rest[7:15]`) is not needed by Gate C but is cheap to return for future use. Keeps the existing all-letter-root assumption (already accepted in `occ.go`; fine for Prophet's mega-cap + ETF universe).

### Rewrite `prophetPositions`

Becomes the eligibility filter `(allPositions, orders) -> eligibleLongs`: for each `Side == "long"`, apply Gate A, then Gate C; collect survivors. For observability, when a long is dropped **while down past the stop threshold** (`lossFraction(p) >= cfg.StopPct`), emit one `WARN prophet_options_stop_skipped_unowned` naming the failing gate. This makes the monitor *visibly* decline a deeply-underwater manual/spread leg rather than silently — and is the canary for the dangerous failure mode where attribution is systematically wrong (e.g. Prophet buys somehow untagged → all longs skipped → monitor silently inert). The log repeats per 5-min tick while such a position is held; that is acceptable (Go-side, zero token cost, mirrors the existing `prophet_options_stop_grace_suppressed` cadence).

### Comment fix

Update `prophet_vertical_constants.go:9-11`: after this change the monitor genuinely requires positive `v2-options` attribution, so `v2-vertical` legs are excluded by construction. Rewrite the comment to describe the real mechanism rather than the previously-aspirational "filters on exactly `v2-options`".

## Testing (TDD)

Pure predicates tested directly; the side-effecting flatten path via the existing `recordingFlattener` fake (`prophet_options_stop_monitor_test.go:35`).

**New unit tests:**
- `ParseOCC`: valid call/put, ETF root, non-option (`ok == false`), empty string.
- `attributedToProphetSingleLeg`: lone `v2-options` filled buy → true; `v2-options` + a manual (`""`) filled buy for same symbol → false; only `v2-vertical`/`prophet-defensive` buys → false; no buys → false; `v2-options` *sell* only (no buy) → false; unfilled `v2-options` buy (`FilledQty==0`) → false.
- `hasPairedShort`: same underlying+exp+type short → true; same underlying+exp, *opposite* type → false; unparseable long symbol → false; no short → false.

**EvaluateTick / scoping integration:**
- Manual long (untagged filled buy) down >50% → **not** flattened + `skipped_unowned` log.
- `v2-vertical` leg down >50% → **not** flattened.
- `v2-options` long down >50% **with a seeded filled `v2-options` buy** → flattened (preserves today's core behavior).
- `v2-options` long down >50% **whose paired same-class short is present** → **not** flattened (Gate C belt-and-suspenders).
- `ListOrders` error → whole tick skipped, nothing flattened.

**Existing-test migration (important):** today's flatten/escalation/cool-off tests use **toy symbols** (`"NVDA_C"`, `"SPY_sc"`) and seed positions with **no orders**. Two adjustments:
- Each scenario that expects a flatten must now seed a filled `v2-options` buy for the position's symbol in the flattener's `orders` (this encodes the new ownership contract; it is not a loosening of coverage).
- Gate C is inert on toy symbols (`ParseOCC` → `ok=false` → no pair), so those tests are unaffected by C. New Gate C integration tests use **real OCC symbols** (e.g. `NVDA250620C00130000` + a higher-strike short `NVDA250620C00140000`).
- The `prophetPositions` scoping test (`:80`) is updated to the new signature/semantics; `TestMonitor_LossFraction` is untouched.

## Rollout

- **No feature flag.** The change is **strictly more conservative**: the set it flattens (Gate-A ∧ Gate-C survivors past the stop) is a strict subset of today's (all longs past the stop). It can only ever *skip* positions the monitor used to flatten, never flatten something new — so there is no unsafe direction to gate. Shipping it on **is** the fix.
- **Accepted trade-off:** a genuine Prophet `v2-options` naked long whose opening order has aged out of the 500-order window will not be back-stopped by the monitor. The LLM remains the primary manager; the monitor is a catastrophic-loss backstop. Failing safe here is correct given the priority *never break a spread > always catch every naked long*, and the `skipped_unowned` log surfaces any such case. Given Prophet's short-dated, days-held options, aging out before close is a genuine but rare edge.
- **Deploy:** Go rebuild + restart the bot. No migration, no config change.

## Considered & rejected

- **`HasRawSymbol` as the (or a secondary) positive-attribution signal.** It is in-memory and resets on every Go-bot restart (the operator restarts often), so it cannot durably attest ownership and would make the monitor go dormant on real positions after a restart. Gate A (broker order history) is durable. The existing `HasRawSymbol` warning is now subsumed by Gate A; leaving its wiring untouched is fine (harmless redundancy) and removing it is an optional out-of-scope cleanup.
- **Reading the `DBProphetVertical` ledger (or a managed-positions DB) to exclude legs.** Authoritative, but adds a DB dependency the monitor does not currently have, for no safety gain over Gate A ∧ Gate C (which already double-cover vertical and hedge legs). YAGNI.

## Verification items for planning

1. Confirm options orders returned by `ListOrders("all")` carry the OCC contract symbol in `o.Symbol` for **buys** (the cool-off path already assumes this for Prophet orders generally; Gate A narrows to filled buys).
2. Confirm Prophet single-leg option **buys** are tagged `v2-options:` in the client_order_id at submission (so `ParseStrategyFromClientOrderID` yields `"v2-options"`).
3. Confirm how mleg/vertical and hedge leg orders surface in `ListOrders` (parent vs nested child legs; whether legs carry their `v2-vertical` / `prophet-defensive` tag). **Either way the safety property holds**: a spread long leg either shows a non-`v2-options` buy (Gate A skips) or no buy at all (Gate A fails closed), and Gate C catches the structural pair — but document the actual shape for future readers.
4. Confirm `ParseOCC` slicing against a real Alpaca options position symbol sample (index-correctness of the `rest[0:6]` / `rest[6]` / `rest[7:15]` split).
