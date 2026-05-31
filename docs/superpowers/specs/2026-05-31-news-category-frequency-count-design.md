# News-Category Event-Frequency Count — Design (Sub-project 1)

**Date:** 2026-05-31
**Status:** Design approved; spec for review.
**Type:** Feasibility measurement (counting only — no outcome scoring, no pre-registration).
**Parent program:** "Which news *types* genuinely predict short-term direction?" — a research follow-on to the Stage 1 FAIL (`docs/lab/stage1-RESULTS.md`). Stage 1 refuted one fixed signal; this program asks whether *specific news categories* carry directional information.

---

## 0. Why this sub-project exists (and what it is NOT)

The parent question is prone to three traps we must respect (carried from Stage 1):
1. **Burned data** — the 2022–2026 *outcomes* were already scored in Stage 1; the eventual per-category test (Sub-project 2) must run on an untouched/forward window.
2. **Multiple comparisons** — testing ~20 categories will surface spurious "predictors" without correction.
3. **Selecting on the outcome** — categories must be assigned from information available *before* the move, never by the move that followed.

This sub-project touches **none** of those, because it only **counts category frequencies** — it never looks at price outcomes. Counting is outcome-blind, so it neither burns data nor risks selection. Its sole job: **find which categories have enough events to be statistically testable at all**, so Sub-project 2's pre-registered test is scoped only to powered categories. Most rare-but-interesting categories (bailouts, grants, FDA) are expected to fail this bar — that is itself a legitimate finding.

**Out of scope (deferred to Sub-project 2):** the pre-registered direction hypothesis per category, the untouched test window, the actual hit-rate test, and any verdict about *whether* a category predicts.

---

## 1. The testability bar (and why it's higher than it looks)

In Sub-project 2 the **direction is pre-registered per category** (e.g. bailout→up), so there is no sentiment/price-state agreement filter — *every* category event becomes a firing, and per-category `n ≈ event count` (minus light per-ticker thinning + trading-day match).

Power, one-sided binomial, 80% power, +0.08 effect (the same large-edge anchor as Stage 1):
- **Uncorrected** (α=0.05): ~**235/split → ~470 events** total per category. (Robust to the null choice: HR₀=0.50→HR₁=0.58 gives n≈240/split; HR₀=0.55→0.63 gives 235/split.)
- **Bonferroni-corrected** over the *testable* categories — expected to be ~10 of the ~25 candidates once rare ones are pruned (α≈0.005): ~**453/split → ~900 events** total per category.

So the count flags each category against **both bars**, leading with the conservative **~900** (Bonferroni) figure. (The correction divisor is the count of categories that actually clear the bar, not all 25 candidates — slightly circular, resolved by iterating once on the pruned set in Sub-project 2.) **Anticipated finding:** only the few highest-frequency families (analyst actions, guidance, earnings) clear the corrected bar — which would mean fine-grained per-category testing largely collapses back toward the events Stage 1 already covered. The count will confirm or refute that cheaply.

---

## 2. Taxonomy (~25 candidate categories, multi-label)

Direction-relevant splits, so Sub-project 2 can attach a clean per-category direction hypothesis. An item may match several (multi-label) — counting is per `(ticker, date, category)`.

| Category | Cue gist (precision-leaning) |
|---|---|
| `ma_target` | company is the target: "to be acquired", "agrees to be acquired", "takeover/acquisition offer for", "tender offer for" |
| `ma_acquirer` | company is the acquirer: "to acquire", "agrees to acquire/buy", "completes acquisition of" |
| `earnings_beat` | "beats/tops EPS\|revenue\|estimates\|consensus" |
| `earnings_miss` | "misses/trails EPS\|revenue\|estimates\|consensus" |
| `guidance_raise` | "raises/lifts/boosts (FY\|Q#) guidance\|forecast\|outlook" |
| `guidance_cut` | "cuts/lowers/slashes (FY\|Q#) guidance\|forecast\|outlook", "profit warning" |
| `analyst_upgrade` | "upgrades/raised to buy\|overweight\|outperform" |
| `analyst_downgrade` | "downgrades/cut to sell\|underweight\|underperform" |
| `analyst_pt` | "raises/cuts price target", "PT to $" |
| `fda_approval` | "FDA approval/approves/clears", "grants approval" |
| `fda_reject` | "FDA rejection/declines/CRL/complete response letter", "fails trial", "misses endpoint" |
| `legal_action` | "lawsuit", "SEC probe/investigation", "fined", "settlement", "charges" |
| `antitrust` | "antitrust", "DOJ/FTC sues/blocks", "monopoly" |
| `gov_bailout` | "bailout", "government rescue", "federal loan/aid", "rescue package" |
| `gov_grant` | "government grant/subsidy", "awarded contract", "DoD/DOE contract", "CHIPS Act funds" |
| `tariff` | "tariff", "trade restriction/ban", "export controls" |
| `buyback` | "buyback", "repurchase program", "authorizes $.. repurchase" |
| `dividend_change` | "raises/cuts/suspends dividend", "initiates dividend" |
| `offering` | "secondary offering", "stock offering", "dilution", "convertible notes offering" |
| `ceo_change` | "CEO steps down/resigns/named/appointed", "CFO departs" |
| `insider_trade` | "insider buying/selling", "Form 4", "CEO buys/sells shares" |
| `product_launch` | "launches", "unveils", "debuts" (product/model) |
| `product_recall` | "recall", "recalls", "safety probe" (product) |
| `restructuring` | "layoffs", "job cuts", "restructuring", "plant closure" |
| `short_report` | "short seller", "short report", "Hindenburg/Muddy Waters", "alleges fraud" |

