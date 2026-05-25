# Screener FMP v3→stable Migration (PEAD, FTD, Earnings-Trade-Analyzer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (recommended here — sequential, shared live-FMP starter-tier budget) or superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `pead-screener`, `ftd-detector`, and `earnings-trade-analyzer` skills actually run on the user's FMP **starter tier** (post-Aug-2025 subscription) by porting the proven VCP migration (commit `79bebf7`): swap the dead `historical-price-full` endpoint for `historical-price-eod/full`, add stable fallbacks where only v3 exists, scope PEAD to the tradable universe, and fix Windows cp1252 report writes.

**Architecture:** Each screener's `fmp_client.py` is an independent copy of the same shape (`_FMP_ENDPOINTS` table + `_request_with_fallback` + circuit breaker). The migration template is `market-top-detector`/`vcp-screener` (already migrated). Port the exact same diffs. PEAD additionally gets a `--universe` filter (mirroring VCP's `--universe`, but as an earnings-calendar *filter*, not a symbol-source replacement) and gets wired in `mcp-server.js` like `run_vcp_screener`. FTD and earnings are not MCP-universe-scoped (FTD tracks indices; earnings is not MCP-wired and its `--lookback-days 2` default keeps the fan-out small).

**Tech Stack:** Python 3 (`pytest`), Node 20 ESM (`node:test`), FMP stable REST API.

**Reference commit:** `79bebf7` — `git show 79bebf7 -- .claude/skills/vcp-screener/scripts/fmp_client.py`

**Live-FMP discipline:** The user is on starter tier with a shared key (their agents are off, so live runs are safe but must be economical). Run real invocations with a capped `--max-api-calls` and a lookback wide enough to actually exercise the historical path. Never print non-ASCII to the cp1252 console in verification scripts.

---

## Shared port: the EOD historical endpoint (applies to all three clients)

Every `fmp_client.py` gets the **same three edits** to migrate `historical`. These are quoted verbatim from VCP so they are byte-identical across copies:

**Edit S1 — import** (top of file, after `import time`):
```python
from datetime import datetime, timedelta, timezone
```

**Edit S2 — add the `_eod_hist_url` builder** (immediately before the existing `_stable_hist_url` def):
```python
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
```
Also relabel the two legacy builders' docstrings to end with ` (legacy)` (cosmetic, matches VCP).

**Edit S3 — register the EOD endpoint first** in `_FMP_ENDPOINTS["historical"]`:
```python
    "historical": [
        ("https://financialmodelingprep.com/stable/historical-price-eod/full", _eod_hist_url),
        ("https://financialmodelingprep.com/stable/historical-price-full", _stable_hist_url),
        ("https://financialmodelingprep.com/api/v3/historical-price-full", _v3_hist_url),
    ],
```

**Edit S4 — normalize the flat-array EOD response** in `_request_with_fallback`. Replace the historical block's opening:
```python
            if endpoint_key == "historical":
                if not isinstance(data, dict):
                    valid = False
```
with:
```python
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
```
(The rest of the historical block — `historicalStockList`, `"historical" not in data`, symbol-mismatch — is unchanged.)

`params.get("timeseries")` reads the outer `params` (the original `{"timeseries": N}`); each builder receives its own `dict(params)` copy, so `_eod_hist_url` popping `timeseries` does not affect the slice. Confirmed against VCP.

---

## Task 1: PEAD screener (universe-scope + EOD migration + encoding)

**Files:**
- Modify: `.claude/skills/pead-screener/scripts/fmp_client.py` (EOD migration S1–S4)
- Modify: `.claude/skills/pead-screener/scripts/screen_pead.py` (`--universe` arg + Mode A filter)
- Modify: `.claude/skills/pead-screener/scripts/report_generator.py:50,162` (encoding)
- Modify: `mcp-server.js` (`run_pead_screener` passes `--universe`)
- Test: `.claude/skills/pead-screener/scripts/tests/test_pead_screener.py` (add EOD + universe tests)

- [ ] **Step 1: Write failing test for EOD normalization** — add to `TestFMPClient` in `test_pead_screener.py`:

