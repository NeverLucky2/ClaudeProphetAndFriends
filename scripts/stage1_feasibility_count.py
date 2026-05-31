#!/usr/bin/env python3
"""Stage 1 feasibility gate: how many catalyst-days does Alpaca news yield over the
56-name universe? Catalyst-days are the UPPER BOUND on firings (the agreement filter,
trading-day match, and thinning only reduce it). If even the upper bound, extrapolated
to ~4 years, can't clear ~470 (235/split x2), Stage 1 is UNDERPOWERED -> STOP and we do
NOT build the orchestrator. Reuses the production _classify so this measures the real path.
"""
import json
import os
import sys
import time
import urllib.request
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / ".claude" / "skills" / "catalyst-news" / "scripts"))
sys.path.insert(0, str(ROOT / "scripts"))
from fetch_catalyst_news import _classify  # loose daily-brief classifier (ma|earnings|None)
from stage1_catalyst_trigger import classify_catalyst_strict  # hardened experiment trigger


def _loose(h, t):
    return _classify(f"{h} {t}")[0]


def _strict(h, t):
    return classify_catalyst_strict(h, t)


def load_env(*names):
    for n in names:
        v = os.getenv(n)
        if v:
            return v
    envf = ROOT / ".env"
    if envf.is_file():
        for line in envf.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            if k.strip() in names:
                return v.strip().strip('"').strip("'")
    return None


def load_universe():
    p = ROOT / "config" / "prophet_tradable_universe.txt"
    out = []
    for raw in p.read_text(encoding="utf-8").splitlines():
        s = raw.split("#", 1)[0].strip()
        if s:
            out.append(s.upper())
    return out


def alpaca_news(symbols, start, end, key_id, secret, max_pages=600):
    base = "https://data.alpaca.markets/v1beta1/news"
    headers = {"APCA-API-KEY-ID": key_id, "APCA-API-SECRET-KEY": secret}
    token = None
    pages = 0
    items = []
    while pages < max_pages:
        q = {"symbols": ",".join(symbols), "start": f"{start}T00:00:00Z",
             "end": f"{end}T23:59:59Z", "limit": "50", "sort": "asc"}
        if token:
            q["page_token"] = token
        url = base + "?" + urllib.parse.urlencode(q)
        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                data = json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(2.0)
                continue
            raise
        items.extend(data.get("news") or [])
        token = data.get("next_page_token")
        pages += 1
        if not token:
            break
        time.sleep(0.3)
    return items, pages


def count_window(items, universe, clf):
    """Count unique (ticker, date) catalyst-days under classifier `clf(headline, summary)`."""
    catdays = set()      # (ticker, date)
    by_type = {"ma": 0, "earnings": 0}
    catalyst_items = 0
    for it in items:
        title = it.get("headline") or ""
        text = it.get("summary") or ""
        et = clf(title, text)
        if et is None:
            continue
        catalyst_items += 1
        by_type[et] = by_type.get(et, 0) + 1
        d = (it.get("created_at") or "")[:10]
        for s in (it.get("symbols") or []):
            su = s.upper()
            if su in universe:
                catdays.add((su, d))
    return catdays, by_type, catalyst_items


def main():
    key_id = load_env("ALPACA_PUBLIC_KEY", "ALPACA_API_KEY")
    secret = load_env("ALPACA_SECRET_KEY", "ALPACA_API_SECRET")
    if not key_id or not secret:
        print("MISSING Alpaca creds in .env")
        return 1
    universe = set(load_universe())
    print(f"universe: {len(universe)} tickers")

    # Two sample months (one Q1-earnings-heavy, one mid-quarter) to bracket the rate.
    windows = [("2024-04-01", "2024-04-30"), ("2024-08-01", "2024-08-31")]
    monthly_loose, monthly_strict = [], []
    for start, end in windows:
        t0 = time.time()
        items, pages = alpaca_news(sorted(universe), start, end, key_id, secret)
        cd_l, ty_l, ci_l = count_window(items, universe, _loose)
        cd_s, ty_s, ci_s = count_window(items, universe, _strict)
        monthly_loose.append(len(cd_l))
        monthly_strict.append(len(cd_s))
        print(f"{start[:7]}: news_items={len(items)} pages={pages} ({time.time() - t0:.0f}s)")
        print(f"   loose : catalyst_items={ci_l:>3} catalyst_days={len(cd_l):>3} by_type={ty_l}")
        print(f"   STRICT: catalyst_items={ci_s:>3} catalyst_days={len(cd_s):>3} by_type={ty_s}")

    avg_l = sum(monthly_loose) / len(monthly_loose)
    avg_s = sum(monthly_strict) / len(monthly_strict)
    print("-" * 70)
    print(f"avg catalyst-days/month  loose={avg_l:.0f}  STRICT={avg_s:.0f}  "
          f"(strict keeps {100 * avg_s / max(avg_l, 1):.0f}% of loose)")
    ext = avg_s * 48
    print(f"STRICT extrapolated 4y (48mo) ~= {ext:.0f} catalyst-days  [UPPER BOUND on firings]")
    print(f"Stage 1 needs ~470 INDEPENDENT firings total (235/split x2), BEFORE the")
    print(f"sentiment/price-state agreement filter, thinning (>=3 sessions), and trading-day")
    print(f"match cut it further. Rough rule: firings ~ 0.2-0.4 x catalyst-days.")
    est_lo, est_hi = ext * 0.2, ext * 0.4
    print(f"=> very rough firing estimate: {est_lo:.0f}-{est_hi:.0f} total  "
          f"(~{est_lo/2:.0f}-{est_hi/2:.0f} per split; need >=235/split)")
    if est_lo / 2 >= 235:
        hint = "PLAUSIBLE (even low end clears 235/split) — proceed to Build B"
    elif est_hi / 2 >= 235:
        hint = "MARGINAL (mid/high clears, low end does not) — exact full-window count needed before Build B"
    else:
        hint = "LIKELY UNDERPOWERED -> STOP (even high end misses 235/split)"
    print(f"VERDICT HINT: {hint}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
