# News-Category Event-Frequency Count — Implementation Plan (Sub-project 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deterministic multi-label news categorizer (~25 categories) and a frequency counter that reports, per category, the count of *distinct* `(ticker, category)` events (cluster-initiation deduped) over 2022–2026 — so we can decide which categories clear the testability bar and whether the per-category research program is worth continuing.

**Architecture:** Two focused Python modules in `scripts/`. `stage1_news_categories.py` is a pure multi-label keyword classifier reusing the strict-trigger's global excludes. `stage1_category_count.py` reuses the existing resumable Alpaca news fetcher (`stage1_fetch_catalysts.py`), categorizes every item, dedups multi-day coverage waves into distinct events, and emits a per-category frequency report + a program go/no-go. All pure logic is `pytest`-tested with mocked data; the network fetch is verified by the live run.

**Tech Stack:** Python 3 (`re`, `statistics.NormalDist`, `urllib`), `pytest`. No new deps.

**Spec:** `docs/superpowers/specs/2026-05-31-news-category-frequency-count-design.md`

---

## File structure

| File | Responsibility |
|---|---|
| `scripts/stage1_news_categories.py` | `categorize(headline, summary) -> set[str]` — multi-label keyword categorizer over ~25 categories; global excludes (junk/hypothetical/macro) applied first (imported from `stage1_catalyst_trigger`). |
| `scripts/test_stage1_news_categories.py` | Per-category true/false fixtures (real headlines) + multi-label test. |
| `scripts/stage1_category_count.py` | Pure: `required_n_per_split`, `cluster_dedup`, `build_report`. CLI: fetch (reuse) → categorize → checkpoint → merge → report. |
| `scripts/test_stage1_category_count.py` | Unit tests for the pure helpers with mock events (no network). |

---

## Task 1: Multi-label news categorizer

**Files:**
- Create: `scripts/stage1_news_categories.py`
- Test: `scripts/test_stage1_news_categories.py`

- [ ] **Step 1: Write the failing test**

```python
# scripts/test_stage1_news_categories.py
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from stage1_news_categories import categorize as C


TRUE_CASES = {
    "ma_acquirer":    "Johnson & Johnson Agrees To Acquire Shockwave Medical For $335/Share",
    "ma_target":      "Shockwave Medical To Be Acquired By Johnson & Johnson",
    "earnings_beat":  "Microsoft Tops Q2 EPS Estimates",
    "earnings_miss":  "Acme Misses Q3 Revenue Estimates",
    "guidance_raise": "Delta Raises Full-Year Profit Guidance",
    "guidance_cut":   "FedEx Cuts FY Guidance; Issues Profit Warning",
    "analyst_upgrade":"Morgan Stanley Upgrades Nvidia To Overweight",
    "analyst_downgrade":"Goldman Downgrades Intel To Sell",
    "analyst_pt":     "BofA Raises Apple Price Target To $260",
    "fda_approval":   "FDA Approves Eli Lilly's New Diabetes Drug",
    "fda_reject":     "Biotech Shares Plunge As FDA Issues Complete Response Letter",
    "legal_action":   "SEC Opens Investigation Into Company's Accounting; Lawsuit Filed",
    "antitrust":      "DOJ Sues To Block The Merger On Antitrust Grounds",
    "gov_bailout":    "Airline Secures Federal Bailout In Rescue Package",
    "gov_grant":      "Intel Awarded CHIPS Act Grant For New Fab",
    "tariff":         "New Tariffs On Chinese EV Imports Hit The Sector",
    "buyback":        "Company Authorizes $10B Share Repurchase Program",
    "dividend_change":"Company Raises Quarterly Dividend By 8%",
    "offering":       "Company Prices $500M Secondary Offering",
    "ceo_change":     "Company CEO Steps Down; Board Names New CEO",
    "insider_trade":  "CEO Buys 50,000 Shares In Insider Purchase",
    "product_launch": "Apple Unveils New iPhone Model",
    "product_recall": "Automaker Recalls 200,000 Vehicles Over Safety Defect",
    "restructuring":  "Tech Giant Announces Layoffs, Cutting 10,000 Jobs",
    "short_report":   "Hindenburg Short Report Alleges Accounting Fraud",
}

NOISE = [
    "Jamie Dimon Warns Of Stickier Inflation In Annual JPMorgan Letter",
    "US Job Growth Beats Expectations And What That Means For You",
    "Bob Iger Once Thought Apple And Disney Merger Would Have Happened",
    "Analyst Warns Of Escalation If Iran Strikes Back",
    "Company Recommends Rejection Of Mini-Tender Offer",
]


def test_each_category_matches_its_true_case():
    for cat, headline in TRUE_CASES.items():
        assert cat in C(headline, ""), f"{cat!r} not in {C(headline, '')!r} for {headline!r}"


def test_noise_matches_nothing():
    for h in NOISE:
        assert C(h, "") == set(), f"expected empty for noise {h!r}, got {C(h, '')!r}"


def test_multilabel_ma_with_guidance():
    h = "MegaCorp Agrees To Acquire Rival And Raises Full-Year Guidance"
    got = C(h, "")
    assert "ma_acquirer" in got and "guidance_raise" in got


def test_empty_is_empty_set():
    assert C("", "") == set()
    assert C(None, None) == set()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest scripts/test_stage1_news_categories.py -q`
