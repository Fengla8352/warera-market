-- MIGRACIJA sa stare sheme (player_stats) na novu (player_item_daily).
-- Pokreni u D1 Consoleu OVIM REDOSLIJEDOM. Dio 1 odjednom, pa dio 2 (okidač) kao zasebnu naredbu.
-- Briše spremljene transakcije i statistiku (učitat će se ponovo iz API-ja). Igrači, države i savezi ostaju.

-- ===== DIO 1 =====
DROP TRIGGER IF EXISTS trg_tx_stats;
DROP TABLE IF EXISTS player_stats;
DELETE FROM transactions;
DELETE FROM meta WHERE key LIKE 's:%' OR key LIKE 'dbg_%' OR key IN ('head_ts','backfill_done','backfill_cursor','fwd_cursor','fwd_new_head','order');

CREATE TABLE IF NOT EXISTS player_item_daily (
  user_id     TEXT NOT NULL,
  day         TEXT NOT NULL,
  item_code   TEXT NOT NULL,
  bought_qty  INTEGER NOT NULL DEFAULT 0,
  sold_qty    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, item_code)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_daily_day ON player_item_daily(day);

-- ===== DIO 2 (zasebna naredba) =====
CREATE TRIGGER IF NOT EXISTS trg_tx_daily AFTER INSERT ON transactions
BEGIN
  INSERT OR IGNORE INTO players (user_id, fetched_at) VALUES (NEW.buyer_id, 0);
  INSERT OR IGNORE INTO players (user_id, fetched_at) VALUES (NEW.seller_id, 0);

  INSERT INTO player_item_daily (user_id, day, item_code, bought_qty, sold_qty)
  VALUES (NEW.buyer_id, substr(NEW.created_at, 1, 10), COALESCE(NEW.item_code, '?'), NEW.quantity, 0)
  ON CONFLICT(user_id, day, item_code) DO UPDATE SET bought_qty = bought_qty + NEW.quantity;

  INSERT INTO player_item_daily (user_id, day, item_code, bought_qty, sold_qty)
  VALUES (NEW.seller_id, substr(NEW.created_at, 1, 10), COALESCE(NEW.item_code, '?'), 0, NEW.quantity)
  ON CONFLICT(user_id, day, item_code) DO UPDATE SET sold_qty = sold_qty + NEW.quantity;
END;
