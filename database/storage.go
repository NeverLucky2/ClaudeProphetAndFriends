package database

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"prophet-trader/interfaces"
	"prophet-trader/models"
	"time"

	"github.com/sirupsen/logrus"
	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"gorm.io/gorm/logger"
)

// LocalStorage implements the StorageService interface using SQLite
type LocalStorage struct {
	db     *gorm.DB
	logger *logrus.Logger
}

// NewLocalStorage creates a new local storage service
func NewLocalStorage(dbPath string) (*LocalStorage, error) {
	// Ensure the directory exists
	dir := filepath.Dir(dbPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create database directory: %w", err)
	}

	// Open SQLite database
	db, err := gorm.Open(sqlite.Open(dbPath), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}

	// Auto-migrate schemas
	if err := db.AutoMigrate(
		&models.DBOrder{},
		&models.DBBar{},
		&models.DBPosition{},
		&models.DBTrade{},
		&models.DBAccountSnapshot{},
		&models.DBSignal{},
		&models.DBManagedPosition{},
		&models.DBHarvestCondor{},
		&models.DBHarvestIVSnapshot{},
		&models.DBSegmentPnL{},
		&models.DBTrendLedgerEntry{},
		&models.DBTurtleSession{},
		&models.DBProphetHedgeSpread{},
		&models.DBProphetHedgeSession{},
	); err != nil {
		return nil, fmt.Errorf("failed to migrate database: %w", err)
	}

	logger := logrus.New()
	logger.SetFormatter(&logrus.TextFormatter{
		FullTimestamp: true,
	})

	return &LocalStorage{
		db:     db,
		logger: logger,
	}, nil
}

// SaveBars saves multiple bars to the database
func (s *LocalStorage) SaveBars(bars []*interfaces.Bar) error {
	if len(bars) == 0 {
		return nil
	}

	s.logger.WithField("count", len(bars)).Info("Saving bars to database")

	// Convert interface bars to DB bars
	dbBars := make([]*models.DBBar, len(bars))
	for i, bar := range bars {
		dbBars[i] = &models.DBBar{
			Symbol:    bar.Symbol,
			Timestamp: bar.Timestamp,
			Open:      bar.Open,
			High:      bar.High,
			Low:       bar.Low,
			Close:     bar.Close,
			Volume:    bar.Volume,
			VWAP:      bar.VWAP,
		}
	}

	// Batch insert with upsert on conflict
	result := s.db.Create(&dbBars)
	if result.Error != nil {
		return fmt.Errorf("failed to save bars: %w", result.Error)
	}

	s.logger.WithField("saved", result.RowsAffected).Info("Bars saved successfully")
	return nil
}

// GetBars retrieves bars for a symbol within a time range
func (s *LocalStorage) GetBars(symbol string, start, end time.Time) ([]*interfaces.Bar, error) {
	var dbBars []*models.DBBar

	result := s.db.Where("symbol = ? AND timestamp >= ? AND timestamp <= ?", symbol, start, end).
		Order("timestamp ASC").
		Find(&dbBars)

	if result.Error != nil {
		return nil, fmt.Errorf("failed to get bars: %w", result.Error)
	}

	// Convert DB bars to interface bars
	bars := make([]*interfaces.Bar, len(dbBars))
	for i, dbBar := range dbBars {
		bars[i] = &interfaces.Bar{
			Symbol:    dbBar.Symbol,
			Timestamp: dbBar.Timestamp,
			Open:      dbBar.Open,
			High:      dbBar.High,
			Low:       dbBar.Low,
			Close:     dbBar.Close,
			Volume:    dbBar.Volume,
			VWAP:      dbBar.VWAP,
		}
	}

	return bars, nil
}

