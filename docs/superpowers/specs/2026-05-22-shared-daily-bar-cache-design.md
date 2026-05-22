# Shared Daily-Bar Cache — Design

**Date:** 2026-05-22
**Status:** Draft — rev. 2 (draft review incorporated)
**Author:** Cross-agent 429-storm follow-up (sub-project 1 of 3)
**Scope owner decisions captured:** single shared Alpaca account on the free IEX tier (intentional — mirrors eventual real-money setup); Option 2 first (shared cache), Option 1 sidecar deferred; single 5-min TTL (open/closed split dropped per draft review); candidate-warmer gating to the consuming agents (Coil/Drift) **in scope**, fetch staggering deferred; file-per-key on-disk cache, soft-fail.

---

## 1. Background

Every agent (Prophet, Harvest, Turtle, Coil, Drift, PennyProphet) runs as a
**separate `prophet_bot` OS process**, spawned per sandbox by
`agent/orchestrator.js:196`, each on its own port. The `[go:4535]` / `[go:4536]`
prefix in the operator logs is the **port** (`orchestrator.js:213`), not a PID —
so those parallel log streams are independent bots.

All of these bots authenticate with **one shared Alpaca account** on the free
IEX data tier (≈200 requests/min, enforced **account-wide**). The orchestrator
injects the same `account.publicKey`/`secretKey` into every bot
(`orchestrator.js:180`), and the v4→v5 config migration deliberately dedups
sandboxes onto a shared account (`config-store.js:650`). The single account is
an intentional choice — it mirrors the single real-money account the operator
will use after paper.

The operator's logs show a sustained `HTTP 429 "too many requests"` storm on the
daily-bar path across multiple bots simultaneously, with the **same symbols**
(DIS, TXN, NEE, INTU, AMGN, IBM, PM, …) fetched by Prophet (`go:4535`) and
Harvest (`go:4536`) within **seconds** of each other.

### Root cause

The recent options-chain-resilience work (commit `5541598`, spec
`2026-05-22-options-chain-fetch-resilience-design.md`) added a token-bucket rate
limiter (`services/rate_limiter.go`, `ALPACA_DATA_RATE_PER_MIN`, default
180/min). That limiter is correct, but it lives **in each process's memory**.
With N bots each self-capping at 180/min against **one** account, the combined
rate is up to N × 180/min — three bots already blow the ≈200/min account
ceiling, guaranteeing 429s. The per-process limiter cannot see the other
processes, so it cannot coordinate the shared budget.

Compounding it: most of those calls are **redundant**. The candidate-cache
warmer is started **unconditionally in every bot** —

```go
// cmd/bot/main.go:524
go services.RunCandidateCacheWarmer(ctx, services.CandidateCacheWarmInterval,
    logger, meanRevCandidatesSvc, driftCandidatesSvc)
```

— and it recomputes the Coil + Drift candidate lists over the same curated S&P
large-cap universe on a sub-5-minute interval. Each recompute walks the universe
one symbol at a time via `GetHistoricalBars(..., "1Day")`
(`trend/meanrev/drift_signal_service.go`). So all six bots independently re-fetch
**identical** daily bars for the same symbols every few minutes. The duplication
is the bulk of the traffic, and it is what the logs show.

### Relationship to prior work

The options-chain-resilience spec explicitly deferred two things to a follow-up
(its §2 non-goals and §7 out-of-scope): "**which** agent runs the universe bar
loop … a scheduling-coordination question", and "any rate coordination across
*separate* … keys — assumes a single account key". **This spec is that
follow-up.** It keeps the per-process limiter as-is (a backstop) and attacks the
problem from the volume side: if the redundant fetches collapse to one upstream
call shared across bots, N processes comfortably fit under the account budget
without any cross-process limiter.

This is **Option 2** of the three approaches weighed with the scope owner. The
**Option 1 sidecar** (a single process owning the Alpaca connection + a
genuinely account-wide limiter + in-flight de-duplication) remains the
principled end state and is deferred to a separate sub-project. Option 2 buys
most of that relief for a fraction of the work and is a clean stepping stone:
the cache surface defined here is the same surface a sidecar would later own.

