#!/usr/bin/env python3
"""QQQ -> AMZN lead-lag analysis.

Two questions:
  (1) SAME-DAY: how tightly does AMZN move with QQQ today? (beta / correlation / R^2)
  (2) NEXT-DAY: does *yesterday's* QQQ move predict *today's* AMZN move, once you
      already know yesterday's AMZN move? (simple lag corr + partial correlation)

Pure-python stats. Reuses the us-stock-analysis skill's FMPClient (auto-loads
FMP_API_KEY from the project-root .env)."""
import sys
from pathlib import Path

SKILL = Path(__file__).resolve().parent / "skills" / "us-stock-analysis" / "scripts"
sys.path.insert(0, str(SKILL))
from fmp_client import FMPClient  # noqa: E402


def closes(client, tkr, days=430):
    rows = client.get_historical_prices(tkr, days=days) or []
    out = {}
    for r in rows:
        dt = r.get("date")
        c = r.get("close", r.get("adjClose"))
        if dt and isinstance(c, (int, float)):
            out[dt[:10]] = float(c)
    return out


def rets(dates, px):
    return [(px[dates[i]] / px[dates[i - 1]]) - 1.0 for i in range(1, len(dates))]


def corr(xs, ys):
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    return sxy / ((sxx * syy) ** 0.5)


def beta(xs, ys):  # slope of ys regressed on xs
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    sxx = sum((x - mx) ** 2 for x in xs)
    return sxy / sxx


def main():
    c = FMPClient()
    a_px, q_px = closes(c, "AMZN"), closes(c, "QQQ")
    common = sorted(set(a_px) & set(q_px))
    a, q = rets(common, a_px), rets(common, q_px)
    n = len(a)

    print(f"Window: {common[1]} .. {common[-1]}  ({n} trading days)")
    print(f"Latest close: AMZN {a_px[common[-1]]:.2f}  QQQ {q_px[common[-1]]:.2f}  ({common[-1]})")

    r_sd = corr(q, a)
    print("\n== SAME-DAY (contemporaneous) ==")
    print(f"  corr(AMZN_t, QQQ_t)            = {r_sd:+.3f}")
    print(f"  beta (AMZN on QQQ)            = {beta(q, a):+.2f}")
    print(f"  R^2 (AMZN var explained QQQ)  = {r_sd ** 2 * 100:.1f}%")

    # next-day predictive test
    Y, X2, X1 = a[1:], q[:-1], a[:-1]          # AMZN_t , QQQ_{t-1} , AMZN_{t-1}
    r_YX2, r_YX1, r_X2X1 = corr(X2, Y), corr(X1, Y), corr(X2, X1)
    pc = (r_YX2 - r_YX1 * r_X2X1) / (((1 - r_YX1 ** 2) * (1 - r_X2X1 ** 2)) ** 0.5)
    df = len(Y) - 3
    t = pc * (df / (1 - pc ** 2)) ** 0.5
    print("\n== NEXT-DAY (predictive: yesterday -> today) ==")
    print(f"  corr(QQQ_t-1 , AMZN_t)        = {r_YX2:+.3f}   <- can yesterday's QQQ predict today's AMZN?")
    print(f"  corr(AMZN_t-1, AMZN_t)        = {r_YX1:+.3f}   <- AMZN's own 1-day carryover")
    print(f"  partial corr (QQQ_t-1 | AMZN_t-1) = {pc:+.3f}   t={t:+.2f}  df={df}")
    print(f"    (|t|>1.96 ~ 5% significant; this tests if QQQ_t-1 adds anything new)")

    for k in (63, 21):
        rq, ra = q[-k:], a[-k:]
        rr = corr(rq, ra)
        print(f"\n== RECENT {k} DAYS (regime check) ==")
        print(f"  corr same-day = {rr:+.3f}   beta = {beta(rq, ra):+.2f}   R^2 = {rr ** 2 * 100:.1f}%")


if __name__ == "__main__":
    main()
