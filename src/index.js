import { ITEMS, ITEM_CODES } from "./items.js";

const API = "https://api2.warera.io/trpc";
const STATIC_REFRESH_MS = 60 * 60 * 1000; // države/savezi jednom na sat
const PLAYER_REFRESH_MS = 3 * 24 * 60 * 60 * 1000; // osvježi igrače starije od 3 dana
const LOCK_MS = 120 * 1000;
// država igrača iz player_country vrijedi 14 dana, zatim se ponovno pita API (igrač je mogao promijeniti državu)
const COUNTRY_TTL_MS = 14 * 24 * 60 * 60 * 1000;
// osvježavanje imena praćenih igrača radi se svakih 10 minuta (ne treba svake minute)
const STALE_EVERY_MS = 10 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* API helperi                                                         */
/* ------------------------------------------------------------------ */

function unwrap(node) {
  if (!node) return null;
  if (node.error) {
    throw new Error(node.error?.message || node.error?.json?.message || "tRPC error");
  }
  let data = node.result?.data;
  // superjson omot, ako ga API koristi
  if (data && typeof data === "object" && "json" in data && Object.keys(data).length <= 2) {
    data = data.json;
  }
  return data;
}

// Ako API odbije ključ (401/403, npr. ključ je poništen jer je napravljen novi), sinkronizacija
// nastavlja bez ključa (API to dopušta, uz niži limit) i 10 minuta ga ne šalje; status to prijavljuje.
let keyRejectedAt = 0;
const KEY_RETRY_MS = 10 * 60 * 1000;
const useKey = (env) => Boolean(env.WARERA_API_KEY) && Date.now() - keyRejectedAt > KEY_RETRY_MS;
const apiKeyRejected = () => keyRejectedAt > 0 && Date.now() - keyRejectedAt <= KEY_RETRY_MS;

function headers(env, extra = {}, withKey = useKey(env)) {
  return { accept: "application/json", ...(withKey ? { "X-API-Key": env.WARERA_API_KEY } : {}), ...extra };
}

async function apiFetch(env, url, init = {}, extra = {}) {
  const withKey = useKey(env);
  let res = await fetch(url, { ...init, headers: headers(env, extra, withKey) });
  if (withKey && (res.status === 401 || res.status === 403)) {
    keyRejectedAt = Date.now();
    res = await fetch(url, { ...init, headers: headers(env, extra, false) });
  }
  return res;
}

async function trpc(env, proc, input) {
  const url = `${API}/${proc}?input=${encodeURIComponent(JSON.stringify(input ?? {}))}`;
  const res = await apiFetch(env, url);
  if (!res.ok) throw new Error(`${proc} -> HTTP ${res.status}`);
  const body = await res.json();
  return unwrap(Array.isArray(body) ? body[0] : body);
}

// više poziva iste procedure u jednom POST-u (API dopušta do 50)
async function trpcBatch(env, proc, inputs) {
  const names = inputs.map(() => proc).join(",");
  const payload = {};
  inputs.forEach((x, i) => (payload[i] = x));
  const res = await apiFetch(env, `${API}/${names}?batch=1`, { method: "POST", body: JSON.stringify(payload) }, {
    "content-type": "application/json",
  });
  if (!res.ok) throw new Error(`${proc} batch -> HTTP ${res.status}`);
  const arr = await res.json();
  return arr.map((n) => {
    try {
      return unwrap(n);
    } catch {
      return null;
    }
  });
}

/* ------------------------------------------------------------------ */
/* Meta (stanje sinkronizacije)                                        */
/* ------------------------------------------------------------------ */

async function getMeta(env) {
  const { results } = await env.DB.prepare("SELECT key, value FROM meta").all();
  const m = {};
  for (const r of results) m[r.key] = r.value;
  return m;
}

function setMeta(env, key, value) {
  if (value === null || value === undefined) {
    return env.DB.prepare("DELETE FROM meta WHERE key = ?").bind(key).run();
  }
  return env.DB.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE value IS NOT excluded.value",
  )
    .bind(key, String(value))
    .run();
}

/* ------------------------------------------------------------------ */
/* Države i savezi                                                     */
/* ------------------------------------------------------------------ */

const idOf = (x) => (x && typeof x === "object" ? (x._id ?? x.id ?? x.countryId ?? x.country ?? null) : (x ?? null));

function memberCountryIds(alliance) {
  const keys = ["countries", "countryIds", "members", "memberCountries", "memberIds", "memberCountryIds"];
  const out = [];
  for (const k of keys) {
    if (Array.isArray(alliance[k])) {
      for (const el of alliance[k]) {
        const id = idOf(el);
        if (id) out.push(String(id));
      }
    }
  }
  return out;
}

async function refreshStatic(env, meta) {
  const last = Number(meta.static_at || 0);
  if (Date.now() - last < STATIC_REFRESH_MS) return;

  let countries = await trpc(env, "country.getAllCountries", {});
  if (countries && !Array.isArray(countries)) countries = Object.values(countries);
  countries = countries || [];

  const alliances = [];
  let cursor;
  for (let i = 0; i < 10; i++) {
    const page = await trpc(env, "alliance.getManyPaginated", { limit: 100, ...(cursor ? { cursor } : {}) });
    const items = Array.isArray(page) ? page : page?.items || [];
    alliances.push(...items);
    if (Array.isArray(page) || !page?.hasMore || !page?.nextCursor) break;
    cursor = page.nextCursor;
  }

  const allianceOfCountry = new Map();
  for (const a of alliances) {
    const aid = String(a._id ?? a.id);
    for (const cid of memberCountryIds(a)) allianceOfCountry.set(cid, aid);
  }
  for (const c of countries) {
    const cid = String(c._id ?? c.id);
    const direct = idOf(c.allianceId ?? c.alliance);
    if (direct) allianceOfCountry.set(cid, String(direct));
  }

  const stmts = [];
  for (const a of alliances) {
    stmts.push(
      env.DB.prepare(
        "INSERT INTO alliances (id, name) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name WHERE name IS NOT excluded.name",
      ).bind(String(a._id ?? a.id), a.name ?? a.title ?? null),
    );
  }
  for (const c of countries) {
    const cid = String(c._id ?? c.id);
    stmts.push(
      env.DB.prepare(
        "INSERT INTO countries (id, name, alliance_id) VALUES (?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET name = excluded.name, alliance_id = excluded.alliance_id " +
          "WHERE name IS NOT excluded.name OR alliance_id IS NOT excluded.alliance_id",
      ).bind(cid, c.name ?? null, allianceOfCountry.get(cid) ?? null),
    );
  }
  if (stmts.length) await env.DB.batch(stmts);
  await syncRoster(env);
  await setMeta(env, "static_at", Date.now());
}

