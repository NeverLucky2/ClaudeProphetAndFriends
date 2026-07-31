# Defensive-Prophet option-chain fetch repair (silent-dead-hedge fix)

- **Date:** 2026-07-31 (revised after a fresh-eyes review that found two further fatal defects)
- **Status:** Design approved (awaiting spec review)
- **Component:** `services/alpaca_options_data.go`, `services/prophet_hedge_executor.go` (`pickExpiry`), `cmd/bot/main.go` (3 constructor call sites)
- **Flag:** none (repairs an always-broken code path; ships on). `ENABLE_PROPHET_DEFENSIVE` is already `true` in the real `.env`, so the hedge goes live at the first 17:00 ET heartbeat after the rebuild.
- **Related:** [[defensive-prophet-project]] (the agent this unblocks), `docs/superpowers/specs/2026-06-01-defensive-prophet-design.md` (original design), [[foundation-measurement-lifecycle-status]] (the BALLAST track that will finally receive data), [[deploy-binary-staleness-trap]] (the rebuild step this fix depends on), [[fleet-uncorrelated-ballast-pivot]] (why the hedge exists at all).

## Problem

Defensive-Prophet has been enabled since **2026-06-08** and has opened **zero** put-debit spreads in 52 calendar days. `prophet_hedge_spreads` has 0 rows.

This is not the strategy declining to fire. The Go scheduler is alive — `prophet_hedge_session` records daily 17:00 ET heartbeats through 2026-07-29 — and the hedge has been **armed** essentially the whole time: the regime gate reads score **39** / tier `DEFENSIVE` against an arm threshold of 50 (`hedgeArmThreshold`), and breadth has been pinned at 22–27 for weeks, which holds the composite well under 50.

The hedge is armed and failing silently, in four separate places on one code path.

## The four defects

All were verified live against the account's own credentials on 2026-07-31. **Three are independently fatal, and the fourth becomes fatal as soon as the first is fixed** — so no subset of these fixes produces a single placed order. This is why 52 days of daily heartbeats produced nothing but plausible-sounding skip messages.

### Defect 1 — contracts fetched from the wrong host (fatal)

`AlpacaOptionsDataService.GetOptionChain` (`alpaca_options_data.go:156`) builds its URL from `baseURL = "https://data.alpaca.markets"`:

```
https://data.alpaca.markets/v1beta1/options/contracts?underlying_symbols=QQQ&expiration_date=…
```

| Host | Response |
|---|---|
| `data.alpaca.markets/v1beta1/options/contracts` (what the code calls) | **HTTP 404** `{"message":"Not Found"}` |
| `paper-api.alpaca.markets/v2/options/contracts` (correct) | 200, full QQQ chain |

The contracts endpoint lives on the **trading** API, not the data API. `pickExpiry` (`prophet_hedge_executor.go:383`) probes the chain *before* pricing anything, so every heartbeat dies there and records `"no monthly expiry in DTE band"` — a message that reads like a legitimate calendar outcome, which is why this went unnoticed for 52 days.

`GetOptionSnapshot` is **not** affected: `/v1beta1/options/snapshots` genuinely is a data-API endpoint and returns HTTP 200 with live quotes and greeks (verified). It must stay on the data host.

### Defect 2 — `pickExpiry` probes one exact date against a range-shaped requirement (fatal)

```go
probe := now.Add(time.Duration((p.DTEMin+p.DTEMax)/2) * 24 * time.Hour)  // now + 52 days
chain, err := e.chain.GetOptionChain(ctx, "QQQ", probe)
```

`GetOptionChain` queries `expiration_date=<exact date>`, so the returned chain contains **only that single date**. The loop that follows — scanning for any expiry with DTE in [45, 60] — can therefore only ever return the probe date itself. It cannot scan a band, despite the skip message claiming it does.

At 45–60 DTE only **monthlies** are listed; weeklies are not listed that far out. Measured for the current band (2026-09-14 … 2026-09-29):

