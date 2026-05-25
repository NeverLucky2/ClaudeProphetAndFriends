#!/usr/bin/env python3
"""
FMP API Client for Earnings Trade Analyzer

Provides rate-limited access to Financial Modeling Prep API endpoints
for post-earnings trade analysis and scoring.

Features:
- Rate limiting (0.3s between requests)
- Automatic retry on 429 errors
- Session caching for duplicate requests
- API call budget enforcement
- Batch profile support
- Earnings calendar fetching
"""

import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

try:
    import requests
except ImportError:
    print("ERROR: requests library not found. Install with: pip install requests", file=sys.stderr)
    sys.exit(1)


def _load_dotenv_from_ancestors(key: str) -> Optional[str]:
    """Walk up from this script's directory looking for a .env file and return key's value.

    Lets the skill work when the user has FMP_API_KEY in a project-root .env
    but hasn't exported it to the shell environment.
    """
    for d in (Path(__file__).resolve(), *Path(__file__).resolve().parents):
        env_path = d / ".env" if d.is_dir() else d.parent / ".env"
        if env_path.is_file():
            try:
                for line in env_path.read_text(encoding="utf-8").splitlines():
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, _, v = line.partition("=")
                    if k.strip() == key:
                        return v.strip().strip('"').strip("'")
            except OSError:
                pass
    return None


# --- FMP endpoint fallback: stable (new users) -> v3 (legacy users) ---


def _eod_hist_url(base, symbols_str, params):
    """stable/historical-price-eod/full?symbol=^GSPC&from=YYYY-MM-DD&to=YYYY-MM-DD

    Replaces the deprecated /historical-price-full. Translates legacy
    'timeseries=N' (N trading days) into a from/to date range with a
    1.5x calendar buffer so we cover N trading days even with weekends.
    """
    params["symbol"] = symbols_str
    if "timeseries" in params:
        days = int(params.pop("timeseries"))
        calendar_span = int(days * 1.5) + 30
        to_d = datetime.now(timezone.utc).date()
        from_d = to_d - timedelta(days=calendar_span)
        params["from"] = from_d.isoformat()
        params["to"] = to_d.isoformat()
    return base, params


def _stable_hist_url(base, symbols_str, params):
    """stable/historical-price-full?symbol=SPY&timeseries=90 (legacy)"""
    params["symbol"] = symbols_str
    return base, params


def _v3_hist_url(base, symbols_str, params):
    """api/v3/historical-price-full/SPY?timeseries=90 (legacy)"""
    return f"{base}/{symbols_str}", params


_FMP_ENDPOINTS = {
    "historical": [
        ("https://financialmodelingprep.com/stable/historical-price-eod/full", _eod_hist_url),
        ("https://financialmodelingprep.com/stable/historical-price-full", _stable_hist_url),
        ("https://financialmodelingprep.com/api/v3/historical-price-full", _v3_hist_url),
    ],
}


def _normalize_stable_profile(profile: dict) -> dict:
    """Map stable /profile field names onto the v3 keys callers expect.

    The stable profile endpoint renames several fields (marketCap vs v3's
    mktCap, exchange vs exchangeShortName). Add the v3 aliases so the market-cap
    and US-exchange filters — written against v3 — keep working regardless of
    which tier served the profile.
    """
    if not isinstance(profile, dict):
        return profile
    if "mktCap" not in profile and "marketCap" in profile:
        profile["mktCap"] = profile["marketCap"]
    if "exchangeShortName" not in profile and "exchange" in profile:
        profile["exchangeShortName"] = profile["exchange"]
    return profile


class ApiCallBudgetExceeded(Exception):
    """Raised when the API call budget has been exhausted."""

    pass


