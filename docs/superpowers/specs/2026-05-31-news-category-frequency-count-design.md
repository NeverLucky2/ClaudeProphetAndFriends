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

**This sub-project's real deliverable is a program-level GO/NO-GO:** is the per-category idea worth continuing at all? The honest expected answer — given rare categories are rare in *any* window and only a few families accumulate enough events — is *"only for the analyst/guidance/earnings families Stage 1 already effectively covered."* SP1 is the cheap counting script that confirms or refutes that before we invest in SP2.

**The cardinal rule SP2 must never break (locked here):** SP2 measures, *of all times category X fired (move or no move), what fraction were followed by the pre-registered direction* — a hit rate over the **full, unconditional firing base** (§6). It must **never** scan for big moves and look back at co-occurring news ("which news was near the moves"): that conditions on the outcome, ignores the silent firings, and inflates every category into a false predictor. The frequency count here *is* that unconditional denominator.

**Out of scope (deferred to Sub-project 2):** the pre-registered direction hypothesis per category, the choice of untouched test window (2016–2021 historical-untouched and/or forward — see §6), the actual hit-rate test, and any verdict about *whether* a category predicts.

---

## 1. The testability bar (and why it's higher than it looks)

In Sub-project 2 the **direction is pre-registered per category** (e.g. bailout→up), so there is no sentiment/price-state agreement filter — *every distinct* category event becomes a firing, and per-category `n ≈ distinct-event count` (after cluster-initiation dedup, §3.2, and light trading-day match).

Power, one-sided binomial, 80% power, +0.08 effect (the same large-edge anchor as Stage 1):
- **Uncorrected** (α=0.05): ~**235/split → ~470 distinct events** total per category. (Robust to the null choice: HR₀=0.50→HR₁=0.58 gives n≈240/split; HR₀=0.55→0.63 gives 235/split.)

**The Bonferroni divisor is fixed outcome-blind, now — no iteration.** Lock **K = the number of categories that clear the uncorrected ~470 bar** in SP1's output. SP2 then commits to testing exactly those K categories and corrects at **α/K** (one-sided). The corrected per-category bar is higher — e.g. for K≈8, α≈0.006 → ~**440/split → ~880 events**. A category that clears ~470 (so we commit to test it) but cannot reach the corrected bar is reported as **underpowered / inconclusive — not a fail**. Because K is a fixed, pre-committed, outcome-blind quantity, there is no circular fixed-point to chase, and erring conservative is the correct direction for multiple comparisons.

So SP1 reports each category's distinct-event count against the uncorrected ~470 bar (which defines K) and, for context, against the corrected bar implied by that K. **Anticipated finding:** only the highest-frequency families (analyst actions, guidance, earnings) clear the corrected bar — fine-grained per-category testing largely collapses back toward the events Stage 1 already covered. The count confirms or refutes this cheaply.

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
- For each item: `categorize()` → for each matched category, for each tagged **universe** symbol, record a raw `(ticker, date, category)` coverage event.
- **Cluster-initiation dedup (primary metric — this is a validity fix, not just deflation).** A multi-day news wave (e.g. an M&A story covered Mon–Wed) is **one** event, and only its *first* date is a valid SP2 firing — a follow-up article post-dates the move it would "predict," violating the Stage-1 "firing must precede the move" discipline. So per `(ticker, category)`, collapse coverage events to a **distinct event** = the first date with **no prior same-`(ticker, category)` event within `W = 5` trading sessions**. The **distinct-event count is the primary frequency**; raw coverage-day count is retained only as the inflated upper-bound reference. (`W=5` is a screen parameter; report counts at `W∈{3,5,10}` for sensitivity.)
- Counts distinct events per category, plus per-year breakdown (to spot spiky-vs-durable categories), and the implied `K` (categories clearing the uncorrected ~470 bar).
- Emits `data/lab/category-frequencies.json` and a printed table.

