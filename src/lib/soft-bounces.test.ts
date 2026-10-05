import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import fs from "fs";
import test from "node:test";
import os from "os";
import path from "path";
import { saveAccountSettings } from "./account-settings";
import { createUser } from "./queries";
import { closeSql, readySql } from "./sql";
import { recordSoftBounce, softBounceCountFor } from "./soft-bounces";
import { suppressionReason } from "./deliverability";

process.env.APP_SECRET = "test-secret-test-secret-test-secret";
process.env.POSTROOM_AUTO_VERIFY = "1";

async function withDb(fn: (email: string) => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postroom-"));
  process.env.POSTROOM_DB = path.join(dir, "test.db");
  await closeSql();
  const email = `owner-${randomUUID().slice(0, 8)}@example.com`;
  try {
    await fn(email);
  } finally {
    const sql = await readySql();
    const owner = (await sql.prepare("SELECT id FROM users WHERE email = ?").get(email)) as { id: string } | null;
    if (owner) await sql.prepare("DELETE FROM users WHERE id = ?").run(owner.id);
    await closeSql();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("soft bounces accumulate and auto-suppress at the threshold", async () => {
  await withDb(async (email) => {
    const user = await createUser({ name: "Pat", email, password: "password1" });
    await saveAccountSettings(user.id, { softBounceThreshold: 3, softBounceWindowDays: 30 });
    const target = "soft@example.com";
    assert.equal((await recordSoftBounce({ userId: user.id, email: target, source: "smtp", detail: "4xx" })).suppressed, false);
    assert.equal((await recordSoftBounce({ userId: user.id, email: target, source: "webhook", detail: "soft" })).suppressed, false);
    assert.equal(await softBounceCountFor(user.id, target), 2);
    assert.equal(await suppressionReason(user.id, target), null);
    const third = await recordSoftBounce({ userId: user.id, email: target, source: "smtp", detail: "gave up" });
    assert.equal(third.suppressed, true);
    assert.equal(await suppressionReason(user.id, target), "soft_bounce");
  });
});
