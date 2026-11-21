import { ITEMS, ITEM_CODES } from "./items.js";

const API = "https://api2.warera.io/trpc";
const STATIC_REFRESH_MS = 60 * 60 * 1000; // države/savezi jednom na sat
const PLAYER_REFRESH_MS = 3 * 24 * 60 * 60 * 1000; // osvježi igrače starije od 3 dana
const LOCK_MS = 120 * 1000;

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

function headers(env, extra = {}) {
  return { accept: "application/json", "X-API-Key": env.WARERA_API_KEY, ...extra };
}

async function trpc(env, proc, input) {
  const url = `${API}/${proc}?input=${encodeURIComponent(JSON.stringify(input ?? {}))}`;
  const res = await fetch(url, { headers: headers(env) });
  if (!res.ok) throw new Error(`${proc} -> HTTP ${res.status}`);
  const body = await res.json();
  return unwrap(Array.isArray(body) ? body[0] : body);
}

// više poziva iste procedure u jednom POST-u (API dopušta do 50)
async function trpcBatch(env, proc, inputs) {
  const names = inputs.map(() => proc).join(",");
  const payload = {};
  inputs.forEach((x, i) => (payload[i] = x));
  const res = await fetch(`${API}/${names}?batch=1`, {
    method: "POST",
    headers: headers(env, { "content-type": "application/json" }),
    body: JSON.stringify(payload),
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
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
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
        "INSERT INTO alliances (id, name) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name",
      ).bind(String(a._id ?? a.id), a.name ?? a.title ?? null),
    );
  }
  for (const c of countries) {
    const cid = String(c._id ?? c.id);
    stmts.push(
      env.DB.prepare(
        "INSERT INTO countries (id, name, alliance_id) VALUES (?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET name = excluded.name, alliance_id = excluded.alliance_id",
      ).bind(cid, c.name ?? null, allianceOfCountry.get(cid) ?? null),
    );
  }
  if (stmts.length) await env.DB.batch(stmts);
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

async function storePage(env, items) {
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
  if (stmts.length) await env.DB.batch(stmts);
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
  if (trackedMemo.key === raw && Date.now() - trackedMemo.at < 60_000) return trackedMemo.val;
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

/* --- država igrača: memorija -> D1 -> user.getUserLite --------------- */

const PC = new Map(); // user_id -> country_id | null (poznato)

async function knownCountries(env, ids) {
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const { results } = await env.DB.prepare(
      `SELECT user_id, country_id FROM players WHERE fetched_at > 0 AND user_id IN (${chunk.map(() => "?").join(",")})`,
    )
      .bind(...chunk)
      .all();
    for (const r of results) PC.set(r.user_id, r.country_id ?? null);
  }
}

