package services

import (
	"context"
	"fmt"
	"math"
	"sync"
	"time"

	"prophet-trader/interfaces"
)

// verticalProposal is a stored propose→place record. quotedDebit is the
// per-contract net debit priced at propose (Alpaca-positive, guaranteed > 0).
type verticalProposal struct {
	id          string
	expiresAt   time.Time
	req         PlaceVerticalRequest
	quotedDebit float64
	entryLong   *interfaces.OptionContract
	entryShort  *interfaces.OptionContract
}

// proposalStore is an in-memory, TTL-expiring, mutex-guarded proposal map.
// Expiry is lazy on get AND swept at the top of each propose; a restart drops
// all proposals (place then rejects "not found" → the LLM re-proposes).
type proposalStore struct {
	mu sync.Mutex
	m  map[string]*verticalProposal
}

func newProposalStore() *proposalStore {
	return &proposalStore{m: map[string]*verticalProposal{}}
}

func (s *proposalStore) put(p *verticalProposal, now time.Time) {
	p.expiresAt = now.Add(verticalProposalTTL)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.m[p.id] = p
}

func (s *proposalStore) get(id string, now time.Time) (*verticalProposal, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.m[id]
	if !ok || !now.Before(p.expiresAt) {
		if ok {
			delete(s.m, id)
		}
		return nil, false
	}
	return p, true
}

func (s *proposalStore) sweep(now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, p := range s.m {
		if !now.Before(p.expiresAt) {
			delete(s.m, id)
		}
	}
}

func (s *proposalStore) len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.m)
}

// chainSource supplies the option chain (as a symbol-keyed map) and the
// underlying spot used as the ATM long-leg target. Implemented in production by
// an adapter over the trading/data service.
type chainSource interface {
	ChainMap(ctx context.Context, underlying string, expiration time.Time) (map[string]*interfaces.OptionContract, error)
	Spot(ctx context.Context, underlying string) (float64, error)
}

// openGuard is the per-leg dry-run guard check (CheckOptionsOpen subset).
type openGuard interface {
	CheckOptionsOpen(agent AgentSource, underlying, symbol string, q *interfaces.OptionsQuote, now time.Time) error
}

// VerticalCard is the entry decision card (instructional approximation).
type VerticalCard struct {
	ProposalID   string  `json:"proposal_id"`
	Underlying   string  `json:"underlying"`
	Direction    string  `json:"direction"`
	Expiration   string  `json:"expiration"`
	DTE          int     `json:"dte"`
	LongSymbol   string  `json:"long_symbol"`
	ShortSymbol  string  `json:"short_symbol"`
	LongStrike   float64 `json:"long_strike"`
	ShortStrike  float64 `json:"short_strike"`
	Width        float64 `json:"width"`
	NetDebit     float64 `json:"net_debit"`    // per-contract
	MaxLossUSD   float64 `json:"max_loss_usd"` // = net_debit * 100 * contracts
	Breakeven    float64 `json:"breakeven"`
	MaxProfitUSD float64 `json:"max_profit_usd"`
	LongIV       float64 `json:"long_iv"`
	ShortIV      float64 `json:"short_iv"`
}

type VerticalProposer struct {
	src   chainSource
	guard openGuard
	store *proposalStore
}

func NewVerticalProposer(src chainSource, guard openGuard, store *proposalStore) *VerticalProposer {
	return &VerticalProposer{src: src, guard: guard, store: store}
}

