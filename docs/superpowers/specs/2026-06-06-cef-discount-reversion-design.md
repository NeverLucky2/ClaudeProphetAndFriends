# CEF Discount-Reversion Premium — Design Spec

**Date:** 2026-06-06
**Status:** Design approved (brainstorm); pending writing-plans.
**Type:** Pre-registered lab study (FULL hash-locked, train/holdout). Edge-graduation candidate. Read-only, no runtime/deploy impact.
**Subproject:** 2 of 2 in the "uncorrelated ballast" arc — the first NEW premium, contingent on Subproject 1's gap finding.

---

## 1. Why this premium (the S1 → S2 link)

[[fleet-correlation-diagnostic-done]] (Subproject 1) found the fleet's real gap is **equity-selloff protection**: Coil and Drift co-crash with the tech book in QQQ's worst weeks (Coil with genuine tail co-movement), and only the def-Prophet hedge cushions. The edge lanes are low full-β but not crisis-ballast. So Subproject 2 must test a premium that is **genuinely orthogonal to equity-beta**, not another sleeve that bleeds when QQQ bleeds.

After the data walls (merger-arb needs deal terms; commodity/FX carry needs futures term-structure — both unavailable), the chosen premium is **closed-end-fund (CEF) discount-to-NAV mean-reversion**: a behavioral/structural premium where a CEF's market-price discount to its NAV mean-reverts on retail sentiment/flows, *independent of the underlying's direction*. It is capacity-limited to the individual scale the ballast thesis targets, and was the user's pre-stated default "if S1 shows I need non-equity idiosyncratic exposure" — which it did.

**Honest prior: genuinely UNCERTAIN** (like the ORB study, not the confident-REJECT EMA study). The CEF-discount premium has real academic support (the closed-end-fund puzzle), but a small edge × wide CEF spreads makes survival-after-friction a coin-flip.

## 2. Data feasibility (verified 2026-06-06)

CEFConnect exposes a free, clean JSON API — no auth, no HTML scraping:
`GET https://www.cefconnect.com/api/v3/pricinghistory/{TICKER}/{PERIOD}` →
`{Data:{PriceHistory:[{NAVData, DiscountData, Data(=market price), DataDate, ...}], NAVTicker, Cusip, Ticker, Name}}`.

- `PERIOD=1Y` → ~250 **daily** rows; `PERIOD=5Y` → ~245 **weekly** rows (2021→2026). `10Y/MAX/ALL` → empty (invalid tokens).
- **Available depth = ~5Y weekly per CEF** (or daily for the most recent 1Y only). Discount is pre-computed (`DiscountData`).
- **Window = ~5Y weekly (2021→2026)** — covers the 2022 bear + 2025 tariff selloff (good for the orthogonality test); no 2020 COVID. Weekly granularity fits the premium (discount reversion is a slow multi-week behavioral effect).