/* ------------------------------------------------------------------ */
/* Transakcije: forward sync (novo) + backfill (cijela povijest)       */
/* ------------------------------------------------------------------ */

// "trading" = tržište resursa (Food, Ammo, Construction, Cases...); "itemMarket" = oprema/oružje
const txType = (env) => env.TX_TYPE || "trading";

async function fetchPage(env, cursor) {
  const input = { limit: 100, transactionType: txType(env) };
  if (cursor) input.cursor = cursor;
  const data = await trpc(env, "transaction.getPaginatedTransactions", input);
  const items = data?.items || [];
  return {
    items,
    nextCursor: data?.nextCursor || null,
    // API ne vraća uvijek `hasMore`; tada je kraj samo kad nema nextCursor ili je stranica prazna
    hasMore: items.length > 0 && (data?.hasMore ?? Boolean(data?.nextCursor)),
  };
}

// zbroj upisanih redaka iz rezultata D1 batcha (uključuje okidač i indekse)
const rowsWritten = (res) => (res || []).reduce((n, r) => n + (Number(r?.meta?.rows_written) || 0), 0);

async function storePage(env, items, extra = []) {
  const stmts = [];
  for (const t of items) {
    stmts.push(
      env.DB.prepare(
        "INSERT OR IGNORE INTO transactions (id, created_at, buyer_id, seller_id, item_code, quantity, money) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        String(t._id),
        new Date(t.createdAt).toISOString(),
        String(t.buyerId),
        String(t.sellerId),
        t.itemCode ?? null,
        Number(t.quantity) || 0,
        Number(t.money) || 0,
      ),
    );
  }
  stmts.push(...extra);
  return stmts.length ? rowsWritten(await env.DB.batch(stmts)) : 0;
}

// transakcije jednog igrača (kupnje i prodaje), novije prve; API ih čuva mjesecima unatrag
async function fetchUserPage(env, userId, cursor) {
  const input = { limit: 100, transactionType: txType(env), userId };
  if (cursor) input.cursor = cursor;
  const data = await trpc(env, "transaction.getPaginatedTransactions", input);
  return { items: data?.items || [], nextCursor: data?.nextCursor || null };
}

const tsOf = (t) => new Date(t.createdAt).toISOString();
const maxTs = (items) => items.reduce((m, t) => (tsOf(t) > m ? tsOf(t) : m), "");
const minTs = (items) => items.reduce((m, t) => (m === null || tsOf(t) < m ? tsOf(t) : m), null);

// Države koje pratimo (TRACKED_COUNTRIES = imena ili ID-ovi odvojeni zarezom). Prazno = sve države.
let trackedMemo = { at: 0, key: "", val: null };

async function trackedCountries(env) {
  const raw = env.TRACKED_COUNTRIES || "";
  const list = raw
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (!list.length) return null;
  if (trackedMemo.key === raw && Date.now() - trackedMemo.at < 600_000) return trackedMemo.val;
  const ids = [];
  const missing = [];
  for (const entry of list) {
    const row = await env.DB.prepare("SELECT id FROM countries WHERE id = ? OR lower(name) = lower(?) LIMIT 1")
      .bind(entry, entry)
      .first();
    if (row) ids.push(row.id);
    else missing.push(entry);
  }
  const val = { ids, missing };
  if (ids.length) trackedMemo = { at: Date.now(), key: raw, val };
  return val;
}

/* --- popis igrača praćenih država ------------------------------------ */
// user.getUsersByCountry vraća sve građane države; igrači koji nisu trgovali u zadnja ~3 dana
// inače ne bi bili poznati, pa im se ne bi dohvatila povijest. Novi se upisuju s fetched_at = 0
// (enrichPlayers ih zatim dohvati, a prvi dohvat postavi hist_done = 0).
async function syncRoster(env) {
  const tracked = await trackedCountries(env);
  if (!tracked?.ids?.length) return;
  const ids = new Set();
  for (const countryId of tracked.ids) {
    let cursor;
    for (let i = 0; i < 20; i++) {
      const data = await trpc(env, "user.getUsersByCountry", { countryId, limit: 100, ...(cursor ? { cursor } : {}) });
      for (const u of data?.items || []) if (u?._id) ids.add(String(u._id));
      cursor = data?.nextCursor;
      if (!cursor || !data?.items?.length) break;
    }
  }
  const list = [...ids];
  for (let i = 0; i < list.length; i += 90) {
    const chunk = list.slice(i, i + 90);
    const { results } = await env.DB.prepare(`SELECT user_id FROM players WHERE user_id IN (${chunk.map(() => "?").join(",")})`)
      .bind(...chunk)
      .all();
    const known = new Set(results.map((r) => r.user_id));
    const fresh = chunk.filter((id) => !known.has(id));
    if (fresh.length) await env.DB.batch(fresh.map((id) => env.DB.prepare("INSERT OR IGNORE INTO players (user_id, fetched_at) VALUES (?, 0)").bind(id)));
  }
}

/* --- država igrača: memorija -> D1 -> user.getUserLite --------------- */
// player_country: država (i ime) za SVE provjerene igrače, 1 redak bez indeksa (jeftin upis).
// players: samo igrači iz praćenih država (imaju indekse za pretragu i rang listu).
// tracked: ID-ovi praćenih država, okidač po njima odlučuje kome pisati dnevnu statistiku.

