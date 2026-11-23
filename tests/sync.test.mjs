// Testovi sinkronizacije i API-ja s lažnim WarEra API-jem i pravom SQLite bazom.
// Pokretanje: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeD1, makeWorld, installFakeApi, loadWorker, baseEnv, runTicks, get, TRACKED, DAY } from "./helpers.mjs";

// očekivano stanje izračunato "ručno" iz svijeta: zbroj po igraču za spremljene transakcije
function expected(world, storedIds) {
  const per = new Map();
  for (const t of world.txs) {
    if (!storedIds.has(t._id)) continue;
    for (const [id, side] of [[t.buyerId, "b"], [t.sellerId, "s"]]) {
      if (!TRACKED.has(world.users.get(id).country)) continue;
      const e = per.get(id) || { bq: 0, sq: 0, bm: 0, sm: 0 };
      if (side === "b") { e.bq += t.quantity; e.bm += t.money; } else { e.sq += t.quantity; e.sm += t.money; }
      per.set(id, e);
    }
  }
  return per;
}

async function synced(opts = {}, ticks = 40) {
  const world = makeWorld(opts.world);
  const { db, DB, stats } = makeD1();
  const calls = installFakeApi(world, opts.api);
  const worker = await loadWorker();
  const env = baseEnv(DB, opts.env);
  const limits = await runTicks(worker, env, db, stats, calls, ticks);
  return { world, db, DB, stats, calls, worker, env, limits };
}

test("sprema sve transakcije praćenih država unutar 30 dana i ništa drugo", async () => {
  const { world, db } = await synced();
  const stored = new Set(db.prepare("SELECT id FROM transactions").all().map((r) => r.id));
  const cutoff = new Date(Date.now() - 30 * DAY).toISOString();
  const tracked = (t) => TRACKED.has(world.users.get(t.buyerId).country) || TRACKED.has(world.users.get(t.sellerId).country);
  for (const t of world.txs) {
    if (t.createdAt >= cutoff && tracked(t)) assert.ok(stored.has(t._id), `nedostaje ${t._id}`);
    if (!tracked(t)) assert.ok(!stored.has(t._id), `spremljena nepraćena ${t._id}`);
  }
  const meta = Object.fromEntries(db.prepare("SELECT key, value FROM meta").all().map((r) => [r.key, r.value]));
  assert.equal(meta.g_back_done, "1");
  assert.deepEqual(Object.keys(meta).filter((k) => k.startsWith("err_")), []);
});

test("dnevna statistika (količine i novac) točno odgovara transakcijama", async () => {
  const { world, db } = await synced();
  const stored = new Set(db.prepare("SELECT id FROM transactions").all().map((r) => r.id));
  const exp = expected(world, stored);
  const got = db.prepare("SELECT user_id, SUM(bought_qty) bq, SUM(sold_qty) sq, SUM(bought_money) bm, SUM(sold_money) sm FROM player_item_daily GROUP BY user_id").all();
  assert.equal(got.length, exp.size, "broj igrača u statistici");
  for (const r of got) {
    const e = exp.get(r.user_id);
    assert.ok(e, `statistika za nepraćenog igrača ${r.user_id}`);
    assert.equal(r.bq, e.bq); assert.equal(r.sq, e.sq);
    assert.ok(Math.abs(r.bm - e.bm) < 1e-6 && Math.abs(r.sm - e.sm) < 1e-6, `novac za ${r.user_id}`);
  }
});

test("u players su samo igrači iz praćenih država, s imenom i profilnom slikom", async () => {
  const { world, db } = await synced();
  const rows = db.prepare("SELECT user_id, name, country_id, avatar FROM players").all();
  assert.ok(rows.length > 0);
  for (const r of rows) {
    assert.ok(TRACKED.has(r.country_id), `nepraćeni igrač u players: ${r.user_id}`);
    assert.equal(r.name, world.users.get(r.user_id).username);
    assert.equal(r.avatar, world.users.get(r.user_id).avatarUrl ?? null);
  }
});

test("cron prolaz ostaje unutar ograničenja besplatnog plana (50 D1 upita, 50 API poziva)", async () => {
  const { limits } = await synced();
  assert.ok(limits.maxQueries < 50, `D1 upita u prolazu: ${limits.maxQueries}`);
  assert.ok(limits.maxCalls < 50, `API poziva u prolazu: ${limits.maxCalls}`);
});