// SaveOrder saves an order to the database
func (s *LocalStorage) SaveOrder(order *interfaces.Order) error {
	dbOrder := &models.DBOrder{
		OrderID:        order.ID,
		ClientOrderID:  order.ClientOrderID,
		Symbol:         order.Symbol,
		Qty:            order.Qty,
		Side:           order.Side,
		Type:           order.Type,
		TimeInForce:    order.TimeInForce,
		LimitPrice:     order.LimitPrice,
		StopPrice:      order.StopPrice,
		Status:         order.Status,
		FilledQty:      order.FilledQty,
		FilledAvgPrice: order.FilledAvgPrice,
		SubmittedAt:    order.SubmittedAt,
		FilledAt:       order.FilledAt,
		CanceledAt:     order.CanceledAt,
		StrategyName:   order.Strategy,
	}

	result := s.db.Save(dbOrder)
	if result.Error != nil {
		return fmt.Errorf("failed to save order: %w", result.Error)
	}

	return nil
}

// GetOrder retrieves an order by ID
func (s *LocalStorage) GetOrder(orderID string) (*interfaces.Order, error) {
	var dbOrder models.DBOrder

	result := s.db.Where("order_id = ?", orderID).First(&dbOrder)
	if result.Error != nil {
		return nil, fmt.Errorf("failed to get order: %w", result.Error)
	}

	// Strategy preference: explicit StrategyName column wins; fall back to
	// reverse-extraction from ClientOrderID if the column was never written
	// (legacy rows or fills that arrived before the DBOrder write).
	strategy := dbOrder.StrategyName
	if strategy == "" {
		strategy = interfaces.ParseStrategyFromClientOrderID(dbOrder.ClientOrderID)
	}

	return &interfaces.Order{
		ID:             dbOrder.OrderID,
		ClientOrderID:  dbOrder.ClientOrderID,
		Symbol:         dbOrder.Symbol,
		Qty:            dbOrder.Qty,
		Side:           dbOrder.Side,
		Type:           dbOrder.Type,
		TimeInForce:    dbOrder.TimeInForce,
		LimitPrice:     dbOrder.LimitPrice,
		StopPrice:      dbOrder.StopPrice,
		Status:         dbOrder.Status,
		FilledQty:      dbOrder.FilledQty,
		FilledAvgPrice: dbOrder.FilledAvgPrice,
		SubmittedAt:    dbOrder.SubmittedAt,
		FilledAt:       dbOrder.FilledAt,
		CanceledAt:     dbOrder.CanceledAt,
		Strategy:       strategy,
	}, nil
}

// GetSymbolStrategyAttribution returns a symbol → agent-strategy map derived
// from the most recent buy-side order per symbol. Used by the position-by-
// strategy filter to attribute broker-truth positions back to the agent that
// opened them.
//
// Source priority per symbol:
//  1. DBOrder.StrategyName (set by tagged buy orders via the regular path)
//  2. ParseStrategyFromClientOrderID(DBOrder.ClientOrderID) — fallback for
//     fills where the StrategyName column was never written but the broker
//     still preserved our encoded client_order_id
//  3. DBManagedPosition.AgentStrategy — defense-in-depth fallback for symbols
//     held via PlaceManagedPosition where the entry order's DBOrder row was
//     lost or never persisted. The dedicated AgentStrategy column carries
//     agent IDs (trend, v2-options) cleanly; do NOT confuse
//     it with DBManagedPosition.Strategy which is the trading-style label
//     (DAY_TRADE / SWING_TRADE / LONG_TERM). Rows with an empty AgentStrategy
//     are ignored.
func (s *LocalStorage) GetSymbolStrategyAttribution() (map[string]string, error) {
	var dbOrders []*models.DBOrder
	if err := s.db.
		Where("side = ?", "buy").
		Order("submitted_at DESC").
		Find(&dbOrders).Error; err != nil {
		return nil, fmt.Errorf("query buy orders for attribution: %w", err)
	}

	out := make(map[string]string)
	for _, o := range dbOrders {
		// Symbols already attributed by a more recent order win — skip.
		if _, seen := out[o.Symbol]; seen {
			continue
		}
		strategy := o.StrategyName
		if strategy == "" {
			strategy = interfaces.ParseStrategyFromClientOrderID(o.ClientOrderID)
		}
		if strategy != "" {
			out[o.Symbol] = strategy
		}
	}

	// Managed-position fallback. Orders win when present, so we only fill in
	// symbols not yet seen. Newest row per symbol wins (most-recent buy
	// semantics, matching the order path).
	var dbPositions []*models.DBManagedPosition
	if err := s.db.
		Where("agent_strategy <> ?", "").
		Order("created_at DESC").
		Find(&dbPositions).Error; err != nil {
		return nil, fmt.Errorf("query managed_positions for attribution: %w", err)
	}
	for _, p := range dbPositions {
		if _, seen := out[p.Symbol]; seen {
			continue
		}
		out[p.Symbol] = p.AgentStrategy
	}
	return out, nil
}

