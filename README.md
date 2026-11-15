# WarEra Market Ranking

Cloudflare Worker + D1 aplikacija koja prati transakcije item marketa u igri WarEra i prikazuje rang listu igrača po broju kupljenih itema. Filtriranje po državi i savezu, pretraga igrača, detalji igrača s nedavnim transakcijama.

## Kako radi

- **Cron (svake minute)** povlači transakcije (`transaction.getPaginatedTransactions`, tip `itemMarket`):
  - prvo pokretanje uzme najnoviju stranicu i zapamti "glavu",
  - svaki sljedeći poziv povuče sve novije od glave (praćenje uživo),
  - preostali budžet ide na **backfill** cijele povijesti unatrag (kursor se sprema, nastavlja se sam).
- Transakcije se deduplicirajju po ID-u; statistika po igraču (`player_stats`) puni se SQL triggerom samo za stvarno nove retke, pa ponovno učitavanje ne kvari brojeve.
- Imena i države igrača dohvaćaju se iz `user.getUserLite` (50 po zahtjevu), države i savezi jednom na sat.
- Nedavne transakcije u detaljima igrača dohvaćaju se uživo iz API-ja (cache 60 s), ne spremaju se po igraču.

## Deploy

```bash
cd warera-market
npm install

# 1) baza
npx wrangler d1 create warera-market
#    -> kopiraj database_id u wrangler.toml (database_id)
npx wrangler d1 execute warera-market --remote --file=schema.sql

# 2) API key kao secret (ne ide u kod)
npx wrangler secret put WARERA_API_KEY

# 3) objava
npx wrangler deploy
```

Ako ga hostaš kroz GitHub repo kao prijašnju aplikaciju, dovoljno je pushati ovaj direktorij i u Cloudflare Workers Builds povezati repo; secret i D1 binding postavi u dashboardu (Settings → Variables / Bindings).

Lokalno testiranje: `npm run db:init:local && npx wrangler dev --test-scheduled`, zatim `curl "http://localhost:8787/__scheduled"` za ručno pokretanje sync-a.

## Što provjeriti nakon prvog pokretanja

Otvori `/api/status` (isti podaci su ispod tablice na stranici).

- `order` mora biti `newest-first`. Ako piše `OLDEST-FIRST`, API vraća transakcije obrnutim redoslijedom i sync logiku treba prilagoditi.
- `errors` mora biti prazan. Moje poznavanje oblika odgovora za `user.getUserLite`, `country.getAllCountries` i `alliance.getManyPaginated` temelji se na dokumentaciji klijentskih biblioteka. Kod čita imena polja defenzivno (npr. `username`/`name`, `country`/`citizenship`), ali ako `players_with_names` ostane 0 ili `countries_in_alliance` ostane 0, pošalji mi jedan sirovi odgovor tog endpointa pa ću dotjerati parsiranje.

## Ograničenja i troškovi

- **Cijela povijest može biti velika.** Svaka transakcija znači nekoliko upisa u D1 (redak + dva ažuriranja statistike). Free plan dopušta 100 000 upisanih redaka dnevno, što je za pun backfill premalo; za cijelu povijest računaj na Workers Paid plan. Do tada backfill jednostavno napreduje koliko dopusti limit.
- API ima limit od 500 zahtjeva/min s ključem. `PAGE_BUDGET` u `wrangler.toml` (zadano 25 stranica po 100 transakcija u minuti) određuje koliko brzo ide backfill.
- Rang lista po "Kupljeni itemi" ima indeks; ostala sortiranja skeniraju tablicu i sporija su kad igrača bude puno.
