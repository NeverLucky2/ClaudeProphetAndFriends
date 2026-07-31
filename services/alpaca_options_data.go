package services

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	neturl "net/url"
	"prophet-trader/interfaces"
	"strconv"
	"strings"
	"time"

	"github.com/sirupsen/logrus"
)

// defaultAlpacaTradingURL is the paper trading host. Option CONTRACTS are
// served by the trading API, not the data API — data.alpaca.markets returns
// 404 for /options/contracts.
const defaultAlpacaTradingURL = "https://paper-api.alpaca.markets"

// AlpacaOptionsDataService fetches real options data from Alpaca.
// Two hosts, deliberately: snapshots/bars/quotes come from the DATA API,
// contract metadata comes from the TRADING API.
type AlpacaOptionsDataService struct {
	apiKey     string
	secretKey  string
	baseURL    string // data API   — /v1beta1/options/snapshots
	tradingURL string // trading API — /v2/options/contracts
	logger     *logrus.Logger
	client     *http.Client
}

// NewAlpacaOptionsDataService creates a new Alpaca options data service.
// tradingURL should be cfg.AlpacaBaseURL so the contracts host follows
// whichever account (paper or live) the sandbox is configured against; an
// empty value falls back to the paper host.
func NewAlpacaOptionsDataService(apiKey, secretKey, tradingURL string) *AlpacaOptionsDataService {
	logger := logrus.New()
	logger.SetFormatter(&logrus.TextFormatter{
		FullTimestamp: true,
	})

	trimmed := strings.TrimRight(strings.TrimSpace(tradingURL), "/")
	if trimmed == "" {
		trimmed = defaultAlpacaTradingURL
	}

	// Note: Options data API might require different subscription
	return &AlpacaOptionsDataService{
		apiKey:     apiKey,
		secretKey:  secretKey,
		baseURL:    "https://data.alpaca.markets", // Options data endpoint
		tradingURL: trimmed,
		logger:     logger,
		client:     &http.Client{Timeout: 30 * time.Second},
	}
}

// AlpacaOptionsSnapshot represents Alpaca's options snapshot response
type AlpacaOptionsSnapshot struct {
	Snapshots map[string]AlpacaOptionContract `json:"snapshots"`
}

// AlpacaOptionContract represents an option contract from Alpaca
type AlpacaOptionContract struct {
	LatestQuote AlpacaQuote `json:"latestQuote"`
	LatestTrade AlpacaTrade `json:"latestTrade"`
	Greeks      AlpacaGreeks `json:"greeks"`
	ImpliedVolatility float64 `json:"impliedVolatility"`
}

// AlpacaQuote represents quote data
type AlpacaQuote struct {
	Timestamp time.Time `json:"t"`
	BidPrice  float64   `json:"bp"`
	AskPrice  float64   `json:"ap"`
	BidSize   int       `json:"bs"`
	AskSize   int       `json:"as"`
}

// AlpacaTrade represents trade data
type AlpacaTrade struct {
	Timestamp time.Time `json:"t"`
	Price     float64   `json:"p"`
	Size      int       `json:"s"`
}

// AlpacaGreeks represents Greeks data
type AlpacaGreeks struct {
	Delta float64 `json:"delta"`
	Gamma float64 `json:"gamma"`
	Theta float64 `json:"theta"`
	Vega  float64 `json:"vega"`
	Rho   float64 `json:"rho"`
}

// AlpacaOptionChainResponse represents the option chain response
type AlpacaOptionChainResponse struct {
	OptionContracts []AlpacaOptionChainContract `json:"option_contracts"`
	NextPageToken   string                      `json:"next_page_token"`
}

// AlpacaOptionChainContract represents contract metadata.
// NOTE: Alpaca serialises strike_price and open_interest as JSON STRINGS
// ("654", "4669"). Declaring them float64/int64 makes the whole response fail
// to decode — parse them per contract instead (see toOptionContract).
type AlpacaOptionChainContract struct {
	Symbol           string `json:"symbol"`
	UnderlyingSymbol string `json:"underlying_symbol"`
	ExpirationDate   string `json:"expiration_date"`
	StrikePrice      string `json:"strike_price"`
	Type             string `json:"type"` // "call" or "put"
	Style            string `json:"style"`
	OpenInterest     string `json:"open_interest"`
}