Expected: FAIL — `ImportError: cannot import name 'categorize'`.

- [ ] **Step 3: Write the categorizer**

```python
# scripts/stage1_news_categories.py
"""Deterministic multi-label news categorizer (~25 categories) for the per-category
frequency screen. Global excludes (junk/hypothetical/macro) are applied FIRST, reusing
the strict trigger, so a macro headline never tags a company event. Precision-leaning:
a missed category only costs frequency; a false tag inflates a category's apparent base.
Returns the SET of matched categories. Spec: 2026-05-31-news-category-frequency-count."""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from stage1_catalyst_trigger import JUNK, HYPOTHETICAL  # reuse junk + hypothetical excludes

# Categorizer-local macro exclude = the strict trigger's MACRO_SUBJECT MINUS tariff/trade-war,
# because `tariff` is one of OUR categories here (a tariff story tagged to a company is a
# company event). Everything else macro (inflation/jobs/Fed/geopolitics) still excluded so a
# macro headline never spuriously tags a category (e.g. "Job Growth Beats Expectations").
_MACRO_EXCL = re.compile(
    r"\b(inflation|recession|interest rate|rate (cut|hike|jitters|decision)|"
    r"jobs? (report|growth|numbers|data|gains)|unemployment|payrolls?|jobless|"
    r"gdp|cpi|ppi|fed(eral reserve)?|fomc|treasury yield|bond yield|"
    r"oil demand|world (economy|oil)|copper supply|gold (price|at \$)|"
    r"global economy|geopolit|ukraine|iran|israel|middle east)\b", re.I)


def _p(s):
    return re.compile(s, re.I)


CATEGORY_PATTERNS = {
    "ma_target":        _p(r"\b(to be acquired|agrees? to be acquired|agrees? to sell itself|"
                           r"(acquisition|takeover|buyout|tender) offer for|to be (acquired|bought) by)\b"),
    "ma_acquirer":      _p(r"\b(to acquire|agrees? to (acquire|buy)|completes? (its |the )?acquisition of)\b"),
    "earnings_beat":    _p(r"\b(beats?|tops?|crushes?|surpasses?) [\w' .,$-]{0,25}"
                           r"(eps|earnings|revenue|profit|estimates|consensus|expectations)\b"),
    "earnings_miss":    _p(r"\b(misses?|trails?|falls short of) [\w' .,$-]{0,25}"
                           r"(eps|earnings|revenue|profit|estimates|consensus|expectations)\b"),
    "guidance_raise":   _p(r"\b(raises?|lifts?|hikes?|boosts?|increases?) (its )?"
                           r"(full[- ]year |fy |q[1-4] |quarterly |annual )?"
                           r"(eps |revenue |profit |sales |earnings )?(guidance|forecast|outlook)\b"),
    "guidance_cut":     _p(r"\b((cuts?|lowers?|slashes?|trims?|reduces?) (its )?"
                           r"(full[- ]year |fy |q[1-4] |quarterly |annual )?"
                           r"(eps |revenue |profit |sales |earnings )?(guidance|forecast|outlook)|"
                           r"profit warning)\b"),
    "analyst_upgrade":  _p(r"\b(upgrade[sd]?|raised to (buy|overweight|outperform)|"
                           r"initiates? [\w' ]{0,15}(buy|outperform|overweight))\b"),
    "analyst_downgrade":_p(r"\b(downgrade[sd]?|cut to (sell|underweight|underperform)|"
                           r"lowered to (sell|hold|underperform))\b"),
    "analyst_pt":       _p(r"\b(raises?|lifts?|cuts?|lowers?|boosts?|hikes?) [\w' ]{0,20}price target\b|"
                           r"\bprice target (raised|cut|lowered|boosted|hiked|to \$)"),
    "fda_approval":     _p(r"\bfda (approv\w+|clears?|grants? approval)\b|"
                           r"\breceives? fda (approval|clearance)\b"),
    "fda_reject":       _p(r"\bfda (reject\w+|declines?)\b|\b(complete response letter|crl)\b|"
                           r"\b(fails?|failed|misses?) [\w' ]{0,20}(trial|endpoint|study)\b"),
    "legal_action":     _p(r"\b(lawsuit|sued|sues|class action|fined \$|settlement|"
                           r"(sec|doj) (probe|investigation|charges))\b"),
    "antitrust":        _p(r"\bantitrust\b|\b(doj|ftc|eu) (sues?|to sue|blocks?|to block|challenges?)\b|"
                           r"\bmonopoly\b"),
    "gov_bailout":      _p(r"\b(bailout|government rescue|federal (loan|aid|rescue)|rescue package|"
                           r"state aid)\b"),
    "gov_grant":        _p(r"\b(government grant|federal grant|subsid(y|ies)|"
                           r"awarded [\w' ]{0,20}contract|wins? [\w' ]{0,15}(government|federal|defense|dod|doe) contract|"
                           r"chips act (fund\w*|grant|award))\b"),
    "tariff":           _p(r"\b(tariffs?|export controls?|export ban|trade restrictions?)\b"),
    "buyback":          _p(r"\b(buyback|share repurchase|stock repurchase|repurchase program|"
                           r"authoriz\w+ [\w' $]{0,20}repurchase)\b"),
    "dividend_change":  _p(r"\b(raises?|increases?|cuts?|lowers?|suspends?|initiates?|declares?) "
                           r"[\w' ]{0,10}dividend\b|\bdividend (increase|cut|hike|boost|suspension)\b"),
    "offering":         _p(r"\b(secondary offering|public offering|share offering|stock offering|"
                           r"convertible (notes|bond) offering|prices? [\w' $]{0,15}offering|"
                           r"registered direct offering|dilution)\b"),
    "ceo_change":       _p(r"\b(ceo|cfo|chief executive) (steps? down|resigns?|to retire|departs?|"
                           r"named|appointed|to step down)\b|\bnames? new (ceo|cfo)\b|"
                           r"\b(ceo|cfo) (transition|shakeup|ouster)\b"),
    "insider_trade":    _p(r"\binsider (buying|selling|purchase|sale)\b|"
                           r"\b(ceo|cfo|director|insider) (buys?|sells?|purchases?) [\w' ,]{0,15}shares\b|"
                           r"\bform 4\b"),
    "product_launch":   _p(r"\b(unveils?|debuts?|launches? [\w' ]{0,20}(product|model|chip|device|service|app)|"
                           r"announces? [\w' ]{0,15}(launch|release))\b"),
    "product_recall":   _p(r"\b(recalls?|recall of|voluntary recall|safety recall)\b"),
    "restructuring":    _p(r"\b(layoffs?|job cuts?|cuts? [\w' ]{0,10}jobs|"
                           r"to cut [\w' ]{0,10}(jobs|workforce)|restructuring|plant closure|"
                           r"workforce reduction)\b"),
    "short_report":     _p(r"\b(short seller|short report|hindenburg|muddy waters|citron research|"
                           r"alleges? (fraud|accounting))\b"),
}


def categorize(headline, summary=""):
    text = f"{headline or ''} {summary or ''}".strip()
    if not text:
        return set()
    if JUNK.search(text) or HYPOTHETICAL.search(text) or _MACRO_EXCL.search(text):
        return set()
    return {cat for cat, pat in CATEGORY_PATTERNS.items() if pat.search(text)}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest scripts/test_stage1_news_categories.py -q`