**Return-basis decision (resolved 2026-06-06 — the load-bearing call).** CEFs yield 6–10%; total return = price-change + distributions, but CEFConnect exposes only `pricinghistory` (NAV + price + discount) — the distribution/total-return endpoints 404 (probed). Rather than the academic "discount-change-isolated" fallback (not holdable) or a yield-contaminated total-return (yield carries credit/rates β and could masquerade as reversion edge), **the graduatable basis is the price-change return** `= Δprice/price` (which embeds NAV-move + Δdiscount), friction-net. Properties:
- **Conservative lower bound** on the holder's return — it excludes the positive distribution yield (the holder also pockets that), so a KEEP on price-change is *robust*; yield only strengthens it. The risk is false-REJECT of a yield-dependent sleeve, not false-KEEP — and a yield-dependent sleeve is a credit-carry trade, not the orthogonal reversion ballast we want (and gate 2 would flag its β).
- **Excludes yield entirely → no "yield wearing a reversion costume" false-KEEP.**
- **Decomposed** into **NAV-move (underlying β)** vs **Δdiscount (the reversion premium)** so a KEEP is honestly attributed (catches the *other* costume: edge that's just "bought bond-CEFs during a bond rally," not reversion).
- **Yield** is reported descriptively as a separate non-orthogonal carry the sleeve would *also* earn — never part of the graduation decision.
- **Total return** (price-change + distributions) is attempted as an optional *strengthening* add via a plan data-spike (inspect the fund page's network calls for the real distribution endpoint); if found it's reported alongside, but the KEEP gate never depends on it.

## 3. Approved decisions (from the brainstorm)

| Decision | Choice | Rationale |
|---|---|---|
| **Premium** | CEF discount-to-NAV reversion | Genuinely non-equity / idiosyncratic, individual-capacity; best fills the S1 equity-selloff gap. |
| **Expression** | **Time-series z-score, long-only** | Coil-shaped, implementable (no borrow), fits the fleet's complexity ceiling. Carries the underlying's beta — which we MEASURE (orthogonality gate), not assume. (Cross-sectional long-short rejected: CEF borrow is impractical; NAV-hedge overlay deferred.) |
| **Window** | ~5Y weekly (2021→2026), chronological train/holdout split | Data-depth limit; ~120 weekly points per side. |
| **Friction** | **Primary gate on friction-NET returns** + 2× stress | CEF spreads are wide; a small gross edge dies after costs — the decisive risk (the EMA/ORB/Coil-options lesson). |
| **KEEP bar** | **Dual gate**: friction-net holdout edge (bootstrap-CI>0) AND orthogonality/ballast (low equity-β + no crisis co-crash + low corr to existing lanes) | The S1→S2 connection: a beta-carrying edge fails; a no-edge orthogonal sleeve fails. Small-but-real-and-uncorrelated is the win. |
| **Rigor** | FULL hash-locked prereg + train/holdout, honest REJECT | Graduation-candidate edge test. |

## 4. Signal (time-series z-score on the discount)

Weekly, per CEF:
- Discount `D_t = (price_t − NAV_t)/NAV_t` (use CEFConnect `DiscountData`; verify its sign convention in the plan).
- Trailing-norm z-score: `z_t = (D_t − mean(D, trailing L)) / std(D, trailing L)`, **L = 52 weeks** primary. The z-vs-own-norm controls for structurally-wide-discount funds — it buys cheapness *relative to the fund's own discount history*, not funds that always trade wide.
- **Entry:** `z_t ≤ −z_enter`; primary **z_enter = 1.5**. Enter at that week's close price.
- **Exit:** `z_t ≥ 0` (reverted to norm) **OR** 26-week time stop. (Widen-stop deferred.)
- **Portfolio:** equal-weight active positions, cap **≤10**, one position per CEF, fixed-fractional sizing (Coil convention). **Admission rule when > 10 qualify: most-negative-z first** (the Coil "most-oversold-first" analogue; pinned because it bites hardest in the common-driver risk-off weeks gate 2 examines). Non-compounding fixed base for fair cross-config comparison.
- **Holding return:** **price-change return** `Δprice/price`, friction-net (§2 — the graduatable conservative basis), **decomposed into NAV-move vs Δdiscount** for reversion-attribution; distribution yield reported descriptively, never gated.

All parameters (L, z_enter, exit threshold, time stop, position cap) carry a **train-only sensitivity grid** with the primary config frozen a-priori (Coil/EMA/ORB discipline).

## 5. Universe

A curated **liquid** subset (~50–80 CEFs) spanning fixed-income / equity / multi-asset, screened on AUM + dollar-volume to exclude thin names where the discount edge is real on paper but uncapturable after spreads. Stored as `cef-universe.mjs` (ticker + type + liquidity/spread tier). Most wide-discount CEFs are bond/credit funds — which is exactly why §6's equity-β measurement is load-bearing (the sleeve could be low-equity-β but carry credit/rates beta; we report what it is).

## 6. Friction + the dual KEEP gate

**Friction (the killer):** per-round-trip cost = half-spread on entry + half-spread on exit (+ ~$0 retail commission; spread dominates). Half-spread estimated per CEF from its liquidity tier, with a **conservative blanket floor (~30–50 bps)**. The **primary verdict runs on friction-NET returns**; a **2× friction stress** is the robustness check (`stress-test-friction` discipline). Edge that doesn't survive realistic CEF spreads ⇒ **REJECT**.

**Dual KEEP gate (both are hard gates):**
1. **Edge gate** — the friction-net **holdout weekly sleeve price-change-return series** (§2 basis) has a mean > 0 with a **block-bootstrap CI lower bound > 0**, **block length = 8 weeks** (spans a discount cycle; reuse `coil-threshold-metrics`). The weekly sleeve series is the primary measure (holdable portfolio AND exactly what gate 2 correlates); per-trade expectancy secondary. **Effective-n caveat:** CEF discounts share a common retail-flow driver, so simultaneous positions are cross-sectionally correlated and the holdout's independent discount-widening episodes are few (a handful over 2021–2026); RESULTS reports the episode count and treats a CI resting on 3–4 episodes as optimistic. Pre-registered on the holdout only.
2. **Orthogonality / ballast gate** — reconstruct the sleeve's **weekly price-change series**, run it through the S1 `fleet-correlate` modules vs QQQ + the existing lanes (Coil/Turtle/Drift weekly, regenerated via the S1 builders):
   - **low equity-β to QQQ** (bootstrap-β CI near/bracketing 0),
   - **does not co-crash** — the crisis-conditional **mean** (QQQ worst-quintile weeks) CI is **not entirely < 0**. (The mean is the gate; it is *not* subject to S1's downside-β range-restriction inflation — that was a slope artifact, not a mean one. ρ_crisis / downside-β are reported beside S1's rotation band as descriptive context, consistent with S1, not as the gate.)
   - **low correlation to the existing lanes — pinned bar: |ρ| < 0.3 to *each* of Coil / Turtle / Drift** (weekly Pearson) — so it adds genuine diversification, not redundancy.

**KEEP requires BOTH.** A juicy edge that carries equity-β fails gate 2 (defeats the ballast purpose). A genuinely-orthogonal sleeve with no friction-surviving edge fails gate 1. Both → honest REJECT, pre-committed acceptable. A **small, friction-surviving, genuinely-uncorrelated** edge is the explicit KEEP.

## 7. Reuse map (local main — S1 just merged at b0943f2)

- `fleet-correlate.mjs` → the **entire orthogonality gate** (`pearson`/`spearman`/`betaTo`/`bootstrapBetaCI`/`bootstrapCorrCI`/`crisisWeeks`/`crisisMean`+CI/`rhoCrisis`/`downsideBeta`/`rotationBand`).
- `fleet-align.mjs` → weekly alignment of the sleeve to QQQ + the lanes (`unionDates`/`alignDaily`/`toWeekly`; the sleeve is already weekly).
- `fleet-prereg.mjs` pattern → canonical (sorted-key) sha256 hash-lock.
- `coil-threshold-metrics.mjs` → block-bootstrap CI on the edge.
- S1 lane builders (`fleet-coil-marks.buildCoilSeries`, `fleet-turtle-sim.simulateTurtle`, `fleet-drift-sim.buildDriftSeries`) + `fleet-bars`/`fleet-fetch-bars`/`fleet-fetch-earnings` → regenerate Coil/Turtle/Drift weekly series for the lane-correlation check.

## 8. New modules (TDD pure cores + controller-authored data-glue)

1. `cef-fetch.mjs` — CEFConnect pricinghistory (5Y weekly) + distribution/total-return handling → `data/lab/cef-cache/{TICKER}.json` (controller-authored).
2. `cef-universe.mjs` — curated liquid CEF list + spread tiers *(pure)*.
3. `cef-signal.mjs` — discount z-score entry/exit *(pure, TDD)*.
4. `cef-friction.mjs` — per-CEF spread model + 2× stress *(pure, TDD)*.
5. `cef-sim.mjs` — portfolio sim → friction-net weekly return series + per-trade ledger *(pure, TDD)*.
6. `cef-prereg.mjs` — hash-locked methodology block *(pure, TDD)*.
7. `cef-score.mjs` — orchestrator: prereg → train/holdout sim → edge gate (bootstrap) + orthogonality gate (reuse `fleet-correlate`) → KEEP/REJECT → RESULTS (controller-authored).
8. report renderer → `docs/lab/cef-discount-reversion-RESULTS.md` (committed).

## 9. Scope (YAGNI)

- **In:** long-only z-score CEF discount-reversion, friction-net, train/holdout, dual KEEP gate, orthogonality vs QQQ + existing lanes.
- **Out:** shorting; NAV-hedge overlay (deferred — only if the raw sleeve shows edge but carries too much equity-β); options; daily/intraday (weekly only); cross-sectional ranking (time-series chosen); 2020 COVID (data-depth limit).
- Lab-only, read-only, no agent/runtime/deploy change. Isolated worktree off **local main**, Haiku subagents, `data/lab/*` git-ignored, only `docs/lab/cef-discount-reversion-RESULTS.md` committed. CEFConnect data is free (approved).

## 10. Pre-registration block (hashed by `cef-prereg` before scoring)

- **Universe:** the curated liquid CEF list (frozen file).
- **Window:** 2021→2026 weekly; chronological train/holdout split at the midpoint (~mid-2023, ~2.5Y each); boundary pinned a-priori. **Regime caveat (pinned):** the midpoint straddles the 2022–23 rate-regime break (zero-rate → high-rate plateau); a holdout result is interpreted WITH that caveat and the **train-half result is reported alongside**, so a regime shift cannot masquerade as honest-REJECT or honest-KEEP.
- **Signal:** z-score L=52w; entry z ≤ −1.5; exit z ≥ 0 OR 26w time stop; equal-weight, ≤10 positions, one/CEF, fixed-fractional; **admission when > 10 qualify = most-negative-z first.**
- **Return basis:** **price-change return** (NAV-move + Δdiscount), gross then friction-net — the graduatable conservative basis; **decomposed** into NAV-move vs Δdiscount; distribution yield descriptive-only (never gated); total-return an optional non-gating add if the distribution endpoint is found.
- **Friction (pinned per liquidity tier):** half-spread **liquid 25 bps / mid 50 bps / thin 100 bps**; round-trip = 2× half-spread (+ ~$0 retail commission); primary verdict = net; **2× stress** as robustness.
- **Edge gate:** friction-net holdout weekly sleeve price-change mean, **block-bootstrap CI lower bound > 0, block = 8 weeks**; report the count of independent discount-widening episodes (CI optimistic if it rests on 3–4).
- **Orthogonality gate:** QQQ-β CI near/bracketing 0 + crisis-conditional **mean** CI not entirely < 0 (the mean is the gate; ρ_crisis/downside-β descriptive vs S1 rotation band) + **|ρ| < 0.3 to each of Coil / Turtle / Drift** (reuse `fleet-correlate`).
- **Regime-chase check (pinned):** report whether entries cluster in the 2022–23 rate-hike re-rating and whether those trades fare systematically worse (the mean-reversion-into-a-regime-break trap), and whether any edge is concentrated in the pre-2022 / train portion.
- **KEEP = both gates; else REJECT.** Pre-committed acceptable findings: "edge dies after CEF friction"; "edge survives but carries equity-β / co-crashes (not ballast)"; "edge is NAV-drift or yield-carry, not reversion (decomposition)"; "genuinely orthogonal but no edge"; **"apparent edge is a survivorship artifact"** — the current-snapshot universe omits CEFs that liquidated/merged/delisted by 2026 (disproportionately the distressed wide-discount names that did NOT recover), biasing the edge **upward toward false-KEEP**; unfixable with CEFConnect's snapshot → **loud caveat in RESULTS** tempering any KEEP. The study may REJECT.

## 11. Open items for the implementation plan

- **Data-spike (do first):** try to find CEFConnect's real distribution endpoint by inspecting the fund page's network calls (the guessed `/distributionhistory/...` paths 404). If found, add total-return as a non-gating strengthening report; if not, the price-change basis (§2) stands and the study proceeds unchanged (it does NOT block — price-change is the committed graduatable basis).
- Confirm CEFConnect `DiscountData` **sign convention** (discount negative vs positive) before the z-score.
- Build the **curated liquid CEF universe** (which ~50–80 tickers; the screen on AUM/volume — possibly from a CEFConnect screener endpoint).
- Confirm the CEFConnect fetch is **rate-limit-tolerant** across ~50–80 tickers (throttle if needed).
- Pin the **half-spread floor** per liquidity tier (the single most outcome-determining assumption).