// GetOptionSnapshot gets the latest snapshot for an option
func (s *AlpacaOptionsDataService) GetOptionSnapshot(ctx context.Context, optionSymbol string) (*interfaces.OptionContract, error) {
	// The OCC symbol goes in the `symbols` QUERY param. The path segment of
	// .../options/snapshots/<X> is the UNDERLYING ticker; a full option symbol
	// there makes Alpaca return HTTP 400 "invalid underlying symbol". See the
	// matching note on AlpacaTradingService.GetOptionsQuote.
	url := fmt.Sprintf("%s/v1beta1/options/snapshots?symbols=%s", s.baseURL, neturl.QueryEscape(optionSymbol))

	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, err
	}

	req.Header.Set("APCA-API-KEY-ID", s.apiKey)
	req.Header.Set("APCA-API-SECRET-KEY", s.secretKey)

	resp, err := s.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch snapshot: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("API error %d: %s", resp.StatusCode, string(body))
	}

	var snapshot AlpacaOptionsSnapshot
	if err := json.NewDecoder(resp.Body).Decode(&snapshot); err != nil {
		return nil, fmt.Errorf("failed to decode snapshot: %w", err)
	}

	// Convert to our format
	if alpacaContract, ok := snapshot.Snapshots[optionSymbol]; ok {
		premium := (alpacaContract.LatestQuote.BidPrice + alpacaContract.LatestQuote.AskPrice) / 2

		contract := &interfaces.OptionContract{
			Symbol:            optionSymbol,
			Premium:           premium,
			Bid:               alpacaContract.LatestQuote.BidPrice,
			Ask:               alpacaContract.LatestQuote.AskPrice,
			Delta:             alpacaContract.Greeks.Delta,
			Gamma:             alpacaContract.Greeks.Gamma,
			Theta:             alpacaContract.Greeks.Theta,
			Vega:              alpacaContract.Greeks.Vega,
			ImpliedVolatility: alpacaContract.ImpliedVolatility,
		}

		return contract, nil
	}

	return nil, fmt.Errorf("no snapshot data for %s", optionSymbol)
}

const (
	// contractsPageLimit asks for the whole chain in one round trip. A single
	// QQQ expiry is ~518 contracts; the default page size is 100.
	contractsPageLimit = 10000
	// contractsMaxPages bounds the token loop so a misbehaving server cannot
	// hang the 17:00 ET hedge heartbeat.
	contractsMaxPages = 20
)

// toOptionContract maps one Alpaca contract to the internal type. Returns
// ok=false for a contract that cannot be used at all — a bad strike or a bad
// expiration — so one malformed row degrades itself, not the whole chain.
func (s *AlpacaOptionsDataService) toOptionContract(ac AlpacaOptionChainContract) (*interfaces.OptionContract, bool) {
	strike, err := strconv.ParseFloat(ac.StrikePrice, 64)
	if err != nil {
		s.logger.WithFields(logrus.Fields{
			"symbol":       ac.Symbol,
			"strike_price": ac.StrikePrice,
		}).Debug("skipping option contract with unparseable strike_price")
		return nil, false
	}
	expDate, err := time.Parse("2006-01-02", ac.ExpirationDate)
	if err != nil {
		s.logger.WithFields(logrus.Fields{
			"symbol":          ac.Symbol,
			"expiration_date": ac.ExpirationDate,
		}).Debug("skipping option contract with unparseable expiration_date")
		return nil, false
	}
	// open_interest is informational on the hedge path — never drop a
	// contract over it.
	oi, err := strconv.ParseInt(ac.OpenInterest, 10, 64)
	if err != nil {
		oi = 0
	}
	return &interfaces.OptionContract{
		Symbol:           ac.Symbol,
		UnderlyingSymbol: ac.UnderlyingSymbol,
		ContractType:     ac.Type,
		StrikePrice:      strike,
		ExpirationDate:   expDate,
		DTE:              int(time.Until(expDate).Hours() / 24),
		OpenInterest:     oi,
	}, true
}

