import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import fs from "fs";
import test from "node:test";
import os from "os";
import path from "path";
import { signClick, readClickTarget } from "./crypto";
import {
  addContact,
  campaignStats,
  contactsCsv,
  createList,
  createUser,
  dashboard,
  deleteAccount,
  deleteContact,
  duplicateCampaign,
  getCampaign,
  importContacts,
  listContacts,
  listLists,
  listMembers,
  queueCampaign,
  recordClick,
  recordOpen,
  saveCampaign,
  setCampaignStatus,
  setContactStatus,
  unsubView,
  unsubscribe,
  updateSettings,
  verifyPassword,
} from "./queries";
import { closeSql, readySql } from "./sql";
import { runBatch } from "./worker-cycle";

// Runs against SQLite by default. Set DATABASE_URL to run the same tests against Postgres
// (each run uses its own account and removes it afterwards).

process.env.APP_SECRET = "test-secret-test-secret-test-secret";
process.env.SEND_DELAY_MS = "0";

const onPostgres = Boolean(process.env.DATABASE_URL);

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
    if (owner) {
      await sql.prepare("DELETE FROM suppressions WHERE user_id = ?").run(owner.id);
      await deleteAccount(owner.id);
    }
    await closeSql();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function contactField(userId: string, email: string, field: "id" | "status" | "unsub_token"): Promise<string> {
  const sql = await readySql();
  const row = (await sql
    .prepare(`SELECT ${field} AS value FROM contacts WHERE user_id = ? AND email = ?`)
    .get(userId, email)) as { value: string } | null;
  assert.ok(row, `contact ${email} exists`);
  return row.value;
}

const SETTINGS = {
  name: "Ada Lovelace",
  companyName: "Analytical Engines",
  postalAddress: "1 King Street\nLondon",
  fromName: "Ada",
  fromEmail: "owner@postroom.test",
  replyTo: "",
  smtpHost: "",
  smtpPort: 587,
  smtpSecure: false,
  smtpUser: "",
  smtpPass: null,
};