| Expiry | Weekday | DTE | Contracts |
|---|---|---|---|
| **2026-09-18** | Fri (3rd Friday) | 49 | **518** |
| *every other date in the band* | — | — | **0** |

Today's probe date is **2026-09-21 (Monday)** — 0 contracts. Also verified 0 on the 19th, 20th and 22nd. So `len(chain) == 0` → `pickExpiry` returns false → skip.

Because the band holds exactly one listed expiry, `now + 52 days` coincides with a tradable date roughly **1 day in 30**. Fixing Defect 1 alone would leave the hedge dead on ~97% of days, with the same misleading skip message.

### Defect 3 — string-typed numerics (fatal once Defect 1 is fixed)

Alpaca returns `strike_price: "654"` and `open_interest: "4669"` as JSON **strings**. `AlpacaOptionChainContract` (`alpaca_options_data.go:87-95`) declares them `float64` and `int64`, so `json.NewDecoder(...).Decode()` fails outright and `GetOptionChain` returns an error even against the correct host.

### Defect 4 — pagination ignored; page 1 contains no puts at all (fatal once 1 and 3 are fixed)

The endpoint pages at 100 results and the code ignores the `next_page_token` it already declares (`alpaca_options_data.go:83`). The code sends **no `type` filter**, and Alpaca returns calls first. Measured for QQQ 2026-09-18 exactly as the code requests it:

| Request | Total returned | Puts included | `next_page_token` |
|---|---|---|---|
| default page (what the code sends) | 100 | **0** | `"MTAw"` |
| `limit=10000` | 518 | 259 (strikes 205–1100) | `null` |

Page 1 is **entirely calls**. `nearestPut` therefore returns `nil` for both legs, `pickPutStrikes` returns `ok=false`, and the hedge skips with `"no valid strike pair (degenerate chain)"`.

This was originally written up as a latent correctness risk — silent strike clamping as QQQ rises. That understated it: **it is a hard blocker today.** The clamping risk is real too, but secondary.

## Goals

- Defensive-Prophet can locate a valid expiry, read a complete correctly-typed chain, and place its hedge.
- Chain truncation can never silently produce a wrong or empty strike selection.
- A single malformed contract degrades that one contract, not the whole chain.
- The contracts host follows whichever Alpaca account a sandbox is configured against (paper or live), not a hardcoded assumption.

## Non-goals

- **No strategy or tuning changes.** `hedgeArmThreshold`, `hedgeDebitCapPct`, the OTM percentages, DTE band, harvest/roll thresholds all stay exactly as pre-registered.
- **No removal of the four morning regime skills.** They were the original subject of this investigation; the conclusion is that they stay (see "Cost finding").
- Not repairing `FindOptionsNearDTE` beyond the shared host/type/paging fix it inherits — it has no live callers, so it gets no dedicated tests.
- No new env flags, no new DB tables, no change to the hedge lifecycle or the arm/disarm rule.

## Design

### 1. Split the two base URLs

`AlpacaOptionsDataService` gains a second host field. The two endpoint families genuinely live on different hosts and must not share one:

| Method | Host | Path |
|---|---|---|
| `GetOptionSnapshot` | `data.alpaca.markets` (unchanged) | `/v1beta1/options/snapshots` |
| `GetOptionChain` | **trading host** (new) | `/v2/options/contracts` |
| `GetOptionChainRange` (new) | **trading host** | `/v2/options/contracts` |
| `FindOptionsNearDTE` | **trading host** (new) | `/v2/options/contracts` |

The constructor becomes `NewAlpacaOptionsDataService(apiKey, secretKey, tradingURL string)`, fed `cfg.AlpacaBaseURL` at all three call sites in `cmd/bot/main.go` (`:494` hedge, `:522` vertical, `:567`). `cfg.AlpacaBaseURL` already exists (`config/config.go:142`), defaults to `https://paper-api.alpaca.markets`, and honors `ALPACA_BASE_URL` / `ALPACA_ENDPOINT` — so a sandbox pointed at a live account gets the live contracts host automatically. An empty `tradingURL` falls back to the paper default rather than producing a malformed URL.

