package models

import (
	"time"

	"gorm.io/gorm"
)

// DBIVSnapshot stores one ATM-IV reading per underlying per trading day. The
// table name is retained as "harvest_iv_snapshots" for historical-data
// continuity (the daily IV collector predates the Harvest retirement); the data
// is consumed by IVRankService for Prophet's IV-rank gate.
type DBIVSnapshot struct {
	gorm.Model
	Underlying string    `gorm:"uniqueIndex:idx_harvest_iv_under_date"`
	Date       time.Time `gorm:"uniqueIndex:idx_harvest_iv_under_date"`
	ATMIV      float64   // at-the-money implied volatility (average of nearest put+call)
}

func (DBIVSnapshot) TableName() string { return "harvest_iv_snapshots" }
