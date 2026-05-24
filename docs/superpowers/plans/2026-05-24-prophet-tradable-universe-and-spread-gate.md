# Prophet Tradable-Universe Boundary + Options Spread Gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Prophet's tradable universe a single bot-owned source the FMP top-up cannot reach, code-enforce an underlying allowlist and an options spread gate on Prophet's options opens (both flag-gated, default off, opens-only), and reconcile the intraday watchlist + V2 rules to the tradable floor.

**Architecture:** Two new code-enforced gates live in `TradeGuard.CheckOptionsOpen`, invoked from `PlaceOptionsOrder` before the existing cap checks. The universe gate fails **open** on missing config (not-configured-yet); the spread gate fails **closed** on missing runtime quote (can't-verify-liquidity). A single Alpaca options-snapshot fetch per open feeds both notional sizing and the spread gate. The catalyst skills keep reading the same floor file as their static base and append their surveillance top-up in memory only.

**Tech Stack:** Go (gin, logrus, Alpaca REST) for the guard/controller/quote path; Node (node:test) for the watchlist; Python (pytest) for the universe builders; Markdown for rules.

**Spec:** `docs/superpowers/specs/2026-05-24-prophet-tradable-universe-and-spread-gate-design.md`

---

## File Structure

**Created:**
- `config/prophet_tradable_universe.txt` — the single bot-owned tradable floor (one ticker per line, `#` comments).
- `services/tradable_universe.go` — `LoadTradableUniverse(path)` loader.
- `services/tradable_universe_test.go` — loader tests.
- `services/occ.go` — `ParseOCCUnderlying(symbol)` OCC-root parser.
- `services/occ_test.go` — parser tests.

**Modified:**
- `services/trade_guard.go` — new `TradeGuardConfig` fields + `CheckOptionsOpen` method.
- `services/trade_guard_test.go` — `CheckOptionsOpen` tests.
- `services/alpaca_trading.go` — implement `GetOptionsQuote` (snapshot fetch, preserves timestamp) + extracted pure mapper.
- `services/alpaca_trading_test.go` — mapper test.
- `controllers/order_controller.go` — `PlaceOptionsOrder` fetches the quote once, calls `CheckOptionsOpen`, reuses the quote for notional.
- `controllers/order_controller_test.go` — handler-level tests incl. OCC-fallback rejection.
- `config/config.go` — new env-backed config fields.
- `cmd/bot/main.go` — load the floor, wire the new `TradeGuardConfig` fields.
- `agent/harness.js` — widen + export `PROPHET_INTRADAY_WATCHLIST`.
- `agent/watchlist.test.mjs` — assert watchlist ⊆ floor.
- `.claude/skills/analyst-actions/scripts/universe_builder.py`, `.claude/skills/catalyst-news/scripts/universe_builder.py` — repoint `DEFAULT_STATIC_PATH` to the bot-owned floor.
- `TRADING_RULES_V2.md` — reconcile watchlist/universe references.

**Deleted:**
- `.claude/skills/analyst-actions/universe.txt` — replaced by the bot-owned floor (after both builders repoint).

---

## Workstream A — Tradable floor + universe allowlist

### Task A1: Create the bot-owned tradable floor file

**Files:**
- Create: `config/prophet_tradable_universe.txt`

- [ ] **Step 1: Write the floor file**

Content (the static floor migrated from `.claude/skills/analyst-actions/universe.txt`; mega-caps + liquid ETFs only — no dynamic top-up):

```text
# Prophet tradable universe — the SINGLE bot-owned source of trade eligibility.
#
# Read at startup by services.LoadTradableUniverse (the Go guard) AND by the
# analyst-actions / catalyst-news universe_builder.py modules as their static
# floor. The FMP top-up appends to the catalyst SURVEILLANCE list in memory
# only and MUST NOT be written back here — that is what keeps top-up names
# physically unreachable by trade selection.
#
# Curation: mega caps + liquid ETFs with deep options liquidity (tight monthly
# bid-ask). Review every 6-12 months. The options spread gate is the runtime
# check that a name's options are still liquid; this file is the eligibility set.

# Index ETFs
SPY
QQQ
IWM
DIA

# Mega-cap tech
AAPL
MSFT
GOOG
GOOGL
AMZN
NVDA
META
TSLA
AVGO
AMD
ORCL
NFLX
ADBE
CRM

# Financials
JPM
BAC
GS
MS
V
MA

# Healthcare
LLY
UNH
JNJ
ABBV

# Energy
XOM
CVX

# Other mega-caps
WMT
COST
HD
PG
DIS

# Crypto-correlated (Prophet's active set)
MSTR
COIN
MARA

# High-volume active
PLTR
INTC
MU
QCOM
BA
```

- [ ] **Step 2: Commit**

```bash
git add config/prophet_tradable_universe.txt
git commit -m "feat: add bot-owned Prophet tradable-universe floor file"
```

---

### Task A2: Repoint both catalyst universe builders to the floor; delete old file

**Files:**
- Modify: `.claude/skills/analyst-actions/scripts/universe_builder.py:20-22`
- Modify: `.claude/skills/catalyst-news/scripts/universe_builder.py:20-22`
- Delete: `.claude/skills/analyst-actions/universe.txt`
- Test: `.claude/skills/analyst-actions/scripts/tests/test_universe_builder.py`

- [ ] **Step 1: Write the failing test**

Add to `test_universe_builder.py`:

```python
def test_default_static_path_points_at_bot_owned_floor():
    # The floor must be the repo-root config file, not a skill-local copy,
    # so the Go guard and the catalyst skills share one source of truth.
    from universe_builder import DEFAULT_STATIC_PATH
    assert DEFAULT_STATIC_PATH.name == "prophet_tradable_universe.txt"
    assert DEFAULT_STATIC_PATH.parent.name == "config"
    assert DEFAULT_STATIC_PATH.exists(), f"floor file missing at {DEFAULT_STATIC_PATH}"
    names = DEFAULT_STATIC_PATH.read_text(encoding="utf-8")
    assert "NVDA" in names and "SPY" in names
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd .claude/skills/analyst-actions/scripts && python -m pytest tests/test_universe_builder.py::test_default_static_path_points_at_bot_owned_floor -v`
Expected: FAIL (path still points at `analyst-actions/universe.txt`).

- [ ] **Step 3: Repoint `DEFAULT_STATIC_PATH` in analyst-actions**

In `.claude/skills/analyst-actions/scripts/universe_builder.py`, replace:

```python
DEFAULT_STATIC_PATH = (
    Path(__file__).resolve().parent.parent / "universe.txt"
)
```
with:
```python
# Single source of truth lives at repo-root config/, shared with the Go guard.
# parents: [0]=scripts [1]=analyst-actions [2]=skills [3]=.claude [4]=repo root
DEFAULT_STATIC_PATH = (
    Path(__file__).resolve().parents[4] / "config" / "prophet_tradable_universe.txt"
)
```

- [ ] **Step 4: Repoint `DEFAULT_STATIC_PATH` in catalyst-news**

In `.claude/skills/catalyst-news/scripts/universe_builder.py`, replace:

```python
    Path(__file__).resolve().parent.parent.parent / "analyst-actions" / "universe.txt"
```
with the same repo-root reference:
```python
    # Shared bot-owned floor at repo-root config/ (single source of truth).
    # parents: [0]=scripts [1]=catalyst-news [2]=skills [3]=.claude [4]=repo root
    Path(__file__).resolve().parents[4] / "config" / "prophet_tradable_universe.txt"
```

- [ ] **Step 5: Delete the old skill-local floor**

```bash
git rm .claude/skills/analyst-actions/universe.txt
```

- [ ] **Step 6: Run the full builder test suite (both skills)**

Run: `cd .claude/skills/analyst-actions/scripts && python -m pytest tests/test_universe_builder.py -v`
Run: `cd .claude/skills/catalyst-news/scripts && python -m pytest tests/ -v` (if present)
Expected: PASS. Confirm no test still references the deleted `universe.txt` path; update any that load it to point at the config floor.

- [ ] **Step 7: Commit**

```bash
git add .claude/skills/analyst-actions/scripts/universe_builder.py .claude/skills/catalyst-news/scripts/universe_builder.py .claude/skills/analyst-actions/scripts/tests/test_universe_builder.py
git commit -m "feat: catalyst builders read bot-owned floor; drop skill-local universe.txt"
```

---

### Task A3: OCC underlying parser (Go)

**Files:**
- Create: `services/occ.go`
- Test: `services/occ_test.go`

- [ ] **Step 1: Write the failing test**

```go
package services

import "testing"

func TestParseOCCUnderlying(t *testing.T) {
	cases := []struct{ in, want string }{
		{"TSLA251219C00400000", "TSLA"},
		{"SPY251219P00500000", "SPY"},
		{"F251219C00012000", "F"},      // 1-char root
		{"GOOGL251219C00150000", "GOOGL"},
		{"NVDA", "NVDA"},               // bare underlying (no option suffix)
		{"", ""},                       // empty
		{"123456C00010000", ""},        // no alpha root -> unresolved
	}
	for _, c := range cases {
		if got := ParseOCCUnderlying(c.in); got != c.want {
			t.Errorf("ParseOCCUnderlying(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./services/ -run TestParseOCCUnderlying -v`
Expected: FAIL ("undefined: ParseOCCUnderlying").

- [ ] **Step 3: Implement the parser**

Create `services/occ.go`:

```go
package services

import "unicode"

// ParseOCCUnderlying extracts the underlying root from an OCC option symbol
// (e.g. "TSLA251219C00400000" -> "TSLA"). The root is the leading run of
// ASCII letters before the 6-digit expiration date. A bare ticker with no
// option suffix returns itself. Returns "" when no leading-letter root exists.
//
// Limitation (see spec): assumes an all-letter root. Roots containing digits
// or non-standard broker formats are not handled; the universe gate fails
// closed when the resolved root is empty, so an unparseable symbol is rejected
// rather than silently allowed.
func ParseOCCUnderlying(symbol string) string {
	end := 0
	for _, r := range symbol {
		if !unicode.IsLetter(r) || r > unicode.MaxASCII {
			break
		}
		end++
	}
	return symbol[:end]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./services/ -run TestParseOCCUnderlying -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/occ.go services/occ_test.go
git commit -m "feat: add OCC underlying-root parser"
```

---

### Task A4: Tradable-universe loader (Go)

**Files:**
- Create: `services/tradable_universe.go`
- Test: `services/tradable_universe_test.go`

- [ ] **Step 1: Write the failing test**

```go
package services

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadTradableUniverse(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "floor.txt")
	os.WriteFile(p, []byte("# header\nSPY\n  nvda  \n\nMSTR # inline\n"), 0o644)

	got, err := LoadTradableUniverse(p)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	for _, want := range []string{"SPY", "NVDA", "MSTR"} {
		if !got[want] {
			t.Errorf("expected %q in floor, got %v", want, got)
		}
	}
	if len(got) != 3 {
		t.Errorf("expected 3 names, got %d (%v)", len(got), got)
	}
}

func TestLoadTradableUniverse_MissingFileIsEmptyNotError(t *testing.T) {
	// Missing file = "not configured yet" -> empty map, no error (gate fails open).
	got, err := LoadTradableUniverse(filepath.Join(t.TempDir(), "absent.txt"))
	if err != nil {
		t.Fatalf("missing file must not error, got %v", err)
	}
	if len(got) != 0 {
		t.Errorf("missing file must yield empty map, got %v", got)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./services/ -run TestLoadTradableUniverse -v`
Expected: FAIL ("undefined: LoadTradableUniverse").

- [ ] **Step 3: Implement the loader**

Create `services/tradable_universe.go`:

```go
package services

import (
	"os"
	"strings"
)

// LoadTradableUniverse reads a tradable-floor file (one ticker per line, '#'
// comments and blank lines ignored, inline '#...' trimmed, upper-cased) into a
// membership set. A missing file returns an empty map and NO error: absence
// means "not configured yet", and the universe gate treats an empty set as
// disabled (fail open). Only a genuine read error (permissions, etc.) returns
// an error.
func LoadTradableUniverse(path string) (map[string]bool, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]bool{}, nil
		}
		return nil, err
	}
	out := map[string]bool{}
	for _, raw := range strings.Split(string(data), "\n") {
		line := raw
		if i := strings.Index(line, "#"); i >= 0 {
			line = line[:i]
		}
		if t := strings.ToUpper(strings.TrimSpace(line)); t != "" {
			out[t] = true
		}
	}
	return out, nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./services/ -run TestLoadTradableUniverse -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/tradable_universe.go services/tradable_universe_test.go
git commit -m "feat: add tradable-universe floor loader (missing file fails open)"
```

---

### Task A5: Guard config fields + `CheckOptionsOpen` universe gate

**Files:**
- Modify: `services/trade_guard.go` (`TradeGuardConfig` ~line 53; new method near `CheckBuy`)
- Test: `services/trade_guard_test.go`

- [ ] **Step 1: Write the failing test**

Add to `services/trade_guard_test.go` (the file already defines `stubTrading` with a `GetOptionsQuote` stub and constructs guards):

```go
func TestCheckOptionsOpen_UniverseGate(t *testing.T) {
	floor := map[string]bool{"NVDA": true, "SPY": true}
	g := NewTradeGuard(nil, nil, TradeGuardConfig{
		EnableUniverseGate:  true,
		TradableUnderlyings: floor,
	})

	// On-floor underlying passes.
	if err := g.CheckOptionsOpen(AgentMain, "NVDA", "NVDA251219C00400000", nil, time.Now()); err != nil {
		t.Errorf("on-floor NVDA should pass universe gate, got %v", err)
	}
	// Off-floor underlying rejected.
	if err := g.CheckOptionsOpen(AgentMain, "PLUG", "PLUG251219C00010000", nil, time.Now()); err == nil {
		t.Error("off-floor PLUG should be rejected by universe gate")
	}
	// Blank underlying -> OCC fallback resolves on-floor root -> passes.
	if err := g.CheckOptionsOpen(AgentMain, "", "SPY251219C00500000", nil, time.Now()); err != nil {
		t.Errorf("blank underlying with on-floor OCC root should pass, got %v", err)
	}
	// Blank underlying + off-floor OCC root -> rejected.
	if err := g.CheckOptionsOpen(AgentMain, "", "PLUG251219C00010000", nil, time.Now()); err == nil {
		t.Error("blank underlying with off-floor OCC root should be rejected")
	}
	// Non-main agent: not gated.
	if err := g.CheckOptionsOpen(AgentPenny, "PLUG", "PLUG251219C00010000", nil, time.Now()); err != nil {
		t.Errorf("non-main agent must not be universe-gated, got %v", err)
	}
	// Gate off: not gated.
	gOff := NewTradeGuard(nil, nil, TradeGuardConfig{EnableUniverseGate: false, TradableUnderlyings: floor})
	if err := gOff.CheckOptionsOpen(AgentMain, "PLUG", "PLUG251219C00010000", nil, time.Now()); err != nil {
		t.Errorf("gate off must not block, got %v", err)
	}
	// Empty floor (not configured) -> fail open.
	gEmpty := NewTradeGuard(nil, nil, TradeGuardConfig{EnableUniverseGate: true, TradableUnderlyings: map[string]bool{}})
	if err := gEmpty.CheckOptionsOpen(AgentMain, "PLUG", "PLUG251219C00010000", nil, time.Now()); err != nil {
		t.Errorf("empty floor must fail open, got %v", err)
	}
}
```

Add `"time"` to the test file's imports if not present.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./services/ -run TestCheckOptionsOpen_UniverseGate -v`
Expected: FAIL (unknown fields `EnableUniverseGate`/`TradableUnderlyings`; undefined `CheckOptionsOpen`).

- [ ] **Step 3: Add config fields**

In `services/trade_guard.go`, add to `TradeGuardConfig` (after `MaxDeployedPct`, ~line 89):

```go
	// EnableUniverseGate flag-gates the Prophet (AgentMain) options-open
	// underlying allowlist. Default off (observe-first rollout).
	EnableUniverseGate bool `json:"enable_universe_gate"`
	// TradableUnderlyings is the set of underlyings Prophet may open options on.
	// Empty = not configured -> gate fails OPEN (never blocks). Loaded from the
	// bot-owned floor file at startup.
	TradableUnderlyings map[string]bool `json:"-"`
```

- [ ] **Step 4: Implement the universe gate in a new `CheckOptionsOpen`**

Add to `services/trade_guard.go` (after `CheckBuy`). This task implements only the universe portion; Task C2 extends the same method with the spread gate.

```go
// CheckOptionsOpen runs the Prophet-scoped options-OPEN gates: the tradable
// underlying allowlist and (Task C2) the options spread gate. It is called from
// PlaceOptionsOrder before CheckBuy, on opening buys only — so it can never
// block a close/exit. quote may be nil (the spread gate handles that); now is
// passed in for testable staleness.
//
// Scope: AgentMain (Prophet) only. Other agents pass through untouched.
func (g *TradeGuard) CheckOptionsOpen(agent AgentSource, underlying, symbol string, quote *interfaces.OptionsQuote, now time.Time) error {
	if agent != AgentMain {
		return nil
	}

	// --- Universe allowlist ---
	// Empty set = not configured -> fail OPEN (a missing/unpopulated floor must
	// not halt trading the moment the flag is flipped).
	if g.cfg.EnableUniverseGate && len(g.cfg.TradableUnderlyings) > 0 {
		u := strings.ToUpper(strings.TrimSpace(underlying))
		if u == "" {
			u = strings.ToUpper(ParseOCCUnderlying(symbol))
		}
		if u == "" || !g.cfg.TradableUnderlyings[u] {
			g.logger.WithFields(logrus.Fields{
				"guard_universe_not_tradable": true,
				"underlying":                  u,
				"symbol":                      symbol,
			}).Warn("guard: options open blocked — underlying not in tradable floor")
			return fmt.Errorf("guard: universe — %q is not in Prophet's tradable floor", symbol)
		}
	}

	return nil
}
```

**Imports:** `trade_guard.go` currently imports only `context`, `fmt`, `prophet-trader/interfaces`, `sync`, and `logrus`. This method introduces `strings` and `time` (the `now time.Time` param) — add **both** to the import block, or the package will not compile.

- [ ] **Step 5: Run test to verify it passes**

Run: `go test ./services/ -run TestCheckOptionsOpen_UniverseGate -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add services/trade_guard.go services/trade_guard_test.go
git commit -m "feat: add CheckOptionsOpen universe allowlist (AgentMain, flag-gated, fail-open on empty floor)"
```

---

## Workstream C — Options quote path + spread gate

### Task C1: Implement `GetOptionsQuote` with a testable mapper

**Files:**
- Modify: `services/alpaca_trading.go` (`GetOptionsQuote` ~line 601)
- Test: `services/alpaca_trading_test.go`

- [ ] **Step 1: Write the failing test (pure mapper)**

Add to `services/alpaca_trading_test.go`:

```go
func TestOptionsQuoteFromSnapshot(t *testing.T) {
	ts := time.Date(2026, 5, 24, 14, 30, 0, 0, time.UTC)
	snap := AlpacaOptionsSnapshot{Snapshots: map[string]AlpacaOptionContract{
		"NVDA251219C00400000": {
			LatestQuote: AlpacaQuote{Timestamp: ts, BidPrice: 5.00, AskPrice: 5.20, BidSize: 10, AskSize: 12},
			LatestTrade: AlpacaTrade{Price: 5.10},
		},
	}}
	q, err := optionsQuoteFromSnapshot(snap, "NVDA251219C00400000")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if q.BidPrice != 5.00 || q.AskPrice != 5.20 || q.LastPrice != 5.10 {
		t.Errorf("bad price mapping: %+v", q)
	}
	if !q.Timestamp.Equal(ts) {
		t.Errorf("timestamp must be preserved for staleness checks, got %v", q.Timestamp)
	}

	if _, err := optionsQuoteFromSnapshot(AlpacaOptionsSnapshot{Snapshots: map[string]AlpacaOptionContract{}}, "MISSING"); err == nil {
		t.Error("missing symbol in snapshot should error")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./services/ -run TestOptionsQuoteFromSnapshot -v`
Expected: FAIL ("undefined: optionsQuoteFromSnapshot").

- [ ] **Step 3: Implement the mapper + real fetch**

In `services/alpaca_trading.go`, replace the stub `GetOptionsQuote` (lines ~601-608) with:

```go
// optionsQuoteFromSnapshot maps an Alpaca options snapshot into our
// OptionsQuote, preserving the quote's exchange timestamp (required by the
// spread gate's staleness check). Pure; unit-tested without network.
func optionsQuoteFromSnapshot(snap AlpacaOptionsSnapshot, symbol string) (*interfaces.OptionsQuote, error) {
	c, ok := snap.Snapshots[symbol]
	if !ok {
		return nil, fmt.Errorf("no snapshot data for %s", symbol)
	}
	return &interfaces.OptionsQuote{
		Symbol:    symbol,
		BidPrice:  c.LatestQuote.BidPrice,
		BidSize:   int64(c.LatestQuote.BidSize),
		AskPrice:  c.LatestQuote.AskPrice,
		AskSize:   int64(c.LatestQuote.AskSize),
		LastPrice: c.LatestTrade.Price,
		Timestamp: c.LatestQuote.Timestamp,
	}, nil
}

// GetOptionsQuote fetches a live options snapshot from Alpaca's data API and
// returns bid/ask/last + the quote timestamp. Replaces the previous stub.
func (s *AlpacaTradingService) GetOptionsQuote(ctx context.Context, symbol string) (*interfaces.OptionsQuote, error) {
	url := fmt.Sprintf("https://data.alpaca.markets/v1beta1/options/snapshots/%s", symbol)
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("APCA-API-KEY-ID", s.apiKey)
	req.Header.Set("APCA-API-SECRET-KEY", s.apiSecret)

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch options snapshot: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("options snapshot API error %d: %s", resp.StatusCode, string(body))
	}
	var snapshot AlpacaOptionsSnapshot
	if err := json.NewDecoder(resp.Body).Decode(&snapshot); err != nil {
		return nil, fmt.Errorf("failed to decode options snapshot: %w", err)
	}
	return optionsQuoteFromSnapshot(snapshot, symbol)
}
```

Confirm `io`, `encoding/json`, `net/http`, `fmt` are already imported in `alpaca_trading.go` (they are — see file header).

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./services/ -run TestOptionsQuoteFromSnapshot -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/alpaca_trading.go services/alpaca_trading_test.go
git commit -m "feat: implement GetOptionsQuote via Alpaca options snapshot (preserves quote timestamp)"
```

---

### Task C2: Extend `CheckOptionsOpen` with the spread + staleness gate

**Files:**
- Modify: `services/trade_guard.go` (`TradeGuardConfig` + `CheckOptionsOpen`)
- Test: `services/trade_guard_test.go`

- [ ] **Step 1: Write the failing test**

Add to `services/trade_guard_test.go`:

```go
func TestCheckOptionsOpen_SpreadGate(t *testing.T) {
	now := time.Date(2026, 5, 24, 14, 30, 0, 0, time.UTC)
	base := TradeGuardConfig{
		EnableOptionsSpreadGate: true,
		SpreadMaxPct:            0.10,
		OptionsQuoteMaxAge:      60 * time.Second,
		// universe gate off so we isolate the spread gate
	}
	g := NewTradeGuard(nil, nil, base)

	fresh := func(bid, ask float64) *interfaces.OptionsQuote {
		return &interfaces.OptionsQuote{BidPrice: bid, AskPrice: ask, Timestamp: now}
	}

	// Tight spread (5/5.20 -> ~3.9%) passes.
	if err := g.CheckOptionsOpen(AgentMain, "NVDA", "NVDA251219C00400000", fresh(5.00, 5.20), now); err != nil {
		t.Errorf("tight spread should pass, got %v", err)
	}
	// Wide spread (1.00/1.30 -> ~26%) rejected.
	if err := g.CheckOptionsOpen(AgentMain, "NVDA", "NVDA251219C00400000", fresh(1.00, 1.30), now); err == nil {
		t.Error("wide spread should be rejected")
	}
	// Nil quote -> fail closed.
	if err := g.CheckOptionsOpen(AgentMain, "NVDA", "NVDA251219C00400000", nil, now); err == nil {
		t.Error("nil quote should fail closed")
	}
	// Stale quote (age > max) -> fail closed.
	stale := &interfaces.OptionsQuote{BidPrice: 5.00, AskPrice: 5.20, Timestamp: now.Add(-5 * time.Minute)}
	if err := g.CheckOptionsOpen(AgentMain, "NVDA", "NVDA251219C00400000", stale, now); err == nil {
		t.Error("stale quote should fail closed")
	}
	// Zero/absent bid -> fail closed (can't verify liquidity).
	if err := g.CheckOptionsOpen(AgentMain, "NVDA", "NVDA251219C00400000", fresh(0, 5.20), now); err == nil {
		t.Error("zero bid should fail closed")
	}
	// Gate off: nil quote no longer blocks.
	gOff := NewTradeGuard(nil, nil, TradeGuardConfig{EnableOptionsSpreadGate: false})
	if err := gOff.CheckOptionsOpen(AgentMain, "NVDA", "NVDA251219C00400000", nil, now); err != nil {
		t.Errorf("gate off must not block on nil quote, got %v", err)
	}
	// Non-main agent: not gated even with a wide spread.
	if err := g.CheckOptionsOpen(AgentPenny, "NVDA", "NVDA251219C00400000", fresh(1.00, 1.30), now); err != nil {
		t.Errorf("non-main agent must not be spread-gated, got %v", err)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./services/ -run TestCheckOptionsOpen_SpreadGate -v`
Expected: FAIL (unknown fields `EnableOptionsSpreadGate`/`SpreadMaxPct`/`OptionsQuoteMaxAge`).

- [ ] **Step 3: Add spread-gate config fields**

In `TradeGuardConfig`, after the universe fields from Task A5:

```go
	// EnableOptionsSpreadGate flag-gates the Prophet (AgentMain) options-open
	// spread/liquidity check. Default off (observe-first).
	EnableOptionsSpreadGate bool `json:"enable_options_spread_gate"`
	// SpreadMaxPct rejects an options open whose (ask-bid)/mid >= this fraction
	// (0.10 = 10%, matching the advisory rule).
	SpreadMaxPct float64 `json:"spread_max_pct"`
	// OptionsQuoteMaxAge is the staleness bound: a quote older than this (or with
	// a zero timestamp) fails closed when the spread gate is enabled.
	OptionsQuoteMaxAge time.Duration `json:"options_quote_max_age"`
```

`time` was already added to `trade_guard.go` imports in Task A5 (the `now time.Time` param). No new import needed here.

- [ ] **Step 4: Extend `CheckOptionsOpen` with the spread gate**

Append the spread block to `CheckOptionsOpen`, before the final `return nil`:

```go
	// --- Options spread / liquidity gate ---
	// Fail CLOSED on missing/stale/unpriced quote: a missing runtime quote means
	// "can't verify liquidity right now" (contrast the universe gate's fail-open
	// on missing config). Distinct log reasons so the operator can tell a
	// degraded feed (quote_unavailable) from a genuinely illiquid market
	// (spread_exceeded).
	if g.cfg.EnableOptionsSpreadGate {
		if quote == nil || quote.Timestamp.IsZero() || quote.BidPrice <= 0 || quote.AskPrice <= 0 {
			g.logger.WithFields(logrus.Fields{
				"guard_options_quote_unavailable": true,
				"symbol":                          symbol,
			}).Warn("guard: options open blocked — quote unavailable (fail closed)")
			return fmt.Errorf("guard: options spread gate — no usable quote for %q (fail closed)", symbol)
		}
		if g.cfg.OptionsQuoteMaxAge > 0 && now.Sub(quote.Timestamp) > g.cfg.OptionsQuoteMaxAge {
			g.logger.WithFields(logrus.Fields{
				"guard_options_quote_unavailable": true,
				"symbol":                          symbol,
				"quote_age_sec":                   now.Sub(quote.Timestamp).Seconds(),
			}).Warn("guard: options open blocked — quote stale (fail closed)")
			return fmt.Errorf("guard: options spread gate — quote for %q is stale (fail closed)", symbol)
		}
		mid := (quote.BidPrice + quote.AskPrice) / 2
		spreadPct := (quote.AskPrice - quote.BidPrice) / mid
		if spreadPct >= g.cfg.SpreadMaxPct {
			g.logger.WithFields(logrus.Fields{
				"guard_options_spread_exceeded": true,
				"symbol":                        symbol,
				"spread_pct":                    spreadPct,
			}).Warn("guard: options open blocked — spread too wide")
			return fmt.Errorf("guard: options spread gate — %q spread %.1f%% exceeds %.1f%% cap",
				symbol, spreadPct*100, g.cfg.SpreadMaxPct*100)
		}
	}

	return nil
```

(Delete the existing lone `return nil` at the end of the method so this block's trailing `return nil` is the only one.)

- [ ] **Step 5: Run both CheckOptionsOpen tests**

Run: `go test ./services/ -run TestCheckOptionsOpen -v`
Expected: PASS (both `_UniverseGate` and `_SpreadGate`).

- [ ] **Step 6: Commit**

```bash
git add services/trade_guard.go services/trade_guard_test.go
git commit -m "feat: add options spread+staleness gate to CheckOptionsOpen (fail closed, distinct reasons)"
```

---

### Task C3: Wire `CheckOptionsOpen` into `PlaceOptionsOrder` (single fetch, observe logging)

**Files:**
- Modify: `controllers/order_controller.go` (`optionsNotional` ~line 500, `PlaceOptionsOrder` ~line 534)
- Test: `controllers/order_controller_test.go`

- [ ] **Step 1: Write the failing test**

`order_controller_test.go` already defines `recordingTradingService` with a `GetOptionsQuote` stub. Make that stub return a configurable quote, then add a handler-level test. First, locate the `recordingTradingService` struct and its `GetOptionsQuote` (line ~61) and replace the stub body with a settable field:

```go
// add field to recordingTradingService:
optionsQuote *interfaces.OptionsQuote
optionsQuoteErr error

func (r *recordingTradingService) GetOptionsQuote(_ context.Context, _ string) (*interfaces.OptionsQuote, error) {
	r.optionsQuoteCalls++ // add this int field too
	return r.optionsQuote, r.optionsQuoteErr
}
```

**Note on `recordingTradingService`:** match the struct's *existing* field names — this file already records calls (it's the "recording" stub). Reuse its current placement counter for the broker-call assertion (the test below uses `placeOptionsCalls`; rename to whatever the struct already exposes, or add it if absent). Only `optionsQuote`, `optionsQuoteErr`, and `optionsQuoteCalls` are guaranteed-new fields.

Then the test (uses the gin handler via httptest; mirror existing handler tests in this file for router setup):

```go
func TestPlaceOptionsOrder_UniverseAndSpreadGates(t *testing.T) {
	floor := map[string]bool{"NVDA": true}
	guard := services.NewTradeGuard(nil, nil, services.TradeGuardConfig{
		EnableUniverseGate:      true,
		TradableUnderlyings:     floor,
		EnableOptionsSpreadGate: true,
		SpreadMaxPct:            0.10,
		OptionsQuoteMaxAge:      60 * time.Second,
	})

	// (a) off-floor underlying via OCC fallback (blank Underlying) -> 422, never placed.
	ts := &recordingTradingService{optionsQuote: &interfaces.OptionsQuote{BidPrice: 1, AskPrice: 1.02, Timestamp: time.Now()}}
	oc := NewOrderController(ts, nil, nil)
	oc.SetGuard(guard)
	w := postOptionsOrder(t, oc, `{"symbol":"PLUG251219C00010000","qty":1,"side":"buy","order_type":"limit","limit_price":1.0,"strategy":"v2-options"}`)
	if w.Code != 422 {
		t.Fatalf("off-floor OCC fallback should 422, got %d", w.Code)
	}
	if ts.placeOptionsCalls != 0 {
		t.Errorf("off-floor order must not reach the broker, got %d calls", ts.placeOptionsCalls)
	}

	// (b) on-floor + wide spread -> 422 with spread_exceeded path.
	ts2 := &recordingTradingService{optionsQuote: &interfaces.OptionsQuote{BidPrice: 1.0, AskPrice: 1.3, Timestamp: time.Now()}}
	oc2 := NewOrderController(ts2, nil, nil)
	oc2.SetGuard(guard)
	w2 := postOptionsOrder(t, oc2, `{"symbol":"NVDA251219C00400000","underlying":"NVDA","qty":1,"side":"buy","order_type":"limit","limit_price":1.0,"strategy":"v2-options"}`)
	if w2.Code != 422 {
		t.Fatalf("wide spread should 422, got %d", w2.Code)
	}
	if ts2.optionsQuoteCalls != 1 {
		t.Errorf("expected exactly one quote fetch (shared), got %d", ts2.optionsQuoteCalls)
	}

	// (c) on-floor + tight spread -> placed.
	ts3 := &recordingTradingService{optionsQuote: &interfaces.OptionsQuote{BidPrice: 5.0, AskPrice: 5.1, Timestamp: time.Now()}}
	oc3 := NewOrderController(ts3, nil, nil)
	oc3.SetGuard(guard)
	w3 := postOptionsOrder(t, oc3, `{"symbol":"NVDA251219C00400000","underlying":"NVDA","qty":1,"side":"buy","order_type":"limit","limit_price":5.0,"strategy":"v2-options"}`)
	if w3.Code != 200 && w3.Code != 201 {
		t.Fatalf("tight-spread on-floor order should place, got %d", w3.Code)
	}

	// (d) close of an off-floor name is never gated.
	ts4 := &recordingTradingService{optionsQuote: &interfaces.OptionsQuote{BidPrice: 1.0, AskPrice: 1.3, Timestamp: time.Now()}}
	oc4 := NewOrderController(ts4, nil, nil)
	oc4.SetGuard(guard)
	w4 := postOptionsOrder(t, oc4, `{"symbol":"PLUG251219C00010000","qty":1,"side":"sell","position_intent":"sell_to_close","order_type":"limit","limit_price":1.0,"strategy":"v2-options"}`)
	if w4.Code == 422 {
		t.Error("closing an off-floor position must never be blocked by the open gates")
	}
}
```

Add a `postOptionsOrder` helper if the file lacks one (mirror the existing handler-test router setup in `order_controller_test.go`):

```go
func postOptionsOrder(t *testing.T, oc *OrderController, body string) *httptest.ResponseRecorder {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.POST("/options/order", oc.PlaceOptionsOrder)
	req := httptest.NewRequest("POST", "/options/order", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}
```

Ensure imports: `net/http/httptest`, `strings`, `time`, `github.com/gin-gonic/gin`, `prophet-trader/interfaces`, `prophet-trader/services`.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./controllers/ -run TestPlaceOptionsOrder_UniverseAndSpreadGates -v`
Expected: FAIL (gates not wired; quote not shared).

- [ ] **Step 3: Refactor `optionsNotional` to accept a pre-fetched quote**

Change `optionsNotional` so the quote is fetched by the caller once and passed in (avoids a second Alpaca call):

```go
// optionsNotional returns the dollar outlay: per-contract price x qty x 100.
// Uses the limit price when present, else the provided quote (mid, then ask,
// then last). quote may be nil. Returns 0 when no price is obtainable.
func optionsNotional(order *interfaces.OptionsOrder, quote *interfaces.OptionsQuote) float64 {
	price := 0.0
	if order.LimitPrice != nil && *order.LimitPrice > 0 {
		price = *order.LimitPrice
	} else if quote != nil {
		switch {
		case quote.BidPrice > 0 && quote.AskPrice > 0:
			price = (quote.BidPrice + quote.AskPrice) / 2
		case quote.AskPrice > 0:
			price = quote.AskPrice
		case quote.LastPrice > 0:
			price = quote.LastPrice
		}
	}
	return price * order.Qty * 100
}
```

- [ ] **Step 4: Wire the gates into `PlaceOptionsOrder`**

In `PlaceOptionsOrder`, replace the existing guard block (the `if oc.guard != nil { ... }` around lines 574-590) with a single-fetch flow:

```go
	if oc.guard != nil {
		if opening && req.Side == "buy" {
			// One quote fetch, reused by both the new gates and the notional cap.
			var quote *interfaces.OptionsQuote
			if oc.tradingService != nil {
				if q, err := oc.tradingService.GetOptionsQuote(ctx, order.Symbol); err == nil {
					quote = q
				}
			}
			// Universe allowlist + spread/staleness gate (Prophet-scoped, flag-gated).
			if err := oc.guard.CheckOptionsOpen(agent, order.Underlying, order.Symbol, quote, time.Now()); err != nil {
				oc.logger.WithError(err).Warn("Options open blocked by trade guard (universe/spread)")
				c.JSON(422, gin.H{"error": err.Error()})
				return
			}
			// Existing dollar caps + daily-loss breaker.
			notional := optionsNotional(order, quote)
			if err := oc.guard.CheckBuy(ctx, agent, order.Symbol, notional); err != nil {
				oc.logger.WithError(err).Warn("Options buy blocked by trade guard")
				c.JSON(422, gin.H{"error": err.Error()})
				return
			}
		} else if !opening {
			if err := oc.guard.CheckSell(ctx, agent, order.Symbol); err != nil {
				oc.logger.WithError(err).Warn("Options close blocked by trade guard")
				c.JSON(422, gin.H{"error": err.Error()})
				return
			}
		}
	}
```

Remove the now-unused `ts interfaces.TradingService` parameter usage in the old `optionsNotional` call site (the signature changed in Step 3).

- [ ] **Step 5: Run test to verify it passes**

Run: `go test ./controllers/ -run TestPlaceOptionsOrder_UniverseAndSpreadGates -v`
Expected: PASS.

- [ ] **Step 6: Run the full controllers + services suites**

Run: `go test ./controllers/ ./services/ -v`
Expected: PASS (no regressions in existing options/guard tests).

- [ ] **Step 7: Commit**

```bash
git add controllers/order_controller.go controllers/order_controller_test.go
git commit -m "feat: wire universe+spread gates into PlaceOptionsOrder with a single shared quote fetch"
```

---

### Task C4: Config + main.go wiring for both gates

**Files:**
- Modify: `config/config.go` (struct ~line 52; `Load()` ~line 111)
- Modify: `cmd/bot/main.go` (TradeGuardConfig literal ~line 191; log fields ~line 207)

- [ ] **Step 1: Add config fields**

In `config/config.go` `Config` struct, after the position-caps block (~line 51):

```go
	// Prophet tradable-universe gate + options spread gate. Both flag-gated,
	// default OFF (observe-first). See the 2026-05-24 spec.
	EnableUniverseGate         bool
	TradableUniversePath       string
	EnableProphetOptionsSpread bool
	ProphetSpreadMaxPct        float64
	ProphetQuoteMaxAgeSec      int
```

In `Load()`, after the position-caps assignments (~line 111):

```go
		EnableUniverseGate:         getEnvOrDefault("ENABLE_PROPHET_UNIVERSE_GATE", "false") == "true",
		TradableUniversePath:       getEnvOrDefault("PROPHET_TRADABLE_UNIVERSE_PATH", "./config/prophet_tradable_universe.txt"),
		EnableProphetOptionsSpread: getEnvOrDefault("ENABLE_PROPHET_OPTIONS_SPREAD", "false") == "true",
		ProphetSpreadMaxPct:        parseFloat(getEnvOrDefault("PROPHET_OPTIONS_SPREAD_MAX_PCT", "0.10")),
		ProphetQuoteMaxAgeSec:      parseIntOrDefault("PROPHET_OPTIONS_QUOTE_MAX_AGE_SEC", 60),
```

- [ ] **Step 2: Load the floor and wire the guard in main.go**

In `cmd/bot/main.go`, immediately before `tradeGuard := services.NewTradeGuard(` (~line 188):

```go
	tradableUniverse, err := services.LoadTradableUniverse(cfg.TradableUniversePath)
	if err != nil {
		logger.WithError(err).Warn("Failed to load tradable universe floor — universe gate will fail open")
		tradableUniverse = map[string]bool{}
	}
```

Add to the `TradeGuardConfig{...}` literal (after `MaxDeployedPct`):

```go
			EnableUniverseGate:      cfg.EnableUniverseGate,
			TradableUnderlyings:     tradableUniverse,
			EnableOptionsSpreadGate: cfg.EnableProphetOptionsSpread,
			SpreadMaxPct:            cfg.ProphetSpreadMaxPct,
			OptionsQuoteMaxAge:      time.Duration(cfg.ProphetQuoteMaxAgeSec) * time.Second,
```

Add to the "Trade guard initialized" log fields (~line 207):

```go
		"universe_gate_enabled":       cfg.EnableUniverseGate,
		"tradable_universe_count":     len(tradableUniverse),
		"options_spread_gate_enabled": cfg.EnableProphetOptionsSpread,
		"spread_max_pct":              cfg.ProphetSpreadMaxPct,
		"quote_max_age_sec":           cfg.ProphetQuoteMaxAgeSec,
```

Confirm `"time"` is imported in `main.go` (it is used elsewhere).

- [ ] **Step 3: Build + run the whole Go test suite**

Run: `go build ./... && go test ./...`
Expected: build succeeds; all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add config/config.go cmd/bot/main.go
git commit -m "feat: wire universe + options spread gate config and floor loading"
```

---

## Workstream B — Watchlist + rules coherence

### Task B1: Widen + export the intraday watchlist; assert it is a floor subset

**Files:**
- Modify: `agent/harness.js:18`
- Test: `agent/watchlist.test.mjs` (create)

- [ ] **Step 1: Write the failing test**

Create `agent/watchlist.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PROPHET_INTRADAY_WATCHLIST } from './harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const floorPath = join(here, '..', 'config', 'prophet_tradable_universe.txt');

function loadFloor() {
  return new Set(
    readFileSync(floorPath, 'utf8')
      .split('\n')
      .map((l) => l.split('#')[0].trim().toUpperCase())
      .filter(Boolean),
  );
}

test('intraday watchlist is a subset of the tradable floor', () => {
  const floor = loadFloor();
  for (const sym of PROPHET_INTRADAY_WATCHLIST) {
    assert.ok(floor.has(sym), `watchlist symbol ${sym} is not in the tradable floor`);
  }
});

test('intraday watchlist is ~12 deep-chain names', () => {
  assert.ok(PROPHET_INTRADAY_WATCHLIST.length >= 10 && PROPHET_INTRADAY_WATCHLIST.length <= 14,
    `expected ~12 names, got ${PROPHET_INTRADAY_WATCHLIST.length}`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test agent/watchlist.test.mjs`
Expected: FAIL (`PROPHET_INTRADAY_WATCHLIST` not exported; current list has 6 names).

- [ ] **Step 3: Widen + export the constant**

In `agent/harness.js`, replace line 18:

```javascript
const PROPHET_INTRADAY_WATCHLIST = ['SPY', 'QQQ', 'NVDA', 'AMD', 'TSLA', 'MSTR'];
```
with:
```javascript
// Auto-pushed intraday context sample — the ~12 deepest-chain names from the
// tradable floor (config/prophet_tradable_universe.txt). NOT the tradable
// universe itself (the guard enforces that); just what each beat pre-loads.
// Off-watchlist floor names remain reachable via get_intraday_signals on demand.
export const PROPHET_INTRADAY_WATCHLIST = ['SPY', 'QQQ', 'NVDA', 'TSLA', 'AAPL', 'MSFT', 'AMZN', 'META', 'AMD', 'AVGO', 'GOOGL', 'MSTR'];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test agent/watchlist.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the agent test suite for regressions**

Run: `node --test agent/*.test.mjs`
Expected: PASS (confirm nothing imported the constant by a non-export path).

- [ ] **Step 6: Commit**

```bash
git add agent/harness.js agent/watchlist.test.mjs
git commit -m "feat: widen intraday watchlist to ~12 deep-chain floor names; assert floor subset"
```

---

### Task B2: Reconcile `TRADING_RULES_V2.md` with the tradable floor

**Files:**
- Modify: `TRADING_RULES_V2.md` (line 41 sector example; line 166 intraday block; new universe note)

- [ ] **Step 1: Update the intraday context block symbol list (line ~166)**

Replace the parenthetical "covering SPY, QQQ, NVDA, AMD, TSLA, MSTR" with the new 12-name list and a clarifying sentence:

```markdown
During market hours (9:30 AM – 4:00 PM ET) you will see an **"Intraday Context"** table prepended to each heartbeat covering SPY, QQQ, NVDA, TSLA, AAPL, MSFT, AMZN, META, AMD, AVGO, GOOGL, MSTR. This table is a **context sample of the tradable floor, not the tradable universe.** Your tradable universe is the full floor in `config/prophet_tradable_universe.txt`, code-enforced by the guard's underlying allowlist when `ENABLE_PROPHET_UNIVERSE_GATE` is on. Off-table floor names are reachable via `get_intraday_signals` on demand.
```

- [ ] **Step 2: Add a "Tradable Universe" subsection under Position Sizing**

After the sector-sizing rule (~line 43), insert:

```markdown
**Rule:** Trade only names in Prophet's tradable floor (`config/prophet_tradable_universe.txt`)
- The floor is curated for deep options liquidity (mega-caps + liquid ETFs).
- When `ENABLE_PROPHET_UNIVERSE_GATE` is on, the guard **rejects** an options open whose underlying is not in the floor (opens only — never blocks a close).
- The daily-brief catalyst feeds (analyst actions, ticker catalysts) scan a *wider* surveillance universe that includes transient high-volume names. Those names are for **awareness only** — they are not tradable and the guard will reject orders on them. Do not propose trades on a catalyst name that is not in the floor.
```

- [ ] **Step 3: Add a spread-gate note under Liquidity & Spreads**

After the "bid-ask spread <10%" rule (~line 142):

```markdown
> **Code-enforced (flag-gated, default OFF) as of 2026-05-24:** when
> `ENABLE_PROPHET_OPTIONS_SPREAD` is on, the guard rejects an options open whose
> `(ask−bid)/mid ≥ 10%`, or whose quote is missing/stale (fail closed). This is
> the only programmatic options-liquidity check; it backstops the floor curation,
> which is human-asserted and can decay. Quote-unavailable rejections log
> distinctly from genuine wide-spread rejections.
```

- [ ] **Step 4: Commit**

```bash
git add TRADING_RULES_V2.md
git commit -m "docs: reconcile V2 rules with tradable floor + universe/spread gates"
```

---

## Final verification

- [ ] **Run every suite:**

Run: `go build ./... && go test ./...`
Run: `node --test agent/*.test.mjs`
Run: `cd .claude/skills/analyst-actions/scripts && python -m pytest tests/ -v`
Expected: all green. No success claim without observed green output (per `superpowers:verification-before-completion`).

- [ ] **Confirm flags default OFF:** grep `ENABLE_PROPHET_UNIVERSE_GATE` and `ENABLE_PROPHET_OPTIONS_SPREAD` resolve to `false` by default in `config/config.go`; nothing changes live behavior until the operator flips them.

---

## Operational rollout (post-merge — NOT code; tracked separately)

1. **Observe phase (Workstream C):** with `ENABLE_PROPHET_OPTIONS_SPREAD=false`, the quote fetch runs (it feeds the notional cap), and you can extend `PlaceOptionsOrder` / `CheckOptionsOpen` logging to emit `spread_pct` + `quote_age_sec` on every options open. Collect until **≥5 trading sessions AND ≥30 option-open samples**.
2. **Set N:** if observed `quote_age` p95 < ~5s → real-time feed, set `PROPHET_OPTIONS_QUOTE_MAX_AGE_SEC=30`; if it clusters ~15min → delayed feed, set ~1020 and note the known limitation. Cap: ≤60s real-time, ≤1020s delayed.
3. **Enable:** flip `ENABLE_PROPHET_OPTIONS_SPREAD=true`, then `ENABLE_PROPHET_UNIVERSE_GATE=true`, watching the distinct `guard_options_quote_unavailable` vs `guard_options_spread_exceeded` counters.

---

## Notes for the implementer

- **TDD discipline:** every task is red → green → commit. Do not write implementation before its failing test.
- **Test the executor, not just predicates** (project convention): the C3 handler test exercises the real `/options/order` path, not just `CheckOptionsOpen` in isolation.
- **Mock-based, no network:** `optionsQuoteFromSnapshot` is the pure seam; the HTTP `GetOptionsQuote` is not unit-tested against the live API.
- **Opens-only invariant:** both new gates run only on opening buys. If you ever see a test where a close/exit is blocked, that is a bug — closes must always pass.
- **Fail directions are intentional and opposite:** universe gate fails OPEN on empty/missing floor (config absence); spread gate fails CLOSED on missing/stale quote (runtime degradation). Do not "fix" this into consistency.