// upiše popis praćenih država u tablicu tracked kad se promijeni (prazno = sve države)
async function syncTrackedTable(env, meta, ids) {
  const key = [...ids].sort().join(",");
  if ((meta.tracked_ids ?? null) === key) return;
  const stmts = [env.DB.prepare("DELETE FROM tracked")];
  for (const id of ids) stmts.push(env.DB.prepare("INSERT OR IGNORE INTO tracked (country_id) VALUES (?)").bind(id));
  stmts.push(
    env.DB.prepare(
      "INSERT INTO meta (key, value) VALUES ('tracked_ids', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).bind(key),
  );
  await env.DB.batch(stmts);
}

function upsertPlayerCountry(env, id, u, now) {
  return env.DB.prepare(
    "INSERT INTO player_country (user_id, country_id, name, fetched_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(user_id) DO UPDATE SET country_id = excluded.country_id, " +
      "name = COALESCE(excluded.name, name), fetched_at = excluded.fetched_at",
  ).bind(id, u?.country ?? null, u?.name ?? null, now);
}

function upsertPlayer(env, id, u, now) {
  return env.DB.prepare(
    "INSERT INTO players (user_id, name, country_id, fetched_at, avatar, hist_done) VALUES (?, ?, ?, ?, ?, 0) " +
      "ON CONFLICT(user_id) DO UPDATE SET name = COALESCE(excluded.name, name), " +
      "country_id = COALESCE(excluded.country_id, country_id), fetched_at = excluded.fetched_at, " +
      "avatar = COALESCE(excluded.avatar, avatar), " +
      // igrač kojeg je okidač upisao (fetched_at = 0) prvi put je dohvaćen: treba mu povijest
      "hist_done = CASE WHEN players.fetched_at = 0 THEN 0 ELSE players.hist_done END",
  ).bind(id, u?.name ?? null, u?.country ?? null, now, u?.avatar ?? null);
}

const PC = new Map(); // user_id -> country_id | null (poznato)

async function knownCountries(env, ids) {
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const { results } = await env.DB.prepare(
      `SELECT user_id, country_id FROM player_country WHERE fetched_at > ? AND user_id IN (${chunk.map(() => "?").join(",")})`,
    )
      .bind(Date.now() - COUNTRY_TTL_MS, ...chunk)
      .all();
    for (const r of results) PC.set(r.user_id, r.country_id ?? null);
  }
}

// vraća true ako je država poznata za SVE navedene igrače (u granicama lookup budžeta)
async function resolveCountries(env, ids, lookups, trackedSet) {
  if (PC.size > 100_000) PC.clear();
  const need = ids.filter((id) => !PC.has(id));
  if (need.length) await knownCountries(env, need);
  const unknown = ids.filter((id) => !PC.has(id));
  while (unknown.length && lookups.left > 0) {
    const chunk = unknown.splice(0, 50);
    lookups.left--;
    const users = await trpcBatch(env, "user.getUserLite", chunk.map((userId) => ({ userId })));
    const now = Date.now();
    const stmts = [];
    chunk.forEach((id, i) => {
      const u = parseUser(users[i]);
      PC.set(id, u?.country ?? null);
      stmts.push(upsertPlayerCountry(env, id, u, now));
      // puni redak (ime, indeksi) samo za igrače iz praćenih država
      if (u?.country && trackedSet.has(u.country)) stmts.push(upsertPlayer(env, id, u, now));
    });
    lookups.written = (lookups.written || 0) + rowsWritten(await env.DB.batch(stmts));
  }
  return unknown.length === 0;
}

// zadrži samo transakcije u kojima je kupac ILI prodavač iz praćene države; null = treba još lookupa
async function keepTracked(env, items, trackedSet, lookups) {
  const typed = items.filter(
    (t) => t._id && t.buyerId && t.sellerId && (!t.transactionType || t.transactionType === txType(env)),
  );
  if (!trackedSet) return typed;
  const ids = [...new Set(typed.flatMap((t) => [String(t.buyerId), String(t.sellerId)]))];
  const ok = await resolveCountries(env, ids, lookups, trackedSet);
  if (!ok) return null;
  return typed.filter((t) => trackedSet.has(PC.get(String(t.buyerId))) || trackedSet.has(PC.get(String(t.sellerId))));
}

function setMetaMany(env, obj) {
  const stmts = Object.entries(obj).map(([k, v]) =>
    v === null || v === undefined || v === ""
      ? env.DB.prepare("DELETE FROM meta WHERE key = ?").bind(k)
      : env.DB.prepare(
          "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE value IS NOT excluded.value",
        ).bind(k, String(v)),
  );
  return stmts.length ? env.DB.batch(stmts) : null;
}

/* --- globalni tok: forward (novo) + backfill (povijest unatrag) ------- */

