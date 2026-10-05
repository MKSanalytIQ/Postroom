import type { Sql } from "../sql";
import { nowIso } from "../time";
import { migration001Baseline } from "./001_baseline";
import { migration002Polish } from "./002_polish";
import type { Migration } from "./types";

export type { Migration } from "./types";

export const MIGRATIONS: Migration[] = [migration001Baseline, migration002Polish];

const BOOTSTRAP = `CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
)`;

export type MigrationStatus = {
  applied: { id: string; appliedAt: string }[];
  pending: string[];
};

export async function migrationStatus(sql: Sql): Promise<MigrationStatus> {
  await sql.prepare(BOOTSTRAP).run();
  const rows = (await sql.prepare("SELECT id, applied_at FROM schema_migrations ORDER BY id").all()) as {
    id: string;
    applied_at: string;
  }[];
  const appliedIds = new Set(rows.map((row) => row.id));
  return {
    applied: rows.map((row) => ({ id: row.id, appliedAt: row.applied_at })),
    pending: MIGRATIONS.map((m) => m.id).filter((id) => !appliedIds.has(id)),
  };
}

/**
 * Runs ordered migrations. Caller must already have applied the portable CREATE IF NOT EXISTS
 * schema (db.ts for SQLite, SCHEMA exec for Postgres) so existing databases keep their data.
 * Empty schema_migrations on a DB that already has users → stamp 001_baseline, then apply the rest.
 */
export async function runMigrations(sql: Sql): Promise<{ applied: string[] }> {
  await sql.prepare(BOOTSTRAP).run();

  const existing = (await sql.prepare("SELECT id FROM schema_migrations").all()) as { id: string }[];
  const appliedSet = new Set(existing.map((row) => row.id));

  if (appliedSet.size === 0) {
    const users = (await sql.prepare("SELECT 1 AS found FROM users LIMIT 1").get()) as { found: number } | null;
    if (users) {
      await sql.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(migration001Baseline.id, nowIso());
      appliedSet.add(migration001Baseline.id);
    }
  }

  const newly: string[] = [];
  for (const migration of MIGRATIONS) {
    if (appliedSet.has(migration.id)) continue;
    await sql.transaction(async (tx) => {
      await migration.up(tx);
      await tx.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(migration.id, nowIso());
    });
    newly.push(migration.id);
    appliedSet.add(migration.id);
  }
  return { applied: newly };
}