```python
    @patch("fmp_client.requests.Session")
    def test_historical_eod_flat_array_normalized(self, mock_session_class):
        """stable EOD endpoint returns a flat list -> normalized to {symbol, historical} and sliced."""
        mock_session = MagicMock()
        eod_rows = [{"date": f"2026-05-{20 - i:02d}", "open": 1.0, "high": 2.0,
                     "low": 0.5, "close": 1.5, "volume": 100} for i in range(5)]
        resp = MagicMock(status_code=200)
        resp.json.return_value = eod_rows
        resp.text = "ok"
        mock_session.get.return_value = resp
        mock_session_class.return_value = mock_session

        client = FMPClient(api_key="test_key", max_api_calls=200)
        client.session = mock_session
        client.RATE_LIMIT_DELAY = 0

        result = client.get_historical_prices("AAPL", days=3)
        assert result is not None
        assert result["symbol"] == "AAPL"
        assert len(result["historical"]) == 3  # sliced to timeseries
        assert result["historical"][0]["close"] == 1.5
        # EOD is the first endpoint -> exactly one HTTP call
        assert mock_session.get.call_count == 1
```

- [ ] **Step 2: Run it — verify it fails**

Run: `python -m pytest ".claude/skills/pead-screener/scripts/tests/test_pead_screener.py::TestFMPClient::test_historical_eod_flat_array_normalized" -q`
Expected: FAIL (current code hits `historical-price-full` first, treats the flat list as wrong-shape → falls through → makes 3 calls / returns None).

- [ ] **Step 3: Apply EOD migration S1–S4 to `pead-screener/scripts/fmp_client.py`**

Apply the four shared edits above. PEAD's `get_historical_prices` returns the full dict (`{"symbol","historical"}`), so no caller change.

- [ ] **Step 4: Run the EOD test + full PEAD suite — verify green**

Run: `python -m pytest ".claude/skills/pead-screener/scripts/tests/test_pead_screener.py" -q`
Expected: PASS (new test green; `TestFMPClient::test_api_timeout` still returns None — now after 3 endpoint attempts).

- [ ] **Step 5: Write failing test for `--universe` Mode A filtering** — add a new test class to `test_pead_screener.py`:

```python
class TestUniverseFilter:
    """Mode A filters the earnings calendar to the tradable universe BEFORE profile fan-out."""

    def test_universe_filters_before_profiles(self):
        import screen_pead
        from types import SimpleNamespace

        client = MagicMock()
        client.get_earnings_calendar.return_value = [
            {"symbol": "AAPL", "date": "2026-05-20", "time": "amc"},
            {"symbol": "ZZZZ", "date": "2026-05-20", "time": "bmo"},  # not in universe
            {"symbol": "MSFT", "date": "2026-05-21", "time": "amc"},
        ]
        # profiles returns mktCap for whatever symbols it is asked about
        client.get_company_profiles.side_effect = lambda syms: {
            s: {"mktCap": 3_000_000_000} for s in syms
        }
        client.get_api_stats.return_value = {"budget_remaining": 200}

        args = SimpleNamespace(
            lookback_days=14, min_market_cap=500_000_000, universe=["AAPL", "MSFT"]
        )
        candidates = screen_pead._get_candidates_mode_a(client, args)

        symbols_profiled = set(client.get_company_profiles.call_args[0][0])
        assert symbols_profiled == {"AAPL", "MSFT"}  # ZZZZ filtered out pre-profile
        assert {c["symbol"] for c in candidates} == {"AAPL", "MSFT"}
```

- [ ] **Step 6: Run it — verify it fails**

Run: `python -m pytest ".claude/skills/pead-screener/scripts/tests/test_pead_screener.py::TestUniverseFilter" -q`
Expected: FAIL — `parse_arguments` has no `--universe`, and `_get_candidates_mode_a` profiles all 3 symbols (`AttributeError`/assertion on `{'AAPL','MSFT','ZZZZ'}`).

- [ ] **Step 7: Add `--universe` arg in `parse_arguments`** (in the Mode A arguments block, after `--min-market-cap`):

```python
    parser.add_argument(
        "--universe",
        nargs="+",
        help="Restrict the earnings calendar to these symbols (Mode A). "
        "Bypasses the whole-market profile fan-out that exhausts the API budget "
        "on the starter tier; mirror of the VCP screener's --universe.",
    )
```

- [ ] **Step 8: Filter earnings to the universe in `_get_candidates_mode_a`** — immediately after the `print(f"  Raw earnings events: {len(earnings)}")` line and before `# Get unique symbols`:

