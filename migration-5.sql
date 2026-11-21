-- MIGRACIJA 5: potrošeni i zarađeni novac u dnevnoj statistici.
-- Pokreni jednom u D1 Consoleu, PRIJE objave novog koda. Podaci se ne brišu.
-- Novac za već spremljene dane izračuna se iz tablice transactions (samo za igrače iz praćenih država).

ALTER TABLE player_item_daily ADD COLUMN bought_money REAL NOT NULL DEFAULT 0;
ALTER TABLE player_item_daily ADD COLUMN sold_money REAL NOT NULL DEFAULT 0;

DROP TRIGGER IF EXISTS trg_tx_daily;
CREATE TRIGGER IF NOT EXISTS trg_tx_daily AFTER INSERT ON transactions
BEGIN
  -- tablica tracked je prazna = pratimo sve države; inače samo strana iz praćene države dobiva statistiku
  INSERT OR IGNORE INTO players (user_id, fetched_at)
  SELECT NEW.buyer_id, 0
  WHERE NOT EXISTS (SELECT 1 FROM tracked)
     OR EXISTS (SELECT 1 FROM player_country pc JOIN tracked t ON t.country_id = pc.country_id WHERE pc.user_id = NEW.buyer_id);

  INSERT OR IGNORE INTO players (user_id, fetched_at)
  SELECT NEW.seller_id, 0
  WHERE NOT EXISTS (SELECT 1 FROM tracked)
     OR EXISTS (SELECT 1 FROM player_country pc JOIN tracked t ON t.country_id = pc.country_id WHERE pc.user_id = NEW.seller_id);

  INSERT INTO player_item_daily (user_id, day, item_code, bought_qty, sold_qty, bought_money, sold_money)
  SELECT NEW.buyer_id, substr(NEW.created_at, 1, 10), COALESCE(NEW.item_code, '?'), NEW.quantity, 0, NEW.money, 0
  WHERE NOT EXISTS (SELECT 1 FROM tracked)
     OR EXISTS (SELECT 1 FROM player_country pc JOIN tracked t ON t.country_id = pc.country_id WHERE pc.user_id = NEW.buyer_id)
  ON CONFLICT(user_id, day, item_code) DO UPDATE SET bought_qty = bought_qty + NEW.quantity, bought_money = bought_money + NEW.money;

  INSERT INTO player_item_daily (user_id, day, item_code, bought_qty, sold_qty, bought_money, sold_money)
  SELECT NEW.seller_id, substr(NEW.created_at, 1, 10), COALESCE(NEW.item_code, '?'), 0, NEW.quantity, 0, NEW.money
  WHERE NOT EXISTS (SELECT 1 FROM tracked)
     OR EXISTS (SELECT 1 FROM player_country pc JOIN tracked t ON t.country_id = pc.country_id WHERE pc.user_id = NEW.seller_id)
  ON CONFLICT(user_id, day, item_code) DO UPDATE SET sold_qty = sold_qty + NEW.quantity, sold_money = sold_money + NEW.money;
END;

UPDATE player_item_daily SET
  bought_money = COALESCE((SELECT SUM(t.money) FROM transactions t
    WHERE t.buyer_id = player_item_daily.user_id AND substr(t.created_at, 1, 10) = player_item_daily.day
      AND COALESCE(t.item_code, '?') = player_item_daily.item_code), 0),
  sold_money = COALESCE((SELECT SUM(t.money) FROM transactions t
    WHERE t.seller_id = player_item_daily.user_id AND substr(t.created_at, 1, 10) = player_item_daily.day
      AND COALESCE(t.item_code, '?') = player_item_daily.item_code), 0)
WHERE user_id IN (SELECT user_id FROM players WHERE country_id IN (SELECT country_id FROM tracked));