func (p *VerticalProposer) Propose(ctx context.Context, underlying string, dir VerticalDirection, expiration time.Time, targetWidth float64, now time.Time) (string, VerticalCard, error) {
	p.store.sweep(now)
	chain, err := p.src.ChainMap(ctx, underlying, expiration)
	if err != nil {
		return "", VerticalCard{}, fmt.Errorf("propose: chain unavailable: %w", err)
	}
	spot, err := p.src.Spot(ctx, underlying)
	if err != nil || spot <= 0 {
		return "", VerticalCard{}, fmt.Errorf("propose: spot unavailable: %w", err)
	}
	long, short, ok := pickVerticalStrikes(chain, dir, spot, targetWidth)
	if !ok {
		return "", VerticalCard{}, fmt.Errorf("propose: no liquid %s strikes near %.2f width %.2f", dir, spot, targetWidth)
	}
	// Dry-run guard, both legs.
	for _, leg := range []*interfaces.OptionContract{long, short} {
		q := &interfaces.OptionsQuote{Symbol: leg.Symbol, BidPrice: leg.Bid, AskPrice: leg.Ask, Timestamp: now}
		if err := p.guard.CheckOptionsOpen(AgentMain, underlying, leg.Symbol, q, now); err != nil {
			return "", VerticalCard{}, fmt.Errorf("propose: guard blocked %s: %w", leg.Symbol, err)
		}
	}
	longMid, shortMid := (long.Bid+long.Ask)/2, (short.Bid+short.Ask)/2
	width := math.Abs(long.StrikePrice - short.StrikePrice)
	debit := verticalDebitLimit(longMid, shortMid, long.Ask-long.Bid, short.Ask-short.Bid, width, verticalLimitBufferFrac)
	if debit <= 0 {
		return "", VerticalCard{}, fmt.Errorf("propose: non-positive net debit %.2f at current quotes", debit)
	}
	if debit*100*float64(verticalContracts) > verticalDebitCapUSD {
		return "", VerticalCard{}, fmt.Errorf("propose: debit cap — $%.0f exceeds $%.0f", debit*100, verticalDebitCapUSD)
	}
	id := fmt.Sprintf("vp-%d", now.UnixNano())
	req := PlaceVerticalRequest{
		Underlying: underlying, Expiration: expiration, Direction: dir,
		LongSymbol: long.Symbol, LongStrike: long.StrikePrice,
		ShortSymbol: short.Symbol, ShortStrike: short.StrikePrice,
	}
	p.store.put(&verticalProposal{id: id, req: req, quotedDebit: debit, entryLong: long, entryShort: short}, now)
	card := VerticalCard{
		ProposalID: id, Underlying: underlying, Direction: string(dir),
		Expiration: expiration.Format("2006-01-02"), DTE: verticalDTE(expiration, now),
		LongSymbol: long.Symbol, ShortSymbol: short.Symbol,
		LongStrike: long.StrikePrice, ShortStrike: short.StrikePrice, Width: width,
		NetDebit: debit, MaxLossUSD: debit * 100 * float64(verticalContracts),
		Breakeven:    breakeven(dir, long.StrikePrice, debit),
		MaxProfitUSD: (width - debit) * 100 * float64(verticalContracts),
		LongIV:       long.ImpliedVolatility, ShortIV: short.ImpliedVolatility,
	}
	return id, card, nil
}

// breakeven for a debit vertical: long strike ± net debit (call up, put down).
func breakeven(dir VerticalDirection, longStrike, debit float64) float64 {
	if dir == CallDebit {
		return longStrike + debit
	}
	return longStrike - debit
}

// ValidateForPlace enforces the place-side identity contract: TTL + debit-drift
// against the STORED legs. Returns the stored request and the fresh per-contract
// debit (for the caller's notional/guard computation). Never snaps strikes.
func (p *VerticalProposer) ValidateForPlace(ctx context.Context, proposalID string, now time.Time) (PlaceVerticalRequest, float64, error) {
	prop, ok := p.store.get(proposalID, now)
	if !ok {
		return PlaceVerticalRequest{}, 0, fmt.Errorf("place: proposal expired or not found — re-propose")
	}
	long, err := p.src.ChainMap(ctx, prop.req.Underlying, prop.req.Expiration)
	if err != nil {
		return PlaceVerticalRequest{}, 0, fmt.Errorf("place: re-price chain unavailable: %w", err)
	}
	lc, okL := long[prop.req.LongSymbol]
	sc, okS := long[prop.req.ShortSymbol]
	if !okL || !okS {
		return PlaceVerticalRequest{}, 0, fmt.Errorf("place: stored legs no longer quoted")
	}
	width := math.Abs(prop.req.LongStrike - prop.req.ShortStrike)
	fresh := verticalDebitLimit((lc.Bid+lc.Ask)/2, (sc.Bid+sc.Ask)/2, lc.Ask-lc.Bid, sc.Ask-sc.Bid, width, verticalLimitBufferFrac)
	if prop.quotedDebit <= 0 { // defensive; propose guarantees >0
		return PlaceVerticalRequest{}, 0, fmt.Errorf("place: invalid quoted debit")
	}
	if math.Abs(fresh-prop.quotedDebit)/prop.quotedDebit > verticalDebitDriftTolerance {
		return PlaceVerticalRequest{}, 0, fmt.Errorf("place: net debit drifted — quoted %.2f, now %.2f (>%.0f%%)", prop.quotedDebit, fresh, verticalDebitDriftTolerance*100)
	}
	return prop.req, fresh, nil
}

