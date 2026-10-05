import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import fs from "fs";
import test from "node:test";
import os from "os";
import path from "path";
import { assertAuthAllowed, clearAuthFailures, getAuthLockoutState, recordAuthFailure } from "./abuse";
import { closeSql } from "./sql";
import { UserError } from "./user-error";

process.env.APP_SECRET = "test-secret-test-secret-test-secret";

async function withDatabase(fn: () => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postroom-"));
  process.env.POSTROOM_DB = path.join(dir, "test.db");
  await closeSql();
  try {
    // Ensure a clean schema: Postgres may still have an older INTEGER window from a failed run
    // that stored milliseconds. Dropping is safe — these tables are only rate-limit scratch.
    const { readySql } = await import("./sql");
    const sql = await readySql();
    await sql.prepare("DELETE FROM rate_limit_buckets").run();
    await sql.prepare("DELETE FROM auth_lockouts").run();
    await fn();
  } finally {
    await closeSql();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("assertAuthAllowed rate-limits by IP across calls", async () => {
  await withDatabase(async () => {
    const ip = `203.0.113.${randomUUID().slice(0, 2)}`;
    for (let i = 0; i < 10; i += 1) {
      await assertAuthAllowed("signup", { email: `u${i}@example.com`, ip });
    }
    await assert.rejects(assertAuthAllowed("signup", { email: "more@example.com", ip }), UserError);
  });
});

test("login failures escalate to a lockout with a generic message path", async () => {
  await withDatabase(async () => {
    const email = `lock-${randomUUID().slice(0, 6)}@example.com`;
    const ip = "198.51.100.9";
    for (let i = 0; i < 5; i += 1) await recordAuthFailure({ email, ip });
    const state = await getAuthLockoutState(`email:${email}`);
    assert.equal(state.failures, 5);
    assert.ok(state.lockedUntil);
    await assert.rejects(assertAuthAllowed("login", { email, ip }), /Too many attempts/);
    await clearAuthFailures({ email, ip });
    await assertAuthAllowed("login", { email, ip });
  });
});
