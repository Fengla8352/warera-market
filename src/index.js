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

async function fetchPage(env, cursor, countryId) {
  const input = { limit: 100, transactionType: txType(env) };
  if (countryId) input.countryId = countryId;
  if (cursor) input.cursor = cursor;
  const data = await trpc(env, "transaction.getPaginatedTransactions", input);
  return {
    items: data?.items || [],
    nextCursor: data?.nextCursor || null,
    // API ne vraća uvijek `hasMore`; tada je kraj samo kad nema nextCursor ili je stranica prazna
    hasMore: (data?.items?.length ?? 0) > 0 && (data?.hasMore ?? Boolean(data?.nextCursor)),
  };
}

async function storePage(env, items) {
  const stmts = [];
  for (const t of items) {
    if (t.transactionType && t.transactionType !== txType(env)) continue;
    if (!t._id || !t.buyerId || !t.sellerId) continue;
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

async function syncTransactions(env, meta, budget) {
  const tracked = await trackedCountries(env);
  let streams;
  if (tracked === null) {
    streams = [{ key: "", country: null }];
  } else {
    await setMeta(env, "err_tracked", tracked.missing.length ? `Države nisu pronađene: ${tracked.missing.join(", ")}` : null);
    if (!tracked.ids.length) throw new Error("Nijedna država iz TRACKED_COUNTRIES nije pronađena u bazi");
    streams = tracked.ids.map((id) => ({ key: `s:${id}:`, country: id }));
  }
  const share = Math.max(1, Math.floor(budget / streams.length));
  for (const s of streams) await syncStream(env, meta, share, s);
}

// jedan tok transakcija (jedna država ili sve) sa svojim kursorima u meta tablici
async function syncStream(env, meta, budget, stream) {
  const K = (name) => stream.key + name;
  const c = stream.country;

  // 1) prvo pokretanje: povuci najnoviju stranicu, zapamti "glavu" i kursor za backfill
  if (!meta[K("head_ts")] && !meta[K("backfill_cursor")] && !meta[K("backfill_done")]) {
    const page = await fetchPage(env, undefined, c);
    budget--;
    await storePage(env, page.items);
    if (page.items.length >= 2) {
      const first = tsOf(page.items[0]);
      const last = tsOf(page.items[page.items.length - 1]);
      await setMeta(env, "order", first >= last ? "newest-first" : "OLDEST-FIRST (provjeri sync logiku!)");
    }
    await setMeta(env, K("head_ts"), maxTs(page.items) || new Date().toISOString());
    if (page.hasMore && page.nextCursor) await setMeta(env, K("backfill_cursor"), page.nextCursor);
    else await setMeta(env, K("backfill_done"), "1");
    meta = await getMeta(env);
  }

  // 2) forward: dohvati sve novije od zadnje viđene transakcije
  if (meta[K("head_ts")]) {
    let cursor = meta[K("fwd_cursor")] || undefined;
    let newHead = meta[K("fwd_new_head")] || meta[K("head_ts")];
    while (budget > 0) {
      const page = await fetchPage(env, cursor, c);
      budget--;
      await storePage(env, page.items);
      const top = maxTs(page.items);
      if (top > newHead) newHead = top;
      const oldest = minTs(page.items);
      const reached = !page.items.length || (oldest !== null && oldest <= meta[K("head_ts")]) || !page.hasMore;
      if (reached) {
        await setMeta(env, K("head_ts"), newHead);
        await setMeta(env, K("fwd_cursor"), null);
        await setMeta(env, K("fwd_new_head"), null);
        break;
      }
      cursor = page.nextCursor;
      await setMeta(env, K("fwd_cursor"), cursor);
      await setMeta(env, K("fwd_new_head"), newHead);
    }
  }

  // 3) backfill: ostatak budžeta ide na povijest unatrag
  let cursor = meta[K("backfill_cursor")] || null;
  while (budget > 0 && cursor && !meta[K("backfill_done")]) {
    const page = await fetchPage(env, cursor, c);
    budget--;
    await storePage(env, page.items);
    if (page.hasMore && page.nextCursor) {
      cursor = page.nextCursor;
      await setMeta(env, K("backfill_cursor"), cursor);
    } else {
      await setMeta(env, K("backfill_cursor"), null);
      await setMeta(env, K("backfill_done"), "1");
      break;
    }
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

async function enrichPlayers(env, batches = 5) {
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
    from: DAY_RE.test(p.get("from") || "") ? p.get("from") : null,
    to: DAY_RE.test(p.get("to") || "") ? p.get("to") : null,
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
  periodWhere(f, where, args, { withItems: false });
  const { results: perItem } = await env.DB.prepare(
    "SELECT d.item_code, SUM(d.bought_qty) AS bought, SUM(d.sold_qty) AS sold FROM player_item_daily d " +
      `WHERE ${where.join(" AND ")} GROUP BY d.item_code ORDER BY bought DESC`,
  )
    .bind(...args)
    .all();

  // zadnje transakcije igrača dohvaćamo uživo iz WarEra API-ja (ne spremamo ih po igraču)
  let recent = [];
  try {
    const data = await trpc(env, "transaction.getPaginatedTransactions", {
      limit: 50,
      userId: id,
      transactionType: txType(env),
    });
    const items = data?.items || [];
    const others = [...new Set(items.map((t) => (String(t.buyerId) === id ? t.sellerId : t.buyerId)).filter(Boolean))];
    const names = new Map();
    if (others.length) {
      const { results } = await env.DB.prepare(
        `SELECT user_id, name FROM players WHERE user_id IN (${others.map(() => "?").join(",")})`,
      )
        .bind(...others.map(String))
        .all();
      for (const r of results) names.set(r.user_id, r.name);
    }
    recent = items.map((t) => {
      const bought = String(t.buyerId) === id;
      const other = String(bought ? t.sellerId : t.buyerId);
      return {
        at: t.createdAt,
        side: bought ? "buy" : "sell",
        item: t.itemCode,
        quantity: t.quantity,
        other_id: other,
        other_name: names.get(other) ?? null,
      };
    });
  } catch (e) {
    recent = [];
  }

  const res = json({ player, per_item: perItem, recent }, 200, { "cache-control": "public, max-age=60" });
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
      backfill_done: trackedInfo
        ? trackedInfo.ids.length > 0 && trackedInfo.ids.every((id) => meta[`s:${id}:backfill_done`] === "1")
        : meta.backfill_done === "1",
      newest_synced: trackedInfo
        ? trackedInfo.ids.map((id) => meta[`s:${id}:head_ts`]).filter(Boolean).sort().pop() || null
        : meta.head_ts || null,
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
