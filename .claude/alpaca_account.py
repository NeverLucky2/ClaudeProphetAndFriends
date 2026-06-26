#!/usr/bin/env python3
"""Live Alpaca paper-account snapshot: account P&L, open positions (with options
greeks-free marks), and recent orders (multi-leg expanded). Read-only."""
import os, json, urllib.request, urllib.parse
from datetime import datetime, timezone, timedelta

KEY = os.environ["ALPACA_PUBLIC_KEY"]
SEC = os.environ["ALPACA_SECRET_KEY"]
TRADE = os.environ.get("ALPACA_ENDPOINT", "https://paper-api.alpaca.markets")
H = {"APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SEC, "accept": "application/json"}


def get(path):
    req = urllib.request.Request(f"{TRADE}{path}", headers=H)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def fnum(x, p=2):
    try:
        return f"{float(x):.{p}f}"
    except Exception:
        return str(x)


# ---- account ----
try:
    a = get("/v2/account")
    eq, le = float(a.get("equity", 0)), float(a.get("last_equity", 0))
    print("==== ACCOUNT ====")
    print(f"  equity={fnum(eq)}  last_equity={fnum(le)}  "
          f"day P&L={eq-le:+.2f} ({(eq-le)/le*100 if le else 0:+.2f}%)")
    print(f"  cash={fnum(a.get('cash'))}  buying_power={fnum(a.get('buying_power'))}  "
          f"options_bp={fnum(a.get('options_buying_power'))}")
except Exception as e:
    print("account error:", e)

# ---- positions ----
try:
    pos = get("/v2/positions")
    print(f"\n==== OPEN POSITIONS ({len(pos)}) ====")
    tot = 0.0
    for p in sorted(pos, key=lambda x: x.get("asset_class", "")):
        upl = float(p.get("unrealized_pl") or 0)
        tot += upl
        print(f"  {p['symbol']:<22} {p.get('asset_class',''):<9} "
              f"qty={str(p.get('qty')):>5} {p.get('side',''):<5} "
              f"entry={fnum(p.get('avg_entry_price'))}  mark={fnum(p.get('current_price'))}  "
              f"mv={fnum(p.get('market_value')):>10}  uPL={upl:+.2f} "
              f"({float(p.get('unrealized_plpc') or 0)*100:+.1f}%)")
    print(f"  --- total unrealized P&L: {tot:+.2f}")
except Exception as e:
    print("positions error:", e)

# ---- recent orders ----
try:
    after = (datetime.now(timezone.utc) - timedelta(days=5)).strftime("%Y-%m-%dT%H:%M:%SZ")
    q = urllib.parse.urlencode({"status": "all", "limit": "500",
                                "after": after, "nested": "true"})
    orders = get(f"/v2/orders?{q}")
    print(f"\n==== ORDERS last 5d ({len(orders)}) ====")
    for o in orders:
        sub = (o.get("submitted_at") or "")[:19]
        coid = (o.get("client_order_id") or "")[:28]
        legs = o.get("legs") or []
        head = f"  {sub} {o.get('status',''):<9} {o.get('order_class',''):<6} [{coid}]"
        if legs:
            print(head + f"  MLEG x{o.get('qty')}")
            for lg in legs:
                print(f"      {lg.get('symbol',''):<22} {lg.get('side',''):<10} "
                      f"{lg.get('position_intent',''):<13} qty={lg.get('qty')} "
                      f"st={lg.get('status','')} fill={fnum(lg.get('filled_avg_price'))}")
        else:
            print(head + f"  {o.get('symbol',''):<22} {o.get('side',''):<10} "
                  f"{o.get('position_intent',''):<13} qty={o.get('qty')} "
                  f"st={o.get('status','')} fill={fnum(o.get('filled_avg_price'))}")
except Exception as e:
    print("orders error:", e)