class FMPClient:
    """Client for Financial Modeling Prep API with rate limiting, caching, and budget control"""

    BASE_URL = "https://financialmodelingprep.com/api/v3"
    RATE_LIMIT_DELAY = 0.3  # 300ms between requests
    US_EXCHANGES = ["NYSE", "NASDAQ", "AMEX", "NYSEArca", "BATS", "NMS", "NGM", "NCM"]

    _ENDPOINT_FAILURE_THRESHOLD = 3  # disable endpoint after N consecutive failures

    def __init__(self, api_key: Optional[str] = None, max_api_calls: int = 200):
        self.api_key = (
            api_key
            or os.getenv("FMP_API_KEY")
            or _load_dotenv_from_ancestors("FMP_API_KEY")
        )
        if not self.api_key:
            raise ValueError(
                "FMP API key required. Set FMP_API_KEY environment variable, "
                "add it to a project .env file, or pass api_key parameter."
            )
        self.session = requests.Session()
        self.session.headers.update({"apikey": self.api_key})
        self.cache = {}
        self.last_call_time = 0
        self.rate_limit_reached = False
        self.retry_count = 0
        self.max_retries = 1
        self.api_calls_made = 0
        self.max_api_calls = max_api_calls
        # Circuit breaker: track consecutive failures per endpoint URL prefix
        self._endpoint_failures: dict[str, int] = {}
        self._disabled_endpoints: set[str] = set()

    def _rate_limited_get(
        self, url: str, params: Optional[dict] = None, quiet: bool = False
    ) -> Optional[dict]:
        """Execute a rate-limited GET request with budget enforcement."""
        if self.rate_limit_reached:
            return None

        if self.api_calls_made >= self.max_api_calls:
            raise ApiCallBudgetExceeded(
                f"API call budget exceeded: {self.api_calls_made}/{self.max_api_calls} calls used."
            )

        if params is None:
            params = {}

        elapsed = time.time() - self.last_call_time
        if elapsed < self.RATE_LIMIT_DELAY:
            time.sleep(self.RATE_LIMIT_DELAY - elapsed)

        try:
            response = self.session.get(url, params=params, timeout=30)
            self.last_call_time = time.time()
            self.api_calls_made += 1

            if response.status_code == 200:
                self.retry_count = 0
                return response.json()
            elif response.status_code == 429:
                self.retry_count += 1
                if self.retry_count <= self.max_retries:
                    print("WARNING: Rate limit exceeded. Waiting 60 seconds...", file=sys.stderr)
                    time.sleep(60)
                    return self._rate_limited_get(url, params, quiet=quiet)
                else:
                    print("ERROR: Daily API rate limit reached.", file=sys.stderr)
                    self.rate_limit_reached = True
                    return None
            else:
                if not quiet:
                    print(
                        f"ERROR: API request failed: {response.status_code} - {response.text[:200]}",
                        file=sys.stderr,
                    )
                return None
        except requests.exceptions.Timeout:
            print(f"WARNING: Request timed out for {url}", file=sys.stderr)
            return None
        except requests.exceptions.RequestException as e:
            print(f"ERROR: Request exception: {e}", file=sys.stderr)
            return None

    def _request_with_fallback(self, endpoint_key, symbols_str, extra_params=None):
        """Try stable endpoint first, fall back to v3 for legacy users.

        Returns parsed JSON in v3-compatible shape, or None if all fail.
        Non-last endpoints use quiet=True to suppress expected 403 stderr.
        """
        params = dict(extra_params) if extra_params else {}
        endpoints = _FMP_ENDPOINTS[endpoint_key]
        is_single = "," not in symbols_str

        for i, (base_url, url_builder) in enumerate(endpoints):
            # Circuit breaker: skip endpoints with too many consecutive failures
            if base_url in self._disabled_endpoints:
                continue

            url, final_params = url_builder(base_url, symbols_str, dict(params))
            is_last = i == len(endpoints) - 1
            data = self._rate_limited_get(url, final_params, quiet=not is_last)
            if not data:  # falsy (None, [], {}) -- try next endpoint
                self._record_endpoint_failure(base_url)
                continue

            # Shape validation: reject truthy-but-wrong-shape responses
            valid = True
            if endpoint_key == "historical":
                # New stable EOD endpoint returns a flat list of OHLCV records.
                # Normalize into the v3-compatible {"symbol", "historical": [...]} shape.
                if isinstance(data, list):
                    if not data or not isinstance(data[0], dict) or "date" not in data[0]:
                        valid = False
                    else:
                        max_records = params.get("timeseries")
                        records = data[: int(max_records)] if max_records else data
                        self._endpoint_failures[base_url] = 0
                        return {"symbol": symbols_str, "historical": records}
                elif not isinstance(data, dict):
                    valid = False
                elif "historicalStockList" in data:
                    # stable batch format -> v3 single format (exact match only)
                    norm = symbols_str.replace("-", ".")
                    found = None
                    for entry in data["historicalStockList"]:
                        if entry.get("symbol", "").replace("-", ".") == norm:
                            found = {
                                "symbol": entry.get("symbol"),
                                "historical": entry.get("historical", []),
                            }
                            break
                    if found:
                        self._endpoint_failures[base_url] = 0
                        return found
                    valid = False
                elif "historical" not in data:
                    valid = False
                elif is_single and data.get("symbol"):
                    if data["symbol"].replace("-", ".") != symbols_str.replace("-", "."):
                        valid = False

            if valid:
                self._endpoint_failures[base_url] = 0
                return data
            self._record_endpoint_failure(base_url)
        return None

    def _record_endpoint_failure(self, base_url: str) -> None:
        """Track consecutive failures and disable endpoint after threshold."""
        failures = self._endpoint_failures.get(base_url, 0) + 1
        self._endpoint_failures[base_url] = failures
        if failures >= self._ENDPOINT_FAILURE_THRESHOLD:
            self._disabled_endpoints.add(base_url)

    def get_earnings_calendar(self, from_date: str, to_date: str) -> Optional[list]:
        """Fetch earnings calendar for a date range.

        Args:
            from_date: Start date (YYYY-MM-DD)
            to_date: End date (YYYY-MM-DD)

        Returns:
            List of earnings announcements or None on failure.
        """
        cache_key = f"earnings_{from_date}_{to_date}"
        if cache_key in self.cache:
            return self.cache[cache_key]

        params = {"from": from_date, "to": to_date}
        # Stable first (post-Aug-2025 accounts), v3 fallback (legacy). The v3
        # earning_calendar 403s on the starter tier, so without the stable
        # endpoint the analyzer dies in Phase 1 before any historical fetch.
        candidates = [
            ("https://financialmodelingprep.com/stable/earnings-calendar", True),
            (f"{self.BASE_URL}/earning_calendar", False),
        ]
        data = None
        for url, quiet in candidates:
            data = self._rate_limited_get(url, params, quiet=quiet)
            if data:
                break
        if data:
            self.cache[cache_key] = data
        return data

    def get_company_profiles(self, symbols: list[str]) -> dict[str, dict]:
        """Fetch company profiles. v3 batch first (legacy, fast); stable per-symbol fallback.

        On the starter tier the v3 /profile batch 403s, so we fall through to the
        stable /profile?symbol= endpoint one symbol at a time, normalizing its
        renamed fields (marketCap->mktCap, exchange->exchangeShortName) so the
        cap/exchange filters keep working.

        Args:
            symbols: List of ticker symbols

        Returns:
            Dictionary mapping symbol to profile data.
        """
        profiles = {}

        batch_size = 100
        v3_batch_works = True
        for i in range(0, len(symbols), batch_size):
            if not v3_batch_works:
                break
            batch = symbols[i : i + batch_size]
            symbols_str = ",".join(batch)

            cache_key = f"profiles_{symbols_str}"
            if cache_key in self.cache:
                for profile in self.cache[cache_key]:
                    if isinstance(profile, dict):
                        profiles[profile.get("symbol")] = profile
                continue

            url = f"{self.BASE_URL}/profile/{symbols_str}"
            data = self._rate_limited_get(url, quiet=True)
            if data:
                self.cache[cache_key] = data
                for profile in data:
                    if isinstance(profile, dict):
                        profiles[profile.get("symbol")] = profile
            else:
                v3_batch_works = False
                break

        if v3_batch_works and len(profiles) >= len(symbols) * 0.5:
            return profiles

        # Stable per-symbol fallback for post-Aug-2025 accounts.
        stable_url = "https://financialmodelingprep.com/stable/profile"
        for symbol in symbols:
            if symbol in profiles:
                continue
            cache_key = f"profile_stable_{symbol}"
            if cache_key in self.cache:
                cached = self.cache[cache_key]
                if cached:
                    profiles[symbol] = cached
                continue
            data = self._rate_limited_get(stable_url, {"symbol": symbol}, quiet=True)
            if data and isinstance(data, list) and data:
                prof = _normalize_stable_profile(data[0])
                self.cache[cache_key] = prof
                profiles[symbol] = prof
            else:
                self.cache[cache_key] = None

        return profiles

    def get_historical_prices(self, symbol: str, days: int = 250) -> Optional[list[dict]]:
        """Fetch historical daily OHLCV data for a symbol.

        Args:
            symbol: Ticker symbol
            days: Number of trading days to fetch (default: 250)

        Returns:
            List of price dicts (most-recent-first) or None on failure.
        """
        cache_key = f"prices_{symbol}_{days}"
        if cache_key in self.cache:
            return self.cache[cache_key]

        data = self._request_with_fallback("historical", symbol, {"timeseries": days})
        if data and "historical" in data:
            result = data["historical"]
            self.cache[cache_key] = result
            return result
        return None

    def get_api_stats(self) -> dict:
        """Return API usage statistics."""
        return {
            "cache_entries": len(self.cache),
            "api_calls_made": self.api_calls_made,
            "max_api_calls": self.max_api_calls,
            "rate_limit_reached": self.rate_limit_reached,
        }
