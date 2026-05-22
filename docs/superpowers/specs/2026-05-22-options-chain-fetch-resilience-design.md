# Options-Chain Fetch Resilience — Design

**Date:** 2026-05-22
**Status:** Draft for review
**Author:** Harvest 429-storm diagnosis follow-up
**Scope owner decisions captured:** moderate retry budget (2 retries + Retry-After), hybrid throttle via shared rate limiter (not bare semaphore), bar-fetcher rate contention in scope, 429 status passthrough.

---

## 1. Background

During a Harvest heartbeat on 2026-05-22, the options-chain fetch path returned
persistent errors for QQQ, IWM, TLT (put-side) and for all call-side queries
including SPY and GLD. SPY otherwise qualified for an iron-condor entry
(IVR=100, IV 20.6% > RV 10.2%), so a genuinely qualifying trade was skipped.

The agent's fail-closed behavior was **correct** — no half-built condor was
entered on bad data. The problem is entirely in the infrastructure beneath it.
Three distinct defects compound:

1. **No admission control on Alpaca's account-wide data-API rate limit.**
   The raw Go log shows `HTTP 429 "too many requests"` on *both* the
   options-chain snapshots endpoint **and** concurrent daily-bar fetches
   (`[go:4536]` fetching SPGI, BKNG, …). Every data caller — the marketdata SDK
   bar path (`AlpacaDataService.GetHistoricalBars`/`GetMultiBars`) and the raw
   HTTP options-chain path (`AlpacaTradingService.GetOptionsChain`) — shares one
   Alpaca **account-level** rate budget, but nothing coordinates request rate
   across them. The agent also fired five underlyings' chains (plus call-side)
   *in parallel* in one beat, a self-inflicted burst.

2. **No retry on the options-chain path.** `GetOptionsChain`
   (`services/alpaca_trading.go:456-464`) does a single bare `httpClient.Do`
   with no retry/backoff. Order placement, by contrast, is protected by
   `placeOrderWithRetry` + `isTransientBrokerError` (`alpaca_trading.go:114,129`),
   and the bar path retries via the marketdata SDK's built-in `RetryLimit=3`.
   The options-chain path is the only major fetch with zero recovery, so a
   single transient 429 = immediate hard fail for the whole beat.

3. **429 is mislabeled as 500.** `controllers/order_controller.go:691` maps
   **every** `GetOptionsChain` error to `c.JSON(500, ...)`. A rate-limit
   (429) reaches the agent as "HTTP 500", so its operator note recommended
   *"investigate the broker options data feed"* — a phantom-outage hunt for what
   was actually self-inflicted throttling.

### Relationship to prior work