```python
    # Scope to the tradable universe BEFORE the profile fan-out. Without this,
    # Mode A pulls a whole-market calendar (~3.7k events) and fetches one profile
    # per symbol, blowing the --max-api-calls budget on the starter tier before
    # the market-cap filter can run.
    universe = getattr(args, "universe", None)
    if universe:
        allowed = {u.upper() for u in universe}
        earnings = [e for e in earnings if (e.get("symbol") or "").upper() in allowed]
        print(f"  After universe filter ({len(allowed)} symbols): {len(earnings)} events")
```

- [ ] **Step 9: Run the universe test + full suite — verify green**

Run: `python -m pytest ".claude/skills/pead-screener/scripts/tests/test_pead_screener.py" -q`
Expected: PASS (all).

- [ ] **Step 10: Add `encoding="utf-8"` to `report_generator.py` writes** (defensive — company/sector names from FMP profiles can be non-ASCII):

`.claude/skills/pead-screener/scripts/report_generator.py`, both occurrences:
```python
    with open(output_file, "w", encoding="utf-8") as f:
```
(line 50 JSON, line 162 markdown — use `replace_all`).

- [ ] **Step 11: Wire `--universe` into `mcp-server.js` `run_pead_screener`** — replace the spawnBg arg array and the stale "not yet scoped" comment.

