// Pomoćni dio za testove: prava SQLite baza umjesto D1, lažni WarEra API i izmišljeni svijet igrača.
// Pokreće se s `npm test` (potreban je Node 22.5+ zbog ugrađenog node:sqlite).
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const DAY = 86_400_000;

// D1 sučelje (prepare/bind/all/first/run/batch) nad node:sqlite; broji upite i upisane retke
export function makeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(fs.readFileSync(ROOT + "schema.sql", "utf8"));
  const stats = { queries: 0 };
  const exec = (sql, args) => {
    const p = db.prepare(sql);
    if (p.columns().length) return { results: p.all(...args), meta: { rows_written: 0 } };
    const r = p.run(...args);
    // približno kao D1: redak + okidač i indeksi
    return { results: [], meta: { rows_written: Number(r.changes) * 5 } };
  };
  class Stmt {
    constructor(sql) { this.sql = sql; this.args = []; }
    bind(...a) { this.args = a; return this; }
    async all() { stats.queries++; return exec(this.sql, this.args); }
    async first() { stats.queries++; return exec(this.sql, this.args).results[0] ?? null; }
    async run() { stats.queries++; return exec(this.sql, this.args); }
  }
  const DB = {
    prepare: (sql) => new Stmt(sql),
    async batch(stmts) {
      stats.queries++;
      db.exec("BEGIN");
      try {
        const out = stmts.map((s) => exec(s.sql, s.args));
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return { db, DB, stats };
}

export const COUNTRIES = [
  ["c_hr", "Croatia"], ["c_cu", "Cuba"], ["c_kg", "Kyrgyzstan"], ["c_bw", "Botswana"],
  ["x_de", "Germany"], ["x_rs", "Serbia"], ["x_pl", "Poland"],
];
export const TRACKED = new Set(["c_hr", "c_cu", "c_kg", "c_bw"]);
const ITEMS = ["bread", "steel", "oil"];

// izmišljeni svijet: 600 igrača (40 iz praćenih država), transakcije kroz zadnjih `days` dana, najnovije prve
export function makeWorld({ txCount = 6000, days = 40, seed = 1 } = {}) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const users = new Map();
  for (let i = 0; i < 600; i++) {
    const c = i < 40 ? COUNTRIES[i % 4][0] : COUNTRIES[4 + (i % 3)][0];
    users.set("u" + i, { username: "name" + i, country: c, avatarUrl: i % 3 ? `https://media.warera.io/avatars/u${i}-1-x.jpg` : undefined });
  }
  const now = Date.now();
  const txs = [];
  for (let i = 0; i < txCount; i++) {
    const b = "u" + Math.floor(rnd() * 600);
    let sl = "u" + Math.floor(rnd() * 600);
    if (sl === b) sl = "u" + ((Number(b.slice(1)) + 1) % 600);
    const q = 1 + (i % 7);
    const price = 1 + (i % 5) * 0.5;
    txs.push({
      _id: "t" + i, createdAt: new Date(now - rnd() * days * DAY).toISOString(), buyerId: b, sellerId: sl,
      itemCode: ITEMS[i % 3], quantity: q, money: Math.round(q * price * 1000) / 1000, transactionType: "trading",
    });
  }
  txs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return { users, txs, now };
}

// lažni WarEra tRPC API nad svijetom; vraća brojač poziva.
// globalDays: koliko dana unatrag seže globalni popis (pravi API: ~3), filter userId vraća cijelu povijest igrača.
export function installFakeApi(world, { globalDays = Infinity, badKey = null } = {}) {
  const calls = { n: 0, withKey: 0 };
  globalThis.fetch = async (url, opts = {}) => {
    calls.n++;
    const key = opts.headers?.["X-API-Key"];
    if (key) calls.withKey++;
    if (badKey && key === badKey) return { ok: false, status: 401, json: async () => ({ error: "unauthorized" }) };
    const u = new URL(url);
    const proc = u.pathname.split("/").pop();
    const ok = (x) => ({ ok: true, status: 200, json: async () => x });
    if (u.searchParams.get("batch")) {
      const body = JSON.parse(opts.body);
      return ok(Object.values(body).map((x) => ({ result: { data: world.users.get(x.userId) ?? null } })));
    }
    const input = JSON.parse(u.searchParams.get("input"));
    if (proc === "transaction.getPaginatedTransactions") {
      const minTs = Number.isFinite(globalDays) ? new Date(Date.now() - globalDays * DAY).toISOString() : "";
      const list = input.userId
        ? world.txs.filter((t) => t.buyerId === input.userId || t.sellerId === input.userId)
        : world.txs.filter((t) => t.createdAt >= minTs);
      const off = input.cursor ? Number(input.cursor) : 0;
      const items = list.slice(off, off + input.limit);
      return ok({ result: { data: { items, nextCursor: off + input.limit < list.length ? String(off + input.limit) : null } } });
    }
    if (proc === "user.getUsersByCountry") {
      const all = [...world.users.entries()].filter(([, u]) => u.country === input.countryId).map(([id]) => ({ _id: id }));
      const off = input.cursor ? Number(input.cursor) : 0;
      return ok({ result: { data: { items: all.slice(off, off + input.limit), nextCursor: off + input.limit < all.length ? String(off + input.limit) : null } } });
    }
    if (proc === "country.getAllCountries") return ok({ result: { data: COUNTRIES.map(([_id, name]) => ({ _id, name })) } });
    if (proc === "alliance.getManyPaginated") return ok({ result: { data: { items: [] } } });
    throw new Error("Lažni API ne zna proceduru " + proc);
  };
  return calls;
}

let instance = 0;
// svaki test dobiva svježu kopiju Workera (bez memorije prethodnog testa)
export async function loadWorker() {
  return (await import(`../src/index.js?test=${++instance}`)).default;
}

export function baseEnv(DB, extra = {}) {
  return {
    DB, WARERA_API_KEY: "test", PAGE_BUDGET: "12", LOOKUP_BUDGET: "6",
    TRACKED_COUNTRIES: "Croatia,Cuba,Kyrgyzstan,Botswana", HISTORY_DAYS: "30", TX_TYPE: "trading", ...extra,
  };
}

// pokrene `ticks` cron prolaza; vraća najveći broj D1 upita i API poziva u jednom prolazu
export async function runTicks(worker, env, db, stats, calls, ticks) {
  let maxQueries = 0, maxCalls = 0;
  for (let i = 0; i < ticks; i++) {
    stats.queries = 0; calls.n = 0;
    let done;
    await worker.scheduled({}, env, { waitUntil: (p) => (done = p) });
    await done;
    maxQueries = Math.max(maxQueries, stats.queries);
    maxCalls = Math.max(maxCalls, calls.n);
    db.prepare("DELETE FROM meta WHERE key = 'lock_until'").run();
  }
  return { maxQueries, maxCalls };
}

export async function get(worker, env, path) {
  const res = await worker.fetch(new Request("http://test" + path), env, { waitUntil() {} });
  return { status: res.status, body: await res.json() };
}