async function syncTransactions(env, meta, pages) {
  const tracked = await trackedCountries(env);
  let trackedSet = null;
  if (tracked) {
    await setMeta(env, "err_tracked", tracked.missing.length ? `Države nisu pronađene: ${tracked.missing.join(", ")}` : null);
    if (!tracked.ids.length) throw new Error("Nijedna država iz TRACKED_COUNTRIES nije pronađena u bazi");
    trackedSet = new Set(tracked.ids);
  }
  await syncTrackedTable(env, meta, trackedSet ? [...trackedSet] : []);
  const lookups = { left: Math.max(1, Number(env.LOOKUP_BUDGET) || 10), written: 0 };
  // dnevni proračun upisa za povijest (besplatni D1: 100 000 upisanih redaka dnevno, UTC).
  // Kad se potroši, povijest čeka iduću ponoć UTC, a nove transakcije se i dalje prate.
  const today = new Date().toISOString().slice(0, 10);
  const writeBase = meta.w_day === today ? Number(meta.w_rows) || 0 : 0;
  // od HISTORY_EOD_FROM (UTC) do ponoći proračun se podiže na HISTORY_EOD_WRITES, da se iskoristi ostatak limita
  const eodFrom = /^\d{2}:\d{2}$/.test(env.HISTORY_EOD_FROM || "") ? env.HISTORY_EOD_FROM : "23:30";
  // Proračun se raspoređuje kroz dan: u trenutku t (dio UTC dana) povijest smije ići dok su ukupni
  // današnji upisi (povijest + praćenje uživo) ispod HISTORY_DAILY_WRITES × t. Tako praćenje uživo
  // uvijek ima mjesta do kraja dana, a povijest ne može potrošiti limit odjednom (npr. u ponoć).
  const dayFrac = (Date.now() % 86_400_000) / 86_400_000;
  const histLimit = new Date().toISOString().slice(11, 16) >= eodFrom
    ? Number(env.HISTORY_EOD_WRITES) || 85000
    : Math.floor((Number(env.HISTORY_DAILY_WRITES) || 70000) * dayFrac);
  let stored = 0;
  const writesToday = () => writeBase + stored + lookups.written;
  const days = Number(env.HISTORY_DAYS);
  const cutoff = days > 0 ? new Date(Date.now() - days * 86_400_000).toISOString() : null;

  const st = {
    head: meta.g_head_ts || null,
    fwdCursor: meta.g_fwd_cursor || null,
    fwdHead: meta.g_fwd_new_head || null,
    back: meta.g_back_cursor || null,
    done: meta.g_back_done === "1",
    oldest: meta.g_back_oldest || null,
    order: meta.order || null,
  };
  let stalled = false;

  try {
    // 1) prvo pokretanje: najnovija stranica postaje "glava", kursor za povijest ide unatrag
    if (!st.head) {
      const page = await fetchPage(env, undefined);
      pages--;
      const kept = await keepTracked(env, page.items, trackedSet, lookups);
      if (kept === null) return;
      stored += await storePage(env, kept);
      if (page.items.length >= 2) {
        const first = tsOf(page.items[0]);
        const last = tsOf(page.items[page.items.length - 1]);
        st.order = first >= last ? "newest-first" : "OLDEST-FIRST (provjeri sync logiku!)";
      }
      st.head = maxTs(page.items) || new Date().toISOString();
      st.oldest = minTs(page.items);
      if (page.hasMore && page.nextCursor && !(days < 0)) st.back = page.nextCursor;
      else st.done = true;
    }

    // 2) forward: sve što je novije od zadnje viđene transakcije
    while (pages > 0 && st.head) {
      const page = await fetchPage(env, st.fwdCursor || undefined);
      pages--;
      const kept = await keepTracked(env, page.items, trackedSet, lookups);
      if (kept === null) {
        stalled = true; // iduću minutu ponovno ista stranica (igrači su u međuvremenu dopunjeni)
        break;
      }
      stored += await storePage(env, kept);
      const top = maxTs(page.items);
      if (top > (st.fwdHead || "")) st.fwdHead = top;
      const oldest = minTs(page.items);
      const reached = !page.items.length || (oldest !== null && oldest <= st.head) || !page.hasMore;
      if (reached) {
        if (st.fwdHead && st.fwdHead > st.head) st.head = st.fwdHead;
        st.fwdCursor = null;
        st.fwdHead = null;
        break;
      }
      st.fwdCursor = page.nextCursor;
    }

    // 3) povijest: ostatak budžeta ide unatrag do HISTORY_DAYS (0 = koliko god API čuva, -1 = bez povijesti)
    if (days < 0 && !st.done) {
      st.back = null;
      st.done = true;
    }
    while (pages > 0 && st.back && !st.done && !stalled && writesToday() < histLimit) {
      const page = await fetchPage(env, st.back);
      pages--;
      const kept = await keepTracked(env, page.items, trackedSet, lookups);
      if (kept === null) {
        stalled = true;
        break;
      }
      stored += await storePage(env, kept);
      const oldest = minTs(page.items);
      if (oldest && (!st.oldest || oldest < st.oldest)) st.oldest = oldest;
      const past = cutoff && oldest !== null && oldest < cutoff;
      if (page.hasMore && page.nextCursor && !past) {
        st.back = page.nextCursor;
      } else {
        st.back = null;
        st.done = true;
      }
    }

    // 4) povijest po igraču: globalni popis seže samo ~3 dana, pa se starija povijest praćenih igrača
    //    dohvaća filtrom userId, do HISTORY_DAYS unatrag (svaki igrač jednom; novi igrači automatski)
    if (trackedSet && cutoff && !stalled && pages > 0 && writesToday() < histLimit) {
      const ids = [...trackedSet];
      const { results: queue } = await env.DB.prepare(
        "SELECT user_id, hist_cursor FROM players WHERE hist_done = 0 AND fetched_at > 0 " +
          `AND country_id IN (${ids.map(() => "?").join(",")}) ORDER BY rowid LIMIT 12`,
      )
        .bind(...ids)
        .all();
      st.playersDone = queue.length === 0;
      const typed = (t) => t._id && t.buyerId && t.sellerId && (!t.transactionType || t.transactionType === txType(env));
      for (const pl of queue) {
        let cursor = pl.hist_cursor;
        while (pages > 0 && writesToday() < histLimit) {
          const page = await fetchUserPage(env, pl.user_id, cursor);
          pages--;
          const keep = page.items.filter((t) => typed(t) && tsOf(t) >= cutoff);
          const oldest = minTs(page.items);
          const done = !page.nextCursor || !page.items.length || (oldest !== null && oldest < cutoff);
          cursor = done ? null : page.nextCursor;
          const upd = env.DB.prepare("UPDATE players SET hist_cursor = ?, hist_done = ? WHERE user_id = ?")
            .bind(cursor, done ? 1 : 0, pl.user_id);
          stored += await storePage(env, keep, [upd]);
          if (done) break;
        }
        if (pages <= 0 || writesToday() >= histLimit) break;
      }
    }
  } finally {
    await setMetaMany(env, {
      // nepoznato (korak nije išao) = zadrži prethodno stanje
      p_hist_done: st.playersDone === undefined ? meta.p_hist_done ?? null : st.playersDone ? "1" : null,
      g_head_ts: st.head,
      g_fwd_cursor: st.fwdCursor,
      g_fwd_new_head: st.fwdHead,
      g_back_cursor: st.back,
      g_back_done: st.done ? "1" : null,
      g_back_oldest: st.oldest,
      order: st.order,
      w_day: today,
      w_rows: writesToday(),
    });
  }
}

/* ------------------------------------------------------------------ */
/* Igrači (ime + država)                                               */
/* ------------------------------------------------------------------ */