// VerticalContracts returns the number of contracts per vertical trade (immutable
// sentinel for JSON serialization and notional computation).
func VerticalContracts() int {
	return verticalContracts
}

// ParseVerticalDirection parses a string direction into a VerticalDirection constant.
// Accepts "call_debit" and "put_debit"; returns an error for anything else.
func ParseVerticalDirection(s string) (VerticalDirection, error) {
	switch s {
	case "call_debit":
		return CallDebit, nil
	case "put_debit":
		return PutDebit, nil
	default:
		return "", fmt.Errorf("invalid direction %q: must be 'call_debit' or 'put_debit'", s)
	}
}

// chainSourceAdapter implements the chainSource interface by adapting the
// TradingService's GetOptionsChain and DataService's GetLatestQuote methods.
type chainSourceAdapter struct {
	ts interfaces.TradingService
	ds interfaces.DataService
}

// ChainMap calls ts.GetOptionsChain and converts the slice to a symbol-keyed map.
// AlpacaTradingService.GetOptionsChain builds contracts from the snapshot feed,
// which fills pricing/greeks but leaves ContractType and StrikePrice zero (only
// the OCC Symbol encodes them). The vertical strike-snapper filters on those two
// fields, so we backfill them here from the symbol when unset.
func (a *chainSourceAdapter) ChainMap(ctx context.Context, underlying string, expiration time.Time) (map[string]*interfaces.OptionContract, error) {
	chain, err := a.ts.GetOptionsChain(ctx, underlying, expiration)
	if err != nil {
		return nil, err
	}
	m := make(map[string]*interfaces.OptionContract, len(chain))
	for _, c := range chain {
		if c == nil {
			continue
		}
		if c.ContractType == "" {
			if _, _, typ, ok := ParseOCC(c.Symbol); ok {
				switch typ {
				case 'C':
					c.ContractType = "call"
				case 'P':
					c.ContractType = "put"
				}
			}
		}
		if c.StrikePrice == 0 {
			if strike, ok := ParseOCCStrike(c.Symbol); ok {
				c.StrikePrice = strike
			}
		}
		m[c.Symbol] = c
	}
	return m, nil
}

// Spot returns the current bid-ask mid for the underlying equity.
func (a *chainSourceAdapter) Spot(ctx context.Context, underlying string) (float64, error) {
	q, err := a.ds.GetLatestQuote(ctx, underlying)
	if err != nil {
		return 0, fmt.Errorf("spot: quote unavailable: %w", err)
	}
	if q == nil || q.BidPrice <= 0 || q.AskPrice <= 0 {
		return 0, fmt.Errorf("spot: invalid quote for %s: bid=%.2f ask=%.2f", underlying, q.BidPrice, q.AskPrice)
	}
	return (q.BidPrice + q.AskPrice) / 2, nil
}

// NewChainSourceAdapter creates a chainSource adapter from trading and data services.
func NewChainSourceAdapter(ts interfaces.TradingService, ds interfaces.DataService) *chainSourceAdapter {
	return &chainSourceAdapter{ts: ts, ds: ds}
}

// NewProposalStore creates a new in-memory proposal store.
func NewProposalStore() *proposalStore {
	return newProposalStore()
}

// NewVerticalProposerForBot is a convenience constructor for wiring the vertical
// proposer in main.go. It instantiates the chain-source adapter, proposal store,
// and proposer in one call.
func NewVerticalProposerForBot(ts interfaces.TradingService, ds interfaces.DataService, guard *TradeGuard) *VerticalProposer {
	return NewVerticalProposer(
		NewChainSourceAdapter(ts, ds),
		guard,
		NewProposalStore(),
	)
}