---

## 2. Goals / Non-goals

### Goals
- Collapse redundant cross-agent daily-bar fetches to one upstream Alpaca call
  per (symbol, timeframe, day-window), shared across all bot processes.
- Bring the combined account-wide data rate back under the free-tier ceiling
  during normal operation, eliminating the 429 storm.
- Stop the four non-consuming bots from running the candidate warmer at all, and
  warm only the *one* cache each consuming bot reads — cutting per-cycle warm
  operations from 12 (6 bots × meanrev+drift) to 2, which removes the dominant
  source of redundant sweeps at its root (§4.8).
- Soft-fail by construction: the cache can never break or block a fetch. Any
  miss / stale / corrupt / unreadable entry degrades to today's direct-fetch
  behavior.
- Zero behavior change for existing unit tests and stub call sites (the cache is
  a decorator over the shared data service; consumers see the same interface).
- Preserve the intraday client's latency isolation (commit `1ec6b6a`): the
  intraday path is **not** routed through the cache.

### Non-goals
- A cross-process / account-wide **rate limiter**. That is the Option 1 sidecar;
  this spec reduces *volume*, not coordinates *admission*. The per-process
  limiter stays as the backstop.
- Caching **intraday** bars (1Min/5Min/…). They churn within a session and the
  intraday-signals path is deliberately isolated on its own client.
- Fetch **staggering** / jitter on cold start. With the warmer gated (§4.8) the
  cold-start overlap shrinks to two bots and is cache-dedup'd, so staggering is
  deferred (§7); the Option 1 sidecar is the principled full fix for any residual
  cold-start overlap.
- The FMP shared-budget problem (sub-project 3) and the log-routing UI change
  (sub-project 2). Tracked separately.

---

## 3. Architecture overview

A single decorator, `SharedBarCache`, wraps the shared `*AlpacaDataService`. It
implements `interfaces.DataService` by forwarding every method straight through,
intercepting only the two bar methods. It is wired **once** in `main.go`; the
intraday service is constructed separately and never wrapped.

```
   consumers (trend, meanrev, drift, realized-vol, stock-analysis,
   sector, penny-max-filter, penny avg-vol, order ctrl bars endpoint)
                              │  interfaces.DataService
                              ▼
                   ┌──────────────────────────┐
                   │      SharedBarCache       │   cache GetHistoricalBars +
                   │  (decorator, on disk)     │   GetMultiBars for tf >= 1Day;
                   └─────────────┬─────────────┘   forward everything else
                  cache hit ◄────┤ (file-per-key, mtime TTL, atomic write)
                                 │ miss / stale / corrupt  → fetch + store
                                 ▼
                        AlpacaDataService  ── per-process rate limiter (backstop, unchanged)
                                 │
                                 ▼
                          Alpaca IEX data API   (shared account budget)

   IntradayAlpacaDataService ── NOT wrapped (latency isolation, per 1ec6b6a)
```

The cache directory lives at a **shared, non-per-sandbox** path
(`<projectRoot>/data/bar-cache/`). All bots run with `cwd = projectRoot`
(`orchestrator.js:197`), so a project-relative path resolves to the same
directory for every process — that shared directory is what makes the cache
cross-agent.

---

## 4. Detailed design

### 4.1 The decorator and its seam

```go
type SharedBarCache struct {
    underlying interfaces.DataService // the rate-limited *AlpacaDataService
    dir        string                 // shared cache dir, resolved to an absolute path (§4.5)
    ttl        time.Duration          // single freshness window (§4.6)
    clock      func() time.Time       // injectable; prod = time.Now
    logger     *logrus.Logger
}

func NewSharedBarCache(underlying interfaces.DataService, dir string,
    ttl time.Duration) *SharedBarCache
```

- It satisfies `interfaces.DataService`. `GetLatestBar`, `GetLatestQuote`,
  `GetLatestTrade`, and `StreamBars` forward verbatim to `underlying`.