// vraća true ako je država poznata za SVE navedene igrače (u granicama lookup budžeta)
async function resolveCountries(env, ids, lookups) {
  if (PC.size > 100_000) PC.clear();
  const need = ids.filter((id) => !PC.has(id));
  if (need.length) await knownCountries(env, need);
  const unknown = ids.filter((id) => !PC.has(id));
  while (unknown.length && lookups.left > 0) {
    const chunk = unknown.splice(0, 50);
    lookups.left--;
    const users = await trpcBatch(env, "user.getUserLite", chunk.map((userId) => ({ userId })));
    const now = Date.now();
    const stmts = chunk.map((id, i) => {
      const u = parseUser(users[i]);
      PC.set(id, u?.country ?? null);
      return env.DB.prepare(
        "INSERT INTO players (user_id, name, country_id, fetched_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(user_id) DO UPDATE SET name = COALESCE(excluded.name, name), " +
          "country_id = COALESCE(excluded.country_id, country_id), fetched_at = excluded.fetched_at",
      ).bind(id, u?.name ?? null, u?.country ?? null, now);
    });
    await env.DB.batch(stmts);
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
  const ok = await resolveCountries(env, ids, lookups);
  if (!ok) return null;
  return typed.filter((t) => trackedSet.has(PC.get(String(t.buyerId))) || trackedSet.has(PC.get(String(t.sellerId))));
}

function setMetaMany(env, obj) {
  const stmts = Object.entries(obj).map(([k, v]) =>
    v === null || v === undefined || v === ""
      ? env.DB.prepare("DELETE FROM meta WHERE key = ?").bind(k)
      : env.DB.prepare(
          "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
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
  const lookups = { left: Math.max(1, Number(env.LOOKUP_BUDGET) || 10) };
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
      await storePage(env, kept);
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
      await storePage(env, kept);
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
    while (pages > 0 && st.back && !st.done && !stalled) {
      const page = await fetchPage(env, st.back);
      pages--;
      const kept = await keepTracked(env, page.items, trackedSet, lookups);
      if (kept === null) {
        stalled = true;
        break;
      }
      await storePage(env, kept);
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
  } finally {
    await setMetaMany(env, {
      g_head_ts: st.head,
      g_fwd_cursor: st.fwdCursor,
      g_fwd_new_head: st.fwdHead,
      g_back_cursor: st.back,
      g_back_done: st.done ? "1" : null,
      g_back_oldest: st.oldest,
      order: st.order,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Igrači (ime + država)                                               */
/* ------------------------------------------------------------------ */

function parseUser(u) {
  if (!u) return null;
  const c = u.country ?? u.countryId ?? u.citizenship ?? u.citizenshipCountry ?? null;
  return {
    name: u.username ?? u.name ?? null,
    country: c ? String(idOf(c)) : null,
  };
}

async function enrichPlayers(env, batches = 2) {
  for (let b = 0; b < batches; b++) {
    // novi igrači (viđeni u transakciji, fetched_at = 0), najnoviji prvi
    const { results: fresh } = await env.DB.prepare(
      "SELECT user_id FROM players WHERE fetched_at = 0 LIMIT 50",
    ).all();
    let ids = fresh.map((r) => r.user_id);
    if (!ids.length) {
      const { results: stale } = await env.DB.prepare(
        "SELECT user_id FROM players WHERE fetched_at > 0 AND fetched_at < ? ORDER BY fetched_at LIMIT 50",
      )
        .bind(Date.now() - PLAYER_REFRESH_MS)
        .all();
      ids = stale.map((r) => r.user_id);
    }
    if (!ids.length) return;

    const users = await trpcBatch(env, "user.getUserLite", ids.map((userId) => ({ userId })));
    const now = Date.now();
    const stmts = ids.map((id, i) => {
      const u = parseUser(users[i]);
      return env.DB.prepare(
        "INSERT INTO players (user_id, name, country_id, fetched_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(user_id) DO UPDATE SET name = COALESCE(excluded.name, name), " +
          "country_id = COALESCE(excluded.country_id, country_id), fetched_at = excluded.fetched_at",
      ).bind(id, u?.name ?? null, u?.country ?? null, now);
    });
    await env.DB.batch(stmts);
  }
}

/* ------------------------------------------------------------------ */
/* Cron                                                                */
/* ------------------------------------------------------------------ */

async function runSync(env) {
  try {
    await setMeta(env, "last_tick", new Date().toISOString());
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
  await step("players", () => enrichPlayers(env));
  await setMeta(env, "last_run", new Date().toISOString());
  await setMeta(env, "lock_until", null);
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
  const sortCol = p.get("sort") === "sold" ? "sold" : "bought";
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
    "SELECT d.user_id, p.name, p.country_id, c.name AS country_name, " +
    "SUM(d.bought_qty) AS bought, SUM(d.sold_qty) AS sold " +
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
    env.DB.prepare("SELECT MIN(day) AS min, MAX(day) AS max FROM player_item_daily").first(),
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
      "SELECT id, created_at, buyer_id, seller_id, item_code, quantity FROM transactions " +
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
    "SELECT p.user_id, p.name, p.country_id, c.name AS country_name FROM players p " +
      "LEFT JOIN countries c ON c.id = p.country_id WHERE p.user_id = ?",
  )
    .bind(id)
    .first();
  if (!player) return json({ error: "Igrač nije pronađen" }, 404);

  const where = ["d.user_id = ?"];
  const args = [id];
  periodWhere(f, where, args);
  const { results: perItem } = await env.DB.prepare(
    "SELECT d.item_code, SUM(d.bought_qty) AS bought, SUM(d.sold_qty) AS sold FROM player_item_daily d " +
      `WHERE ${where.join(" AND ")} GROUP BY d.item_code ORDER BY bought DESC`,
  )
    .bind(...args)
    .all();

  const { rows, truncated } = await playerTransactions(env, id, f);
  const others = [...new Set(rows.map((r) => (r.side === "buy" ? r.seller_id : r.buyer_id)))];
  const names = new Map();
  for (let i = 0; i < others.length; i += 90) {
    const chunk = others.slice(i, i + 90);
    const { results } = await env.DB.prepare(
      `SELECT user_id, name FROM players WHERE user_id IN (${chunk.map(() => "?").join(",")})`,
    )
      .bind(...chunk)
      .all();
    for (const r of results) names.set(r.user_id, r.name);
  }
  const recent = rows.map((r) => {
    const other = r.side === "buy" ? r.seller_id : r.buyer_id;
    return {
      at: r.created_at,
      side: r.side,
      item: r.item_code,
      quantity: r.quantity,
      other_id: other,
      other_name: names.get(other) ?? null,
    };
  });

  const res = json({ player, per_item: perItem, recent, truncated }, 200, { "cache-control": "public, max-age=60" });
  if (cache) ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

async function apiStatus(env) {
  const trackedInfo = await trackedCountries(env);
  const [meta, tx, players, named, countries, mapped, alliances] = await Promise.all([
    getMeta(env),
    env.DB.prepare("SELECT MAX(rowid) AS n FROM transactions").first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM players").first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM players WHERE name IS NOT NULL").first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM countries").first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM countries WHERE alliance_id IS NOT NULL").first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM alliances").first(),
  ]);
  return json(
    {
      transactions: tx?.n || 0,
      players: players?.n || 0,
      players_with_names: named?.n || 0,
      countries: countries?.n || 0,
      countries_in_alliance: mapped?.n || 0,
      alliances: alliances?.n || 0,
      tracked: trackedInfo ? trackedInfo : "sve države",
      backfill_done: meta.g_back_done === "1",
      history_reached: meta.g_back_oldest || null,
      newest_synced: meta.g_head_ts || null,
      last_run: meta.last_run || null,
      last_tick: meta.last_tick || null,
      has_api_key: Boolean(env.WARERA_API_KEY),
      order: meta.order || null,
      errors: Object.fromEntries(Object.entries(meta).filter(([k]) => k.startsWith("err_"))),
    },
    200,
    { "cache-control": "public, max-age=15" },
  );
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/api/ranking") return await apiRanking(env, url);
      if (path === "/api/filters") return await apiFilters(env);
      if (path === "/api/status") return await apiStatus(env);
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
