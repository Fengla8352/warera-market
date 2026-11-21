-- Sirove transakcije (služe samo za deduplikaciju i okidač; dedupliciraju se po ID-u transakcije)
CREATE TABLE IF NOT EXISTS transactions (
  id          TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL,
  buyer_id    TEXT NOT NULL,
  seller_id   TEXT NOT NULL,
  item_code   TEXT,
  quantity    INTEGER NOT NULL,
  money       REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tx_buyer  ON transactions(buyer_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tx_seller ON transactions(seller_id, created_at);

-- Statistika po igraču, danu (UTC) i itemu. Puni se okidačem samo za stvarno nove transakcije.
CREATE TABLE IF NOT EXISTS player_item_daily (
  user_id     TEXT NOT NULL,
  day         TEXT NOT NULL,
  item_code   TEXT NOT NULL,
  bought_qty  INTEGER NOT NULL DEFAULT 0,
  sold_qty    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, item_code)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_daily_day ON player_item_daily(day);

-- Podaci o igračima (ime + država), dohvaćaju se iz user.getUserLite
-- fetched_at = 0 znači "vidjeli smo igrača u transakciji, još nije dohvaćen"
CREATE TABLE IF NOT EXISTS players (
  user_id    TEXT PRIMARY KEY,
  name       TEXT,
  country_id TEXT,
  fetched_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_players_country ON players(country_id);
CREATE INDEX IF NOT EXISTS idx_players_name ON players(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_players_fetched ON players(fetched_at);

CREATE TABLE IF NOT EXISTS countries (
  id          TEXT PRIMARY KEY,
  name        TEXT,
  alliance_id TEXT
);

CREATE TABLE IF NOT EXISTS alliances (
  id   TEXT PRIMARY KEY,
  name TEXT
);

-- Stanje sinkronizacije (kursori, lock, greške)
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

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