- Only `GetHistoricalBars` and `GetMultiBars` consult the cache.
- `underlying` is an **interface**, not the concrete `*AlpacaDataService`, so
  tests inject a call-counting fake. (The existing `BarFetcher`,
  `MultiBarsFetcher`, `rvDataSource`, etc. consumer interfaces are all subsets of
  `interfaces.DataService`, so the decorator drops into every current wiring
  site — verified at plan time against each constructor signature.)

### 4.2 What is cached, and what bypasses

- **Cached:** timeframes `1Day`, `1Week`, `1Month`.
- **Bypassed (pass straight through, no cache):** every sub-daily timeframe
  (`1Min`, `5Min`, `15Min`, `30Min`, `1Hour`, `4Hour`). The decorator branches on
  timeframe at entry; sub-daily calls are indistinguishable from today.
- The intraday-signals service is wired from `NewIntradayAlpacaDataService`
  (`main.go:480`) and is never handed the decorator, so its isolation is
  structurally preserved regardless of the timeframe branch.

### 4.3 Cache key and normalization

Every `1Day` caller in the codebase passes `end = time.Now()` and
`start = now − N days` (`trend_signal_service.go:64`, `meanrev_signal_service.go:120`,
`drift_signal_service.go:609`, `realized_vol_service.go:50`,
`stock_analysis_service.go:161`, `stock_analysis_sector.go:93`,
`penny_intraday.go:116`, `penny_max_filter.go:77`). The raw timestamps are
therefore unique on every call (sub-second drift), so the key **must** normalize
to calendar-date granularity or it will never hit.

```
key = (symbol, timeframe, startDate, endDate)
        startDate = start.In(ET).Format("2006-01-02")
        endDate   = end.In(ET).Format("2006-01-02")
filename = sanitize("{symbol}_{timeframe}_{startDate}_{endDate}") + ".json"
```

Normalizing to the Eastern **trading date** means two callers requesting the
same window on the same day collapse to one key. The candidate warmer running
identically across the consuming bots is the dominant case, and it collides
perfectly: same code path, same lookback constant, same day → one key → one
upstream fetch.

Different lookbacks (e.g. trend's `barLookbackDays` vs realized-vol's
`lookback × 2`) produce different keys and cache independently. That is accepted
for v1 — the cross-agent win does not depend on cross-consumer key sharing. A
"fetch-generous-window-and-slice" superset optimization (one big entry per
symbol/day, sliced to each caller's window) is a possible later refinement and a
natural fit for the Option 1 sidecar; out of scope here.

### 4.4 Per-symbol entries; GetMultiBars decomposition

Entries are stored **per symbol**, not per request blob, so single- and
multi-symbol paths share one entry format:

- `GetHistoricalBars(symbol, …)`: look up `(symbol, tf, window)`; on hit return
  it; on miss fetch via `underlying`, store, return.
- `GetMultiBars(symbols, …)`: look up each symbol's entry; collect the misses;
  issue **one** batched `underlying.GetMultiBars` for just the misses; store each
  returned symbol; merge cached + freshly-fetched into the result map.

This keeps `GetMultiBars`'s existing partial-result semantics (missing symbols
simply absent) and means a warm cache can serve a multi-call with **zero**
upstream requests. A symbol that legitimately has no data stays a per-call miss
(not cached as empty) — a minor, accepted inefficiency for v1.

### 4.5 Storage: file-per-key, atomic, soft-fail

- One small JSON file per key under the shared cache dir. Payload: the bar slice
  plus a stored copy of the key fields (for debuggability) — freshness is judged
  by the file's **mtime**, not an embedded timestamp, so a write is the clock.
- **Resolved, absolute, logged.** The entire cross-agent benefit rests on all
  bots resolving the cache dir to the *same* directory. The dir is resolved to an
  **absolute** path at construction (`filepath.Abs`) and that absolute path is
  logged once per bot at startup, so the operator can confirm all six processes
  printed an identical path. If a sandbox ever gets a divergent `cwd` or an
  overlay/symlinked path, the cache silently degrades to per-process (still
  correct, zero benefit) — the startup log is the only early warning before the
  429 storm quietly returns.
