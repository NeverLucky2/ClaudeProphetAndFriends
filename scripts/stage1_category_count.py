# scripts/stage1_category_count.py
"""Per-category news event-frequency counter. Pure helpers (this section) + a CLI (added
in Task 3) that fetches Alpaca news, categorizes, dedups coverage waves into distinct
cluster-initiations, and reports which categories clear the testability bar + a program
go/no-go. Spec: docs/superpowers/specs/2026-05-31-news-category-frequency-count-design.md
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
