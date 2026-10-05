import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import fs from "fs";
import test from "node:test";
import os from "os";
import path from "path";
import { eraseContact, exportAccountData, exportContactData } from "./gdpr";
import {
  addContact,
  createList,
  createUser,
  deleteAccount,
  listContacts,
  queueCampaign,
  recordOpen,
  saveCampaign,
  updateSettings,
} from "./queries";
import { suppressionReason as suppressReason } from "./deliverability";
import { closeSql, readySql } from "./sql";
import { runBatch } from "./worker-cycle";

process.env.APP_SECRET = "test-secret-test-secret-test-secret";
process.env.SEND_DELAY_MS = "0";

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

test("contact export includes consent and send events; erase anonymizes history and suppresses", async () => {
  await withDatabase(async (ownerEmail) => {
    const user = await createUser({ name: "Ada", email: ownerEmail, password: "password123" });
    await updateSettings(user.id, {
      name: "Ada",
      companyName: "Co",
      postalAddress: "1 St",
      fromName: "Ada",
      fromEmail: "owner@postroom.test",
      replyTo: "",
      smtpHost: "",
      smtpPort: 587,
      smtpSecure: false,
      smtpUser: "",
      smtpPass: null,
    });
    const listId = await createList(user.id, "L");
    await addContact(user.id, {
      email: "person@example.com",
      firstName: "P",
      lastName: "Q",
      listId,
      consentSource: "manual",
      consentIp: "1.2.3.4",
    });
    const contact = (await listContacts(user.id, 1, "person@example.com")).rows[0];
    const campaignId = await saveCampaign(user.id, {
      name: "C",
      subject: "Hi",
      html: "<p>Hi</p>",
      listId,
      fromName: "Ada",
      fromEmail: "owner@postroom.test",
      replyTo: "",
    });
    await queueCampaign(user.id, campaignId, "http://localhost:3010");
    await runBatch(5);
    const sql = await readySql();
    const token = ((await sql.prepare("SELECT token FROM recipients WHERE email = ?").get("person@example.com")) as { token: string }).token;
    await recordOpen(token);

    const exported = await exportContactData(user.id, contact.id);
    assert.equal((exported.contact as { email: string }).email, "person@example.com");
    assert.equal((exported.consent as { source: string }).source, "manual");
    assert.ok(((exported.events as unknown[]) || []).length >= 1);

    await eraseContact(user.id, contact.id);
    assert.equal((await listContacts(user.id, 1, "person@example.com")).total, 0);
    assert.equal(await suppressReason(user.id, "person@example.com"), "manual");
    const recipient = (await sql.prepare("SELECT email, first_name FROM recipients WHERE campaign_id = ?").get(campaignId)) as {
      email: string;
      first_name: string;
    };
    assert.match(recipient.email, /^erased-/);
    assert.equal(recipient.first_name, "");
    assert.equal(Number(((await sql.prepare("SELECT COUNT(*) AS n FROM recipients WHERE campaign_id = ?").get(campaignId)) as { n: number }).n), 1);

    const account = await exportAccountData(user.id);
    assert.equal((account.account as { email: string }).email, ownerEmail);
    assert.ok(Array.isArray(account.campaigns));
  });
});