// profilna slika: adresa je oblika media.warera.io/avatars/<id>-<vrijeme>-<nasumično>.jpg, pa se ne može složiti iz ID-a
const AVATAR_KEYS = ["avatarUrl", "avatar", "picture", "pictureUrl", "image", "imageUrl", "profilePicture", "photo", "photoUrl"];
function avatarOf(u) {
  for (const k of AVATAR_KEYS) {
    let v = u?.[k];
    if (v && typeof v === "object") v = v.url ?? v.src ?? v.path ?? null;
    if (typeof v !== "string" || !v) continue;
    if (/^https:\/\//.test(v)) return v;
    if (/avatars\//.test(v)) return "https://media.warera.io/" + v.replace(/^\/+/, "").replace(/^media\.warera\.io\//, "");
  }
  return null;
}

function parseUser(u) {
  if (!u) return null;
  const c = u.country ?? u.countryId ?? u.citizenship ?? u.citizenshipCountry ?? null;
  return {
    name: u.username ?? u.name ?? null,
    country: c ? String(idOf(c)) : null,
    avatar: avatarOf(u),
  };
}

// jednom zapiše nazive polja iz odgovora user.getUserLite (i polja koja izgledaju kao slika), radi provjere
async function noteUserShape(env, users) {
  const u = users.find((x) => x && typeof x === "object");
  if (!u) return;
  const pics = Object.fromEntries(Object.entries(u).filter(([k, v]) => /avatar|pic|image|photo/i.test(k)).map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 160) : typeof v]));
  await setMeta(env, "dbg_user_keys", JSON.stringify({ keys: Object.keys(u).slice(0, 60), pics }).slice(0, 1500));
}

async function enrichPlayers(env, meta, batches = 2) {
  const tracked = await trackedCountries(env);
  const ids0 = tracked?.ids?.length ? tracked.ids : null;
  let staleChecked = false;
  for (let b = 0; b < batches; b++) {
    // novi igrači (okidač ih upisuje s fetched_at = 0)
    const { results: fresh } = await env.DB.prepare(
      "SELECT user_id FROM players WHERE fetched_at = 0 LIMIT 50",
    ).all();
    let ids = fresh.map((r) => r.user_id);
    // osvježavanje starih: samo igrači iz praćenih država, najviše jednom u 10 minuta
    if (!ids.length && !staleChecked && Date.now() - Number(meta.stale_at || 0) > STALE_EVERY_MS) {
      staleChecked = true;
      await setMeta(env, "stale_at", Date.now());
      const cutoff = Date.now() - PLAYER_REFRESH_MS;
      const { results: stale } = ids0
        ? await env.DB.prepare(
            `SELECT user_id FROM players WHERE country_id IN (${ids0.map(() => "?").join(",")}) ` +
              "AND fetched_at > 0 AND fetched_at < ? ORDER BY fetched_at LIMIT 50",
          )
            .bind(...ids0, cutoff)
            .all()
        : await env.DB.prepare(
            "SELECT user_id FROM players WHERE fetched_at > 0 AND fetched_at < ? ORDER BY fetched_at LIMIT 50",
          )
            .bind(cutoff)
            .all();
      ids = stale.map((r) => r.user_id);
    }
    if (!ids.length) return;

    const users = await trpcBatch(env, "user.getUserLite", ids.map((userId) => ({ userId })));
    if (!meta.dbg_user_keys) { await noteUserShape(env, users); meta.dbg_user_keys = "1"; }
    const now = Date.now();
    const stmts = [];
    ids.forEach((id, i) => {
      const u = parseUser(users[i]);
      stmts.push(upsertPlayer(env, id, u, now));
      if (ids0) {
        stmts.push(upsertPlayerCountry(env, id, u, now));
        PC.set(id, u?.country ?? null);
      }
    });
    await env.DB.batch(stmts);
  }
}

/* ------------------------------------------------------------------ */
/* Cron                                                                */
/* ------------------------------------------------------------------ */

async function runSync(env) {
  try {
    if (!env.WARERA_API_KEY) {
      await setMeta(env, "err_key", "WARERA_API_KEY nije postavljen u Workeru (secret nedostaje ili nije objavljen)");
      return;
    }
    await setMeta(env, "err_key", null);
    await runSyncInner(env);
  } catch (e) {
    try {
      await setMeta(env, "err_run", `${new Date().toISOString()} ${e?.message || e}`);
    } catch {}
  }
}

async function runSyncInner(env) {
  let meta = await getMeta(env);
  if (Number(meta.lock_until || 0) > Date.now()) return;
  await setMeta(env, "lock_until", Date.now() + LOCK_MS);

  const budget = Math.min(Number(env.PAGE_BUDGET) || 25, 40);
  const step = async (name, fn) => {
    try {
      await fn();
      await setMeta(env, `err_${name}`, null);
    } catch (e) {
      await setMeta(env, `err_${name}`, `${new Date().toISOString()} ${e?.message || e}`);
    }
  };

  await step("static", () => refreshStatic(env, meta));
  meta = await getMeta(env);
  await step("tx", () => syncTransactions(env, meta, budget));
  await step("players", () => enrichPlayers(env, meta));
  // jedan batch: zadnji prolaz, brisanje stare greške err_run, stanje API ključa i otključavanje
  await setMetaMany(env, {
    last_run: new Date().toISOString(),
    err_run: null,
    err_apikey: apiKeyRejected()
      ? "WarEra API odbija WARERA_API_KEY (401). Upiši važeći ključ u Cloudflare: Worker → Settings → Variables and Secrets"
      : null,
    lock_until: null,
  });
}

/* ------------------------------------------------------------------ */
/* HTTP API                                                            */
/* ------------------------------------------------------------------ */

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
// YYYY-MM-DD koji je stvarni kalendarski dan (npr. 2026-02-31 se odbija)
const validDay = (x) => {
  if (!DAY_RE.test(x || "")) return null;
  const t = Date.parse(`${x}T00:00:00Z`);
  return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== x ? null : x;
};
const nextDay = (d) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

// items = popis kodova odvojen zarezom (prazno ili svi = bez filtra), from/to = YYYY-MM-DD (UTC)
function parseFilters(url) {
  const p = url.searchParams;
  const items = [
    ...new Set(
      (p.get("items") || "")
        .split(",")
        .map((x) => x.trim())
        .filter((c) => ITEM_CODES.has(c)),
    ),
  ];
  return {
    items: items.length && items.length < ITEM_CODES.size ? items : [],
    from: validDay(p.get("from")),
    to: validDay(p.get("to")),
  };
}