### 2. Add a date-range chain fetch, and use it in `pickExpiry`

New method on the service and on the executor's `hedgeChainProvider` interface (`prophet_hedge_executor.go:24`):

```go
GetOptionChainRange(ctx context.Context, underlying string, gte, lte time.Time) (map[string]*interfaces.OptionContract, error)
```

It issues `expiration_date_gte` / `expiration_date_lte` — the shape `FindOptionsNearDTE` already demonstrates (`alpaca_options_data.go:223`), which is dead code today but had the right idea.

`pickExpiry` switches from a single-date probe to a band query over `[now+DTEMin, now+DTEMax]` and keeps its existing selection loop unchanged. `openNew` continues to call the exact-date `GetOptionChain` for the chosen expiry — that call is correct and wants exactly one expiry's chain.

**One deliberate behavior change, flagged for veto.** The existing loop picks the *minimum* DTE in band. Once the range query works, a thin weekly listed at DTE 46 would be selected over the liquid monthly at DTE 49. For a 45–60 DTE tail hedge that will be rolled and harvested, and whose short leg is *not* covered by the spread gate (see below), that is a real liquidity hazard. `pickExpiry` will therefore **prefer a third-Friday monthly in band, falling back to the nearest in-band expiry when none exists** — which is what the function's own skip message ("no monthly expiry in DTE band") has always claimed to do. Empirically this is a no-op today, since only monthlies list at this horizon. Say the word and I will drop it and keep pure min-DTE.

### 3. Parse string-typed numerics

`strike_price` and `open_interest` are redeclared as `string` and parsed with `strconv`. Parsing is **per contract**: a contract whose strike does not parse is skipped with a debug log and the rest of the chain is returned. A contract whose `open_interest` does not parse keeps a zero OI and is retained — strike is load-bearing for `pickPutStrikes`, OI is informational on this path.

### 4. Follow pagination

Request `limit=10000` **and** loop on `next_page_token`, merging pages until the token is empty. A bounded page cap (20 iterations) prevents an unterminated token loop from hanging the 17:00 ET heartbeat.

**No `type=put` filter is added.** It would mask Defect 4 rather than fix it, and `GetOptionChain` must stay generic — the debit-verticals sleeve needs calls from the same method. `nearestPut` already filters on `ContractType`, so correct paging is the real fix.

## Verified: no remaining blockers downstream

Both `TradeGuard` gates that `openNew` must clear are enabled in the real `.env`, and both pass:

| Gate | Config | Status |
|---|---|---|
| Universe allowlist | `ENABLE_PROPHET_UNIVERSE_GATE=true` | **passes** — QQQ is line 15 of the 77-name `config/prophet_tradable_universe.txt` |
| Options spread | `ENABLE_PROPHET_OPTIONS_SPREAD=true`, cap 10% of mid | **passes** — long leg bid/ask is 3.5% of mid |

Two observations, neither changed here: the guard is applied only to the **long** leg, so the short leg's liquidity is unchecked (part of the rationale for the monthly preference above); and the executor stamps the quote `Timestamp: now` rather than the snapshot's own timestamp, so the staleness check can never fire.

## Expected first trade

Live Alpaca data, 2026-07-31, simulating the executor's own path (`selectStructure` → `nearestPut` → snapshot mids → `sizeSpread`):

