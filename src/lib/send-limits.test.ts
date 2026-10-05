import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import fs from "fs";
import test from "node:test";
import os from "os";
import path from "path";
import {
  addContact,
  createList,
  createUser,
  deleteAccount,
  queueCampaign,
  saveCampaign,
  updateSettings,
} from "./queries";
import { getSendLimits, remainingSendCapacity, saveSendLimits, tryReserveSend } from "./send-limits";
import { closeSql, readySql } from "./sql";
import { runBatch } from "./worker-cycle";

process.env.APP_SECRET = "test-secret-test-secret-test-secret";
process.env.SEND_DELAY_MS = "0";
process.env.POSTROOM_RETRY_BASE_MS = "0";
process.env.POSTROOM_DISABLE_SEND_LIMITS = "0";

const SETTINGS = {
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
};

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

test("send limits default and refuse when the second window is full", async () => {
  await withDatabase(async (ownerEmail) => {
    const user = await createUser({ name: "Ada", email: ownerEmail, password: "password123" });
    assert.deepEqual(await getSendLimits(user.id), { perSecond: 2, perMinute: 60, perHour: 1000, perDay: 10000 });
    await saveSendLimits(user.id, { perSecond: 1, perMinute: 1, perHour: 100, perDay: 1000 });
    assert.equal(await tryReserveSend(user.id), true);
    assert.equal(await tryReserveSend(user.id), false);
    assert.equal(await remainingSendCapacity(user.id), 0);
  });
});

test("claimBatch leaves recipients pending when the account is over its send ceiling", async () => {
  await withDatabase(async (ownerEmail) => {
    const user = await createUser({ name: "Ada", email: ownerEmail, password: "password123" });
    await updateSettings(user.id, SETTINGS);
    await saveSendLimits(user.id, { perSecond: 1, perMinute: 1, perHour: 10, perDay: 10 });
    const listId = await createList(user.id, "L");
    await addContact(user.id, { email: "a@example.com", firstName: "", lastName: "", listId });
    await addContact(user.id, { email: "b@example.com", firstName: "", lastName: "", listId });
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
    assert.equal(await runBatch(5), 1, "only one message fits under per-second/minute=1");
    const sql = await readySql();
    const rows = (await sql.prepare("SELECT status FROM recipients WHERE campaign_id = ? ORDER BY email").all(campaignId)) as {
      status: string;
    }[];
    assert.equal(rows.filter((row) => row.status === "sent").length, 1);
    assert.equal(rows.filter((row) => row.status === "pending").length, 1);
  });
});