// GetOrders retrieves orders by status
func (s *LocalStorage) GetOrders(status string) ([]*interfaces.Order, error) {
	var dbOrders []*models.DBOrder

	query := s.db.Model(&models.DBOrder{})
	if status != "" {
		query = query.Where("status = ?", status)
	}

	result := query.Order("submitted_at DESC").Find(&dbOrders)
	if result.Error != nil {
		return nil, fmt.Errorf("failed to get orders: %w", result.Error)
	}

	orders := make([]*interfaces.Order, len(dbOrders))
	for i, dbOrder := range dbOrders {
		orders[i] = &interfaces.Order{
			ID:             dbOrder.OrderID,
			Symbol:         dbOrder.Symbol,
			Qty:            dbOrder.Qty,
			Side:           dbOrder.Side,
			Type:           dbOrder.Type,
			TimeInForce:    dbOrder.TimeInForce,
			LimitPrice:     dbOrder.LimitPrice,
			StopPrice:      dbOrder.StopPrice,
			Status:         dbOrder.Status,
			FilledQty:      dbOrder.FilledQty,
			FilledAvgPrice: dbOrder.FilledAvgPrice,
			SubmittedAt:    dbOrder.SubmittedAt,
			FilledAt:       dbOrder.FilledAt,
			CanceledAt:     dbOrder.CanceledAt,
		}
	}

	return orders, nil
}

// CleanupOldData removes data older than the specified time
func (s *LocalStorage) CleanupOldData(before time.Time) error {
	s.logger.WithField("before", before).Info("Cleaning up old data")

	// Delete old bars
	if err := s.db.Where("timestamp < ?", before).Delete(&models.DBBar{}).Error; err != nil {
		return fmt.Errorf("failed to delete old bars: %w", err)
	}

	// Delete old account snapshots
	if err := s.db.Where("snapshot_time < ?", before).Delete(&models.DBAccountSnapshot{}).Error; err != nil {
		return fmt.Errorf("failed to delete old snapshots: %w", err)
	}

	// Delete old signals
	if err := s.db.Where("created_at < ?", before).Delete(&models.DBSignal{}).Error; err != nil {
		return fmt.Errorf("failed to delete old signals: %w", err)
	}

	s.logger.Info("Old data cleaned up successfully")
	return nil
}

// Additional helper methods

// SavePosition upserts the current-state row for a symbol. The DBPosition
// schema has a uniqueIndex on Symbol — one row per symbol = current snapshot.
// db.Save() requires a primary key to update; without one it INSERTs and trips
// the unique index every monitor tick. Use OnConflict(symbol) → UpdateAll so
// subsequent calls overwrite Qty/MarketValue/UnrealizedPL/etc. in place.
func (s *LocalStorage) SavePosition(position *interfaces.Position) error {
	dbPosition := &models.DBPosition{
		Symbol:         position.Symbol,
		Qty:            position.Qty,
		AvgEntryPrice:  position.AvgEntryPrice,
		MarketValue:    position.MarketValue,
		CostBasis:      position.CostBasis,
		UnrealizedPL:   position.UnrealizedPL,
		UnrealizedPLPC: position.UnrealizedPLPC,
		CurrentPrice:   position.CurrentPrice,
		Side:           position.Side,
		SnapshotTime:   time.Now(),
	}

	result := s.db.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "symbol"}},
		UpdateAll: true,
	}).Create(dbPosition)
	if result.Error != nil {
		return fmt.Errorf("failed to save position: %w", result.Error)
	}

	return nil
}