function periodWhere(f, where, args, { withItems = true } = {}) {
  if (f.from) {
    where.push("d.day >= ?");
    args.push(f.from);
  }
  if (f.to) {
    where.push("d.day <= ?");
    args.push(f.to);
  }
  if (withItems && f.items.length) {
    where.push(`d.item_code IN (${f.items.map(() => "?").join(",")})`);
    args.push(...f.items);
  }
}

async function apiRanking(env, url) {
  const p = url.searchParams;
  const f = parseFilters(url);
  const country = p.get("country");
  const alliance = p.get("alliance");
  const q = (p.get("q") || "").trim();
  const SORTS = ["bought", "sold", "spent", "earned", "diff"];
  const sortCol = SORTS.includes(p.get("sort")) ? p.get("sort") : "bought";
  const limit = Math.min(Math.max(Number(p.get("limit")) || 50, 1), 100);
  const offset = Math.max(Number(p.get("offset")) || 0, 0);

  const where = [];
  const args = [];
  periodWhere(f, where, args);
  const tracked = await trackedCountries(env);
  if (tracked && tracked.ids.length) {
    where.push(`p.country_id IN (${tracked.ids.map(() => "?").join(",")})`);
    args.push(...tracked.ids);
  }
  if (country) {
    where.push("p.country_id = ?");
    args.push(country);
  }
  if (alliance) {
    where.push("c.alliance_id = ?");
    args.push(alliance);
  }
  if (q) {
    where.push("(p.name LIKE ? ESCAPE '\\' OR d.user_id = ?)");
    args.push(`%${q.replace(/[\\%_]/g, (m) => "\\" + m)}%`, q);
  }

  const sql =
    "SELECT d.user_id, p.name, p.avatar, p.country_id, c.name AS country_name, " +
    "SUM(d.bought_qty) AS bought, SUM(d.sold_qty) AS sold, SUM(d.bought_qty) - SUM(d.sold_qty) AS diff, " +
    "ROUND(SUM(d.bought_money), 3) AS spent, ROUND(SUM(d.sold_money), 3) AS earned " +
    "FROM player_item_daily d " +
    "LEFT JOIN players p ON p.user_id = d.user_id " +
    "LEFT JOIN countries c ON c.id = p.country_id " +
    (where.length ? "WHERE " + where.join(" AND ") + " " : "") +
    `GROUP BY d.user_id ORDER BY ${sortCol} DESC, d.user_id LIMIT ? OFFSET ?`;

  const { results } = await env.DB.prepare(sql)
    .bind(...args, limit + 1, offset)
    .all();
  const hasMore = results.length > limit;
  const rows = results.slice(0, limit).map((r, i) => ({ rank: offset + i + 1, ...r }));
  return json({ rows, hasMore, offset, limit }, 200, { "cache-control": "public, max-age=30" });
}

// pregled iznad tablice: zbroj po državama, prosječna cijena po danima, najveći kupci danas (UTC)
async function apiOverview(env, url, ctx, request) {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request(request.url);
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }
  const f = parseFilters(url);
  const country = url.searchParams.get("country");
  const tracked = await trackedCountries(env);
  const scope = (where, args) => {
    if (tracked && tracked.ids.length) {
      where.push(`p.country_id IN (${tracked.ids.map(() => "?").join(",")})`);
      args.push(...tracked.ids);
    }
    if (country) {
      where.push("p.country_id = ?");
      args.push(country);
    }
  };
  const FROM =
    "FROM player_item_daily d JOIN players p ON p.user_id = d.user_id LEFT JOIN countries c ON c.id = p.country_id ";

  const w1 = [], a1 = [];
  periodWhere(f, w1, a1);
  scope(w1, a1);
  const where1 = w1.length ? "WHERE " + w1.join(" AND ") + " " : "";

  const today = new Date().toISOString().slice(0, 10);
  const w2 = ["d.day = ?"], a2 = [today];
  if (f.items.length) {
    w2.push(`d.item_code IN (${f.items.map(() => "?").join(",")})`);
    a2.push(...f.items);
  }
  scope(w2, a2);

  const [byCountry, byDay, top, topSell] = await env.DB.batch([
    env.DB.prepare(
      "SELECT p.country_id, c.name AS country_name, SUM(d.bought_qty) AS bought, SUM(d.sold_qty) AS sold, " +
        "ROUND(SUM(d.bought_money), 3) AS spent, ROUND(SUM(d.sold_money), 3) AS earned, " +
        "COUNT(DISTINCT CASE WHEN d.bought_qty > 0 THEN d.user_id END) AS buyers, " +
        "COUNT(DISTINCT CASE WHEN d.sold_qty > 0 THEN d.user_id END) AS sellers " +
        FROM + where1 + "GROUP BY p.country_id ORDER BY bought DESC",
    ).bind(...a1),
    // prosječna cijena = stvarno plaćeno / količina, iz kupnji i prodaja igrača praćenih država
    env.DB.prepare(
      "SELECT d.day, SUM(d.bought_qty + d.sold_qty) AS qty, ROUND(SUM(d.bought_money + d.sold_money), 3) AS money " +
        FROM + where1 + "GROUP BY d.day ORDER BY d.day",
    ).bind(...a1),
    env.DB.prepare(
      "SELECT d.user_id, p.name, p.avatar, c.name AS country_name, SUM(d.bought_qty) AS bought, ROUND(SUM(d.bought_money), 3) AS spent " +
        FROM + "WHERE " + w2.join(" AND ") + " AND d.bought_qty > 0 GROUP BY d.user_id ORDER BY bought DESC, spent DESC LIMIT 5",
    ).bind(...a2),
    env.DB.prepare(
      "SELECT d.user_id, p.name, p.avatar, c.name AS country_name, SUM(d.sold_qty) AS sold, ROUND(SUM(d.sold_money), 3) AS earned " +
        FROM + "WHERE " + w2.join(" AND ") + " AND d.sold_qty > 0 GROUP BY d.user_id ORDER BY sold DESC, earned DESC LIMIT 5",
    ).bind(...a2),
  ]);
  const res = json(
    { by_country: byCountry.results, by_day: byDay.results, today, today_top: top.results, today_sellers: topSell.results },
    200,
    { "cache-control": "public, max-age=120" },
  );
  if (cache) ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

