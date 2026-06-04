# Coil Pre-Close Scouting Report (`/coil-preview`) — Design

**Date:** 2026-06-04
**Status:** Revised after code-review verification → implementation plan next
**Owner:** operator (manual workflow tool, not part of the automated fleet)

---

## Problem

Coil (the RSI(2) mean-reversion agent) has been a consistent winner and the operator
wants to **mirror its trades in a real Merrill Edge account**. The blocker is timing:
Coil fires once per trading day at **15:45 ET**, leaving no time to prep an order before
the close. The operator wants a **rough, advance read — a few hours early — of what Coil
is scouting to buy**, so they can prepare to mirror the entry.

The operator's main account is long-term buy-and-hold (and safe); this is a small,
separate, self-directed swing-trading sleeve. Mirroring Coil means **2–5 day holds** (not
same-day round-trips), so the PDT rule generally does not bite.

### Why existing tools don't suffice

- **`us-stock-analysis`** is a single-ticker fundamental/technical deep-dive. It requires
  you to already know the name and cannot run Coil's mechanical universe scan. Wrong tool.
- A from-scratch reimplementation of Coil's signal in a JS/FMP script was the first design.
  Code review (verified against source) showed it has **two unavoidable divergence
  surfaces** for a *mirror* tool, so it was rejected — see below.

---

## Architecture decision: call Coil's own endpoints (do not reimplement)

A code review asked the load-bearing question: would a reimplemented preview feed the signal
functions the *same series* Coil uses? Verification against the source says no — and that a
reimplementation diverges in two places that matter:

1. **Series construction.** `services/meanrev_signal_service.go` fetches Alpaca `1Day` bars
   (`alpaca_data.go`: **IEX feed, fully split/dividend-adjusted**, `end=now`). At 15:45 the
   current day's **partial bar is `closes[L-1]` and is included in RSI(2), SMA(5), and
   SMA(200)** (`meanRevSMA` explicitly includes the most recent bar). SMA(5) is the gate most
   sensitive to this — today's price is 1/5 of it — so a separately-fetched FMP series with
   its own append logic and a different price feed cannot match byte-for-byte.
2. **Earnings gate.** `EarningsCalendarService.HasEarningsWithinTradingDays` uses **5
   trading days**, holiday-aware via the **Alpaca market calendar**, off the FMP earnings
   cache. A naive "next 8 calendar days" reimplementation over-demotes names Coil would
   actually fire — the worst error class for a mirror tool.

**Resolution:** Coil already exposes its exact computation over HTTP
(`cmd/bot/main.go`): `GET /api/v1/meanrev/candidates`, `GET /api/v1/meanrev/signal/:symbol`
(returns the full signal for *any* ticker, firing or not, via `GetSignalForTicker`), and
`GET /api/v1/meanrev/universe`. The shared bar cache TTL is **5 minutes** (`config.go`), so
these reflect prices ≤5 min old. The preview **calls these endpoints** and renders the
result. It computes no signal math and fetches no bars itself.

This makes the preview byte-for-byte what Coil computes — same feed, same earnings calendar,
same arithmetic — eliminating divergence surfaces (1), (2), and the universe-drift risk
(it reads `/universe` instead of duplicating the list).

**Accepted cost:** the tool requires the Go bot to be running. This is acceptable — Coil
itself requires the bot, so if it's down there is nothing to mirror. If any endpoint is
unreachable the tool prints a clear "Coil bot not reachable — cannot preview" and stops.

---

## Core honesty constraints (must appear in every report)

1. **Provisional, not a prediction.** Signals are recomputed off the live price (≤5 min
   stale). Run at ~12:30 ET, names will drift on/off the list before Coil's 15:45 beat:
   FIRING names can bounce off, WATCH names can flip on. Header: **"Provisional read as of
   HH:MM ET — names can drop off or appear by Coil's 15:45 ET beat."**
2. **Regime is provisional too.** If SPY crosses its 200-day between the preview and 15:45,
   it isn't one name changing — Coil's whole sizing/halt posture flips. The banner says so.
3. **Bot dependency.** The numbers are Coil's own; if the bot is down, there is no preview
   (and nothing to mirror).

