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

async function fetchPage(env, cursor) {
  const input = { limit: 100, transactionType: "itemMarket" };
  if (cursor) input.cursor = cursor;
  const data = await trpc(env, "transaction.getPaginatedTransactions", input);
  return {
    items: data?.items || [],
    nextCursor: data?.nextCursor || null,
    hasMore: Boolean(data?.hasMore),
  };
}

async function storePage(env, items) {
  const stmts = [];
  for (const t of items) {
    if (t.transactionType && t.transactionType !== "itemMarket") continue;
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

async function syncTransactions(env, meta, budget) {
  // 1) prvo pokretanje: povuci najnoviju stranicu, zapamti "glavu" i kursor za backfill
  if (!meta.head_ts && !meta.backfill_cursor && !meta.backfill_done) {
    const page = await fetchPage(env, undefined);
    budget--;
    await storePage(env, page.items);
    if (page.items.length >= 2) {
      const first = tsOf(page.items[0]);
      const last = tsOf(page.items[page.items.length - 1]);
      await setMeta(env, "order", first >= last ? "newest-first" : "OLDEST-FIRST (provjeri sync logiku!)");
    }
    await setMeta(env, "head_ts", maxTs(page.items) || new Date().toISOString());
    if (page.hasMore && page.nextCursor) await setMeta(env, "backfill_cursor", page.nextCursor);
    else await setMeta(env, "backfill_done", "1");
    meta = await getMeta(env);
  }

  // 2) forward: dohvati sve novije od zadnje viđene transakcije
  if (meta.head_ts) {
    let cursor = meta.fwd_cursor || undefined;
    let newHead = meta.fwd_new_head || meta.head_ts;
    while (budget > 0) {
      const page = await fetchPage(env, cursor);
      budget--;
      await storePage(env, page.items);
      const top = maxTs(page.items);
      if (top > newHead) newHead = top;
      const oldest = minTs(page.items);
      const reached = !page.items.length || (oldest !== null && oldest <= meta.head_ts) || !page.hasMore;
      if (reached) {
        await setMeta(env, "head_ts", newHead);
        await setMeta(env, "fwd_cursor", null);
        await setMeta(env, "fwd_new_head", null);
        break;
      }
      cursor = page.nextCursor;
      await setMeta(env, "fwd_cursor", cursor);
      await setMeta(env, "fwd_new_head", newHead);
    }
  }

  // 3) backfill: ostatak budžeta ide na povijest unatrag
  let cursor = meta.backfill_cursor || null;
  while (budget > 0 && cursor && !meta.backfill_done) {
    const page = await fetchPage(env, cursor);
    budget--;
    await storePage(env, page.items);
    if (page.hasMore && page.nextCursor) {
      cursor = page.nextCursor;
      await setMeta(env, "backfill_cursor", cursor);
    } else {
      await setMeta(env, "backfill_cursor", null);
      await setMeta(env, "backfill_done", "1");
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
    const { results: fresh } = await env.DB.prepare(
      "SELECT s.user_id FROM player_stats s LEFT JOIN players p ON p.user_id = s.user_id " +
        "WHERE p.user_id IS NULL ORDER BY s.bought_qty DESC LIMIT 50",
    ).all();
    let ids = fresh.map((r) => r.user_id);
    if (!ids.length) {
      const { results: stale } = await env.DB.prepare(
        "SELECT user_id FROM players WHERE fetched_at < ? ORDER BY fetched_at LIMIT 50",
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

const SORTS = {
  bought_qty: "s.bought_qty",
  bought_money: "s.bought_money",
  sold_qty: "s.sold_qty",
  sold_money: "s.sold_money",
  tx: "(s.bought_tx + s.sold_tx)",
};

async function apiRanking(env, url) {
  const p = url.searchParams;
  const country = p.get("country");
  const alliance = p.get("alliance");
  const q = (p.get("q") || "").trim();
  const sort = SORTS[p.get("sort")] || SORTS.bought_qty;
  const limit = Math.min(Math.max(Number(p.get("limit")) || 50, 1), 100);
  const offset = Math.max(Number(p.get("offset")) || 0, 0);

  const where = [];
  const args = [];
  if (country) {
    where.push("p.country_id = ?");
    args.push(country);
  }
  if (alliance) {
    where.push("c.alliance_id = ?");
    args.push(alliance);
  }
  if (q) {
    where.push("(p.name LIKE ? ESCAPE '\\' OR s.user_id = ?)");
    args.push(`%${q.replace(/[\\%_]/g, (m) => "\\" + m)}%`, q);
  }

  const sql =
    "SELECT s.user_id, p.name, p.country_id, c.name AS country_name, c.alliance_id, a.name AS alliance_name, " +
    "s.bought_qty, s.bought_money, s.bought_tx, s.sold_qty, s.sold_money, s.sold_tx " +
    "FROM player_stats s " +
    "LEFT JOIN players p ON p.user_id = s.user_id " +
    "LEFT JOIN countries c ON c.id = p.country_id " +
    "LEFT JOIN alliances a ON a.id = c.alliance_id " +
    (where.length ? "WHERE " + where.join(" AND ") + " " : "") +
    `ORDER BY ${sort} DESC, s.user_id LIMIT ? OFFSET ?`;

  const { results } = await env.DB.prepare(sql)
    .bind(...args, limit + 1, offset)
    .all();
  const hasMore = results.length > limit;
  const rows = results.slice(0, limit).map((r, i) => ({ rank: offset + i + 1, ...r }));
  return json({ rows, hasMore, offset, limit }, 200, { "cache-control": "public, max-age=30" });
}

async function apiFilters(env) {
  const [countries, alliances] = await Promise.all([
    env.DB.prepare(
      "SELECT c.id, c.name, c.alliance_id FROM countries c " +
        "WHERE EXISTS (SELECT 1 FROM players p WHERE p.country_id = c.id) ORDER BY c.name",
    ).all(),
    env.DB.prepare(
      "SELECT a.id, a.name FROM alliances a " +
        "WHERE EXISTS (SELECT 1 FROM countries c WHERE c.alliance_id = a.id) ORDER BY a.name",
    ).all(),
  ]);
  return json({ countries: countries.results, alliances: alliances.results }, 200, {
    "cache-control": "public, max-age=300",
  });
}

async function apiPlayer(env, id, ctx, request) {
  const cache = caches.default;
  const cacheKey = new Request(new URL(`/__cache/player/${id}`, request.url).toString());
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const row = await env.DB.prepare(
    "SELECT s.*, p.name, p.country_id, c.name AS country_name, a.name AS alliance_name " +
      "FROM player_stats s LEFT JOIN players p ON p.user_id = s.user_id " +
      "LEFT JOIN countries c ON c.id = p.country_id LEFT JOIN alliances a ON a.id = c.alliance_id " +
      "WHERE s.user_id = ?",
  )
    .bind(id)
    .first();
  if (!row) return json({ error: "Igrač nije pronađen" }, 404);

  // zadnje transakcije igrača dohvaćamo uživo iz WarEra API-ja (ne spremamo ih po igraču)
  let recent = [];
  try {
    const data = await trpc(env, "transaction.getPaginatedTransactions", {
      limit: 50,
      userId: id,
      transactionType: "itemMarket",
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
        money: t.money,
        other_id: other,
        other_name: names.get(other) ?? null,
      };
    });
  } catch (e) {
    recent = [];
  }

  const res = json({ player: row, recent }, 200, { "cache-control": "public, max-age=60" });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

async function apiStatus(env) {
  const [meta, tx, players, named, countries, mapped, alliances] = await Promise.all([
    getMeta(env),
    env.DB.prepare("SELECT MAX(rowid) AS n FROM transactions").first(),
    env.DB.prepare("SELECT MAX(rowid) AS n FROM player_stats").first(),
    env.DB.prepare("SELECT MAX(rowid) AS n FROM players WHERE name IS NOT NULL").first(),
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
      backfill_done: meta.backfill_done === "1",
      newest_synced: meta.head_ts || null,
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
        return await apiPlayer(env, decodeURIComponent(path.slice("/api/player/".length)), ctx, request);
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