Change the comment block above the log capture to:
```javascript
        // Scope the screen to Prophet's tradable universe and capture output to a
        // per-run log. Without --universe, Mode A pulls the whole-market earnings
        // calendar and fetches a profile per symbol, exhausting the FMP starter-tier
        // call budget before it can write a report (mirror of run_vcp_screener).
```
Replace the spawn:
```javascript
        const universe = await loadProphetUniverse(PROPHET_UNIVERSE_PATH);
        const proc = spawnBg(PYTHON_BIN, [
          path.join(process.cwd(), '.claude/skills/pead-screener/scripts/screen_pead.py'),
          '--output-dir', REPORTS_DIR,
          '--universe', ...universe,
        ], {
          cwd: process.cwd(),
          env: { ...process.env, FMP_API_KEY: fmpKey },
          stdio: peadLogFd !== null ? ['ignore', peadLogFd, peadLogFd] : 'ignore',
          detached: false,
        });
```
And update the return message to mention `over ${universe.length} universe symbols` (mirror VCP's wording).

- [ ] **Step 12: Verify the JS loader test still passes** (the loader is the only unit-testable JS piece; the spawn wrapper is verified e2e in Step 13):

Run: `node --test mcp-tools/prophet-universe.test.mjs`
Expected: PASS (8/8).

- [ ] **Step 13: End-to-end live run** (mirrors exactly what `run_pead_screener` now invokes; widen lookback so ≥1 universe member actually has earnings and the historical path runs; cap the budget):

Run (PowerShell; `$U` = universe from config):
```powershell
$key = (Select-String '^FMP_API_KEY=' .env).Line.Split('=',2)[1]
$U = Get-Content config/prophet_tradable_universe.txt | ForEach-Object { ($_ -split '#')[0].Trim() } | Where-Object { $_ }
$env:FMP_API_KEY=$key
python .claude/skills/pead-screener/scripts/screen_pead.py --output-dir data/reports --universe $U --lookback-days 45 --max-api-calls 80
```
Expected: exit 0; log shows `After universe filter (...)`, profiles fetched only for universe members, ≥1 historical fetch with no `403`/`Legacy Endpoint`, a `pead_screener_*.json` + `.md` written. If 0 candidates even at 45 days, confirm via the stderr that the calendar+profile+at-least-one-historical calls returned 200 (pipeline proven) and note it.

- [ ] **Step 14: Confirm exit code + report**

Run: `Get-ChildItem data/reports/pead_screener_*.json | Sort-Object LastWriteTime | Select-Object -Last 1`
Expected: a fresh JSON whose `metadata.api_stats` shows calls made and `rate_limit_reached=false`.

- [ ] **Step 15: Commit (one squashed commit for PEAD)**

```bash
git add .claude/skills/pead-screener mcp-server.js docs/superpowers/plans/2026-05-24-screener-fmp-stable-migration.md
git commit -m "fix(pead-screener): scope to tradable universe + migrate to FMP stable API"
```

---

## Task 2: FTD detector (EOD migration + batch-quote one-per-call + encoding)

**Files:**
- Modify: `.claude/skills/ftd-detector/scripts/fmp_client.py` (EOD migration S1–S4 + `get_batch_quotes`)
- Modify: `.claude/skills/ftd-detector/scripts/report_generator.py:13,342` (encoding — **critical**, statically emits `─`)
- Test: `.claude/skills/ftd-detector/scripts/tests/test_fmp_client.py` (add EOD + batch tests; fix one endpoint-count test)

- [ ] **Step 1: Write failing test for EOD normalization** — add to `TestResponseNormalization` in `test_fmp_client.py`:

```python
    def test_historical_eod_flat_array_normalized(self):
        """stable EOD flat list -> normalized to {symbol, historical}, sliced to timeseries."""
        client = _make_client()
        eod_rows = [{"date": f"2026-05-{20 - i:02d}", "open": 5000.0, "high": 5010.0,
                     "low": 4990.0, "close": 5000.0, "volume": 3_000_000_000}
                    for i in range(5)]
        resp = _mock_response(200, eod_rows)
        client.session.get = MagicMock(return_value=resp)

        result = client.get_historical_prices("^GSPC", days=3)
        assert result is not None
        assert result["symbol"] == "^GSPC"
        assert len(result["historical"]) == 3
        assert client.session.get.call_count == 1
```

- [ ] **Step 2: Write failing test for one-request-per-symbol batch quotes** — add to `TestSymbolMismatch` (or a new class) in `test_fmp_client.py`:

```python
    def test_batch_quotes_one_request_per_symbol(self):
        """get_batch_quotes issues one stable/quote request per symbol (no comma batching)."""
        client = _make_client()

        def per_symbol(url, params=None, timeout=None):
            sym = (params or {}).get("symbol")
            return _mock_response(200, [{"symbol": sym, "price": 1.0}])

        client.session.get = MagicMock(side_effect=per_symbol)
        result = client.get_batch_quotes(["AAA", "BBB", "CCC"])
        assert set(result.keys()) == {"AAA", "BBB", "CCC"}
        # One request per symbol — never a comma-joined batch
        assert client.session.get.call_count == 3
        for call in client.session.get.call_args_list:
            assert "," not in (call.kwargs.get("params") or {}).get("symbol", "")
```

- [ ] **Step 3: Run both — verify they fail**

Run: `python -m pytest ".claude/skills/ftd-detector/scripts/tests/test_fmp_client.py::TestResponseNormalization::test_historical_eod_flat_array_normalized" ".claude/skills/ftd-detector/scripts/tests/test_fmp_client.py::TestSymbolMismatch::test_batch_quotes_one_request_per_symbol" -q`
Expected: both FAIL (no EOD endpoint; `get_batch_quotes` comma-batches 5/request → call_count 1, symbol contains commas).

- [ ] **Step 4: Apply EOD migration S1–S4** to `ftd-detector/scripts/fmp_client.py`.

- [ ] **Step 5: Rewrite `get_batch_quotes` to one-per-call** (port from VCP). Replace the current method body:

```python
    def get_batch_quotes(self, symbols: list[str]) -> dict[str, dict]:
        """Fetch quotes for a list of symbols, one request per symbol.

        FMP's stable/quote serves a single symbol per request — a
        comma-separated multi-symbol query returns [], and the dedicated
        stable/batch-quote endpoint requires a paid tier (HTTP 402). Legacy
        v3 accepted comma batches, but single-symbol works on both tiers, so
        we fetch individually (get_quote retains the stable->v3 fallback).
        """
        results = {}
        for sym in symbols:
            quotes = self.get_quote(sym)
            if quotes:
                for q in quotes:
                    results[q["symbol"]] = q
        return results
```

- [ ] **Step 6: Fix the endpoint-count regression in the existing test.** `test_historical_batch_no_match_returns_none_when_v3_also_fails` now has three historical endpoints to exhaust, not two. Update its `side_effect` to provide a third failing response:

```python
        stable_resp = _mock_response(200, batch_data)
        v3_resp = _mock_response(403)

        # Three historical endpoints now: EOD, legacy stable, v3. EOD gets the
        # no-match batch (rejected), the other two 403 -> overall None.
        client.session.get = MagicMock(side_effect=[stable_resp, v3_resp, v3_resp])
```
(Intent unchanged: when every endpoint fails/mismatches, the result is `None`.)

- [ ] **Step 7: Run the full FTD client suite — verify green**

Run: `python -m pytest ".claude/skills/ftd-detector/scripts/tests/test_fmp_client.py" -q`
Expected: PASS (all, including the 2 new tests and the fixed regression test).

- [ ] **Step 8: Add `encoding="utf-8"` to `report_generator.py` writes** (**critical** — the markdown statically contains `─` U+2500; on Windows cp1252 the current write crashes with `UnicodeEncodeError`):

`.claude/skills/ftd-detector/scripts/report_generator.py`, both occurrences:
```python
    with open(output_file, "w", encoding="utf-8") as f:
```
(line 13 JSON, line 342 markdown — use `replace_all`).

- [ ] **Step 9: Run the rest of the FTD suite (rally tracker, post-FTD)** — confirm no collateral breakage:

Run: `python -m pytest ".claude/skills/ftd-detector/scripts/tests/" -q`
Expected: PASS (all).

- [ ] **Step 10: End-to-end live run** (mirrors `run_ftd_check`; FTD needs index history with volume — verify ^GSPC/QQQ EOD returns OHLCV on starter tier):

Run (PowerShell):
```powershell
$key = (Select-String '^FMP_API_KEY=' .env).Line.Split('=',2)[1]
$env:FMP_API_KEY=$key
python .claude/skills/ftd-detector/scripts/ftd_detector.py --output-dir data/reports
```
Expected: exit 0; "Fetching S&P 500 history... OK (N days)" with N≥60, NASDAQ OK, no `403`, a `ftd_detector_*.json` + `.md` written (markdown write no longer crashes on `─`).

- [ ] **Step 11: Confirm report + index volume present**

Run: `Get-ChildItem data/reports/ftd_detector_*.json | Sort-Object LastWriteTime | Select-Object -Last 1`
Expected: fresh JSON with a real `combined_state`/`quality_score` (proves the EOD history with volume drove the state machine).

- [ ] **Step 12: Commit (one squashed commit for FTD)**

```bash
git add .claude/skills/ftd-detector
git commit -m "fix(ftd-detector): migrate to FMP stable API + utf-8 report writes"
```

---

## Task 3: Earnings trade analyzer (EOD + calendar fallback + profiles fallback + encoding)

This client is the most outdated: `get_earnings_calendar` and `get_company_profiles` are **v3-only** (both 403 on starter tier), so the analyzer currently dies in Phase 1 before any historical fetch.

**Files:**
- Modify: `.claude/skills/earnings-trade-analyzer/scripts/fmp_client.py` (EOD S1–S4 + calendar stable fallback + profiles stable fallback)
- Modify: `.claude/skills/earnings-trade-analyzer/scripts/report_generator.py:114,266` (encoding)
- Test: `.claude/skills/earnings-trade-analyzer/scripts/tests/test_earnings_trade_analyzer.py` (add EOD + calendar-fallback + profiles-fallback tests)

- [ ] **Step 1: Write failing tests** — add to `TestFMPClient` in `test_earnings_trade_analyzer.py`:

```python
    def test_historical_eod_flat_array_normalized(self):
        """stable EOD flat list -> get_historical_prices returns the sliced historical list."""
        client = FMPClient(api_key="test_key", max_api_calls=200)
        client.RATE_LIMIT_DELAY = 0
        eod_rows = [{"date": f"2026-05-{20 - i:02d}", "open": 1.0, "high": 2.0,
                     "low": 0.5, "close": 1.5, "volume": 100} for i in range(5)]
        resp = MagicMock(status_code=200)
        resp.json.return_value = eod_rows
        resp.text = "ok"
        client.session.get = MagicMock(return_value=resp)

        result = client.get_historical_prices("AAPL", days=3)  # returns a LIST here
        assert isinstance(result, list)
        assert len(result) == 3
        assert client.session.get.call_count == 1

    def test_earnings_calendar_stable_first_v3_fallback(self):
        """stable earnings-calendar 403 -> falls back to v3 earning_calendar."""
        client = FMPClient(api_key="test_key", max_api_calls=200)
        client.RATE_LIMIT_DELAY = 0
        cal = [{"symbol": "AAPL", "date": "2026-05-20", "time": "amc"}]
        stable_403 = MagicMock(status_code=403, text="Legacy Endpoint")
        stable_403.json.return_value = None
        v3_ok = MagicMock(status_code=200, text="ok")
        v3_ok.json.return_value = cal
        client.session.get = MagicMock(side_effect=[stable_403, v3_ok])

        result = client.get_earnings_calendar("2026-05-18", "2026-05-20")
        assert result == cal
        assert client.session.get.call_count == 2

    def test_company_profiles_stable_per_symbol_when_v3_batch_fails(self):
        """v3 batch profile 403 -> stable per-symbol fallback returns profiles."""
        client = FMPClient(api_key="test_key", max_api_calls=200)
        client.RATE_LIMIT_DELAY = 0

        def fake_get(url, params=None, timeout=None):
            if "/profile/" in url:  # v3 batch -> 403
                r = MagicMock(status_code=403, text="Legacy Endpoint")
                r.json.return_value = None
                return r
            # stable/profile?symbol=XXX -> 200 single-element list
            sym = (params or {}).get("symbol")
            r = MagicMock(status_code=200, text="ok")
            r.json.return_value = [{"symbol": sym, "mktCap": 1_000_000_000}]
            return r

        client.session.get = MagicMock(side_effect=fake_get)
        profiles = client.get_company_profiles(["AAA", "BBB"])
        assert set(profiles.keys()) == {"AAA", "BBB"}
        assert profiles["AAA"]["mktCap"] == 1_000_000_000
```

- [ ] **Step 2: Run them — verify they fail**

Run: `python -m pytest ".claude/skills/earnings-trade-analyzer/scripts/tests/test_earnings_trade_analyzer.py::TestFMPClient" -q`
Expected: the 3 new tests FAIL (no EOD endpoint; calendar is v3-only so a 403 returns None without trying anything else; profiles is v3-only so a 403 yields empty dict).

- [ ] **Step 3: Apply EOD migration S1–S4** to `earnings-trade-analyzer/scripts/fmp_client.py`. Note `get_historical_prices` here extracts `data["historical"]` and returns the **list** — that contract is preserved.

- [ ] **Step 4: Add stable fallback to `get_earnings_calendar`** — replace the v3-only body. Port PEAD's pattern:

```python
        cache_key = f"earnings_{from_date}_{to_date}"
        if cache_key in self.cache:
            return self.cache[cache_key]

        params = {"from": from_date, "to": to_date}
        # Stable first (post-Aug-2025 accounts), v3 fallback (legacy).
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
```

- [ ] **Step 5: Add stable per-symbol fallback to `get_company_profiles`** — replace the v3-only batch body with PEAD's two-stage approach (v3 batch first, stable per-symbol fallback):

```python
    def get_company_profiles(self, symbols: list[str]) -> dict[str, dict]:
        """Fetch company profiles. v3 batch first (legacy, fast); stable per-symbol fallback.

        On the starter tier the v3 /profile batch 403s, so we fall through to the
        stable /profile?symbol= endpoint one symbol at a time.
        """
        results = {}

        batch_size = 100
        v3_batch_works = True
        for i in range(0, len(symbols), batch_size):
            if not v3_batch_works:
                break
            batch = symbols[i : i + batch_size]
            batch_str = ",".join(batch)
            cache_key = f"profiles_{batch_str}"
            if cache_key in self.cache:
                for profile in self.cache[cache_key]:
                    if isinstance(profile, dict):
                        results[profile.get("symbol")] = profile
                continue
            url = f"{self.BASE_URL}/profile/{batch_str}"
            data = self._rate_limited_get(url, quiet=True)
            if data:
                self.cache[cache_key] = data
                for profile in data:
                    if isinstance(profile, dict):
                        results[profile.get("symbol")] = profile
            else:
                v3_batch_works = False
                break

        if v3_batch_works and len(results) >= len(symbols) * 0.5:
            return results

        # Stable per-symbol fallback for post-Aug-2025 accounts.
        stable_url = "https://financialmodelingprep.com/stable/profile"
        for symbol in symbols:
            if symbol in results:
                continue
            cache_key = f"profile_stable_{symbol}"
            if cache_key in self.cache:
                cached = self.cache[cache_key]
                if cached:
                    results[symbol] = cached
                continue
            data = self._rate_limited_get(stable_url, {"symbol": symbol}, quiet=True)
            if data and isinstance(data, list) and data:
                self.cache[cache_key] = data[0]
                results[symbol] = data[0]
            else:
                self.cache[cache_key] = None
        return results
```

- [ ] **Step 6: Run the new tests + full earnings suite — verify green**

Run: `python -m pytest ".claude/skills/earnings-trade-analyzer/scripts/tests/test_earnings_trade_analyzer.py" -q`
Expected: PASS (all). The pre-existing `test_budget_exceeded*` rely on budget-before-call ordering; `_rate_limited_get` ordering is unchanged by this task, so they stay green.

- [ ] **Step 7: Add `encoding="utf-8"` to `report_generator.py` writes** (company/sector names from profiles can be non-ASCII):

`.claude/skills/earnings-trade-analyzer/scripts/report_generator.py`, both occurrences:
```python
    with open(output_path, "w", encoding="utf-8") as f:
```
(line 114 JSON, line 266 markdown — use `replace_all`).

- [ ] **Step 8: End-to-end live run** (cap budget hard; widen lookback enough to catch real earnings; this exercises calendar→profiles→historical all on stable):

Run (PowerShell):
```powershell
$key = (Select-String '^FMP_API_KEY=' .env).Line.Split('=',2)[1]
$env:FMP_API_KEY=$key
python .claude/skills/earnings-trade-analyzer/scripts/analyze_earnings_trades.py --output-dir data/reports --lookback-days 7 --max-api-calls 60
```
Expected: exit 0; stderr shows "Raw earnings announcements: N" (N>0, proving stable calendar), "Profiles retrieved: M" (M>0, proving stable profiles), ≥1 historical fetch, no `403`, an `earnings_trade_analyzer_*.json` + `.md` written. If the budget caps the run mid-way it should still exit 0 and write a report (graceful trim) — acceptable, but confirm the cap (not a 403) was the limiter.

- [ ] **Step 9: Confirm report**

Run: `Get-ChildItem data/reports/earnings_trade_analyzer_*.json | Sort-Object LastWriteTime | Select-Object -Last 1`
Expected: a fresh JSON with `schema_version` `"1.0"` and `metadata.api_stats`.

- [ ] **Step 10: Commit (one squashed commit for earnings)**

```bash
git add .claude/skills/earnings-trade-analyzer
git commit -m "fix(earnings-trade-analyzer): migrate calendar/profiles/history to FMP stable API"
```

---

## Self-Review

**Spec coverage** (vs the 5-point per-screener checklist):
1. EOD endpoint + `_eod_hist_url` + flat-array normalize → Task 1 S3, Task 2 S4, Task 3 S3 (shared S1–S4). ✓
2. Batch quotes one-per-call → only FTD has a comma-batching `get_batch_quotes`; PEAD/earnings have no quote API → Task 2 Step 5. ✓ (verified by reading; gap does not exist for PEAD/earnings)
3. avgVolume→volume fallback → **N/A for all three**: none of these clients call `stable/quote` for an `avgVolume` pre-filter (VCP did; FTD uses single quotes for current price only, non-fatal; PEAD/earnings have no quote path). Verified by reading — gap does not apply. ✓
4. report_generator utf-8 → Task 1 S10, Task 2 S8 (critical/static `─`), Task 3 S7. ✓
5. PEAD `--universe` filter before profiles + mcp wiring → Task 1 S5–S9, S11. ✓

**Extra gap found by reading (not in original checklist):** earnings-trade-analyzer's `get_earnings_calendar` and `get_company_profiles` are v3-only (PEAD's already had stable fallbacks) → Task 3 S4–S5. This is the real reason earnings was broken on starter tier, beyond the shared historical gap.

**Placeholder scan:** none — every code step has full content.

**Type consistency:** `get_historical_prices` returns a dict in PEAD/FTD, a list in earnings — the EOD normalization returns the dict shape inside `_request_with_fallback`, and each `get_historical_prices` keeps its existing post-processing, so contracts are preserved. Tests assert the per-screener shape (PEAD dict, earnings list).

**Out of scope (flagged, not done):** earnings-trade-analyzer is not universe-scoped (not MCP-wired; `--lookback-days 2` default keeps fan-out small; budget mechanism trims overflow). If a heavy earnings day still blows the budget post-migration, adding a `--universe` filter there is a follow-up.

**Verification standard:** each screener is green on its pytest suite AND produces a real report via the actual invocation (exit 0, zero 403s, fresh JSON+MD) before its commit. No `--no-verify`, no push.