Expected: PASS (4 tests). If a single category's regex misses its true fixture, fix that pattern only — do not weaken the fixture. If a NOISE headline tags something, tighten the offending pattern (precision wins).

- [ ] **Step 5: Commit**

```bash
git add scripts/stage1_news_categories.py scripts/test_stage1_news_categories.py
git commit -m "feat(news-cat): multi-label news categorizer (~25 categories) + tests"
```

---

## Task 2: Counter pure helpers (power-n, cluster dedup, report)

**Files:**
- Create: `scripts/stage1_category_count.py` (pure helpers only this task; CLI added in Task 3)
- Test: `scripts/test_stage1_category_count.py`

- [ ] **Step 1: Write the failing test**

```python
# scripts/test_stage1_category_count.py
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from stage1_category_count import required_n_per_split, cluster_dedup, build_report


def test_required_n_matches_stage1_reference():
    # same formula as the Node binomial-stats; 0.55/0.63/0.05/0.80 -> 235
    assert required_n_per_split(0.55, 0.63, 0.05, 0.80) == 235


def test_cluster_dedup_collapses_waves_keeps_distinct():
    dates = ["2024-01-01", "2024-01-03", "2024-01-08", "2024-01-20"]
    # W=5 calendar days: 01-03 within 5 of 01-01 -> dropped; 01-08 (>5 from 01-01) kept; 01-20 kept
    assert cluster_dedup(dates, 5) == ["2024-01-01", "2024-01-08", "2024-01-20"]
    # W=10: 01-08 within 10 of 01-01 -> dropped; 01-20 (>10 from 01-01) kept
    assert cluster_dedup(dates, 10) == ["2024-01-01", "2024-01-20"]


def test_build_report_counts_distinct_and_flags_K():
    # AAA analyst_pt: 480 distinct events (>=470 bar); BBB gov_bailout: 2 events
    events = []
    # 480 analyst_pt events for AAA, each >5 days apart (monthly-ish over many years)
    import datetime
    d = datetime.date(2022, 1, 3)
    for _ in range(480):
        events.append({"ticker": "AAA", "date": d.isoformat(), "category": "analyst_pt"})
        d += datetime.timedelta(days=6)  # >5 apart so none collapse
    events.append({"ticker": "BBB", "date": "2023-05-01", "category": "gov_bailout"})
    events.append({"ticker": "BBB", "date": "2024-05-01", "category": "gov_bailout"})

    rep = build_report(events, window_years=4.42, universe_size=56, w=5)
    assert rep["categories"]["analyst_pt"]["distinct"] == 480
    assert rep["categories"]["analyst_pt"]["clears_uncorrected_470"] is True
    assert rep["categories"]["gov_bailout"]["distinct"] == 2
    assert rep["categories"]["gov_bailout"]["clears_uncorrected_470"] is False
    assert rep["K_committed"] == 1            # only analyst_pt clears
    assert rep["corrected_alpha"] == 0.05 / 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest scripts/test_stage1_category_count.py -q`
