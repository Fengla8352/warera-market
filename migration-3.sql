-- MIGRACIJA 3: indeks na players(fetched_at).
-- Bez njega je cron svake minute čitao cijelu tablicu igrača (2-3 puta), što je trošilo dnevni D1 limit čitanja.
-- Pokreni jednom u D1 Consoleu. Podaci se ne brišu.
CREATE INDEX IF NOT EXISTS idx_players_fetched ON players(fetched_at);