// SaveAccountSnapshot saves an account snapshot
func (s *LocalStorage) SaveAccountSnapshot(account *interfaces.Account) error {
	dbSnapshot := &models.DBAccountSnapshot{
		Cash:             account.Cash,
		PortfolioValue:   account.PortfolioValue,
		BuyingPower:      account.BuyingPower,
		DayTradeCount:    account.DayTradeCount,
		PatternDayTrader: account.PatternDayTrader,
		SnapshotTime:     time.Now(),
	}

	result := s.db.Save(dbSnapshot)
	if result.Error != nil {
		return fmt.Errorf("failed to save account snapshot: %w", result.Error)
	}

	return nil
}

// SaveSignal saves a trading signal
func (s *LocalStorage) SaveSignal(symbol, signalType, strategyName, reason string, strength float64) error {
	dbSignal := &models.DBSignal{
		Symbol:       symbol,
		SignalType:   signalType,
		Strength:     strength,
		StrategyName: strategyName,
		Reason:       reason,
		Executed:     false,
	}

	result := s.db.Save(dbSignal)
	if result.Error != nil {
		return fmt.Errorf("failed to save signal: %w", result.Error)
	}

	return nil
}

// SaveManagedPosition upserts a managed position keyed on PositionID. The
// caller (services.PositionManager.managedPositionToDB) builds a fresh
// DBManagedPosition struct on every save without the GORM primary key — and
// db.Save() with no PK INSERTs, which trips the uniqueIndex on PositionID for
// the second and later writes. Pre-fix, those failures were logged at warn
// and ignored: when an entry order filled, the in-memory position was marked
// ACTIVE and the DB-side update silently dropped, leaving the row stuck in
// PENDING. That state mismatch is what produced Spark's 2026-05-18 Beat-Context
// misread (get_managed_positions returned 0 while the broker held LAND).
// Upsert on PositionID so subsequent saves update in place.
func (s *LocalStorage) SaveManagedPosition(position *models.DBManagedPosition) error {
	result := s.db.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "position_id"}},
		UpdateAll: true,
	}).Create(position)
	if result.Error != nil {
		return fmt.Errorf("failed to save managed position: %w", result.Error)
	}
	return nil
}

// GetManagedPosition retrieves a managed position by ID
func (s *LocalStorage) GetManagedPosition(positionID string) (*models.DBManagedPosition, error) {
	var dbPosition models.DBManagedPosition

	result := s.db.Where("position_id = ?", positionID).First(&dbPosition)
	if result.Error != nil {
		return nil, fmt.Errorf("failed to get managed position: %w", result.Error)
	}

	return &dbPosition, nil
}

// GetAllManagedPositions retrieves all managed positions with optional status filter
func (s *LocalStorage) GetAllManagedPositions(status string) ([]*models.DBManagedPosition, error) {
	var dbPositions []*models.DBManagedPosition

	query := s.db.Model(&models.DBManagedPosition{})
	if status != "" {
		query = query.Where("status = ?", status)
	}

	result := query.Order("created_at DESC").Find(&dbPositions)
	if result.Error != nil {
		return nil, fmt.Errorf("failed to get managed positions: %w", result.Error)
	}

	return dbPositions, nil
}

// DeleteManagedPosition deletes a managed position by ID
func (s *LocalStorage) DeleteManagedPosition(positionID string) error {
	result := s.db.Where("position_id = ?", positionID).Delete(&models.DBManagedPosition{})
	if result.Error != nil {
		return fmt.Errorf("failed to delete managed position: %w", result.Error)
	}
	return nil
}

// ── Harvest condor storage ─────────────────────────────────────────

func (s *LocalStorage) SaveHarvestCondor(c *models.DBHarvestCondor) error {
	return s.db.Save(c).Error
}

// UpdateHarvestCondor applies partial updates to a condor by condorID.
// Map keys must be GORM column names (e.g. "realized_pnl", "status"), not Go field names.
func (s *LocalStorage) UpdateHarvestCondor(condorID string, updates map[string]interface{}) error {
	return s.db.Model(&models.DBHarvestCondor{}).
		Where("condor_id = ?", condorID).
		Updates(updates).Error
}

func (s *LocalStorage) GetHarvestCondorByID(condorID string) (*models.DBHarvestCondor, error) {
	var c models.DBHarvestCondor
	if err := s.db.Where("condor_id = ?", condorID).First(&c).Error; err != nil {
		return nil, err
	}
	return &c, nil
}