Expected: FAIL — `ImportError: cannot import name 'required_n_per_split'`.

- [ ] **Step 3: Write the pure helpers**

```python
# scripts/stage1_category_count.py
"""Per-category news event-frequency counter. Pure helpers (this section) + a CLI (below)
that fetches Alpaca news, categorizes, dedups coverage waves into distinct cluster-
initiations, and reports which categories clear the testability bar + a program go/no-go.
Spec: docs/superpowers/specs/2026-05-31-news-category-frequency-count-design.md
"""
import math
from datetime import date
from statistics import NormalDist

UNCORRECTED_BAR = 470          # ~235/split x2 (0.55->0.63 at alpha=0.05)
P0, P1, POWER = 0.55, 0.63, 0.80


def required_n_per_split(p0, p1, alpha, power=0.80):
    za = NormalDist().inv_cdf(1 - alpha)
    zb = NormalDist().inv_cdf(power)
    num = za * math.sqrt(p0 * (1 - p0)) + zb * math.sqrt(p1 * (1 - p1))
    return math.ceil(num * num / (p1 - p0) ** 2)


def cluster_dedup(dates, w_days):
    """Collapse a (ticker,category) coverage wave: keep a date only if > w_days calendar
    days after the last KEPT date. Distinct cluster-initiations are the only valid SP2
    firings (a follow-up article post-dates the move it would 'predict')."""
    kept, last = [], None
    for d in sorted(dates):
        dd = date.fromisoformat(d)
        if last is None or (dd - last).days > w_days:
            kept.append(d)
            last = dd
    return kept


def build_report(events, window_years, universe_size, w=5, alpha=0.05):
    # group raw coverage events by (category) -> {ticker: [dates]}
    by_cat = {}
    for e in events:
        by_cat.setdefault(e["category"], {}).setdefault(e["ticker"], []).append(e["date"])

    cats = {}
    for cat, by_ticker in by_cat.items():
        distinct = sum(len(cluster_dedup(ds, w)) for ds in by_ticker.values())
        raw = sum(len(ds) for ds in by_ticker.values())
        distinct_by_w = {str(ww): sum(len(cluster_dedup(ds, ww)) for ds in by_ticker.values())
                         for ww in (3, 5, 10)}
        by_year = {}
        for ds in by_ticker.values():
            for d in cluster_dedup(ds, w):
                y = d[:4]
                by_year[y] = by_year.get(y, 0) + 1
        cats[cat] = {
            "distinct": distinct, "raw_coverage": raw, "distinct_by_W": distinct_by_w,
            "per_year": dict(sorted(by_year.items())),
            "events_per_year": round(distinct / window_years, 1) if window_years else 0,
            "clears_uncorrected_470": distinct >= UNCORRECTED_BAR,
        }

    committed = [c for c, v in cats.items() if v["clears_uncorrected_470"]]
    K = max(len(committed), 1)
    corrected_alpha = alpha / K
    corrected_n_split = required_n_per_split(P0, P1, corrected_alpha, POWER)
    for c, v in cats.items():
        epy = v["events_per_year"] or 0.0001
        v["conclusive_at_corrected"] = v["distinct"] >= 2 * corrected_n_split
        v["years_to_corrected_bar"] = round(2 * corrected_n_split / epy, 1)

    return {
        "window_years": window_years, "universe_size": universe_size, "dedup_window_days": w,
        "uncorrected_bar": UNCORRECTED_BAR,
        "K_committed": len(committed), "corrected_alpha": corrected_alpha,
        "corrected_n_per_split": corrected_n_split,
        "testable_uncorrected": sorted(committed),
        "conclusive_at_corrected": sorted(c for c, v in cats.items() if v["conclusive_at_corrected"]),
        "categories": dict(sorted(cats.items(), key=lambda kv: -kv[1]["distinct"])),
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest scripts/test_stage1_category_count.py -q`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/stage1_category_count.py scripts/test_stage1_category_count.py
git commit -m "feat(news-cat): counter pure helpers (power-n, cluster dedup, report)"
```

---

## Task 3: Counter CLI (fetch + categorize + checkpoint + merge + report)

**Files:**
- Modify: `scripts/stage1_category_count.py` (append the CLI block)

This wiring reuses the resumable fetch from `stage1_fetch_catalysts.py` (already retry-hardened) and is verified by the live run, not a unit test (no network in tests).

- [ ] **Step 1: Append the CLI block to `scripts/stage1_category_count.py`**

```python
# --- CLI: resumable fetch -> categorize -> per-month checkpoint -> merge -> report ---
if __name__ == "__main__":
    import json
    import sys
    import time
    from pathlib import Path

    ROOT = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(ROOT / "scripts"))
    from stage1_fetch_catalysts import env, universe, months, fetch_month, FROM, TO
    from stage1_news_categories import categorize

    key_id = env("ALPACA_PUBLIC_KEY", "ALPACA_API_KEY")
    secret = env("ALPACA_SECRET_KEY", "ALPACA_API_SECRET")
    if not key_id or not secret:
        print("missing Alpaca creds", flush=True)
        sys.exit(1)
    uni = universe()
    syms = sorted(uni)
    ckpt_dir = ROOT / "data" / "lab" / "category-events"
    ckpt_dir.mkdir(parents=True, exist_ok=True)

    for label, start, end in months(FROM, TO):
        ck = ckpt_dir / f"{label}.json"
        if ck.exists():
            print(f"{label}: checkpoint exists, skip", flush=True)
            continue
        t0 = time.time()
        items, pages = fetch_month(syms, start, end, key_id, secret)
        rows = []
        for it in items:
            cats = categorize(it.get("headline", ""), it.get("summary", ""))
            if not cats:
                continue
            d = (it.get("created_at") or "")[:10]
            if not d:
                continue
            for s in (it.get("symbols") or []):
                su = s.upper()
                if su in uni:
                    for cat in cats:
                        rows.append({"ticker": su, "date": d, "category": cat})
        ck.write_text(json.dumps(rows), encoding="utf-8")
        print(f"{label}: items={len(items)} pages={pages} category_rows={len(rows)} "
              f"({time.time()-t0:.0f}s)", flush=True)

    events = []
    win = list(months(FROM, TO))
    for label, _, _ in win:
        ck = ckpt_dir / f"{label}.json"
        if ck.exists():
            events.extend(json.loads(ck.read_text(encoding="utf-8")))
    window_years = round(len(win) / 12, 2)
    report = build_report(events, window_years=window_years, universe_size=len(uni), w=5)
    out = ROOT / "data" / "lab" / "category-frequencies.json"
    out.write_text(json.dumps(report, indent=2), encoding="utf-8")

    print(f"\n=== per-category distinct events (W=5), window {window_years}y, "
          f"uncorrected bar {UNCORRECTED_BAR}, K={report['K_committed']}, "
          f"corrected n/split={report['corrected_n_per_split']} ===", flush=True)
    print(f"{'category':<18}{'distinct':>9}{'raw':>7}{'ev/yr':>7}  testable  conclusive", flush=True)
    for cat, v in report["categories"].items():
        print(f"{cat:<18}{v['distinct']:>9}{v['raw_coverage']:>7}{v['events_per_year']:>7.0f}"
              f"  {str(v['clears_uncorrected_470']):>7}  {str(v['conclusive_at_corrected']):>7}", flush=True)
    print(f"\ntestable (clears {UNCORRECTED_BAR}): {report['testable_uncorrected']}", flush=True)
    print(f"conclusive at corrected alpha={report['corrected_alpha']:.4g}: {report['conclusive_at_corrected']}", flush=True)
    print(f"-> GO/NO-GO: continue per-category program only for the conclusive set; "
          f"if it is just analyst/guidance/earnings, the program restates Stage 1 -> STOP.", flush=True)
