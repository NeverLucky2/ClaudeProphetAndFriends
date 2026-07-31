# Defensive-Prophet option-chain fetch repair (silent-dead-hedge fix)

- **Date:** 2026-07-31
- **Status:** Design approved (awaiting spec review)
- **Component:** `services/alpaca_options_data.go`, `cmd/bot/main.go` (3 constructor call sites)
- **Flag:** none (repairs an always-broken code path; ships on). `ENABLE_PROPHET_DEFENSIVE` is already `true` in the real `.env`.
- **Related:** [[defensive-prophet-project]] (the agent this unblocks), `docs/superpowers/specs/2026-06-01-defensive-prophet-design.md` (original design), [[foundation-measurement-lifecycle-status]] (the BALLAST track that will finally receive data), [[deploy-binary-staleness-trap]] (the rebuild step this fix depends on), [[fleet-uncorrelated-ballast-pivot]] (why the hedge exists at all).

## Problem

Defensive-Prophet has been enabled since **2026-06-08** and has opened **zero** put-debit spreads in 52 calendar days. `prophet_hedge_spreads` has 0 rows.

This is not the strategy declining to fire. The Go scheduler is alive — `prophet_hedge_session` records daily 17:00 ET heartbeats through 2026-07-29 — and the hedge has been **armed** essentially the whole time: the regime gate reads score **39** / tier `DEFENSIVE` against an arm threshold of 50 (`hedgeArmThreshold`), and breadth has been pinned at 22–27 for weeks, which holds the composite well under 50.

The hedge is armed and failing silently. `deriveArm` returns armed, `openNew` runs, and then every attempt to read an option chain fails.

### Root cause

`AlpacaOptionsDataService.GetOptionChain` (`alpaca_options_data.go:156`) builds its URL from `baseURL = "https://data.alpaca.markets"`:

```
https://data.alpaca.markets/v1beta1/options/contracts?underlying_symbols=QQQ&expiration_date=…
```

That path does not exist on the data API. Verified live against the account's own credentials on 2026-07-31:

| Host | Response |
|---|---|
| `data.alpaca.markets/v1beta1/options/contracts` (what the code calls) | **HTTP 404** `{"message":"Not Found"}` |
| `paper-api.alpaca.markets/v2/options/contracts` (correct) | 200, full QQQ chain |

The contracts endpoint lives on the **trading** API, not the data API. `pickExpiry` (`prophet_hedge_executor.go:383`) probes the chain *before* pricing anything, so every heartbeat dies there and records the skip `"no monthly expiry in DTE band"` — a message that reads like a legitimate calendar outcome, which is why this went unnoticed for 52 days.

### Two further defects on the same path

Fixing the host alone is not sufficient — it would expose two more failures that were previously unreachable:

**Defect 2 — string-typed numerics.** Alpaca returns `strike_price: "205"` and `open_interest: "4669"` as JSON **strings**. `AlpacaOptionChainContract` (`alpaca_options_data.go:87-95`) declares them `float64` and `int64`, so `json.NewDecoder(...).Decode()` fails outright and `GetOptionChain` returns an error even against the correct host.

**Defect 3 — silent truncation.** The endpoint pages at 100 results and the code ignores the `next_page_token` it already declares (`alpaca_options_data.go:83`). Measured for QQQ 2026-09-18 puts:

| Request | Contracts | Strike range | `next_page_token` |
|---|---|---|---|
| default | 100 | 205 – 660 | `"MTAw"` |
| `limit=10000` | 259 | 205 – 1100 | `null` |

Today's long-put target (653, 5% OTM at QQQ 687.17) lands inside page 1 by 7 strikes. As QQQ rises the target crosses 660 and `pickPutStrikes` → `nearestPut` would **silently clamp** to the truncated chain's top strike and build the wrong spread — no error, no skip, just a wrong hedge. This is the most dangerous of the three because it fails quietly in the *opening* direction.

