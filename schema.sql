-- Sirove transakcije item marketa (dedupliciraju se po ID-u transakcije)
CREATE TABLE IF NOT EXISTS transactions (
  id          TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL,
  buyer_id    TEXT NOT NULL,
  seller_id   TEXT NOT NULL,
  item_code   TEXT,
  quantity    INTEGER NOT NULL,
  money       REAL NOT NULL
);

-- Agregirana statistika po igraču (puni se triggerom, samo za stvarno nove transakcije)
CREATE TABLE IF NOT EXISTS player_stats (
  user_id      TEXT PRIMARY KEY,
  bought_qty   INTEGER NOT NULL DEFAULT 0,
  bought_money REAL    NOT NULL DEFAULT 0,
  bought_tx    INTEGER NOT NULL DEFAULT 0,
  sold_qty     INTEGER NOT NULL DEFAULT 0,
  sold_money   REAL    NOT NULL DEFAULT 0,
  sold_tx      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_stats_bought_qty ON player_stats(bought_qty DESC);

CREATE TRIGGER IF NOT EXISTS trg_tx_stats AFTER INSERT ON transactions
BEGIN
  INSERT INTO player_stats (user_id, bought_qty, bought_money, bought_tx)
  VALUES (NEW.buyer_id, NEW.quantity, NEW.money, 1)
  ON CONFLICT(user_id) DO UPDATE SET
    bought_qty   = bought_qty   + NEW.quantity,
    bought_money = bought_money + NEW.money,
    bought_tx    = bought_tx    + 1;

  INSERT INTO player_stats (user_id, sold_qty, sold_money, sold_tx)
  VALUES (NEW.seller_id, NEW.quantity, NEW.money, 1)
  ON CONFLICT(user_id) DO UPDATE SET
    sold_qty   = sold_qty   + NEW.quantity,
    sold_money = sold_money + NEW.money,
    sold_tx    = sold_tx    + 1;
END;

-- Podaci o igračima (ime + država), dohvaćaju se iz user.getUserLite
CREATE TABLE IF NOT EXISTS players (
  user_id    TEXT PRIMARY KEY,
  name       TEXT,
  country_id TEXT,
  fetched_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_players_country ON players(country_id);
CREATE INDEX IF NOT EXISTS idx_players_name ON players(name COLLATE NOCASE);

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
