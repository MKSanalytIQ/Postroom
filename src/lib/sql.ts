import postgres from "postgres";
import { runMigrations } from "./migrations";
import { SCHEMA } from "./schema";

// One small async database interface for the whole app.
// - DATABASE_URL set: Postgres through the `postgres` package (use this on Vercel).
// - DATABASE_URL unset: the local SQLite file from db.ts (node:sqlite), for development.
// Queries are written once with `?` placeholders and portable SQL; they are rewritten
// to `$1, $2, ...` for Postgres.

type Params = unknown[];

export type Statement = {
  /** First row, or null. */
  get(...params: Params): Promise<unknown>;
  /** All rows. */
  all(...params: Params): Promise<unknown[]>;
  /** Number of rows changed. */
  run(...params: Params): Promise<number>;
};

export type Sql = {
  dialect: "sqlite" | "postgres";
  prepare(text: string): Statement;
  /** Runs fn inside one transaction. Use only the `tx` handle inside fn. */
  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
};

type State = {
  sql: Sql;
  ready: Promise<void>;
  close: () => Promise<void>;
};

let state: State | null = null;

/** Rewrites `?` placeholders to Postgres `$n` placeholders. Queries must not contain literal `?`. */
export function toPostgres(text: string): string {
  let index = 0;
  return text.replace(/\?/g, () => `$${++index}`);
}

// ---------- SQLite (local fallback) ----------

type SqliteModule = typeof import("./db");

function sqliteSql(db: SqliteModule, inTransaction = false): Sql {
  const sql: Sql = {
    dialect: "sqlite",
    prepare(text: string) {
      // getDb() is looked up per statement so tests can switch files with POSTROOM_DB.
      const statement = () => db.getDb().prepare(text);
      return {
        async get(...params: Params) {
          return statement().get(...(params as never[])) ?? null;
        },
        async all(...params: Params) {
          return statement().all(...(params as never[])) as unknown[];
        },
        async run(...params: Params) {
          return Number(statement().run(...(params as never[])).changes);
        },
      };
    },
    async transaction(fn) {
      if (inTransaction) return fn(sql);
      const conn = db.getDb();
      conn.exec("BEGIN IMMEDIATE");
      try {
        const result = await fn(sqliteSql(db, true));
        conn.exec("COMMIT");
        return result;
      } catch (error) {
        conn.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return sql;
}

// ---------- Postgres ----------

type PgClient = postgres.Sql | postgres.TransactionSql;

function postgresSql(client: PgClient, root: postgres.Sql | null): Sql {
  const sql: Sql = {
    dialect: "postgres",
    prepare(text: string) {
      const query = toPostgres(text);
      const exec = (params: Params) => client.unsafe(query, params as postgres.ParameterOrJSON<never>[]);
      return {
        async get(...params: Params) {
          const rows = await exec(params);
          return rows[0] ?? null;
        },
        async all(...params: Params) {
          return [...(await exec(params))];
        },
        async run(...params: Params) {
          const rows = await exec(params);
          return Number(rows.count ?? 0);
        },
      };
    },
    async transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
      // Already inside a transaction: keep using it.
      if (!root) return fn(sql);
      return (await root.begin((tx) => fn(postgresSql(tx, null)))) as T;
    },
  };
  return sql;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const OFF = new Set(["disable", "false", "0", "off", "no"]);
const ON = new Set(["true", "1", "on", "yes"]);
// libpq/Prisma-only URL options that postgres.js would otherwise forward to the
// server as startup parameters (which fails, e.g. Neon's `channel_binding=require`).
const CLIENT_ONLY_PARAMS = ["channel_binding", "gssencmode", "sslsni", "sslcert", "sslkey", "sslcrl", "sslpassword", "pgbouncer"];

export type PgConnection = {
  url: string;
  ssl: false | "require" | "prefer" | "allow" | "verify-full" | undefined;
};

/**
 * Works out the connection URL and TLS mode.
 * Order: DATABASE_SSL env var, then `sslmode` in the URL, then off for localhost and required elsewhere.
 * `ssl: undefined` means "let postgres.js read sslmode from the URL".
 */
export function pgConnection(rawUrl: string, sslEnv = process.env.DATABASE_SSL): PgConnection {
  let parsed: URL | null = null;
  try {
    parsed = new URL(rawUrl);
  } catch {
    parsed = null;
  }
  let url = rawUrl;
  if (parsed) {
    let changed = false;
    for (const name of CLIENT_ONLY_PARAMS) {
      if (parsed.searchParams.has(name)) {
        parsed.searchParams.delete(name);
        changed = true;
      }
    }
    if (changed) url = parsed.toString();
  }
  const env = sslEnv?.trim().toLowerCase();
  if (env) {
    if (OFF.has(env)) return { url, ssl: false };
    if (ON.has(env) || env === "require") return { url, ssl: "require" };
    if (env === "prefer" || env === "allow" || env === "verify-full") return { url, ssl: env };
    throw new Error(`DATABASE_SSL must be one of disable, require, prefer, allow, verify-full (got "${sslEnv}").`);
  }
  if (parsed && (parsed.searchParams.has("sslmode") || parsed.searchParams.has("ssl"))) return { url, ssl: undefined };
  const host = parsed?.hostname ?? "";
  const local = host === "" || LOCAL_HOSTS.has(host);
  return { url, ssl: local ? false : "require" };
}

// Arbitrary constant so concurrent cold starts don't race on CREATE TABLE IF NOT EXISTS.
const MIGRATION_LOCK = 7_406_318_021;

async function migrate(root: postgres.Sql): Promise<void> {
  await root.begin(async (tx) => {
    await tx.unsafe(`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK})`);
    await tx.unsafe(SCHEMA).simple();
    await runMigrations(postgresSql(tx, null));
  });
}

function open(): State {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (databaseUrl) {
    const { url, ssl } = pgConnection(databaseUrl);
    const root = postgres(url, {
      ...(ssl === undefined ? {} : { ssl }),
      max: 5,
      // Works with transaction-mode poolers (Neon pooled URLs, Supabase port 6543).
      prepare: false,
      idle_timeout: 20,
      connect_timeout: 15,
      onnotice: () => {},
    });
    return {
      sql: postgresSql(root, root),
      ready: migrate(root),
      close: () => root.end({ timeout: 5 }),
    };
  }
  if (process.env.VERCEL) {
    console.warn("DATABASE_URL is not set. Falling back to SQLite, which does not keep data on Vercel.");
  }
  const loading = import("./db");
  let sqlite: Sql | null = null;
  const lazy: Sql = {
    dialect: "sqlite",
    prepare: (text) => (sqlite as Sql).prepare(text),
    transaction: (fn) => (sqlite as Sql).transaction(fn),
  };
  return {
    sql: lazy,
    ready: loading.then(async (db) => {
      sqlite = sqliteSql(db);
      await runMigrations(sqlite);
    }),
    close: async () => {
      (await loading).resetDbForTests();
    },
  };
}

/** The ready-to-use database. On Postgres the schema is created on first use. */
export async function readySql(): Promise<Sql> {
  if (!state) state = open();
  const current = state;
  try {
    await current.ready;
  } catch (error) {
    // Don't cache a failed connection or migration; retry on the next call.
    if (state === current) state = null;
    await current.close().catch(() => {});
    throw error;
  }
  return current.sql;
}

/** Closes connections and forgets the cached database (tests and scripts). */
export async function closeSql(): Promise<void> {
  const current = state;
  state = null;
  if (current) await current.close();
}
