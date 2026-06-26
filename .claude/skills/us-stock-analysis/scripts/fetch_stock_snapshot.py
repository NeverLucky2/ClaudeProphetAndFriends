#!/usr/bin/env python3
"""
Fetch a one-shot fundamental snapshot for a single ticker.

Emits a single JSON object on stdout with these top-level keys:
  ticker, quote, profile, ratios_ttm, key_metrics_ttm,
  income_annual, income_quarterly, balance_sheet_annual, cash_flow_annual,
  price_target_consensus, analyst_estimates_annual, recent_news,
  share_context, pt_context

share_context surfaces the share-count trend and a marketCap≈price×shares sanity
check so a surprising price (e.g. after a stock split) can be told apart from corrupt
or stale data without manually digging into the income statement.

pt_context gives the price-target consensus a date (latest analyst update, 90-day
update count, price-vs-consensus gap, stale flag) so a lagging anchor can be told
apart from a genuine sell-side "overvalued" view.

The skill ingests this JSON instead of running 5+ web searches.

Usage:
  python fetch_stock_snapshot.py --ticker SE
  python fetch_stock_snapshot.py --ticker AAPL --annual-years 5 --quarters 4

Exit codes:
  0 success (JSON on stdout)
  1 fatal (missing key, all calls failed, etc.) — stderr explains
"""

import argparse
import json
import sys
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_DIR))

from fmp_client import FMPClient  # noqa: E402


def _shares_trend(income_annual) -> tuple:
    """Return (latest_shares, [{fiscalYear, shares}, ...] oldest-first) from income rows."""
    if not income_annual:
        return None, []
    rows = sorted(
        (r for r in income_annual if r.get("fiscalYear")),
        key=lambda r: str(r.get("fiscalYear")),
    )
    trend = []
    for r in rows:
        sh = r.get("weightedAverageShsOutDil") or r.get("weightedAverageShsOut")
        if sh:
            trend.append({"fiscalYear": str(r.get("fiscalYear")), "shares": float(sh)})
    latest = trend[-1]["shares"] if trend else None
    return latest, trend


def derive_share_context(quote, income_annual) -> dict:
    """Cross-check the quote's implied share count against the reported share count.

    A ratio near 1.0 means the price series and the fundamentals share one basis. A ratio
    far from 1.0 is the signature of an unaccounted stock split (or a large issuance/buyback,
    or a stale/mixed series) — the case that made ServiceNow at $136 look wrong until the
    share count proved it was just split-adjusted.
    """
    latest, trend = _shares_trend(income_annual)
    q = quote or {}
    price, market_cap = q.get("price"), q.get("marketCap")
    implied = (market_cap / price) if (price and market_cap) else None
    ratio = (implied / latest) if (implied and latest) else None

    consistent, note = None, ""
    if ratio is not None:
        consistent = 0.8 <= ratio <= 1.25
        if consistent:
            note = (
                f"Quote-implied (~{implied / 1e6:.0f}M) and latest reported "
                f"(~{latest / 1e6:.0f}M) share counts agree (ratio {ratio:.2f}); "
                f"price basis looks consistent."
            )
        else:
            note = (
                f"Quote implies ~{implied / 1e6:.0f}M shares vs ~{latest / 1e6:.0f}M "
                f"latest reported (ratio {ratio:.2f}). Likely a stock split, large "
                f"issuance/buyback, or a stale/mixed price series — verify the basis "
                f"before trusting the technicals or per-share figures."
            )

    return {
        "shares_outstanding_trend": trend,
        "latest_reported_shares": latest,
        "implied_shares_from_marketcap": round(implied) if implied else None,
        "marketcap_consistency_ratio": round(ratio, 3) if ratio is not None else None,
        "marketcap_consistent": consistent,
        "note": note,
    }