func (s *LocalStorage) ListOpenHarvestCondors() ([]*models.DBHarvestCondor, error) {
	var condors []*models.DBHarvestCondor
	err := s.db.Where("status IN ?", []string{"OPEN", "CLOSING"}).Find(&condors).Error
	return condors, err
}

// GetHarvestClosedPnL sums realized P&L for condors closed within [start, end].
func (s *LocalStorage) GetHarvestClosedPnL(start, end time.Time) (float64, error) {
	var total float64
	err := s.db.Model(&models.DBHarvestCondor{}).
		Where("status = ? AND closed_at >= ? AND closed_at <= ?", "CLOSED", start, end).
		Select("COALESCE(SUM(realized_pnl), 0)").
		Scan(&total).Error
	return total, err
}

// ── Segment P&L storage ────────────────────────────────────────────

// SaveSegmentPnL upserts a daily segment-P&L row on the (strategy, date)
// unique index, so a re-run for the same day updates rather than duplicates.
func (s *LocalStorage) SaveSegmentPnL(row *models.DBSegmentPnL) error {
	result := s.db.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "strategy"}, {Name: "date"}},
		UpdateAll: true,
	}).Create(row)
	if result.Error != nil {
		return fmt.Errorf("failed to save segment pnl: %w", result.Error)
	}
	return nil
}

// GetSegmentPnLForDate returns the row for (strategy, date) or (nil, nil) if none.
func (s *LocalStorage) GetSegmentPnLForDate(strategy string, date time.Time) (*models.DBSegmentPnL, error) {
	var row models.DBSegmentPnL
	err := s.db.Where("strategy = ? AND date = ?", strategy, date).First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get segment pnl: %w", err)
	}
	return &row, nil
}

// GetManagedClosedPnL sums frozen realized P&L (UnrealizedPL, stamped at exit)
// and counts this strategy's managed positions that reached a terminal state
// with closed_at in [start, end).
func (s *LocalStorage) GetManagedClosedPnL(strategy string, start, end time.Time) (float64, int, error) {
	type agg struct {
		Total float64
		N     int64
	}
	var a agg
	err := s.db.Model(&models.DBManagedPosition{}).
		Where("agent_strategy = ? AND status IN ? AND closed_at >= ? AND closed_at < ?",
			strategy, []string{"CLOSED", "STOPPED_OUT"}, start, end).
		Select("COALESCE(SUM(unrealized_pl),0) AS total, COUNT(*) AS n").
		Scan(&a).Error
	if err != nil {
		return 0, 0, fmt.Errorf("failed to sum managed closed pnl: %w", err)
	}
	return a.Total, int(a.N), nil
}

// ListManagedStrategies returns the distinct non-empty AgentStrategy values
// ever recorded — the set of strategies to write daily rows for.
func (s *LocalStorage) ListManagedStrategies() ([]string, error) {
	var out []string
	err := s.db.Model(&models.DBManagedPosition{}).
		Distinct().
		Where("agent_strategy <> ''").
		Pluck("agent_strategy", &out).Error
	if err != nil {
		return nil, fmt.Errorf("failed to list managed strategies: %w", err)
	}
	return out, nil
}

// ── Harvest IV snapshot storage ────────────────────────────────────

func (s *LocalStorage) SaveHarvestIVSnapshot(snap *models.DBHarvestIVSnapshot) error {
	// OnConflict{DoNothing: true} makes duplicate (underlying, date) inserts a no-op,
	// relying on the DB-level unique index as the idempotency mechanism.
	return s.db.Clauses(clause.OnConflict{DoNothing: true}).Create(snap).Error
}

func (s *LocalStorage) GetHarvestIVSnapshots(underlying string, start, end time.Time) ([]*models.DBHarvestIVSnapshot, error) {
	var snaps []*models.DBHarvestIVSnapshot
	// end is an exclusive upper bound (date < end) so callers can use midnight boundaries cleanly.
	err := s.db.Where("underlying = ? AND date >= ? AND date < ?", underlying, start, end).
		Order("date ASC").
		Find(&snaps).Error
	return snaps, err
}

