import assert from "node:assert/strict";
import fs from "fs";
import test from "node:test";
import os from "os";
import path from "path";
import { MIGRATIONS, migrationStatus, runMigrations } from "./migrations";
import { closeSql, readySql } from "./sql";

process.env.APP_SECRET = "test-secret-test-secret-test-secret";

test("migrations apply once and report status", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postroom-"));
  process.env.POSTROOM_DB = path.join(dir, "mig.db");
  await closeSql();
  try {
    const sql = await readySql();
    const status = await migrationStatus(sql);
    assert.ok(status.applied.length >= 1);
    assert.equal(status.pending.length, 0);
    assert.ok(status.applied.some((row) => row.id === MIGRATIONS[0].id));
    const again = await runMigrations(sql);
    assert.deepEqual(again.applied, []);
    const tables = (await sql.prepare("SELECT id FROM schema_migrations ORDER BY id").all()) as { id: string }[];
    assert.ok(tables.map((t) => t.id).includes("002_polish"));
  } finally {
    await closeSql();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
