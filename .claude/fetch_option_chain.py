#!/usr/bin/env python3
"""Ad-hoc Alpaca options-chain snapshot puller (bid/ask/mid/spread/IV/delta).
Reads ALPACA_PUBLIC_KEY / ALPACA_SECRET_KEY from env. Free 'indicative' feed
(falls back to opra if asked). Stale marks when market is closed = last session.
"""
import os, sys, json, urllib.request, urllib.parse
from datetime import datetime, timezone

KEY = os.environ.get("ALPACA_PUBLIC_KEY")
SEC = os.environ.get("ALPACA_SECRET_KEY")
BASE = "https://data.alpaca.markets/v1beta1/options/snapshots"


def occ_parse(sym):
    body = sym[-15:]                      # YYMMDD C/P + 8-digit strike = 15 chars
    yy, mm, dd = body[0:2], body[2:4], body[4:6]
    cp = body[6]
    strike = int(body[7:]) / 1000.0
    return sym[:-15], f"20{yy}-{mm}-{dd}", cp, strike


def fetch(underlying, exp, gte, lte, feed="indicative"):
    params = {"feed": feed, "limit": "1000", "expiration_date": exp,
              "strike_price_gte": str(gte), "strike_price_lte": str(lte)}
    url = f"{BASE}/{underlying}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={
        "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SEC,
        "accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def age(ts):
    if not ts:
        return "-"
    try:
        t = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        mins = (datetime.now(timezone.utc) - t).total_seconds() / 60.0
        return f"{t.strftime('%m/%d %H:%M')}Z ({mins/60:.0f}h)"
    except Exception:
        return ts


def cell(x, p=2):
    return f"{x:.{p}f}" if isinstance(x, (int, float)) else "-"


def run(underlying, exp, gte, lte):
    print(f"\n===== {underlying}   exp {exp}   strikes {gte}-{lte} =====")
    feed_used = "indicative"
    try:
        data = fetch(underlying, exp, gte, lte)
    except Exception as e:
        print(f"  indicative failed ({e}); trying opra...")
        feed_used = "opra"
        try:
            data = fetch(underlying, exp, gte, lte, feed="opra")
        except Exception as e2:
            print(f"  ERROR: {e2}")
            return
    snaps = data.get("snapshots", {}) or {}
    if not snaps:
        print("  (no contracts returned — check expiration/strikes/feed)")
        return
    rows = []
    for sym, s in snaps.items():
        _, _, cp, strike = occ_parse(sym)
        q = s.get("latestQuote", {}) or {}
        tr = s.get("latestTrade", {}) or {}
        gk = s.get("greeks", {}) or {}
        bid, ask = q.get("bp"), q.get("ap")
        mid = spr = None
        if isinstance(bid, (int, float)) and isinstance(ask, (int, float)) and ask > 0:
            mid = (bid + ask) / 2
            spr = (ask - bid) / mid * 100 if mid > 0 else None
        iv = s.get("impliedVolatility")
        rows.append((cp, strike, bid, ask, mid, spr,
                     iv * 100 if isinstance(iv, (int, float)) else None,
                     gk.get("delta"), tr.get("p"), q.get("t")))
    rows.sort(key=lambda r: (r[0], r[1]))
    print(f"  feed={feed_used}")
    print(f"  {'T':>1} {'Strike':>7} {'Bid':>7} {'Ask':>7} {'Mid':>7} "
          f"{'Spr%':>5} {'IV%':>5} {'Delta':>6} {'Last':>7}  QuoteTime")
    for cp, k, bid, ask, mid, spr, iv, dl, last, qt in rows:
        print(f"  {cp:>1} {k:>7.1f} {cell(bid):>7} {cell(ask):>7} {cell(mid):>7} "
              f"{cell(spr,1):>5} {cell(iv,1):>5} {cell(dl,3):>6} {cell(last):>7}  {age(qt)}")


if __name__ == "__main__":
    if not KEY or not SEC:
        sys.exit("ALPACA_PUBLIC_KEY / ALPACA_SECRET_KEY not set")
    a = sys.argv[1:]
    if a:  # groups of 4: UNDERLYING EXP GTE LTE
        for i in range(0, len(a), 4):
            run(a[i], a[i+1], float(a[i+2]), float(a[i+3]))
    else:
        run("NVDA", "2026-07-17", 185, 225)
        run("GOOGL", "2026-07-17", 330, 385)
