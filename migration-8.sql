-- MIGRACIJA 8: povijest po igraču (globalni popis transakcija u WarEra API-ju seže samo ~3 dana).
-- Pokreni jednom u D1 Consoleu, PRIJE objave novog koda. Podaci se ne brišu.
-- Postojeći igrači dobivaju hist_done = 1 (ne trebaju povijest), a igrači praćenih država 0 (treba im povijest).
ALTER TABLE players ADD COLUMN hist_cursor TEXT;
ALTER TABLE players ADD COLUMN hist_done INTEGER NOT NULL DEFAULT 1;
UPDATE players SET hist_done = 0 WHERE fetched_at > 0 AND country_id IN (SELECT country_id FROM tracked);
CREATE INDEX IF NOT EXISTS idx_players_hist ON players(hist_done) WHERE hist_done = 0;