- **Atomic write:** marshal → write to `…/<name>.<rand>.tmp` → `os.Rename` onto
  the final path. `os.Rename` replaces an existing target on Windows
  (MoveFileEx semantics), so a concurrent reader never observes a half-written
  file. **Windows sharp edge:** a rename onto a path another process currently
  holds open for reading can fail with a sharing violation (unlike POSIX).
  Readers open→read→unmarshal→close briefly, so this is rare, but with six
  processes on hot keys it is not "never" — a failed rename is explicitly in the
  soft-fail set (logged at debug; the freshly-fetched bars are still returned and
  the write is retried on the next call).
- **Concurrent cold-miss on the same key:** two bots both fetch and both write
  identical content; last-writer-wins, harmless. (Eliminating even that
  duplicate fetch requires cross-process in-flight de-duplication — the Option 1
  sidecar's job, explicitly out of scope.)
- **Soft-fail everywhere:** a missing file, an `mtime` past TTL, a JSON
  unmarshal error, or any read/stat error is treated as a **miss** → normal
  fetch. A write error is logged at debug and otherwise ignored (the fetched
  bars are still returned to the caller). The cache is incapable of failing a
  request — worst case it is a no-op and behavior reverts to today's.
- File-per-key sidesteps SQLite multi-writer lock contention on Windows and
  matches the repo's existing JSON-artifact idiom (`activity_logs/`,
  `decisive_actions/`, `.claude/reports/`).

### 4.6 TTL / freshness (the only correctness knob)

A daily bar for a **completed** trading day never changes; the only freshness
concern is the **still-forming current day's** bar. The precise correctness
invariant is: *an entry for `endDate` D may be treated as final only once D's
session has closed.* A single short TTL by `mtime` satisfies that invariant
without tracking session boundaries:

```
fresh = (now - mtime) < ttl        // ttl default 5 min (BAR_CACHE_TTL)
```

- Default **5 min**. The logged duplication clusters within seconds, so 5 min
  captures essentially all of it. A still-forming current-day bar is therefore
  at most ~5 min stale — immaterial for the daily-bar consumers, which act on
  *completed* bars (trend/meanrev/drift) or on 20+-day windows (realized vol)
  where one slightly-stale tail bar doesn't move the result.
- **Why a single TTL, not an open/closed split** (draft-review correction). An
  earlier draft used a long "market-closed" TTL to maximize overnight dedup.
  That is both unsafe and pointless here. *Unsafe:* every consumer passes
  `end = now`, so **every** entry has `endDate == today`; a partial bar captured
  at 15:58 ET would then be served as "final" for the entire closed window after
  16:00, silently. *Pointless:* the dominant fetcher — the candidate warmer — is
  a **no-op outside 09:00–17:30 ET** (`candidate_cache_warmer.go:33`,
  `ShouldWarmCandidates`), so there is no overnight rate pressure to optimize
  away. A single short TTL avoids the partial-as-final hazard entirely: entries
  expire and the next post-close fetch returns the genuinely final bar. (A longer
  TTL *only* for entries whose `endDate` session has already closed is a safe
  future optimization, but no current consumer requests a past `endDate`, so it
  is YAGNI for v1.) This removes the `phase`/`StaticMarketPhase` dependency from
  the freshness path.

### 4.7 Configuration and rollout

New config (`config/config.go`, documented in `.env.example`):