```

- [ ] **Step 2: Verify the module still imports and unit tests still pass (no network)**

Run: `python -m pytest scripts/test_stage1_category_count.py scripts/test_stage1_news_categories.py -q`
Expected: PASS (7 tests). The `if __name__ == "__main__"` block does not run under pytest import, so adding it must not break the helper tests.

- [ ] **Step 3: Commit**

```bash
git add scripts/stage1_category_count.py
git commit -m "feat(news-cat): counter CLI — resumable fetch + categorize + merge + go/no-go report"
```

---

## After the plan: run it (live, not a test step)

Run the counter (~15 min, resumable per-month; safe to re-run if a connection drops):

```bash
python scripts/stage1_category_count.py
```

Then read `data/lab/category-frequencies.json` + the printed table and make the program go/no-go: **which categories clear the uncorrected bar (defines K), and are any of the novel ones (bailout/grant/FDA/tariff) conclusive — or does it collapse to analyst/guidance/earnings?** That decision feeds the Sub-project 2 brainstorm (or stops the program).

---

## Self-review notes (addressed)

- **Spec coverage:** §2 taxonomy → Task 1 (25 categories). §3.1 categorizer → Task 1. §3.2 counter + cluster dedup → Tasks 2 (dedup) + 3 (fetch/categorize). §3.3 schema → `build_report` (Task 2) emits `distinct`/`raw_coverage`/`distinct_by_W`/`per_year`/`events_per_year`/`clears_uncorrected_470`/`K_committed`/`corrected_alpha`/`corrected_n_per_split`/`testable_uncorrected`/`conclusive_at_corrected`/`years_to_corrected_bar`. §1 fixed-K → `build_report` (K = #clearing uncorrected bar; α/K). §4 testing → per-category fixtures (Task 1) + helper tests (Task 2). §5 notes → honored (distinct primary, raw as reference upper bound; calendar-day dedup approximates the spec's session window for a screen — immaterial, sensitivity reported). §6 handoff → the post-plan go/no-go.
- **Placeholder scan:** none — complete code in every step.
- **Type consistency:** event dict `{ticker, date, category}` consistent across Tasks 2/3; `categorize()` returns `set[str]` used by Task 3; `build_report(events, window_years, universe_size, w)` signature consistent; report keys match the spec schema.
- **Deliberate deviation from spec, flagged (×2):**
  1. **Dedup window in calendar days** (not trading sessions) — a screen-appropriate simplification avoiding a session-calendar dependency; `distinct_by_W` (3/5/10) makes it transparent. One-line change later if session semantics are wanted.
  2. **Categorizer-local macro exclude, not the full shared one.** The spec says reuse the strict trigger's global excludes, but its `MACRO_SUBJECT` includes `tariff`/`trade war`, and `tariff` is one of OUR categories — applying it would zero out the tariff count. So the categorizer reuses `JUNK`+`HYPOTHETICAL` but uses a local macro pattern identical to the trigger's minus tariff/trade-war (still excludes inflation/jobs/Fed/geopolitics, so noise like "Job Growth Beats Expectations" is still dropped). Documented in-code.
```
