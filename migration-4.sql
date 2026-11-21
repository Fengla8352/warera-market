-- MIGRACIJA 4: manje upisa u bazu (besplatni D1 dopušta 100 000 upisanih redaka dnevno).
-- Igrači iz država koje ne pratimo više se ne spremaju u players (5 redaka s indeksima po igraču),
-- nego u player_country (1 redak). Dnevna statistika piše se samo za igrače iz praćenih država.
-- Pokreni jednom u D1 Consoleu, PRIJE objave novog koda. Podaci se ne brišu.
-- Dok Worker ne upiše tablicu tracked, okidač radi kao prije (sve države).

-- Država i ime za SVE provjerene igrače (i one iz država koje ne pratimo).
-- Jedan redak bez dodatnih indeksa, da upis bude što jeftiniji (besplatni D1 dopušta 100 000 upisanih redaka dnevno).
CREATE TABLE IF NOT EXISTS player_country (
  user_id    TEXT PRIMARY KEY,
  country_id TEXT,
  name       TEXT,
  fetched_at INTEGER NOT NULL
) WITHOUT ROWID;

-- ID-ovi praćenih država (puni ih Worker iz TRACKED_COUNTRIES). Prazno = sve države.
CREATE TABLE IF NOT EXISTS tracked (
  country_id TEXT PRIMARY KEY
) WITHOUT ROWID;

INSERT OR IGNORE INTO player_country (user_id, country_id, name, fetched_at)
SELECT user_id, country_id, name, fetched_at FROM players WHERE fetched_at > 0;

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

  INSERT INTO player_item_daily (user_id, day, item_code, bought_qty, sold_qty)
  SELECT NEW.buyer_id, substr(NEW.created_at, 1, 10), COALESCE(NEW.item_code, '?'), NEW.quantity, 0
  WHERE NOT EXISTS (SELECT 1 FROM tracked)
     OR EXISTS (SELECT 1 FROM player_country pc JOIN tracked t ON t.country_id = pc.country_id WHERE pc.user_id = NEW.buyer_id)
  ON CONFLICT(user_id, day, item_code) DO UPDATE SET bought_qty = bought_qty + NEW.quantity;

  INSERT INTO player_item_daily (user_id, day, item_code, bought_qty, sold_qty)
  SELECT NEW.seller_id, substr(NEW.created_at, 1, 10), COALESCE(NEW.item_code, '?'), 0, NEW.quantity
  WHERE NOT EXISTS (SELECT 1 FROM tracked)
     OR EXISTS (SELECT 1 FROM player_country pc JOIN tracked t ON t.country_id = pc.country_id WHERE pc.user_id = NEW.seller_id)
  ON CONFLICT(user_id, day, item_code) DO UPDATE SET sold_qty = sold_qty + NEW.quantity;
END;