| Env | Default | Meaning |
|---|---|---|
| `BAR_CACHE_ENABLED` | `true` | Master switch. When false, `NewSharedBarCache` is skipped and the raw `dataService` is wired (today's behavior). |
| `BAR_CACHE_DIR` | `data/bar-cache` | Shared cache directory; resolved to an absolute path and logged at startup (§4.5). The orchestrator may optionally inject an explicit absolute `BAR_CACHE_DIR` into every bot's env to guarantee a shared path independent of `cwd`. |
| `BAR_CACHE_TTL` | `5m` | Single freshness window (§4.6). |

- Default **on**: this is a pure, soft-failing read optimization, not a
  trading-action feature, so it follows the "soft-fail cache" pattern rather
  than the default-OFF posture reserved for action-taking monitors.
- The per-process `ALPACA_DATA_RATE_PER_MIN` limiter is **unchanged** and stays
  wired as the backstop: the cache cuts volume, the limiter still smooths any
  uncached burst.
- Wiring in `main.go`: after `dataService.SetRateLimiter(...)`, construct
  `cachedData := services.NewSharedBarCache(dataService, …)` (when enabled) and
  pass `cachedData` wherever the shared `dataService` is passed today —
  **except** the intraday service. `os.MkdirAll(BAR_CACHE_DIR)` once at startup.

### 4.8 Candidate-warmer gating

`RunCandidateCacheWarmer` is launched unconditionally in every bot
(`main.go:524`) and warms **both** the meanrev and drift candidate caches. Yet
only two agents read those caches: the `mean-rev-rsi2` (Coil) preflight calls
`/api/v1/meanrev/candidates` and the `earnings-drift` (Drift) preflight calls
`/api/v1/drift/candidates` (`preflight.js:604-607` dispatches preflight by
`strategyId`; the candidate MCP tools are per-agent allowlisted to the same two
agents). The other four bots warm caches nothing reads — ~10 of every 12
per-cycle warm operations are pure waste, and those sweeps are the dominant
source of the redundant daily-bar fetches.

Gate it to exactly the consuming service on the consuming bot:

- Two env flags, set by the orchestrator from `strategyId` — the same pattern as
  `TURTLE_SCHEDULER_ENABLED` / `ENABLE_PENNY_PIPELINE` (`orchestrator.js:169-191`):
  - `ENABLE_MEANREV_WARMER=true` ⇔ `strategyId === 'mean-rev-rsi2'`
  - `ENABLE_DRIFT_WARMER=true`   ⇔ `strategyId === 'earnings-drift'`
- `main.go` builds the refresher slice from those flags — append
  `meanRevCandidatesSvc` iff the meanrev flag is set, `driftCandidatesSvc` iff the
  drift flag is set — and launches the warmer only when the slice is non-empty
  (the warmer already returns early on an empty slice,
  `candidate_cache_warmer.go:61`). Net: one meanrev sweep on Coil, one drift
  sweep on Drift, none elsewhere.

**Why this is safe (verified).** Gating is a *performance* gate, not a
correctness gate: the candidate endpoints compute on-demand on a cache miss
(exactly what the warmer pre-empts to stay inside preflight's 2s budget). A
mis-set flag therefore degrades to a slower cold scan that still returns correct
data and fails open — it can never serve wrong or empty candidates. And the read
paths are confirmed scoped: only `mean-rev-rsi2` and `earnings-drift` resolve a
candidate-reading preflight (`PREFLIGHT_REGISTRY`), and the candidate tools are
allowlisted to those two agents only.

**Interaction with the cache.** Gating cuts the *number* of universe sweeps
(6→1 meanrev + 1 drift); the shared cache then dedups the *overlap* between
Coil's and Drift's S&P large-cap universes plus the residual analysis /
realized-vol fetches across all agents. Together they remove the steady-state
duplication and most of the cold-start burst — only two bots sweep on a cold
boot, and their overlap is cache-dedup'd.

---

## 5. Testing

TDD — tests written first, all Go via `go test ./...`, mirroring
`alpaca_data_test.go` style. The decorator is tested against a call-counting fake
`interfaces.DataService` and a `t.TempDir()` cache dir, with an injected `clock`:

- **Cache hit:** two identical `GetHistoricalBars` within `ttl` → exactly
  **one** underlying call; the second is served from disk.
- **TTL expiry:** advance the injected clock past `ttl` → second call refetches
  (underlying called twice). Single window; no open/closed branch (§4.6).
- **Sub-daily bypass:** `"5Min"` always calls underlying, never writes a file
  (regression guard for intraday isolation).
- **Soft-fail (read/write):** a corrupt/garbage cache file and an unwritable dir
  both degrade to a normal fetch returning correct data (no error surfaced).
- **Soft-fail (rename):** simulate `os.Rename` failing (target held open) → the
  call still returns correct freshly-fetched bars, no error surfaced.
- **Date normalization:** two calls with `end` differing by sub-second (and by a
  few minutes) on the same ET date map to one key → one underlying call.
- **GetMultiBars partial hit:** pre-warm two of three symbols; the call issues
  **one** batched underlying `GetMultiBars` for only the missing symbol and
  merges all three into the result.
- **Forwarding:** `GetLatestQuote`/`GetLatestBar`/`GetLatestTrade` pass through
  to underlying unchanged.
- **Warmer gating:** `RunCandidateCacheWarmer` with an empty refresher slice is a
  no-op, and a single-refresher slice warms only that one (Go). Orchestrator
  (JS, alongside the existing turtle/penny flag tests): a `mean-rev-rsi2` sandbox
  gets `ENABLE_MEANREV_WARMER=true` and not the drift flag, an `earnings-drift`
  sandbox gets the inverse, and every other strategy gets neither.

---

## 6. Open implementation details (resolve during planning)

- **Exact constructor signatures.** Confirm each consumer constructor
  (`NewTechnicalAnalysisService`, `NewStockAnalysisService`, `NewPositionManager`,
  `NewRealizedVolService`, `NewTrendSignalService`, `NewMeanRevSignalService`,
  `NewDriftSignalService`, `NewPennyIntradayCache`, `NewPennyMaxFilterService`,
  `NewOrderController`) takes `interfaces.DataService` or a subset interface the
  decorator satisfies. Strong prior evidence: every one already has a test stub
  implementing the interface. Any concrete-type signature is widened to the
  interface as part of the change.
- **Filename sanitization vs hashing.** Human-readable
  `{symbol}_{tf}_{start}_{end}.json` (operator-inspectable, matches the
  JSON-artifact idiom) with a sanitizer that rejects path separators, vs a hashed
  hex filename with the key stored inside. Recommendation: **human-readable +
  sanitize** — symbols/timeframes/dates are already filesystem-safe; readability
  aids debugging. Final call in the plan.
- **main.go warmer wiring + orchestrator flags.** Confirm `main.go` reads
  `ENABLE_MEANREV_WARMER` / `ENABLE_DRIFT_WARMER`, builds the refresher slice from
  them, and that `orchestrator.js` sets them from `strategyId` next to the
  existing turtle/penny flags. As with the limiter wiring in the prior spec, the
  env→slice mapping is verified by reading the wiring; the flag-from-`strategyId`
  mapping gets a JS unit test.
- **Cache-dir hygiene (deferred, not truly optional).** `endDate` rolls daily,
  so a new generation of files accrues every trading day — tiny files, but
  unbounded file *count* over months. v1 ships no pruning (per-day key-space is
  bounded; near-term growth is negligible), but a daily sweep of files older than
  `ttl` is a needed follow-up, not a maybe. Flagged, not built.

---

## 7. Out of scope (deliberately)

- **Option 1 sidecar** — the single data-owning process with an account-wide
  limiter and cross-process in-flight de-duplication. The principled end state;
  this cache is the stepping stone. Separate sub-project.
- **Fetch staggering / jitter (deferred).** Gating the warmer (§4.8) shrinks the
  cold-boot overlap to two bots, whose fetches the cache dedups, so the residual
  cold-start burst is small. Meaningful staggering would have to be
  ~sweep-duration scale (a few seconds of jitter doesn't help — a late bot still
  cold-misses what the early one hasn't warmed yet) and would only delay
  Coil/Drift readiness. Deferred; the Option 1 sidecar's cross-process
  coordination is the principled full fix for any remaining cold-start overlap.
- **Negative caching.** A symbol with legitimately no data (delisted / bad
  ticker) stays an uncached per-call miss (§4.4), so it's re-fetched by every bot
  every interval — a small permanent leak of exactly the traffic this kills. A
  short negative-cache TTL would close it; minor (universes are curated),
  deferred.
- **Adjustment/split staleness.** Bars are fetched with `Adjustment: All`, so a
  split retroactively rewrites history; a cached entry reflects the split on its
  next TTL expiry (≤ one session). Splits are rare and the bound is acceptable.
- **FMP shared-budget coordination** (sub-project 3) and **Go-log routing to a
  dedicated console tab** (sub-project 2). Tracked separately.
