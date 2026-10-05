import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import fs from "fs";
import test from "node:test";
import os from "os";
import path from "path";
import {
  changePassword,
  countActiveResetTokens,
  requestPasswordReset,
  resetPasswordWithToken,
} from "./password-reset";
import { accountForSession, createSession, createUser, deleteAccount, verifyPassword } from "./queries";
import { closeSql, readySql } from "./sql";

process.env.APP_SECRET = "test-secret-test-secret-test-secret";
delete process.env.SYSTEM_SMTP_HOST;

async function withDatabase(fn: (ownerEmail: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postroom-"));
  process.env.POSTROOM_DB = path.join(dir, "test.db");
  await closeSql();
  const ownerEmail = `owner-${randomUUID().slice(0, 8)}@postroom.test`;
  try {
    await fn(ownerEmail);
  } finally {
    const sql = await readySql();
    const owner = (await sql.prepare("SELECT id FROM users WHERE email = ?").get(ownerEmail)) as { id: string } | null;
    if (owner) await deleteAccount(owner.id);
    await closeSql();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("requestPasswordReset does not reveal whether the email exists", async () => {
  await withDatabase(async (ownerEmail) => {
    const user = await createUser({ name: "Ada", email: ownerEmail, password: "password123" });
    const unknown = await requestPasswordReset({ email: "nobody@example.com", origin: "http://localhost:3010", ipKey: "1.1.1.1" });
    const known = await requestPasswordReset({ email: ownerEmail, origin: "http://localhost:3010", ipKey: "1.1.1.2" });
    assert.deepEqual(unknown, { ok: true });
    assert.deepEqual(known, { ok: true });
    assert.equal(await countActiveResetTokens(user.id), 1);
  });
});

test("a reset token updates the password, is single-use, and clears other sessions", async () => {
  await withDatabase(async (ownerEmail) => {
    const user = await createUser({ name: "Ada", email: ownerEmail, password: "password123" });
    const sessionA = await createSession(user.id);
    const sessionB = await createSession(user.id);
    await requestPasswordReset({ email: ownerEmail, origin: "http://localhost:3010", ipKey: "2.2.2.2" });
    const sql = await readySql();
    // Recover the plaintext from the system-mail log is hard; insert a known token via hashing helper by requesting
    // and reading the hash then replacing — instead call reset with a token we plant.
    const { createHash } = await import("crypto");
    const token = "test-reset-token-value-xxxxxxxx";
    const tokenHash = createHash("sha256").update(`postroom-password-reset-v1:${token}`, "utf8").digest("hex");
    await sql.prepare("DELETE FROM password_reset_tokens WHERE user_id = ?").run(user.id);
    await sql
      .prepare("INSERT INTO password_reset_tokens (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .run(tokenHash, user.id, new Date(Date.now() + 3600_000).toISOString(), new Date().toISOString());

    await resetPasswordWithToken({ token, password: "newpassword99", ipKey: "2.2.2.3" });
    assert.equal(await verifyPassword(ownerEmail, "password123"), null);
    assert.ok(await verifyPassword(ownerEmail, "newpassword99"));
    assert.equal(await accountForSession(sessionA), null);
    assert.equal(await accountForSession(sessionB), null);
    await assert.rejects(resetPasswordWithToken({ token, password: "anotherpass1", ipKey: "2.2.2.4" }), /not valid/);
  });
});

test("changePassword checks the current password and signs out other sessions", async () => {
  await withDatabase(async (ownerEmail) => {
    const user = await createUser({ name: "Ada", email: ownerEmail, password: "password123" });
    const other = await createSession(user.id);
    await assert.rejects(changePassword(user.id, "wrong", "newpassword99"), /Current password/);
    await changePassword(user.id, "password123", "newpassword99");
    assert.ok(await verifyPassword(ownerEmail, "newpassword99"));
    assert.equal(await accountForSession(other), null);
  });
});
