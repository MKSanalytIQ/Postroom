import type { Migration } from "./types";
import type { Sql } from "../sql";

async function columnExists(sql: Sql, table: string, column: string): Promise<boolean> {
  if (sql.dialect === "sqlite") {
    const rows = (await sql.prepare(`PRAGMA table_info(${table})`).all()) as { name: string }[];
    return rows.some((row) => row.name === column);
  }
  const row = (await sql
    .prepare(
      `SELECT 1 AS found FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = ? AND column_name = ?`,
    )
    .get(table, column)) as { found: number } | null;
  return Boolean(row);
}

async function addColumnIfMissing(sql: Sql, table: string, column: string, ddl: string): Promise<void> {
  if (await columnExists(sql, table, column)) return;
  await sql.prepare(`ALTER TABLE ${table} ADD COLUMN ${ddl}`).run();
}

export const migration002Polish: Migration = {
  id: "002_polish",
  async up(sql) {
    await sql
      .prepare(
        `CREATE TABLE IF NOT EXISTS email_verification_tokens (
          token_hash TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          used_at TEXT
        )`,
      )
      .run();
    await sql.prepare("CREATE INDEX IF NOT EXISTS idx_email_verify_user ON email_verification_tokens(user_id)").run();

    await addColumnIfMissing(sql, "users", "email_verified_at", "email_verified_at TEXT");

    // Existing accounts are treated as verified (created before verification existed).
    await sql.prepare("UPDATE users SET email_verified_at = COALESCE(email_verified_at, created_at) WHERE email_verified_at IS NULL").run();

    await sql
      .prepare(
        `CREATE TABLE IF NOT EXISTS account_settings (
          user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          timezone TEXT NOT NULL DEFAULT 'UTC',
          soft_bounce_threshold INTEGER NOT NULL DEFAULT 3,
          soft_bounce_window_days INTEGER NOT NULL DEFAULT 30,
          updated_at TEXT NOT NULL
        )`,
      )
      .run();

    await sql
      .prepare(
        `CREATE TABLE IF NOT EXISTS soft_bounce_events (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          email TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'smtp',
          detail TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL
        )`,
      )
      .run();
    await sql
      .prepare("CREATE INDEX IF NOT EXISTS idx_soft_bounce_lookup ON soft_bounce_events(user_id, email, created_at)")
      .run();

    await addColumnIfMissing(sql, "events", "bot", "bot INTEGER NOT NULL DEFAULT 0");
  },
};
