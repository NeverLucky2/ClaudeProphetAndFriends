# Sub-project 1 — Results: per-category event-frequency count

**Date:** 2026-05-31
**Verdict:** **QUALIFIED GO** — refutes the pre-run prediction. The per-category program is *not* a Stage-1 restatement; ~7 genuinely testable, mostly-novel categories exist.
**Evidence:** `data/lab/category-frequencies.json` (force-committed past the `data/lab` gitignore).
**Spec/plan:** `docs/superpowers/specs/2026-05-31-news-category-frequency-count-design.md`, `docs/superpowers/plans/2026-05-31-news-category-frequency-count.md`.

## Method
Alpaca news 2022-01 → 2026-05 (4.42y), 56-name universe, multi-label hardened categorizer (~25 categories), counted as **distinct cluster-initiations** (W=5-day per-ticker dedup). Testability bar: ~470 distinct (uncorrected, 235/split) defines K; corrected at α/K. K=10 → corrected α=0.005 → ~446/split → ~892 distinct to be conclusive.

## Per-category distinct events (W=5)
| category | distinct | conclusive@corrected | note |
|---|---|---|---|
| analyst_pt | 4250 | ✅ | ticker-specific (avg 6.1 tkrs/day, legit) |
| analyst_upgrade | 1678 | ✅ | trustworthy |
| product_launch | 1550 | ✅ | trustworthy (avg 2.8); broad regex caveat |
| legal_action | 1482 | ✅ | trustworthy (avg 2.5) |
| **tariff** | **1436** | ✅* | **MACRO-INFLATED — drop** (avg 4.8, **max 36/57 tickers on one day**) |
| analyst_downgrade | 1296 | ✅ | trustworthy |
| restructuring | 958 | ✅ | trustworthy (avg 2.4) |
| antitrust | 950 | ✅ | trustworthy (avg 2.7) |
| earnings_beat | 849 | ❌ inconclusive | clears 470, not corrected bar |
| ma_acquirer | 530 | ❌ inconclusive | clears 470, not corrected bar |
| buyback 278 / gov_grant 272 / product_recall 251 / fda_approval 219 / offering 210 / short_report 185 / dividend_change 150 / guidance_raise 118 / guidance_cut 117 / ceo_change 86 / earnings_miss 79 / insider_trade 58 / ma_target 50 / fda_reject 45 / gov_bailout 44 | <470 | ❌ too rare | untestable at power |

## Findings
1. **Prediction refuted.** I (and the reviewing session) expected only analyst/guidance/earnings to clear, making the program a Stage-1 restatement → STOP. Wrong: the conclusive set is **analyst (pt/up/down), legal_action, antitrust, product_launch, restructuring** — and Stage 1 tested *none* of these (it used only M&A/earnings triggers). Guidance and earnings_miss are in fact **too rare** to test individually.
2. **Cross-ticker attribution is the key validity check.** Per-ticker dedup does not remove the same macro/sector headline being tagged to many tickers. `tariff` is decisively macro-inflated (max 36/57 tickers on one day) and must be dropped or restricted to single-subject items. The other winners are genuinely ticker-specific (avg ≤2.8 tickers/day).
3. **Counts are upper bounds**; "testable" means the question is *answerable at power*, **not** that the category predicts. The Stage-1 prior (most signals show no large edge) stands; SP2 is where prediction is actually tested.

## Go/No-Go for the program
**Qualified GO** for SP2 on the trustworthy conclusive set (drop `tariff`): **analyst_pt, analyst_upgrade, analyst_downgrade, legal_action, antitrust, product_launch, restructuring** (K would re-fix to ~9 after dropping tariff; recompute in SP2). Honest expected SP2 yield: mostly per-category FAILs (informative negatives), maybe 1–2 surprises. SP2 is a real investment (freeze categorizer, pre-register per-category direction, untouched window, per-category scoring) — worth it only if per-category negative/positive results are themselves valuable.

## Reproducibility
`python scripts/stage1_category_count.py` (resumable). Categorizer `scripts/stage1_news_categories.py` (+tests); counter `scripts/stage1_category_count.py` (+tests). 7 unit tests green.