---

## Scope

**In scope (MVP):**
- A manual `/coil-preview` slash command (skill) run around midday.
- A backing Node script that calls Coil's three meanrev endpoints and renders a ranked
  scouting report: 🟢 FIRING + 🟡 WATCH buckets, per-name margins, per-name **mirror block**,
  an **SPY bear-regime banner**, and loud incompleteness/halt warnings.
- `node:test` coverage for the rendering/classification logic (HTTP is a mocked I/O shell).

**Out of scope (deferred):**
- Auto-scheduling / push notifications (operator chose manual-first).
- Any order placement or fleet change. **Read-only.** The operator executes in Merrill.
- Regime-gate `block_new_entries` overlay (the gate defaults OFF; `bear_mode=halt` is the
  primary "Coil won't enter" condition handled now — gate overlay is a clean later add).
- Position-dollar sizing recommendations (operator sizes their own account; Coil's
  5%/max-4 convention is shown as *reference only*).

---

## Behavior

### Data flow

1. `GET /api/v1/meanrev/universe` → the authoritative ticker list (no local duplication).
2. `GET /api/v1/meanrev/candidates` → the **FIRING** set (authoritative — exactly the names
   Coil's entry loop considers, earnings already applied), plus `bear_regime` and
   `bear_mode`. Always one call, so the FIRING bucket is never partial.
3. For each universe name **not** in FIRING: `GET /api/v1/meanrev/signal/:symbol` → apply the
   WATCH band. These are the only calls that can be partial.

### Buckets

| Bucket | Source / definition |
|---|---|
| 🟢 **FIRING** | Directly from `/candidates` (`entry_signal=true`). Most likely Coil buys at 15:45. |
| 🟡 **WATCH** | From per-symbol `/signal`: in-regime (`last_close > sma_200`) **and** `earnings_within_5d=false` **and** not firing **and** `rsi_2 < WATCH_RSI_MAX` (15) **and** `last_close < sma_5 * (1 + WATCH_SMA5_BAND)` (0.5%). Oversold-ish and at/near the pullback line. Capped at `WATCH_MAX_NAMES` (10), ranked by `rsi_2` ascending. |
| ⚪ (hidden) | Everything else. |

WATCH relaxes only the two intraday-moving conditions (RSI(2) and the close-vs-5-day gap);
the 200-day regime and earnings flag are structural, so they stay hard. Thresholds are named
constants for easy tuning after a few live sessions.

### Per-name fields

- `ticker`, `last_close`, `rsi_2`, `sma_5`, `sma_200`
- **Margins:** `rsi2_margin = rsi_2 - 5`; `sma5_gap_pct = (last_close - sma_5)/sma_5 * 100`
  (negative = pullback condition met); `sma200_gap_pct = (last_close - sma_200)/sma_200 * 100`
- `earnings_within_5d`
- **Soft warning** when `0 < sma200_gap_pct < 1`: "thin regime margin — could drop below the
  200-day (out of regime) by the beat."
- **Mirror block** (fill-relative, per review #3):
  - `exit_rules`: "Exit when RSI(2)>70, OR close above the 5-day SMA, OR 5 trading days
    elapse (whichever first)."
  - **stop is a rule, not a number:** "Set your stop at **your actual fill × 0.93** (−7%)."
    The midday-implied figure `round(last_close*0.93, 2)` is shown labeled *illustrative only*.
  - `entry_ref = last_close` labeled "provisional midday reference, not your expected fill."
  - Timing note: "To match Coil, place near its 15:45 ET beat (same-day). Next-morning entry
    adds overnight gap risk."
  - Reference note: "Coil sizes ~5% of its book, max 4 concurrent — size your own account."

### SPY bear-regime banner

From `/candidates` (`bear_regime`, `bear_mode`; mode default `halfsize` per Coil):
- `bear_regime=false` → "Normal regime — Coil sizes full."
- `bear_regime=true`, mode `halfsize` → "⚠️ Bear regime — Coil halves size today."
- `bear_regime=true`, mode `halt` → "⛔ Bear regime + HALT — Coil will place **no** new
  entries today." **In this case the FIRING bucket renders greyed/struck** with the header
  "shown for reference only — Coil will NOT enter these today." (review #4)

### Incompleteness (review #5)

If any per-symbol WATCH fetch fails, render at the top: **"⚠️ N of M universe names failed
to fetch — WATCH list is INCOMPLETE."** FIRING is unaffected (single authoritative call).
If `/candidates` or `/universe` fails, abort with "Coil bot not reachable — cannot preview."

---

## Mechanics

### Files

- **`scripts/coil-preview.mjs`** — the preview. Pure logic (WATCH classification, margins,
  mirror block, banner + halt overlay, incompleteness flag) is **exported** for unit tests;
  the three HTTP calls are a thin, injectable I/O shell (so tests pass a stub fetcher).
  Resolves the bot base URL from env (e.g. `BOT_API_URL`, default `http://localhost:<port>`
  — exact var/port confirmed during planning from how the Node orchestrator reaches the bot).
  Emits a single JSON object on stdout AND writes it to `data/coil-preview/YYYY-MM-DD.json`:
  ```
  { as_of, preview_time_et, bot_ok,
    spy: { bear_regime, bear_mode, banner },
    firing: [ {ticker, last_close, rsi_2, sma_5, sma_200, rsi2_margin, sma5_gap_pct,
               sma200_gap_pct, thin_regime, mirror:{entry_ref, illustrative_stop, exit_rules}} ],
    watch:  [ ...same shape... ],
    incomplete: { failed: N, total: M, names: [...] },
    halt: bool }
  ```
- **`scripts/coil-preview.test.mjs`** — `node:test`, pure-logic only (stub fetcher; no net).
- **`.claude/skills/coil-preview/SKILL.md`** — runs the script, renders the JSON into the
  markdown scouting report with buckets, mirror blocks, banner, halt overlay, the mandatory
  provisional caveat header, and the incompleteness warning.

There is **no** JS signal port, **no** FMP dependency, and **no** local universe list in this
feature — all three are read from the running bot.

### Safety / blast radius

Read-only: GET-only HTTP, no order placement, no writes to fleet state. The only filesystem
write is the namespaced reference cache under `data/coil-preview/`. No effect on Coil or any
other agent.

---

## Testing

`node:test`, pure-logic only (HTTP mocked via injected fetcher):

1. **WATCH classification:** signal objects at/around the band edges — `rsi_2` exactly 15
   (excluded) vs just under (included); `sma5_gap_pct` exactly +0.5% (excluded) vs under;
   in-regime + no-earnings required; a firing-shaped signal is never double-counted as WATCH.
2. **Margins:** `rsi2_margin`, `sma5_gap_pct`, `sma200_gap_pct` arithmetic.
3. **Thin-regime soft warning:** fires only for `0 < sma200_gap_pct < 1`.
4. **Mirror block:** `exit_rules` text present; `illustrative_stop == round(last_close*0.93,2)`
   and is labeled illustrative; `entry_ref` labeled provisional.
5. **Banner + halt overlay:** the three (regime × mode) cases map to the right banner; mode
   `halt` + `bear_regime` sets `halt=true` and the FIRING-greyed flag.
6. **Incompleteness:** stub some per-symbol fetches to fail → `incomplete.failed` correct and
   the warning renders; `/candidates` failure → abort path.
7. **WATCH cap:** more than `WATCH_MAX_NAMES` qualifiers → list truncated to the cap, most
   oversold kept.

A manual smoke run (`node scripts/coil-preview.mjs` with the bot up) verifies the live
endpoint path end-to-end before the feature is considered done.

---

## Open questions / future

- **v2 automation:** a daily scheduled run (~12:30 ET) writing the report + a notification,
  once the manual command has proven useful.
- **Regime-gate overlay:** when `ENABLE_REGIME_GATE` is on, fold `block_new_entries` into the
  halt overlay alongside `bear_mode=halt`.
- **Tunables** (`WATCH_RSI_MAX`=15, `WATCH_SMA5_BAND`=0.5%, `WATCH_MAX_NAMES`=10, preview
  time) adjust after observing how many WATCH names actually flip to firing across sessions.
