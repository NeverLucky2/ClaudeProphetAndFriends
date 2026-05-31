#!/usr/bin/env python3
"""Fetch the Stage 1 catalyst table from Alpaca news over the full window, classified
by the HARDENED strict trigger. Resumable: writes one checkpoint file per month under
data/lab/catalysts/, then merges into data/lab/catalysts-<from>-<to>.json.

Rows: {ticker, date, event_type, headline, snippet, published}. Multiple rows per
(ticker,date) are fine — the Node orchestrator groups + sums polarity. Catalysts are
attributed to every tagged universe symbol (the orchestrator's bar/agreement filters
and trading-day match cut non-events further).
"""
import json
import os
import sys
import time
import urllib.request
import urllib.parse
import urllib.error
from pathlib import Path
from datetime import date

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from stage1_catalyst_trigger import classify_catalyst_strict

FROM = "2022-01-01"
TO = "2026-05-31"
CKPT_DIR = ROOT / "data" / "lab" / "catalysts"
OUT = ROOT / "data" / "lab" / f"catalysts-2022-2026.json"


def env(*names):
    for n in names:
        if os.getenv(n):
            return os.getenv(n)
    for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if "=" in line and not line.startswith("#"):
            k, _, v = line.partition("=")
            if k.strip() in names:
                return v.strip().strip('"').strip("'")
    return None


def universe():
    out = set()
    for raw in (ROOT / "config" / "prophet_tradable_universe.txt").read_text(encoding="utf-8").splitlines():
        s = raw.split("#", 1)[0].strip()
        if s:
            out.add(s.upper())
    return out


def months(frm, to):
    y, m = int(frm[:4]), int(frm[5:7])
    ey, em = int(to[:4]), int(to[5:7])
    while (y, m) <= (ey, em):
        start = f"{y:04d}-{m:02d}-01"
        ny, nm = (y + 1, 1) if m == 12 else (y, m + 1)
        # last day of month = day before first of next month
        from datetime import timedelta
        end = (date(ny, nm, 1) - timedelta(days=1)).isoformat()
        yield f"{y:04d}-{m:02d}", start, end
        y, m = ny, nm


def fetch_month(symbols, start, end, key_id, secret, max_pages=800):
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
        data = None
        for attempt in range(7):
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    data = json.loads(r.read().decode())
                break
            except urllib.error.HTTPError as e:
                if e.code == 429 or 500 <= e.code < 600:
                    time.sleep(min(2 ** attempt, 30))
                    continue
                raise
            except (urllib.error.URLError, TimeoutError, ConnectionError, OSError):
                # transient connection reset / DNS / timeout — back off and retry
                time.sleep(min(2 ** attempt, 30))
                continue
        if data is None:
            raise RuntimeError(f"fetch failed after retries: {start} page {pages}")
        items.extend(data.get("news") or [])
        token = data.get("next_page_token")
        pages += 1
        if not token:
            break
        time.sleep(0.3)
    return items, pages


def rows_from_items(items, uni):
    rows = []
    for it in items:
        headline = it.get("headline") or ""
        summary = it.get("summary") or ""
        et = classify_catalyst_strict(headline, summary)
        if et is None:
            continue
        d = (it.get("created_at") or "")[:10]
        if not d:
            continue
        for s in (it.get("symbols") or []):
            su = s.upper()
            if su in uni:
                rows.append({"ticker": su, "date": d, "event_type": et,
                             "headline": headline, "snippet": summary,
                             "published": it.get("created_at")})
    return rows


def main():
    key_id = env("ALPACA_PUBLIC_KEY", "ALPACA_API_KEY")
    secret = env("ALPACA_SECRET_KEY", "ALPACA_API_SECRET")
    if not key_id or not secret:
        print("missing Alpaca creds", flush=True)
        return 1
    uni = universe()
    syms = sorted(uni)
    CKPT_DIR.mkdir(parents=True, exist_ok=True)

    for label, start, end in months(FROM, TO):
        ck = CKPT_DIR / f"{label}.json"
        if ck.exists():
            print(f"{label}: checkpoint exists, skip", flush=True)
            continue
        t0 = time.time()
        items, pages = fetch_month(syms, start, end, key_id, secret)
        rows = rows_from_items(items, uni)
        ck.write_text(json.dumps(rows), encoding="utf-8")
        cd = len({(r["ticker"], r["date"]) for r in rows})
        print(f"{label}: items={len(items)} pages={pages} catalyst_rows={len(rows)} "
              f"catalyst_days={cd} ({time.time()-t0:.0f}s)", flush=True)

    # Merge all checkpoints.
    allrows = []
    for label, _, _ in months(FROM, TO):
        ck = CKPT_DIR / f"{label}.json"
        if ck.exists():
            allrows.extend(json.loads(ck.read_text(encoding="utf-8")))
    OUT.write_text(json.dumps(allrows, indent=2), encoding="utf-8")
    cd = len({(r["ticker"], r["date"]) for r in allrows})
    by_type = {}
    for r in allrows:
        by_type[r["event_type"]] = by_type.get(r["event_type"], 0) + 1
    print(f"MERGED -> {OUT.name}: rows={len(allrows)} unique_catalyst_days={cd} by_type={by_type}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