def derive_pt_context(quote, pt_consensus, pt_news, today=None) -> dict:
    """Give the price-target consensus a date so staleness is visible.

    The consensus endpoint carries no publish date or analyst count, so a consensus
    lagging a fast rally (DDOG traded +31% above target) looks identical to a genuine
    sell-side "overvalued" call. Recent per-analyst updates disambiguate: fresh targets
    below the price are informative; stale ones are just an out-of-date anchor.
    """
    from datetime import date, datetime

    today = today or date.today()

    update_dates, recent_updates = [], []
    for item in pt_news or []:
        raw = (item.get("publishedDate") or "")[:10]
        try:
            d = datetime.strptime(raw, "%Y-%m-%d").date()
        except ValueError:
            continue
        update_dates.append(d)
        if len(recent_updates) < 5:
            recent_updates.append({
                "date": d.isoformat(),
                "analystCompany": item.get("analystCompany"),
                "priceTarget": item.get("priceTarget") or item.get("adjPriceTarget"),
            })

    latest = max(update_dates) if update_dates else None
    days_since = (today - latest).days if latest else None
    updates_90d = sum(1 for d in update_dates if (today - d).days <= 90)

    q = quote or {}
    price = q.get("price")
    consensus = (pt_consensus or {}).get("targetConsensus")
    gap_pct = (
        round((price - consensus) / consensus * 100, 1)
        if (price and consensus) else None
    )

    stale = (days_since > 90) if days_since is not None else None

    note = ""
    if stale:
        note = (
            f"Consensus PT is stale — last analyst update {latest.isoformat()} "
            f"({days_since}d ago)."
        )
        if gap_pct is not None and gap_pct > 10:
            note += (
                f" Price is {gap_pct:+.1f}% vs consensus, likely just a lagging "
                f"anchor after a rally — don't treat it as a sell-side view."
            )
    elif stale is False:
        note = (
            f"Consensus PT is current — {updates_90d} update(s) in the last 90d, "
            f"latest {latest.isoformat()}."
        )
        if gap_pct is not None and gap_pct > 10:
            note += (
                f" Price is {gap_pct:+.1f}% above consensus on fresh targets — "
                f"analysts genuinely see less upside; treat as informative."
            )

    return {
        "latest_update_date": latest.isoformat() if latest else None,
        "days_since_latest_update": days_since,
        "updates_last_90d": updates_90d,
        "price_vs_consensus_pct": gap_pct,
        "stale": stale,
        "recent_updates": recent_updates,
        "note": note,
    }


def fetch_snapshot(
    ticker: str, annual_years: int = 5, quarters: int = 4, news_limit: int = 15,
    client: "FMPClient | None" = None,
) -> dict:
    client = client or FMPClient()
    t = ticker.upper()

    snapshot: dict = {"ticker": t}

    snapshot["quote"] = client.get_quote(t)
    snapshot["profile"] = client.get_profile(t)
    snapshot["ratios_ttm"] = client.get_ratios_ttm(t)
    snapshot["key_metrics_ttm"] = client.get_key_metrics_ttm(t)

    snapshot["income_annual"] = client.get_income_statement(t, "annual", annual_years)
    snapshot["income_quarterly"] = client.get_income_statement(t, "quarter", quarters)
    snapshot["balance_sheet_annual"] = client.get_balance_sheet(t, "annual", annual_years)
    snapshot["cash_flow_annual"] = client.get_cash_flow(t, "annual", annual_years)

    snapshot["price_target_consensus"] = client.get_price_target_consensus(t)
    snapshot["analyst_estimates_annual"] = client.get_analyst_estimates(t, "annual", 4)
    snapshot["recent_news"] = client.get_stock_news(t, news_limit)

    snapshot["share_context"] = derive_share_context(snapshot["quote"], snapshot["income_annual"])
    snapshot["pt_context"] = derive_pt_context(
        snapshot["quote"],
        snapshot["price_target_consensus"],
        client.get_price_target_news(t),
    )

    snapshot["_api_stats"] = client.get_api_stats()
    return snapshot


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch FMP fundamental snapshot for a ticker.")
    parser.add_argument("--ticker", required=True, help="Stock ticker (e.g. SE, AAPL)")
    parser.add_argument("--annual-years", type=int, default=5, help="Years of annual statements")
    parser.add_argument("--quarters", type=int, default=4, help="Quarters of quarterly statements")
    parser.add_argument("--news-limit", type=int, default=15, help="Recent news items")
    args = parser.parse_args()

    try:
        snapshot = fetch_snapshot(args.ticker, args.annual_years, args.quarters, args.news_limit)
    except ValueError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1

    if snapshot.get("quote") is None and snapshot.get("profile") is None:
        print(
            f"ERROR: no FMP data returned for ticker '{args.ticker}'. Wrong symbol or rate-limited.",
            file=sys.stderr,
        )
        return 1

    json.dump(snapshot, sys.stdout, indent=2, default=str)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