// ── Trend ledger storage ───────────────────────────────────────────

func (s *LocalStorage) SaveTrendLedgerEntry(e *models.DBTrendLedgerEntry) error {
	return s.db.Save(e).Error
}

// ListOpenTrendLedgerEntries returns rows with Status in {"pending_fill","open"}.
// Closed rows are retained for audit but excluded here.
func (s *LocalStorage) ListOpenTrendLedgerEntries() ([]*models.DBTrendLedgerEntry, error) {
	var rows []*models.DBTrendLedgerEntry
	err := s.db.Where("status IN ?", []string{"pending_fill", "open"}).Find(&rows).Error
	return rows, err
}

func (s *LocalStorage) GetTrendLedgerEntryByID(id uint) (*models.DBTrendLedgerEntry, error) {
	var e models.DBTrendLedgerEntry
	if err := s.db.First(&e, id).Error; err != nil {
		return nil, err
	}
	return &e, nil
}

// ── Turtle session storage ─────────────────────────────────────────

// GetTurtleSession returns the singleton session row (SessionID="singleton").
// **First-run contract:** if no row exists, returns (nil, nil) — NOT an error.
// The caller (TurtleExecutor) treats nil as "create a new session on first save".
// Other errors (DB unavailable, schema mismatch) propagate normally.
func (s *LocalStorage) GetTurtleSession() (*models.DBTurtleSession, error) {
	var sess models.DBTurtleSession
	err := s.db.Where("session_id = ?", "singleton").First(&sess).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &sess, nil
}

// SaveTurtleSession upserts the singleton row. Callers MUST set
// SessionID = "singleton" before invoking; on first save the GORM auto-id
// is assigned and the row is persisted.
func (s *LocalStorage) SaveTurtleSession(sess *models.DBTurtleSession) error {
	if sess.SessionID == "" {
		sess.SessionID = "singleton"
	}
	return s.db.Save(sess).Error
}

// ── Defensive-Prophet hedge storage ────────────────────────────────

func (s *LocalStorage) SaveProphetHedgeSpread(e *models.DBProphetHedgeSpread) error {
	return s.db.Save(e).Error
}

// ListOpenProphetHedgeSpreads returns spreads still in a live state
// (pending_fill, open, closing) — the set the executor reconciles/manages.
func (s *LocalStorage) ListOpenProphetHedgeSpreads() ([]*models.DBProphetHedgeSpread, error) {
	var out []*models.DBProphetHedgeSpread
	err := s.db.Where("status IN ?", []string{"pending_fill", "open", "closing"}).Find(&out).Error
	return out, err
}

func (s *LocalStorage) GetProphetHedgeSpreadByID(id uint) (*models.DBProphetHedgeSpread, error) {
	var e models.DBProphetHedgeSpread
	if err := s.db.First(&e, id).Error; err != nil {
		return nil, err
	}
	return &e, nil
}

func (s *LocalStorage) GetProphetHedgeSession() (*models.DBProphetHedgeSession, error) {
	var sess models.DBProphetHedgeSession
	err := s.db.Where("session_id = ?", "singleton").First(&sess).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil // first run
		}
		return nil, err
	}
	return &sess, nil
}

func (s *LocalStorage) SaveProphetHedgeSession(sess *models.DBProphetHedgeSession) error {
	if sess.SessionID == "" {
		sess.SessionID = "singleton"
	}
	return s.db.Save(sess).Error
}

// GetProphetHedgeClosedPnL sums RealizedPnL of spreads CLOSED within [start,end)
// — the realized half the segment writer needs, analogous to GetHarvestClosedPnL.
func (s *LocalStorage) GetProphetHedgeClosedPnL(start, end time.Time) (float64, error) {
	var total float64
	err := s.db.Model(&models.DBProphetHedgeSpread{}).
		Where("status = ? AND closed_at >= ? AND closed_at < ?", "closed", start, end).
		Select("COALESCE(SUM(realized_pnl), 0)").Scan(&total).Error
	return total, err
}

// Close closes the database connection
func (s *LocalStorage) Close() error {
	sqlDB, err := s.db.DB()
	if err != nil {
		return err
	}
	return sqlDB.Close()
}