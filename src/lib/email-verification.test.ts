import assert from "node:assert/strict";
import { createHash, randomUUID } from "crypto";
import fs from "fs";
import test from "node:test";
import os from "os";
import path from "path";
import {
  isEmailVerified,
  markEmailVerified,
  requireEmailVerified,
  sendVerificationEmail,
  verifyEmailWithToken,
} from "./email-verification";
import { addContact, createList, createUser, queueCampaign, saveCampaign, updateSettings } from "./queries";
import { closeSql, readySql } from "./sql";
import { UserError } from "./user-error";

process.env.APP_SECRET = "test-secret-test-secret-test-secret";
delete process.env.SYSTEM_SMTP_HOST;

async function withDb(fn: () => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postroom-"));
  const prevDb = process.env.POSTROOM_DB;
  const prevAuto = process.env.POSTROOM_AUTO_VERIFY;
  process.env.POSTROOM_DB = path.join(dir, "test.db");
  process.env.POSTROOM_AUTO_VERIFY = "0";
  await closeSql();
  try {
    await fn();
  } finally {
    await closeSql();
    fs.rmSync(dir, { recursive: true, force: true });
    if (prevDb === undefined) delete process.env.POSTROOM_DB;
    else process.env.POSTROOM_DB = prevDb;
    if (prevAuto === undefined) delete process.env.POSTROOM_AUTO_VERIFY;
    else process.env.POSTROOM_AUTO_VERIFY = prevAuto;
  }
}

test("new accounts are unverified until the token is used", async () => {
  await withDb(async () => {
    const user = await createUser({ name: "Pat", email: `pat-${randomUUID().slice(0, 8)}@example.com`, password: "password1" });
    assert.equal(await isEmailVerified(user.id), false);
    await assert.rejects(requireEmailVerified(user.id), UserError);

    await sendVerificationEmail({ userId: user.id, origin: "http://localhost:3010" });
    const sql = await readySql();
    const token = "verify-token-for-test-aaaaaaaa";
    const hash = createHash("sha256").update(`postroom-email-verify-v1:${token}`, "utf8").digest("hex");
    await sql.prepare("DELETE FROM email_verification_tokens WHERE user_id = ?").run(user.id);
    await sql
      .prepare("INSERT INTO email_verification_tokens (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .run(hash, user.id, new Date(Date.now() + 3600_000).toISOString(), new Date().toISOString());
    await verifyEmailWithToken(token);
    assert.equal(await isEmailVerified(user.id), true);
  });
});

test("unverified accounts cannot queue campaigns", async () => {
  await withDb(async () => {
    const user = await createUser({ name: "Pat", email: `pat-${randomUUID().slice(0, 8)}@example.com`, password: "password1" });
    await updateSettings(user.id, {
      name: "Pat",
      companyName: "Co",
      postalAddress: "1 Road",
      fromName: "Pat",
      fromEmail: user.email,
      replyTo: "",
      smtpHost: "",
      smtpPort: 587,
      smtpSecure: false,
      smtpUser: "",
      smtpPass: null,
    });
    const listId = await createList(user.id, "List");
    await addContact(user.id, { email: "a@example.com", firstName: "A", lastName: "", listId });
    const campaignId = await saveCampaign(user.id, {
      name: "C",
      subject: "Hi",
      html: "<p>Hi</p>",
      listId,
      fromName: "Pat",
      fromEmail: user.email,
      replyTo: "",
    });
    await assert.rejects(queueCampaign(user.id, campaignId, "http://localhost:3010"), /Verify your email/);
    await markEmailVerified(user.id);
    const result = await queueCampaign(user.id, campaignId, "http://localhost:3010");
    assert.equal(result.queued, 1);
  });
});