// fetchContracts issues paginated GETs against the trading API's
// option-contracts endpoint with the caller's query params and returns every
// contract across all pages, keyed by OCC symbol.
//
// Pagination is load-bearing, not a nicety: Alpaca returns calls before puts,
// so reading only the first page of a QQQ expiry yields zero puts.
func (s *AlpacaOptionsDataService) fetchContracts(ctx context.Context, params neturl.Values) (map[string]*interfaces.OptionContract, error) {
	contracts := make(map[string]*interfaces.OptionContract)
	pageToken := ""

	for page := 0; page < contractsMaxPages; page++ {
		q := neturl.Values{}
		for k, vs := range params {
			for _, v := range vs {
				q.Add(k, v)
			}
		}
		q.Set("limit", strconv.Itoa(contractsPageLimit))
		if pageToken != "" {
			q.Set("page_token", pageToken)
		}
		endpoint := fmt.Sprintf("%s/v2/options/contracts?%s", s.tradingURL, q.Encode())

		req, err := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("APCA-API-KEY-ID", s.apiKey)
		req.Header.Set("APCA-API-SECRET-KEY", s.secretKey)

		resp, err := s.client.Do(req)
		if err != nil {
			return nil, fmt.Errorf("failed to fetch option contracts: %w", err)
		}
		body, readErr := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("API error %d: %s", resp.StatusCode, string(body))
		}
		if readErr != nil {
			return nil, fmt.Errorf("failed to read contracts response: %w", readErr)
		}

		var chainResp AlpacaOptionChainResponse
		if err := json.Unmarshal(body, &chainResp); err != nil {
			return nil, fmt.Errorf("failed to decode chain: %w", err)
		}
		for _, ac := range chainResp.OptionContracts {
			if c, ok := s.toOptionContract(ac); ok {
				contracts[c.Symbol] = c
			}
		}
		if chainResp.NextPageToken == "" {
			return contracts, nil
		}
		pageToken = chainResp.NextPageToken
	}

	// Refuse to hand back a truncated chain: wrong strikes are worse than a
	// skipped beat.
	return nil, fmt.Errorf("option contracts pagination exceeded %d pages — refusing to return a partial chain", contractsMaxPages)
}

// GetOptionChain retrieves every listed contract for an underlying at ONE
// exact expiration date.
func (s *AlpacaOptionsDataService) GetOptionChain(ctx context.Context, underlying string, expirationDate time.Time) (map[string]*interfaces.OptionContract, error) {
	params := neturl.Values{}
	params.Set("underlying_symbols", underlying)
	params.Set("expiration_date", expirationDate.Format("2006-01-02"))

	contracts, err := s.fetchContracts(ctx, params)
	if err != nil {
		return nil, err
	}
	s.logger.WithFields(logrus.Fields{
		"underlying": underlying,
		"expiration": expirationDate.Format("2006-01-02"),
		"count":      len(contracts),
	}).Debug("Fetched option chain")
	return contracts, nil
}

// GetOptionChainRange retrieves every listed contract for an underlying whose
// expiration falls within [gte, lte] inclusive. Used to discover which
// expiries actually exist inside a DTE band.
func (s *AlpacaOptionsDataService) GetOptionChainRange(ctx context.Context, underlying string, gte, lte time.Time) (map[string]*interfaces.OptionContract, error) {
	params := neturl.Values{}
	params.Set("underlying_symbols", underlying)
	params.Set("expiration_date_gte", gte.Format("2006-01-02"))
	params.Set("expiration_date_lte", lte.Format("2006-01-02"))

	contracts, err := s.fetchContracts(ctx, params)
	if err != nil {
		return nil, err
	}
	s.logger.WithFields(logrus.Fields{
		"underlying": underlying,
		"gte":        gte.Format("2006-01-02"),
		"lte":        lte.Format("2006-01-02"),
		"count":      len(contracts),
	}).Debug("Fetched option chain range")
	return contracts, nil
}

// FindOptionsNearDTE finds call contracts near a target DTE for an underlying.
func (s *AlpacaOptionsDataService) FindOptionsNearDTE(ctx context.Context, underlying string, targetDTE int, tolerance int) (map[string]*interfaces.OptionContract, error) {
	targetDate := time.Now().AddDate(0, 0, targetDTE)
	startDate := targetDate.AddDate(0, 0, -tolerance)
	endDate := targetDate.AddDate(0, 0, tolerance)

	params := neturl.Values{}
	params.Set("underlying_symbols", underlying)
	params.Set("expiration_date_gte", startDate.Format("2006-01-02"))
	params.Set("expiration_date_lte", endDate.Format("2006-01-02"))
	params.Set("type", "call")

	contracts, err := s.fetchContracts(ctx, params)
	if err != nil {
		return nil, err
	}
	s.logger.WithFields(logrus.Fields{
		"underlying": underlying,
		"targetDTE":  targetDTE,
		"dateRange":  fmt.Sprintf("%s to %s", startDate.Format("2006-01-02"), endDate.Format("2006-01-02")),
		"count":      len(contracts),
	}).Info("Found option contracts near target DTE")
	return contracts, nil
}