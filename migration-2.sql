-- MIGRACIJA 2: indeksi za brzo dohvaćanje transakcija jednog igrača (prozor igrača).
-- Pokreni jednom u D1 Consoleu. Podaci se ne brišu; indeksi se grade nad postojećim transakcijama
-- (jednokratni upis, otprilike 2 retka po spremljenoj transakciji).
CREATE INDEX IF NOT EXISTS idx_tx_buyer  ON transactions(buyer_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tx_seller ON transactions(seller_id, created_at);
