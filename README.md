# WarEra Market Rankings

Cloudflare Worker + D1 aplikacija koja prati trgovinu resursima u igri WarEra (tržište "Trading": hrana, municija, građevinski materijali, caseovi, buffovi) i prikazuje rang listu igrača.

## Što stranica radi

- Tablica: **#, Igrač, Država, Kupljeno, Prodano** (količine itema). Klik na zaglavlje Kupljeno/Prodano mijenja sortiranje.
- Red ikonica itema: klik uključuje/isključuje item. Bez odabira broje se svi itemi. Odabir se pamti u pregledniku.
- Filteri: pretraga igrača, država, datum Od / Do (dani su u UTC).
- Klik na igrača otvara pregled po itemima za odabrano razdoblje i zadnjih 50 transakcija (uživo iz WarEra API-ja).
- Svijetla / tamna tema (pamti se u pregledniku).

## Kako radi

- **Cron (svake minute)** povlači SVE transakcije tržišta resursa (`transaction.getPaginatedTransactions`, tip `trading`) i zadržava samo one u kojima je kupac ili prodavač igrač iz jedne od država u `TRACKED_COUNTRIES`.
  Filter države na samom API-ju ne koristimo jer on ne hvata transakcije igrača (u transakcijama je polje države gotovo uvijek prazno).
- Država svakog igrača dohvaća se iz `user.getUserLite` (50 igrača po zahtjevu) i pamti u tablici `player_country` (1 redak po igraču, vrijedi 14 dana). U `players` (ime, indeksi za pretragu) spremaju se samo igrači iz praćenih država, a okidač piše dnevnu statistiku samo za njih. Tako sinkronizacija ostaje unutar besplatnog limita od 100 000 upisanih redaka dnevno.
- Prvo se vuče sve novo (praćenje uživo), a ostatak budžeta ide na povijest unatrag do `HISTORY_DAYS` dana. Ako stranica sadrži igrače čija država još nije poznata, ista stranica se ponavlja idući put, pa se ništa ne preskače.
- Uz količine se zbraja i novac: `bought_money` (potrošeno) i `sold_money` (zarađeno); polje `money` iz API-ja je ukupni iznos transakcije.
- Tablica `transactions` služi za deduplikaciju. SQL okidač `trg_tx_daily` za svaku **novu** transakciju zbraja količine u `player_item_daily` (igrač, dan, item).
- Rang lista prikazuje samo igrače iz praćenih država.

## Postavke (`wrangler.toml`)

| Varijabla | Značenje |
|---|---|
| `TRACKED_COUNTRIES` | imena država odvojena zarezom (zadano `Croatia,Cuba,Kyrgyzstan`); prazno = sve države |
| `HISTORY_DAYS` | koliko dana povijesti učitati unatrag (0 = koliko god API čuva, može biti jako puno) |
| `LOOKUP_BUDGET` | koliko puta po cron pozivu se pita API za podatke o igračima |
| `TX_TYPE` | `trading` = resursi; `itemMarket` = oprema i oružje |
| `PAGE_BUDGET` | koliko API stranica (po 100 transakcija) se povuče u jednom cron pozivu |
| `HISTORY_DAILY_WRITES` | koliko upisanih redaka dnevno (UTC) smije potrošiti sinkronizacija prije nego učitavanje povijesti stane do iduće ponoći (zadano 70000; besplatni D1 dopušta 100 000) |

Secret `WARERA_API_KEY` postavlja se u Workeru (Settings → Variables and Secrets), ne u kodu.

## Objava

1. **Migracija baze** (jednom, u D1 Consoleu): izvrši `migration.sql` (Dio 1, pa Dio 2 kao zasebnu naredbu). Briše spremljene transakcije i statistiku, koji se učitaju ponovo.
2. Pushaj datoteke na GitHub (`src/`, `public/` uključujući `public/icons/`, `schema.sql`, `migration.sql`, `wrangler.toml`, `package.json`). Cloudflare sam objavi novu verziju; `wrangler.toml` ponovno spaja D1 bazu `DB` i cron.
3. Kasnije migracije (jednom, u D1 Consoleu, prije objave koda koji ih treba): `migration-2.sql` (indeksi za prozor igrača), `migration-3.sql` (indeks `players(fetched_at)`), `migration-4.sql` (tablice `player_country` i `tracked`, novi okidač), `migration-5.sql` (potrošeni i zarađeni novac u `player_item_daily`), `migration-6.sql` (indeks `(item_code, day)` za pregled iznad tablice), `migration-7.sql` (profilne slike igrača, stupac `players.avatar`).
4. Provjeri `/api/status`: `has_api_key: true`, `errors` prazan, `tracked.missing` prazan i `transactions` raste.

## Testovi

`npm test` pokreće testove iz `tests/` (potreban je Node 22.5 ili noviji, zbog ugrađenog `node:sqlite`; nije potreban Cloudflare ni API ključ).
Testovi koriste pravu SQLite bazu sa `schema.sql` i lažni WarEra API s izmišljenim igračima, pa provjeravaju:

- da se spremaju sve transakcije praćenih država unutar `HISTORY_DAYS` i ništa drugo,
- da dnevna statistika (količine, potrošeno, zarađeno) točno odgovara transakcijama,
- da su u `players` samo igrači praćenih država, s imenom i profilnom slikom,
- da cron prolaz ostaje ispod 50 D1 upita i 50 API poziva (besplatni plan),
- da dnevni proračun zaustavlja povijest, a nove transakcije se i dalje spremaju,
- odgovore API-ja (`/api/ranking`, `/api/player`, `/api/overview`, `/api/prices`, `/api/status`),
- da nepromijenjeno stanje ne troši upise.

Pokreni ih prije svake objave koja dira `src/` ili `schema.sql`.

## Ikonice i boje

Ikonice su u `public/icons/<kod>.webp`. Pozadina svake ikonice ima boju razine kao u igri (siva, zelena, plava, ljubičasta, crvena, maslinasta); razina i naziv svakog itema nalaze se u `src/items.js`.

## Ograničenja

- Svaka nova transakcija znači nekoliko upisa u D1 (redak, indeks i dva zbroja po igraču). Free plan dopušta 100 000 upisanih redaka dnevno; ako učitavanje povijesti prijeđe taj limit, staje do sljedećeg dana.
- Rang lista zbraja dnevne retke za odabrano razdoblje, pa su vrlo široki rasponi s mnogo itema skuplji za čitanje iz baze.