### 3.3 Output schema (`data/lab/category-frequencies.json`)
`distinct` (W=5 cluster-initiations) is the decision metric; `raw_coverage` is the inflated reference; `per_year` drives the forward-rate extrapolation (the real decision input — §6).
```json
{
  "window": "2022-01-01..2026-05-31", "window_years": 4.42,
  "universe_size": 56, "dedup_window_sessions": 5,
  "categories": {
    "analyst_pt": { "distinct": 1840, "raw_coverage": 5210,
                    "distinct_by_W": {"3": 1990, "5": 1840, "10": 1610},
                    "per_year": {"2022": 410, "2023": 405, "2024": 420, "2025": 415, "2026": 190},
                    "events_per_year": 416, "clears_uncorrected_470": true },
    "gov_bailout": { "distinct": 3, "raw_coverage": 11,
                     "distinct_by_W": {"3": 4, "5": 3, "10": 2},
                     "per_year": {"2022": 1, "2023": 0, "2024": 1, "2025": 1, "2026": 0},
                     "events_per_year": 0.7, "clears_uncorrected_470": false }
  },
  "K_committed": 8,
  "corrected_alpha": 0.00625,
  "corrected_n_per_split": 440,
  "testable_uncorrected": ["analyst_pt", "..."],
  "conclusive_at_corrected": ["..."],
  "years_to_reach_corrected_bar": { "analyst_pt": 2.1, "gov_bailout": ">600" },
  "go_no_go": "CONTINUE only for {analyst/guidance/earnings...} | STOP program"
}
```

---

## 4. Testing (TDD)

`scripts/test_stage1_news_categories.py` (pytest): per-category **true** fixtures (real Alpaca headlines that should tag each category) and **false** fixtures (the macro/hypothetical noise that must NOT tag), mirroring the strict-trigger test. At minimum one true + one false per category for the higher-frequency families; the rare families get representative true examples. Verify multi-label (an M&A-with-guidance headline tags both).

---

## 5. Data & honesty notes

- **Window:** 2022–2026 for the count (representative; outcome-blind so not burned). Per-year breakdown + forward-rate extrapolation judge rare-category rates without a decade-long fetch now. **The decision input is the extrapolated forward/untouched-window rate, not the raw historical total** — a category spiky in history may not accumulate enough in the test window (esp. regime-dependent ones: tariff, bailout, antitrust, M&A waves).
- **Counts still an upper bound** even after cluster dedup: multi-label + symbol-tag attribution can over-attribute (same caveat as Stage 1; mild for single-symbol items, which dominate). A category that fails the bar at this upper bound is **decisively** untestable.
- **Cluster dedup is a validity fix, not cosmetic:** counting coverage-days would both inflate n *and* admit post-move follow-up firings into SP2; distinct cluster-initiations are the only legitimately tradable firings (§3.2).
- **Keyword imprecision:** the categorizer is recall/precision-imperfect; it is a *frequency screen*, not the final pre-registered instrument. SP2 tightens and freezes whichever categorizer it uses.
- **No verdict here:** SP1 outputs counts and a testable/untestable flag per category. It makes **no claim** about whether any category predicts direction — only whether the question is *answerable* at adequate power.

---

## 6. Handoff to Sub-project 2 (designed later, after counts)

SP1's outputs — the **K committed categories**, the **frozen categorizer**, and the **forward-rate extrapolation** — feed SP2. SP2 will:
- Pre-register a **direction hypothesis per category** (theory-driven, e.g. bailout→up, guidance-cut→down — never data-derived).
- Measure, for each category, the **hit rate over its full unconditional firing base** (every distinct cluster-initiation, move or no move) → `P(forward move matches the pre-registered direction)`. **Never** "find news near big moves" (§0 cardinal rule).
- Reuse the Stage 1 Node scoring stack (binomial + date-block bootstrap + hash-locked prereg), **correcting at α/K** with K fixed from SP1.
- Run on an **untouched** window. Options, decided in SP2: **2016–2021 historical-untouched** (Benzinga reaches ~2015; we never scored outcomes there) — fastest, but worse survivorship (the *current* 56 names back-applied) and regime drift; **and/or forward** accumulation from now — clean but slow, governed by `events_per_year`. 2022–2026 outcomes remain burned and off-limits either way.

**Program go/no-go gate (the point of SP1):** if only the analyst/guidance/earnings families clear the corrected bar — the expected outcome — the per-category program is **largely a restatement of what Stage 1 already covered**, and the honest call is to STOP rather than build SP2. SP1 exists to make that decision cheaply, on counts, before any further investment.
