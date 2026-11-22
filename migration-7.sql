-- MIGRACIJA 7: profilne slike igrača iz praćenih država.
-- Pokreni jednom u D1 Consoleu, PRIJE objave novog koda. Podaci se ne brišu.
ALTER TABLE players ADD COLUMN avatar TEXT;