test("kad se potroši dnevni proračun, povijest stane, a nove transakcije se i dalje spremaju", async () => {
  const s = await synced({ env: { HISTORY_DAILY_WRITES: "1500" } }, 20);
  const meta = () => Object.fromEntries(s.db.prepare("SELECT key, value FROM meta").all().map((r) => [r.key, r.value]));
  assert.notEqual(meta().g_back_done, "1", "povijest je trebala stati");
  const oldest = meta().g_back_oldest;
  // stignu nove transakcije s vrha
  for (let k = 0; k < 300; k++) {
    s.world.txs.unshift({ _id: "new" + k, createdAt: new Date(Date.now() + k).toISOString(), buyerId: "u" + (k % 40), sellerId: "u" + (100 + k),
      itemCode: "bread", quantity: 1, money: 1, transactionType: "trading" });
  }
  await runTicks(s.worker, s.env, s.db, s.stats, s.calls, 10);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM transactions WHERE id LIKE 'new%'").get().n, 300);
  assert.equal(meta().g_back_oldest, oldest, "povijest se nije smjela pomaknuti");
  assert.ok(Number(meta().w_rows) >= 1500);
});

test("HISTORY_DAYS=-1 prati samo nove transakcije", async () => {
  const { db } = await synced({ env: { HISTORY_DAYS: "-1" } }, 5);
  assert.ok(db.prepare("SELECT COUNT(*) n FROM transactions").get().n <= 100);
});

test("API: rang lista, prozor igrača, pregled, cijene i status", async () => {
  const { worker, env, db } = await synced();
  const rk = await get(worker, env, "/api/ranking?limit=5&sort=spent");
  assert.equal(rk.status, 200);
  assert.equal(rk.body.rows.length, 5);
  for (let i = 1; i < rk.body.rows.length; i++) assert.ok(rk.body.rows[i - 1].spent >= rk.body.rows[i].spent, "poredak po potrošenom");
  for (const r of rk.body.rows) assert.equal(r.diff, r.bought - r.sold, "razlika = kupljeno − prodano");
  const byDiff = await get(worker, env, "/api/ranking?limit=10&sort=diff");
  for (let i = 1; i < byDiff.body.rows.length; i++) assert.ok(byDiff.body.rows[i - 1].diff >= byDiff.body.rows[i].diff, "poredak po razlici");

  const pl = await get(worker, env, "/api/player/" + rk.body.rows[0].user_id + "?items=bread");
  assert.equal(pl.status, 200);
  assert.ok(pl.body.per_day.length > 0 && pl.body.recent.length > 0);
  assert.ok(pl.body.recent.every((r) => r.money != null && r.other_name));

  const ov = await get(worker, env, "/api/overview?items=bread");
  const bought = ov.body.by_country.reduce((a, r) => a + r.bought, 0);
  assert.equal(bought, db.prepare("SELECT SUM(bought_qty) n FROM player_item_daily WHERE item_code = 'bread'").get().n);
  assert.ok(Array.isArray(ov.body.today_top) && Array.isArray(ov.body.today_sellers));

  const pr = await get(worker, env, "/api/prices");
  assert.equal(pr.status, 200);
  assert.ok(pr.body.rows.length > 0 && pr.body.rows.every((r) => r.qty > 0 && r.money > 0));

  const st = await get(worker, env, "/api/status");
  assert.equal(st.body.backfill_done, true);
  assert.ok(st.body.complete_from);
  assert.deepEqual(st.body.errors, {});

  const bad = await get(worker, env, "/api/ranking?from=2026-02-31&sort=xyz");
  assert.equal(bad.status, 200, "neispravan datum i sortiranje se ignoriraju");
});

test("nepromijenjeno stanje ne troši upise u meta", async () => {
  const s = await synced({}, 40);
  const before = s.db.prepare("SELECT key, value FROM meta WHERE key NOT IN ('last_run','w_rows','w_day','lock_until','stale_at')").all();
  // svijet se ne mijenja: novi prolaz ne smije promijeniti kursore i ostalo stanje
  await runTicks(s.worker, s.env, s.db, s.stats, s.calls, 1);
  const after = s.db.prepare("SELECT key, value FROM meta WHERE key NOT IN ('last_run','w_rows','w_day','lock_until','stale_at')").all();
  assert.deepEqual(after, before);
});