| Quantity | Value |
|---|---|
| QQQ spot | 688.76 |
| Long put (5% OTM target 654.32) | **654P** — bid 11.01 / ask 11.40, mid 11.205 |
| Short put (15% OTM target 585.45) | **585P** — bid 3.02 / ask 3.13, mid 3.075 |
| Expiry | 2026-09-18 (DTE 48, inside the 45–60 band) |
| Width | $69 |
| Net debit | $8.13/sh = **$813/contract** |
| 1% cap on $108,292 portfolio | **$1,083** |
| `sizeSpread` result | **1 contract** (24.9% headroom) |
| Max payoff | **$6,900** |

**Ramp:** `openNew` opens at most one spread per heartbeat and `hedgeMaxConcurrent` is 3, so the hedge reaches full size over three armed sessions — roughly $2.4k of debit, ~2.3% of portfolio, against ~$20.7k of max payoff.

**Watch item, not changed:** headroom under the debit cap is ~25% at current pricing. A sharp IV expansion — exactly the regime this hedge is meant to catch — raises the debit and can flip `sizeSpread` to 0, skipping with `"armed but unaffordable"`. `hedgeDebitCapPct` is a pre-registered paper-phase constant; revisiting it is a strategy decision for a separate cycle. Worth watching once rows start appearing.

## Testing

Go unit tests against `httptest` servers, in `services/alpaca_options_data_test.go`:

1. **String numerics decode** — `strike_price: "654"` yields `654.0`; `open_interest: "4669"` yields `4669`.
2. **Pagination merge** — a two-page fixture returns the union of both pages.
3. **Puts survive paging** — a fixture whose first page is entirely calls and whose second page holds the puts yields a chain containing puts. This is the direct regression test for Defect 4.
4. **Page cap** — a server that always returns a token terminates at the cap rather than looping forever.
5. **Host routing** — contracts requests arrive at the trading-host server and snapshot requests at the data-host server; a snapshot call never hits the contracts path.
6. **Range query shape** — `GetOptionChainRange` emits `expiration_date_gte`/`expiration_date_lte`, not `expiration_date`.
7. **Malformed contract tolerated** — a chain with one unparseable `strike_price` returns the remaining contracts rather than an error.
8. **Non-200 propagates** — a 404 still returns an error, guarding against a regression that swallows the very failure mode this spec exists to fix.

In `services/prophet_hedge_executor_test.go`:

9. **`pickExpiry` selects from a band** — a stub returning several in-band expiries picks the third-Friday monthly, and picks the nearest in-band date when no monthly is present.
10. **Empty band still skips cleanly** — no panic, returns `ok=false`.

`hedgeStubChain` gains the new `GetOptionChainRange` method. The existing `prophet_hedge_*_test.go` suite must stay green — it uses stubs throughout, which is precisely why it never caught any of these four defects. **Every one of them lives in the transport layer that the stubs replace**, which is the structural lesson here: the hedge had thorough logic tests and zero integration coverage.

## Deploy and verification

1. `go build -o prophet_bot.exe ./cmd/bot` — **forced**. Restarting Node alone will not rebuild: `_ensureBinary` only builds when the binary is absent, so a stale `prophet_bot.exe` would silently redeploy the broken code ([[deploy-binary-staleness-trap]]).
2. Restart Node so the orchestrator re-spawns the DefensiveProphet sandbox bot.
3. Confirm the boot log line `Defensive-Prophet hedge scheduler started (ENABLE_PROPHET_DEFENSIVE=true)`.
4. After the next 17:00 ET heartbeat, confirm a row in `prophet_hedge_spreads` in `data/sandboxes/sbx_565f5239/prophet_trader.db`.

Step 4 is the real acceptance test: a row appearing is the first proof in 52 days that the hedge can execute end-to-end. Until it appears, treat the repair as unverified — every one of these four defects produced a confident-looking skip message rather than an error.

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

So the chain feeds exactly one consumer, that consumer was broken in four places, and the spend is small and mostly free. Repairing the consumer is the higher-value move than retiring a hedge that was never given the chance to run — and it converts an unmeasured sleeve into a measurable one on the Foundation B BALLAST track. Retirement remains available later, on data rather than on a bug.