// cijene svih itema: prosječna cijena po danu za zadnjih PRICE_DAYS dana (UTC), iz prometa igrača praćenih država
const PRICE_DAYS = 14;
async function apiPrices(env, url, ctx, request) {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request(request.url);
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }
  const country = url.searchParams.get("country");
  const tracked = await trackedCountries(env);
  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.parse(today + "T00:00:00Z") - (PRICE_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
  const where = ["d.day >= ?"], args = [from];
  if (tracked && tracked.ids.length) {
    where.push(`p.country_id IN (${tracked.ids.map(() => "?").join(",")})`);
    args.push(...tracked.ids);
  }
  if (country) {
    where.push("p.country_id = ?");
    args.push(country);
  }
  const { results } = await env.DB.prepare(
    "SELECT d.item_code, d.day, SUM(d.bought_qty + d.sold_qty) AS qty, ROUND(SUM(d.bought_money + d.sold_money), 3) AS money " +
      "FROM player_item_daily d JOIN players p ON p.user_id = d.user_id " +
      `WHERE ${where.join(" AND ")} GROUP BY d.item_code, d.day ORDER BY d.item_code, d.day`,
  )
    .bind(...args)
    .all();
  const res = json({ from, today, rows: results }, 200, { "cache-control": "public, max-age=600" });
  if (cache) ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

// usporedba do 4 igrača: zbroj po itemu za isto razdoblje (iz dnevne statistike, bez upisa)
async function apiCompare(env, url, ctx, request) {
  const ids = [...new Set((url.searchParams.get("ids") || "").split(",").map((x) => x.trim()).filter((x) => /^[A-Za-z0-9_-]{1,64}$/.test(x)))].slice(0, 4);
  if (!ids.length) return json({ error: "Nema igrača za usporedbu" }, 400);
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request(request.url);
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }
  const f = parseFilters(url);
  const ph = ids.map(() => "?").join(",");
  const where = [`d.user_id IN (${ph})`], args = [...ids];
  periodWhere(f, where, args, { withItems: false });
  const [players, rows] = await env.DB.batch([
    env.DB.prepare(
      "SELECT p.user_id, p.name, p.avatar, c.name AS country_name FROM players p " +
        `LEFT JOIN countries c ON c.id = p.country_id WHERE p.user_id IN (${ph})`,
    ).bind(...ids),
    env.DB.prepare(
      "SELECT d.user_id, d.item_code, SUM(d.bought_qty) AS bought, SUM(d.sold_qty) AS sold, " +
        "ROUND(SUM(d.bought_money), 3) AS spent, ROUND(SUM(d.sold_money), 3) AS earned " +
        `FROM player_item_daily d WHERE ${where.join(" AND ")} GROUP BY d.user_id, d.item_code`,
    ).bind(...args),
  ]);
  // redoslijed igrača kao u zahtjevu
  const byId = new Map(players.results.map((p) => [p.user_id, p]));
  const res = json(
    { players: ids.filter((id) => byId.has(id)).map((id) => byId.get(id)), rows: rows.results },
    200,
    { "cache-control": "public, max-age=60" },
  );
  if (cache) ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

async function apiFilters(env) {
  const tracked = await trackedCountries(env);
  const ids = tracked?.ids?.length ? tracked.ids : null;
  const [countries, days] = await Promise.all([
    ids
      ? env.DB.prepare(`SELECT id, name FROM countries WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY name`)
          .bind(...ids)
          .all()
      : env.DB.prepare(
          "SELECT c.id, c.name FROM countries c WHERE EXISTS (SELECT 1 FROM players p WHERE p.country_id = c.id) ORDER BY c.name",
        ).all(),
    env.DB.prepare(
      "SELECT (SELECT MIN(day) FROM player_item_daily) AS min, (SELECT MAX(day) FROM player_item_daily) AS max",
    ).first(),
  ]);
  return json(
    { items: ITEMS, countries: countries.results, days: { min: days?.min ?? null, max: days?.max ?? null } },
    200,
    { "cache-control": "public, max-age=120" },
  );
}

const PLAYER_TX_LIMIT = 100;

// transakcije igrača iz naše baze, uz isti filter datuma i itema kao rang lista (dani su UTC)
async function playerTransactions(env, id, f) {
  const side = async (col) => {
    const where = [`${col} = ?`];
    const args = [id];
    if (f.from) {
      where.push("created_at >= ?");
      args.push(`${f.from}T00:00:00.000Z`);
    }
    if (f.to) {
      where.push("created_at < ?");
      args.push(`${nextDay(f.to)}T00:00:00.000Z`);
    }
    if (f.items.length) {
      where.push(`item_code IN (${f.items.map(() => "?").join(",")})`);
      args.push(...f.items);
    }
    const { results } = await env.DB.prepare(
      "SELECT id, created_at, buyer_id, seller_id, item_code, quantity, money FROM transactions " +
        `WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
    )
      .bind(...args, PLAYER_TX_LIMIT + 1)
      .all();
    return results;
  };
  const [asBuyer, asSeller] = await Promise.all([side("buyer_id"), side("seller_id")]);
  const all = [...asBuyer.map((r) => ({ ...r, side: "buy" })), ...asSeller.map((r) => ({ ...r, side: "sell" }))].sort(
    (a, b) => (a.created_at === b.created_at ? (a.id < b.id ? 1 : -1) : a.created_at < b.created_at ? 1 : -1),
  );
  return { rows: all.slice(0, PLAYER_TX_LIMIT), truncated: all.length > PLAYER_TX_LIMIT };
}

async function apiPlayer(env, id, url, ctx, request) {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request(request.url);
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  const f = parseFilters(url);
  const player = await env.DB.prepare(
    "SELECT p.user_id, p.name, p.avatar, p.country_id, c.name AS country_name FROM players p " +
      "LEFT JOIN countries c ON c.id = p.country_id WHERE p.user_id = ?",
  )
    .bind(id)
    .first();
  if (!player) return json({ error: "Igrač nije pronađen" }, 404);

  const where = ["d.user_id = ?"];
  const args = [id];
  periodWhere(f, where, args);
  const { results: perItem } = await env.DB.prepare(
    "SELECT d.item_code, SUM(d.bought_qty) AS bought, SUM(d.sold_qty) AS sold, " +
      "ROUND(SUM(d.bought_money), 3) AS spent, ROUND(SUM(d.sold_money), 3) AS earned FROM player_item_daily d " +
      `WHERE ${where.join(" AND ")} GROUP BY d.item_code ORDER BY bought DESC`,
  )
    .bind(...args)
    .all();
  // promet po danima (UTC) za graf u prozoru igrača, isti filter
  const { results: perDay } = await env.DB.prepare(
    "SELECT d.day, SUM(d.bought_qty) AS bought, SUM(d.sold_qty) AS sold, " +
      "ROUND(SUM(d.bought_money), 3) AS spent, ROUND(SUM(d.sold_money), 3) AS earned FROM player_item_daily d " +
      `WHERE ${where.join(" AND ")} GROUP BY d.day ORDER BY d.day`,
  )
    .bind(...args)
    .all();

  const { rows, truncated } = await playerTransactions(env, id, f);
  const others = [...new Set(rows.map((r) => (r.side === "buy" ? r.seller_id : r.buyer_id)))];
  const names = new Map();
  for (let i = 0; i < others.length; i += 90) {
    const chunk = others.slice(i, i + 90);
    const ph = chunk.map(() => "?").join(",");
    const [{ results: a }, { results: b }] = await env.DB.batch([
      env.DB.prepare(`SELECT user_id, name FROM player_country WHERE user_id IN (${ph})`).bind(...chunk),
      env.DB.prepare(`SELECT user_id, name FROM players WHERE user_id IN (${ph})`).bind(...chunk),
    ]);
    for (const r of [...a, ...b]) if (r.name) names.set(r.user_id, r.name);
  }
  const recent = rows.map((r) => {
    const other = r.side === "buy" ? r.seller_id : r.buyer_id;
    return {
      at: r.created_at,
      side: r.side,
      item: r.item_code,
      quantity: r.quantity,
      money: r.money,
      other_id: other,
      other_name: names.get(other) ?? null,
    };
  });

  const res = json({ player, per_item: perItem, per_day: perDay, recent, truncated }, 200, { "cache-control": "public, max-age=60" });
  if (cache) ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

async function apiStatus(env, ctx, request) {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request(new URL("/api/status", request.url).toString());
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }
  const res = await apiStatusFresh(env);
  if (cache) ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

async function apiStatusFresh(env) {
  const trackedInfo = await trackedCountries(env);
  const [meta, tx, players, named, countries, mapped, alliances, hist] = await Promise.all([
    getMeta(env),
    env.DB.prepare("SELECT MAX(rowid) AS n FROM transactions").first(),
    // igrači se nikad ne brišu, pa je MAX(rowid) broj igrača; "s imenom" = već dohvaćeni (indeks na fetched_at)
    env.DB.prepare("SELECT MAX(rowid) AS n FROM players").first(),
    env.DB.prepare("SELECT (SELECT MAX(rowid) FROM players) - (SELECT COUNT(*) FROM players WHERE fetched_at = 0) AS n").first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM countries").first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM countries WHERE alliance_id IS NOT NULL").first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM alliances").first(),
    // povijest po igraču: koliko praćenih igrača još čeka (djelomični indeks na hist_done = 0)
    env.DB.prepare("SELECT COUNT(*) AS n FROM players WHERE hist_done = 0 AND fetched_at > 0 AND country_id IN (SELECT country_id FROM tracked)").first(),
  ]);
  const days = Number(env.HISTORY_DAYS);
  const playersDone = meta.p_hist_done === "1" && !(hist?.n > 0);
  // kad je povijest svih praćenih igrača učitana, podaci su potpuni za zadnjih HISTORY_DAYS dana
  const completeFrom = playersDone && days > 0 ? new Date(Date.now() - days * 86_400_000).toISOString() : meta.g_back_oldest || null;
  return json(
    {
      transactions: tx?.n || 0,
      players: players?.n || 0,
      players_with_names: named?.n || 0,
      countries: countries?.n || 0,
      countries_in_alliance: mapped?.n || 0,
      alliances: alliances?.n || 0,
      tracked: trackedInfo ? trackedInfo : "sve države",
      backfill_done: meta.g_back_done === "1" && playersDone,
      history_players_left: hist?.n ?? null,
      history_reached: meta.g_back_oldest || null,
      // podaci su potpuni od ovog trenutka (sve starije je djelomično, od ranijih verzija)
      complete_from: completeFrom,
      writes_today: meta.w_day === new Date().toISOString().slice(0, 10) ? Number(meta.w_rows) || 0 : 0,
      history_paused:
        !(meta.g_back_done === "1" && playersDone) &&
        meta.w_day === new Date().toISOString().slice(0, 10) &&
        Number(meta.w_rows) >= (Number(env.HISTORY_DAILY_WRITES) || 70000),
      newest_synced: meta.g_head_ts || null,
      last_run: meta.last_run || null,
      has_api_key: Boolean(env.WARERA_API_KEY),
      order: meta.order || null,
      errors: Object.fromEntries(Object.entries(meta).filter(([k]) => k.startsWith("err_"))),
    },
    200,
    { "cache-control": "public, max-age=60" },
  );
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/api/ranking") return await apiRanking(env, url);
      if (path === "/api/filters") return await apiFilters(env);
      if (path === "/api/overview") return await apiOverview(env, url, ctx, request);
      if (path === "/api/prices") return await apiPrices(env, url, ctx, request);
      if (path === "/api/compare") return await apiCompare(env, url, ctx, request);
      if (path === "/api/status") return await apiStatus(env, ctx, request);
      if (path.startsWith("/api/player/")) {
        return await apiPlayer(env, decodeURIComponent(path.slice("/api/player/".length)), url, ctx, request);
      }
      if (path.startsWith("/api/")) return json({ error: "Not found" }, 404);
    } catch (e) {
      return json({ error: String(e?.message || e) }, 500);
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSync(env));
  },
};