Global excludes (applied first, from the strict trigger): junk (mini-tender), hypotheticals (would-have/once-thought), macro subjects (inflation/jobs/Fed/geopolitics) — so a macro headline never gets tagged as a company event.

---

## 3. Components (Python; reuse Stage 1 fetch infra)

### 3.1 `scripts/stage1_news_categories.py` — multi-label categorizer
- `categorize(headline, summary) -> set[str]` over the ~20 categories. Deterministic, hashable (basis for Sub-project 2's pre-registered categorizer). Applies global excludes first, then collects every matching category.
- One compiled-regex set per category (precision-leaning, like `classify_catalyst_strict`).

### 3.2 `scripts/stage1_category_count.py` — frequency counter
- Fetches Alpaca news over **2022-01-01 → 2026-05-31** (reuse the resumable month-checkpoint fetcher; same retry/backoff).
- For each item: `categorize()` → for each matched category, for each tagged **universe** symbol, record `(ticker, date, category)`.
- Counts **unique `(ticker, date, category)`** events per category, plus per-year breakdown.
- Emits `data/lab/category-frequencies.json` and a printed table.

### 3.3 Output schema (`data/lab/category-frequencies.json`)
```json
{
  "window": "2022-01-01..2026-05-31",
  "universe_size": 56,
  "categories": {
    "analyst_pt": { "total": 1840, "by_year": {"2022": 410, "...": 0},
                    "clears_uncorrected_470": true, "clears_bonferroni_900": true,
                    "extrapolated_10y": 4180 },
    "gov_bailout": { "total": 3, "by_year": {"...": 0}, "clears_uncorrected_470": false,
                     "clears_bonferroni_900": false, "extrapolated_10y": 7 }
  },
  "testable_uncorrected": ["..."],
  "testable_bonferroni": ["..."]
}
```

---

## 4. Testing (TDD)

`scripts/test_stage1_news_categories.py` (pytest): per-category **true** fixtures (real Alpaca headlines that should tag each category) and **false** fixtures (the macro/hypothetical noise that must NOT tag), mirroring the strict-trigger test. At minimum one true + one false per category for the higher-frequency families; the rare families get representative true examples. Verify multi-label (an M&A-with-guidance headline tags both).

---

## 5. Data & honesty notes

- **Window:** 2022–2026 for the count (representative; outcome-blind so not burned). Per-year + 10-year extrapolation lets us judge rare-category rates without a decade-long fetch now.
- **Upper-bound counts:** multi-label + symbol-tag attribution means counts are an **upper bound** on true ticker-specific events (same caveat as Stage 1; mild for single-symbol items, which dominate). A category that fails the bar even at the upper bound is decisively untestable.
- **Keyword imprecision:** the categorizer is recall/precision-imperfect; it is a *frequency screen*, not the final pre-registered instrument. Sub-project 2 will tighten and freeze whichever categorizer it uses.
- **No verdict here:** this sub-project outputs counts and a testable/untestable flag per category. It makes **no claim** about whether any category predicts direction.

---

## 6. Handoff to Sub-project 2 (designed later, after counts)

The testable-category list + the frozen categorizer feed Sub-project 2: pre-register a direction hypothesis per testable category, choose an **untouched** test window (2022–2026 outcomes are burned), correct for the number of categories tested, and run the per-category hit-rate test on the existing Node scoring stack (binomial + date-block bootstrap + hash-locked prereg). Not started until these counts are in.