test("povijest po igraču dohvati 30 dana i kad globalni popis seže samo 3 dana", async () => {
  const { world, db, worker, env } = await synced({ api: { globalDays: 3 } }, 80);
  const stored = new Set(db.prepare("SELECT id FROM transactions").all().map((r) => r.id));
  const cutoff = new Date(Date.now() - 30 * DAY).toISOString();
  const tracked = (t) => TRACKED.has(world.users.get(t.buyerId).country) || TRACKED.has(world.users.get(t.sellerId).country);
  const missing = world.txs.filter((t) => t.createdAt >= cutoff && tracked(t) && !stored.has(t._id));
  assert.equal(missing.length, 0, `nedostaje ${missing.length} transakcija starijih od 3 dana`);
  // statistika i dalje točna, bez dvostrukog brojanja (transakcija dvaju praćenih igrača dođe dvaput)
  const exp = expected(world, stored);
  for (const r of db.prepare("SELECT user_id, SUM(bought_qty) bq, SUM(sold_qty) sq FROM player_item_daily GROUP BY user_id").all()) {
    assert.equal(r.bq, exp.get(r.user_id).bq); assert.equal(r.sq, exp.get(r.user_id).sq);
  }
  assert.equal(db.prepare("SELECT COUNT(*) n FROM players WHERE hist_done = 0").get().n, 0);
  const st = await get(worker, env, "/api/status");
  assert.equal(st.body.backfill_done, true);
  assert.equal(st.body.history_players_left, 0);
  assert.ok(st.body.complete_from <= new Date(Date.now() - 29 * DAY).toISOString(), "potpuno za 30 dana");
});

test("povijest po igraču poštuje dnevni proračun", async () => {
  const { db } = await synced({ api: { globalDays: 3 }, env: { HISTORY_DAILY_WRITES: "3000", HISTORY_EOD_FROM: "99:99" } }, 40);
  assert.ok(db.prepare("SELECT COUNT(*) n FROM players WHERE hist_done = 0").get().n > 0, "povijest je trebala stati na proračunu");
  const w = Number(db.prepare("SELECT value FROM meta WHERE key = 'w_rows'").get().value);
  assert.ok(w < 3000 + 2000, `proračun prekoračen previše: ${w}`);
});

test("odbijen API ključ: sinkronizacija nastavlja bez ključa i to prijavljuje", async () => {
  const { db, worker, env } = await synced({ api: { badKey: "test" } }, 30);
  const meta = Object.fromEntries(db.prepare("SELECT key, value FROM meta").all().map((r) => [r.key, r.value]));
  assert.equal(meta.err_tx, undefined, "sinkronizacija transakcija ne smije pasti");
  assert.ok(meta.err_apikey, "status mora prijaviti odbijen ključ");
  assert.ok(db.prepare("SELECT COUNT(*) n FROM transactions").get().n > 0);
  const st = await get(worker, env, "/api/status");
  assert.ok(st.body.errors.err_apikey);
});

test("API usporedbe: zbroj po itemu za odabrane igrače, najviše 4", async () => {
  const { worker, env, db } = await synced();
  const ids = db.prepare("SELECT user_id FROM players ORDER BY rowid LIMIT 5").all().map((r) => r.user_id);
  const r = await get(worker, env, "/api/compare?ids=" + ids.join(","));
  assert.equal(r.status, 200);
  assert.equal(r.body.players.length, 4, "najviše 4 igrača");
  assert.deepEqual(r.body.players.map((p) => p.user_id), ids.slice(0, 4), "redoslijed kao u zahtjevu");
  for (const id of ids.slice(0, 4)) {
    const api = r.body.rows.filter((x) => x.user_id === id).reduce((a, x) => a + x.bought, 0);
    const exp = db.prepare("SELECT COALESCE(SUM(bought_qty), 0) n FROM player_item_daily WHERE user_id = ?").get(id).n;
    assert.equal(api, exp, `kupljeno za ${id}`);
  }
  assert.equal((await get(worker, env, "/api/compare?ids=")).status, 400);
});

test("proračun za povijest raspoređen je kroz dan (ne troši se odjednom u ponoć)", async () => {
  const realNow = Date.now;
  // 00:30 UTC: smije se potrošiti tek ~2 % dnevnog proračuna
  const base = Math.floor(realNow() / 86_400_000) * 86_400_000 + 30 * 60_000;
  Date.now = () => base;
  try {
    const { db } = await synced({ api: { globalDays: 3 }, env: { HISTORY_DAILY_WRITES: "100000", HISTORY_EOD_FROM: "99:99" } }, 20);
    const w = Number(db.prepare("SELECT value FROM meta WHERE key = 'w_rows'").get().value);
    assert.ok(w < 100000 * (31 / 1440) + 6000, `u 00:30 potrošeno previše: ${w}`);
    assert.ok(db.prepare("SELECT COUNT(*) n FROM players WHERE hist_done = 0").get().n > 0);
  } finally {
    Date.now = realNow;
  }
});