Commit `1ec6b6a` ("Decouple intraday Alpaca client from the shared client
bound") deliberately split the Alpaca clients so the latency-critical
intraday-signals path (deadline-bounded to 2500ms partial return) is isolated
from heavy batch callers. That work governs **per-request timeout/retry
budgets** — a *latency-isolation* axis. The rate limiter introduced here governs
**request admission rate** — an orthogonal *rate-coordination* axis. The two are
complementary; this design must not re-couple what `1ec6b6a` decoupled, which is
why the intraday client stays exempt from the shared limiter (§4.1).

---

## 2. Goals / Non-goals

### Goals
- Add process-wide admission control so the bar path and options-chain path
  draw from one smoothed Alpaca data-API rate budget and stop colliding.
- Add bounded retry-on-429 (with `Retry-After`) to the options-chain path.
- Stop mislabeling 429 as 500 so the agent can distinguish "back off" from
  "feed down".
- Preserve the intraday client's latency isolation from `1ec6b6a`.
- Zero behavior change for existing unit tests / stub call sites (limiter
  defaults to no-op when not injected).

### Non-goals
- Tuning *which* agent runs the SPGI/BKNG universe bar loop, or whether it
  should run during a Harvest beat. That is a scheduling-coordination question,
  separate from making the fetch paths rate-safe. Flagged as a follow-up.
- Metering the intraday-signals path through the limiter (it stays exempt;
  see §4.1).
- Any change to Harvest's strategy rules or fail-closed logic — that behaved
  correctly.

---

## 3. Architecture overview

Three layers, attacking three points on the failure chain:

```
                     ┌─────────────────────────────────────────┐
                     │   Shared Alpaca data-API rate limiter    │  Layer 1
                     │   (token bucket, account-wide, injected) │  admission
                     └───────────────┬───────────────┬─────────┘
                                     │ Wait(ctx)      │ Wait(ctx)
        ┌────────────────────────────┘                └───────────────────────┐
        ▼                                                                       ▼
  AlpacaDataService                                              AlpacaTradingService
  GetHistoricalBars / GetMultiBars                               GetOptionsChain
  (SDK RetryLimit=3 handles recovery)                            (no retry today)  ── Layer 2: add
                                                                       │              retry-on-429
                                                                       ▼              + Retry-After
                                                                 OrderController
                                                                 .GetOptionsChain
                                                                 maps err→500  ──────  Layer 3: pass
                                                                                       429 through

  IntradayAlpacaDataService ── EXEMPT from limiter (latency isolation, per 1ec6b6a)
```

---

## 4. Detailed design

### 4.1 Layer 1 — Shared rate limiter (admission control)

**Why a rate limiter, not a semaphore.** A semaphore caps concurrency; Alpaca
measures *rate*. Two requests every millisecond stay under any reasonable
concurrency cap yet still trip 429. A token bucket caps the dimension Alpaca
actually enforces, and naturally smooths a burst into a compliant stream — so it
subsumes the concurrency-cap behavior without a separate semaphore.

- Use `golang.org/x/time/rate` (currently transitive in `go.sum`; promote to a
  direct dependency in `go.mod` via `go get golang.org/x/time/rate`).
- Construct **one** `*rate.Limiter` in `cmd/bot/main.go` before the services
  (before line 52), and **inject the same instance** into:
  - `NewAlpacaTradingService` (line 52) — for `GetOptionsChain`.
  - `NewAlpacaDataService` (line 63) — for `GetHistoricalBars` / `GetMultiBars`.
- Each governed fetch calls `limiter.Wait(ctx)` before issuing its HTTP request.
  `Wait` respects the caller's context deadline, so a throttled request fails
  with the context error rather than blocking unbounded.
- **Sizing:** new env var `ALPACA_DATA_RATE_PER_MIN`, default **180/min**
  (≈3/sec), leaving headroom under the Alpaca Basic plan's 200/min account
  limit. Burst **10**. Operators on Algo Trader Plus (10,000/min) can raise it.
  The default is intentionally conservative; mis-setting it high only restores
  today's behavior, never worse.
- **No-op default:** the injection seam accepts a nil/absent limiter and
  substitutes an effectively-unlimited limiter (`rate.Inf`). Every existing unit
  test, stub, and non-`main.go` construction path is therefore unchanged — the
  cap activates only at the production wiring point.

**Intraday exemption.** `IntradayAlpacaDataService` (constructed at
`main.go:469`) is **not** injected with the limiter. It is deadline-bounded
(2500ms partial return) and must never wait behind a heavy batch — that is
exactly the isolation `1ec6b6a` created. Its volume per beat is small and
bounded, and the 180/min cap (vs the true 200/min ceiling) leaves headroom to
absorb it. Trade-off accepted: the limiter slightly under-counts true account
rate by excluding intraday, which we compensate for with the conservative
default rather than by gating the latency-critical path.

### 4.2 Layer 2 — Retry on the options-chain path (recovery)

The limiter prevents most 429s; this recovers the occasional one that slips
through (other processes sharing the account, burst overrun, transient 5xx).

- Wrap the `GetOptionsChain` HTTP call in a retry helper that reuses the
  existing `isTransientBrokerError` classifier (`alpaca_trading.go:114` —
  already treats `http 429` and `http 5xx` as transient, 4xx as fail-fast).
- **Budget:** up to **2 retries**, exponential backoff **250ms → 500ms**. When
  the 429 response carries a `Retry-After` header, honor it instead of the
  fixed backoff, **capped at 2s** per wait. Worst case ≈ 2 × 2s + fetch latency,
  comfortably inside the controller's existing 30s context timeout
  (`order_controller.go:685`).
- This requires reading the response (status + `Retry-After`) inside
  `GetOptionsChain` so the retry decision and wait duration are available; the
  current code already inspects `resp.StatusCode`.
- Bars are **not** changed here — the SDK's built-in `RetryLimit=3` already
  provides equivalent recovery on that path.

### 4.3 Layer 3 — 429 status passthrough

- In `OrderController.GetOptionsChain` (`order_controller.go:689-692`), when the
  returned error is a 429-class error (detect via the same transient/`429`
  string check, or a sentinel error type — see §6), respond with **HTTP 429**
  and a message that names it as transient/rate-limited, echoing `Retry-After`
  when known. All other errors continue to return **HTTP 500**.
- Effect: the MCP/agent tool layer surfaces "429 / rate limited / retry" instead
  of "status code 500", so the agent stops writing misleading
  "investigate the data feed" operator notes.

---

## 5. Testing

TDD — tests written first, all Go via `go test ./...`.

- **Layer 1 (limiter):**
  - Injecting a fake limiter/recorder asserts a token is acquired before the
    HTTP fetch on both `GetOptionsChain` and `GetHistoricalBars`.
  - A nil/absent limiter defaults to no-op (`rate.Inf`) — existing call sites
    and stubs behave identically (regression guard).
  - Extend the `alpaca_data_test.go` decoupling tests to assert the intraday
    constructor path is **not** wired to the shared limiter.
- **Layer 2 (retry):** table test on the retry helper —
  - 429-then-success recovers within budget.
  - A 4xx validation error fails fast with no retry.
  - `Retry-After` is honored and capped at 2s.
  - Total retries never exceed 2. Mirrors `alpaca_trading_test.go:71` style.
- **Layer 3 (status):** controller test —
  - A 429-class error from the trading service yields HTTP 429 + `Retry-After`.
  - A non-transient error still yields HTTP 500.

---

## 6. Open implementation detail (resolve during planning)

How Layer 3 detects "this error was a 429" is currently a brittle string match
on the error text. Two options to decide in the plan:
- **(a)** Reuse the existing `isTransientBrokerError` string check (cheapest,
  consistent with current code, but couples on message format).
- **(b)** Introduce a small typed/sentinel error (e.g. `ErrRateLimited`
  wrapping the status code) returned by `GetOptionsChain`, matched via
  `errors.Is` in the controller (cleaner, slightly more surface).

Recommendation: **(b)** — it makes both Layer 2's retry decision and Layer 3's
status mapping key off a structured signal rather than a fragile string, at the
cost of one new error type. Final call deferred to the implementation plan.

---

## 7. Out of scope (deliberately)

- Scheduling coordination of the SPGI/BKNG universe bar loop relative to Harvest
  beats (§2 non-goals).
- Any rate coordination across *separate Alpaca accounts/keys* — assumes a
  single account key, which is the current deployment.