### Blast radius

`GetOptionChain` has exactly two non-test callers, both inside the hedge executor (`prophet_hedge_executor.go:316`, `:383`). `FindOptionsNearDTE` — which carries the identical host bug at `:223` — has **no** live callers. Nothing else in the fleet is degraded by this, and no other agent's behavior changes as a result of the fix.

## Goals

- Defensive-Prophet can read a complete, correctly-typed QQQ option chain and place its hedge.
- Chain truncation can never silently produce a wrong strike selection.
- A single malformed contract degrades that one contract, not the whole chain.
- The contracts host follows whichever Alpaca account a sandbox is configured against (paper or live), not a hardcoded assumption.

## Non-goals

- **No strategy or tuning changes.** `hedgeArmThreshold`, `hedgeDebitCapPct`, the OTM percentages, DTE band, harvest/roll thresholds all stay exactly as pre-registered.
- **No removal of the four morning regime skills.** They were the original subject of this investigation; the conclusion is that they stay (see "Cost finding" below).
- Not repairing `FindOptionsNearDTE` beyond the shared host/type/paging fix it inherits for free — it has no callers, so it gets no dedicated tests.
- No new env flags, no new DB tables, no change to the hedge lifecycle.

## Design

### 1. Split the two base URLs

`AlpacaOptionsDataService` gains a second host field. The two endpoint families genuinely live on different hosts and must not share one:

| Method | Host | Path |
|---|---|---|
| `GetOptionSnapshot` | `data.alpaca.markets` (unchanged) | `/v1beta1/options/snapshots` |
| `GetOptionChain` | **trading host** (new) | `/v2/options/contracts` |
| `FindOptionsNearDTE` | **trading host** (new) | `/v2/options/contracts` |

`GetOptionSnapshot` is already correct and is what prices the legs today — it must not move.

The constructor becomes `NewAlpacaOptionsDataService(apiKey, secretKey, tradingURL string)`, fed `cfg.AlpacaBaseURL` at all three call sites in `cmd/bot/main.go` (`:494` hedge, `:522` vertical, `:567`). `cfg.AlpacaBaseURL` already exists (`config/config.go:142`), defaults to `https://paper-api.alpaca.markets`, and honors `ALPACA_BASE_URL` / `ALPACA_ENDPOINT` — so a sandbox pointed at a live account gets the live contracts host automatically. An empty `tradingURL` falls back to the paper default rather than producing a malformed URL.

### 2. Parse string-typed numerics

`strike_price` and `open_interest` are redeclared as `string` and parsed with `strconv`. Parsing is **per contract**: a contract whose strike does not parse is skipped with a debug log, and the rest of the chain is returned. A contract whose `open_interest` does not parse keeps a zero OI (it is not load-bearing for strike selection) and is retained.

Rationale for asymmetry: strike is required for `pickPutStrikes` to be correct, so an unparseable strike makes that contract unusable. OI is informational on this path.

### 3. Follow pagination

Request `limit=10000` **and** loop on `next_page_token`, merging pages into the returned map until the token is empty. The explicit limit makes the single-page case the norm (verified: 259 contracts, `next_page_token: null`); the loop is the correctness guard so a future larger chain cannot silently truncate.

A bounded page cap (20 iterations) prevents an unterminated token loop from hanging the 17:00 ET heartbeat.

## Expected first trade

Simulating the executor's own math against the full chain, at QQQ 687.17 on 2026-07-31:

| Quantity | Value |
|---|---|
| Long put (5% OTM target 652.81) | **653P** |
| Short put (15% OTM target 584.09) | **585P** |
| Expiry | 2026-09-18 (49 DTE, inside the 45–60 band) |
| Width | $68 |
| Net debit | ≈ $9.42/sh = **$942/contract** |
| 1% cap on $108,257 portfolio | **$1,082** |
| `sizeSpread` result | **1 contract** |
| Max payoff | $6,800 |

