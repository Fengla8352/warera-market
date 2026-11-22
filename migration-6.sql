-- MIGRACIJA 6: indeks za pregled iznad tablice (cijena po danima, zbroj po državama) i rang listu po itemu.
-- Pokreni jednom u D1 Consoleu. Podaci se ne brišu (jednokratno oko 1 upis po retku dnevne statistike).
CREATE INDEX IF NOT EXISTS idx_daily_item_day ON player_item_daily(item_code, day);