test("capture send skips unsubscribed people and records opens, clicks, and unsubscribe", async () => {
  await withDatabase(async (ownerEmail) => {
    assert.equal((await readySql()).dialect, onPostgres ? "postgres" : "sqlite");
    const user = await createUser({ name: "Ada Lovelace", email: ownerEmail, password: "password123" });
    await updateSettings(user.id, SETTINGS);
    const listId = await createList(user.id, "Readers");
    await addContact(user.id, { email: "ada@example.com", firstName: "Ada", lastName: "Lovelace", listId });
    await addContact(user.id, { email: "grace@example.com", firstName: "Grace", lastName: "Hopper", listId });
    await setContactStatus(user.id, await contactField(user.id, "grace@example.com", "id"), "unsubscribed");
    const imported = await importContacts(
      user.id,
      listId,
      "email,first name,last name\nada@example.com,Ada,Updated\nlinus@example.com,Linus,Torvalds\nnot-an-email,No,One\ngrace@example.com,Grace,Still\n", { consentAttested: true });
    assert.equal(imported.created, 1);
    assert.equal(imported.updated, 2);
    assert.equal(imported.invalid, 1);
    assert.equal(imported.keptUnsubscribed, 1);
    assert.equal(imported.addedToList, 1);

    const campaignId = await saveCampaign(user.id, {
      name: "Hello",
      subject: "Hello {{first_name}}",
      html: `<p>Hi {{first_name}}</p><p><a href="https://example.com/hello">Read</a></p>`,
      listId,
      fromName: "Ada",
      fromEmail: "owner@postroom.test",
      replyTo: "",
    });
    assert.equal((await queueCampaign(user.id, campaignId, "http://localhost:3010")).queued, 2);
    await assert.rejects(queueCampaign(user.id, campaignId, "http://localhost:3010"), /already been queued/);

    await unsubscribe(await contactField(user.id, "linus@example.com", "unsub_token"), campaignId);
    assert.equal(await runBatch(10), 2);

    const campaign = await getCampaign(user.id, campaignId);
    assert.equal(campaign?.status, "sent");
    const sql = await readySql();
    const delivery = (await sql
      .prepare(
        `SELECT d.html, d.subject, d.mode FROM deliveries d
         JOIN recipients r ON r.id = d.recipient_id WHERE r.campaign_id = ? AND r.email = ?`,
      )
      .get(campaignId, "ada@example.com")) as { html: string; subject: string; mode: string };
    assert.equal(delivery.mode, "capture");
    assert.equal(delivery.subject, "Hello Ada");
    assert.match(delivery.html, /Hi Ada/);
    assert.equal(delivery.html.includes('href="https://example.com/hello"'), false);
    assert.match(delivery.html, /\/t\/c\//);
    assert.match(delivery.html, /\/t\/o\//);
    assert.match(delivery.html, /Analytical Engines/);
    assert.match(delivery.html, /\/u\//);

    const tokenRow = (await sql
      .prepare("SELECT token FROM recipients WHERE campaign_id = ? AND email = ?")
      .get(campaignId, "ada@example.com")) as { token: string };
    await recordOpen(tokenRow.token);
    await recordOpen(tokenRow.token);
    const signed = signClick(tokenRow.token, "https://example.com/hello");
    assert.equal(readClickTarget(tokenRow.token, signed.payload, signed.signature), "https://example.com/hello");
    assert.equal(readClickTarget(tokenRow.token, signed.payload, "nope"), null);
    await recordClick(tokenRow.token, "https://example.com/hello");
    const stats = await campaignStats(campaignId);
    assert.equal(stats.total, 2);
    assert.equal(stats.sent, 1);
    assert.equal(stats.skipped, 1);
    assert.equal(stats.uniqueOpens, 1);
    assert.equal(stats.opens, 2);
    assert.equal(stats.uniqueClicks, 1);
    assert.equal(stats.clicks, 1);
    assert.equal(stats.unsubscribes, 1);
    assert.equal(await contactField(user.id, "grace@example.com", "status"), "unsubscribed");

    const overview = await dashboard(user.id);
    assert.deepEqual(overview, {
      subscribed: 1,
      unsubscribed: 2,
      lists: 1,
      sentCampaigns: 1,
      sentRecipients: 1,
      uniqueOpens: 1,
      uniqueClicks: 1,
    });
  });
});

test("lists, search, export, delete, and campaign state behave the same on every database", async () => {
  await withDatabase(async (ownerEmail) => {
    const user = await createUser({ name: "Grace Hopper", email: ownerEmail, password: "password123" });
    await assert.rejects(createUser({ name: "Again", email: ownerEmail.toUpperCase(), password: "password123" }), /already exists/);
    assert.equal((await verifyPassword(ownerEmail, "password123"))?.id, user.id);
    assert.equal(await verifyPassword(ownerEmail, "wrong-password"), null);
    await updateSettings(user.id, SETTINGS);

    const readers = await createList(user.id, "Readers");
    const writers = await createList(user.id, "Writers");
    await addContact(user.id, { email: "Mixed.Case@Example.com", firstName: "Ada", lastName: "Lovelace", listId: readers });
    await addContact(user.id, { email: "mixed.case@example.com", firstName: "", lastName: "", listId: writers });
    await addContact(user.id, { email: "back\\slash@example.com", firstName: "Back", lastName: "Slash", listId: null });
    await addContact(user.id, { email: "other@example.com", firstName: "Zed", lastName: "Other", listId: readers });

    const lists = await listLists(user.id);
    const readerList = lists.find((list) => list.id === readers);
    assert.equal(readerList?.contactCount, 2);
    assert.equal(readerList?.subscribedCount, 2);
    assert.equal(typeof readerList?.contactCount, "number");

    const all = await listContacts(user.id, 1, "");
    assert.equal(all.total, 3);
    const found = await listContacts(user.id, 1, "ADA");
    assert.equal(found.total, 1);
    assert.equal(found.rows[0].firstName, "Ada");
    assert.deepEqual(found.rows[0].listNames.split(", ").sort(), ["Readers", "Writers"]);
    assert.equal((await listContacts(user.id, 1, "MIXED.case")).total, 1);
    assert.equal((await listContacts(user.id, 1, "k\\s")).total, 1);
    assert.equal((await listContacts(user.id, 1, "nobody")).total, 0);
    const members = await listMembers(user.id, readers, 1, "zed");
    assert.equal(members?.total, 1);
    assert.equal(members?.rows[0].email, "other@example.com");
    assert.equal(await listMembers(user.id, "missing", 1, ""), null);

    const csv = await contactsCsv(user.id, readers);
    assert.equal(csv?.trim().split(/\r?\n/).length, 3);
    assert.equal(await contactsCsv(user.id, "missing"), null);

    const reimport = await importContacts(user.id, readers, "email\nmixed.case@example.com\nnew@example.com\nNEW@example.com\n", { consentAttested: true });
    assert.equal(reimport.created, 1);
    assert.equal(reimport.updated, 1);
    assert.equal(reimport.addedToList, 1);

    const otherId = await contactField(user.id, "other@example.com", "id");
    const otherToken = await contactField(user.id, "other@example.com", "unsub_token");
    await deleteContact(user.id, otherId);
    assert.deepEqual(await unsubView(otherToken), {
      email: "other@example.com",
      companyName: "Analytical Engines",
      status: "unsubscribed",
    });
    await assert.rejects(deleteContact(user.id, otherId), /not found/);

    const campaignId = await saveCampaign(user.id, {
      name: "Launch",
      subject: "Hi",
      html: "<p>Hello</p>",
      listId: readers,
      fromName: "",
      fromEmail: "",
      replyTo: "",
    });
    const copyId = await duplicateCampaign(user.id, campaignId);
    assert.equal((await getCampaign(user.id, copyId))?.name, "Launch copy");
    assert.equal((await queueCampaign(user.id, campaignId, "https://mail.example.com/")).queued, 2);
    await setCampaignStatus(user.id, campaignId, "paused");
    assert.equal((await getCampaign(user.id, campaignId))?.status, "paused");
    assert.equal(await runBatch(10), 0);
    await setCampaignStatus(user.id, campaignId, "sending");
    await assert.rejects(setCampaignStatus(user.id, campaignId, "sending"), /cannot be updated/);
    assert.equal(await runBatch(10), 2);
    assert.equal((await getCampaign(user.id, campaignId))?.status, "sent");
    const sql = await readySql();
    const origin = (await sql.prepare("SELECT origin FROM campaigns WHERE id = ?").get(campaignId)) as { origin: string };
    assert.equal(origin.origin, "https://mail.example.com");
  });
});