(Debit derived from `close_price` marks, so live mids will differ somewhat; the magnitude holds.)

**Flagged, not changed:** that leaves only ~13% headroom under the debit cap. A modest IV bump flips `sizeSpread` to 0 and the hedge skips with `"armed but unaffordable"`. `hedgeDebitCapPct` is a pre-registered paper-phase constant — adjusting it is a strategy decision for a separate cycle, not part of this repair. Worth watching once rows start appearing.

## Testing

Go unit tests against an `httptest` server, in `services/alpaca_options_data_test.go`:

1. **String numerics decode** — `strike_price: "653"` yields `StrikePrice == 653.0`; `open_interest: "4669"` yields `4669`.
2. **Pagination merge** — a two-page fixture (token then empty) returns the union of both pages.
3. **Page cap** — a server that always returns a token terminates at the cap rather than looping forever.
4. **Host routing** — contracts requests arrive at the trading-host test server and snapshot requests at the data-host test server; a snapshot call never hits the contracts path.
5. **Malformed contract tolerated** — a chain containing one unparseable `strike_price` returns the remaining contracts rather than an error.
6. **Non-200 propagates** — a 404 still returns an error (guards against a regression that swallows the very failure mode this spec exists to fix).

The existing `prophet_hedge_*_test.go` suite must stay green — those use `hedgeStubChain` and are unaffected by the transport change, which is exactly why they never caught this.

## Deploy and verification

1. `go build -o prophet_bot.exe ./cmd/bot` — **forced**. Restarting Node alone will not rebuild: `_ensureBinary` only builds when the binary is absent, so a stale `prophet_bot.exe` would silently redeploy the broken code ([[deploy-binary-staleness-trap]]).
2. Restart Node so the orchestrator re-spawns the DefensiveProphet sandbox bot.
3. Confirm the boot log line `Defensive-Prophet hedge scheduler started (ENABLE_PROPHET_DEFENSIVE=true)`.
4. After the next 17:00 ET heartbeat, confirm a row in `prophet_hedge_spreads` in `data/sandboxes/sbx_565f5239/prophet_trader.db`.

Step 4 is the real acceptance test: a row appearing is the first proof in 52 days that the hedge can execute end-to-end.

## Cost finding (context for why this repair, not removal)

This work began as a question about whether Defensive-Prophet and the four morning market-analysis skills could be **removed** for eating cost without trading. The measured cost picture:

| Job | Mechanism | Token cost |
|---|---|---|
| `macro_regime_skill` | direct Python spawn (FMP) | **$0** |
| `breadth_skill` | direct Python spawn (public CSV) | **$0** |
| `market_top_skill` | opencode + Haiku 4.5 + WebSearch | costs |
| `bubble_skill` | opencode + Haiku 4.5 + WebSearch | costs |
| DefensiveProphet agent itself | preflight skips every beat; pure Go scheduler | **$0** |

Only 2 of the 4 skills spend anything, both on Haiku. The agent's own LLM never wakes. Exact spend is not recoverable from `data/reports/cost_*.md` because the cost store records only agent beats, not scheduler jobs — those reports show Coil alone at ~$0.15/day.

`regime_gate.json`'s only live consumer is Defensive-Prophet's arm/disarm, which reads `Score` directly. Turtle's `applyGates` and Prophet's preflight both read `BlockNewEntries`, which `buildStatus` hard-forces to `false` while `ENABLE_REGIME_GATE=false` — inert. Coil uses its own SPY-vs-SMA200 bear flag; Drift's "regime" is earnings BMO/AMC timing. Neither touches this file.

So the chain feeds exactly one consumer, that consumer was broken, and the spend is small and mostly free. Repairing the consumer is the higher-value move than retiring a hedge that was never given the chance to run — and it converts an unmeasured sleeve into a measurable one on the Foundation B BALLAST track. Retirement remains available later, on data rather than on a bug.
