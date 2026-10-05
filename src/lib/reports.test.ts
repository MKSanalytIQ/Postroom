import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import fs from "fs";
import test from "node:test";
import os from "os";
import path from "path";
import { activateAutomation, addEmailStep, createAutomation, getAutomation, runAutomationCycle } from "./automations";
import { handleWebhook, rotateWebhookToken } from "./deliverability";
import {
  addContact,
  createList,
  createUser,
  deleteAccount,
  listTemplates,
  queueCampaign,
  recordClick,
  recordOpen,
  saveCampaign,
  unsubscribe,
  updateSettings,
} from "./queries";
import { buildReport, formatRate, isReportKind, ownsCampaign, reportCsv } from "./reports";
import { closeSql, readySql } from "./sql";
import { runBatch } from "./worker-cycle";

// SQLite by default; set DATABASE_URL to run the same tests against Postgres.

process.env.APP_SECRET = "test-secret-test-secret-test-secret";
process.env.SEND_DELAY_MS = "0";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function tokenOf(campaignId: string, email: string): Promise<string> {
  const sql = await readySql();
  return ((await sql.prepare("SELECT token FROM recipients WHERE campaign_id = ? AND email = ?").get(campaignId, email)) as { token: string }).token;
}

async function unsubToken(userId: string, email: string): Promise<string> {
  const sql = await readySql();
  return ((await sql.prepare("SELECT unsub_token AS t FROM contacts WHERE user_id = ? AND email = ?").get(userId, email)) as { t: string }).t;
}

test("rates are formatted compactly", () => {
  assert.equal(formatRate(0), "0%");
  assert.equal(formatRate(0.004), "0.4%");
  assert.equal(formatRate(0.05), "5%");
  assert.equal(formatRate(0.1234), "12%");
  assert.equal(formatRate(0.255), "26%");
  assert.equal(formatRate(1), "100%");
  assert.equal(isReportKind("daily"), true);
  assert.equal(isReportKind("secrets"), false);
  assert.equal(isReportKind(null), false);
});

test("a campaign report counts sends, opens, clicks, bounces, complaints, and unsubscribes", async () => {
  await withDatabase(async (ownerEmail) => {
    const user = await createUser({ name: "Ada", email: ownerEmail, password: "password123" });
    await updateSettings(user.id, SETTINGS);
    const listId = await createList(user.id, "Readers");
    const people = ["a@example.com", "b@example.com", "c@example.com", "d@example.com", "e@example.com"];
    for (const email of people) await addContact(user.id, { email, firstName: email[0], lastName: "", listId });
    const campaignId = await saveCampaign(user.id, {
      name: "News",
      subject: "Hi",
      html: '<p>Hi <a href="https://example.com/one">one</a> <a href="https://example.com/two">two</a></p>',
      listId,
      fromName: "Ada",
      fromEmail: "owner@postroom.test",
      replyTo: "",
    });

    const empty = await buildReport(campaignId);
    assert.equal(empty.totals.recipients, 0);
    assert.deepEqual(empty.days, []);
    assert.equal(empty.rates.open, 0, "no division by zero");
    assert.equal(empty.totals.delivered, null);

    await queueCampaign(user.id, campaignId, "http://localhost:3010");
    await runBatch(10);
    const token = async (email: string) => tokenOf(campaignId, email);
    await recordOpen(await token("a@example.com"));
    await recordOpen(await token("a@example.com"));
    await recordOpen(await token("b@example.com"));
    await recordClick(await token("a@example.com"), "https://example.com/one");
    await sleep(1100); // avoid multi-link scanner heuristic
    await recordClick(await token("a@example.com"), "https://example.com/two");
    await recordClick(await token("b@example.com"), "https://example.com/one");
    await unsubscribe(await unsubToken(user.id, "c@example.com"), campaignId);

    const hook = await rotateWebhookToken(user.id);
    await handleWebhook(hook, JSON.stringify([
      { type: "bounce", email: "d@example.com", reason: "mailbox gone" },
      { type: "complaint", email: "e@example.com" },
      { type: "delivery", email: "a@example.com" },
      { type: "delivery", email: "b@example.com" },
    ]));

    const report = await buildReport(campaignId);
    assert.deepEqual(report.totals, {
      recipients: 5,
      sent: 5,
      attempted: 5,
      delivered: 2,
      uniqueOpens: 2,
      totalOpens: 3,
      uniqueClicks: 2,
      totalClicks: 3,
      bounces: 1,
      complaints: 1,
      unsubscribes: 1,
      failed: 0,
      skipped: 0,
      waiting: 0,
    });
    assert.deepEqual(report.rates, { open: 0.4, click: 0.4, bounce: 0.2, complaint: 0.2, unsubscribe: 0.2, delivered: 0.4 });
    assert.deepEqual(report.links, [
      { url: "https://example.com/one", clicks: 2, people: 2 },
      { url: "https://example.com/two", clicks: 1, people: 1 },
    ]);
    assert.equal(report.days.length, 1);
    assert.deepEqual({ ...report.days[0], date: "" }, { date: "", sent: 5, opens: 2, clicks: 2, bounces: 1, complaints: 1, unsubscribes: 1 });
    assert.match(report.days[0].date, /^\d{4}-\d{2}-\d{2}$/);

    // Spread the activity over several days: gaps are filled with zero rows.
    const sql = await readySql();
    const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString();
    await sql.prepare("UPDATE recipients SET sent_at = ? WHERE campaign_id = ? AND email = ?").run(day(4), campaignId, "a@example.com");
    await sql.prepare("UPDATE recipients SET opened_at = ?, clicked_at = ? WHERE campaign_id = ? AND email = ?").run(day(3), day(1), campaignId, "a@example.com");
    const spread = await buildReport(campaignId);
    assert.equal(spread.days.length, 5);
    assert.equal(spread.days[0].date, day(4).slice(0, 10));
    assert.equal(spread.days[0].sent, 1);
    assert.equal(spread.days[1].sent + spread.days[2].sent, 0);
    assert.equal(spread.days[1].opens, 1);
    assert.equal(spread.days[3].clicks, 1);
    assert.equal(spread.days[4].sent, 4);
    assert.equal(spread.days.reduce((sum, d) => sum + d.sent, 0), 5);
    for (let i = 1; i < spread.days.length; i += 1) assert.ok(spread.days[i].date > spread.days[i - 1].date);

    // A very long history is trimmed to the latest 90 days.
    await sql.prepare("UPDATE recipients SET sent_at = ? WHERE campaign_id = ? AND email = ?").run(day(400), campaignId, "b@example.com");
    assert.equal((await buildReport(campaignId)).days.length, 90);

    const csv = async (kind: "summary" | "daily" | "links" | "recipients") => (await reportCsv(report, kind)).split("\n");
    const summary = await csv("summary");
    assert.equal(summary[0], "metric,count,rate");
    assert.ok(summary.includes("sent,5,"));
    assert.ok(summary.includes("unique opens,2,40%"));
    assert.ok(summary.includes("bounces,1,20%"));
    assert.ok(summary.includes("delivered (reported by webhook),2,40%"));
    const links = await csv("links");
    assert.deepEqual(links, ["url,clicks,people", "https://example.com/one,2,2", "https://example.com/two,1,1"]);
    const daily = await csv("daily");
    assert.equal(daily[0], "date,sent,unique_opens,unique_clicks,bounces,complaints,unsubscribes");
    assert.equal(daily.length, 2);
    const recipients = await csv("recipients");
    assert.equal(recipients.length, 6);
    assert.ok(recipients.find((line) => line.startsWith("d@example.com,"))?.includes(",yes,no,no,"), "d bounced");
    assert.ok(recipients.find((line) => line.startsWith("e@example.com,"))?.includes(",no,yes,no,"), "e complained");
    assert.ok(recipients.find((line) => line.startsWith("c@example.com,"))?.includes(",no,no,yes,"), "c unsubscribed");
    assert.ok(recipients.find((line) => line.startsWith("a@example.com,"))?.includes(",2,2,no,no,no,"));

    // Ownership check used by pages and exports.
    assert.equal(await ownsCampaign(user.id, campaignId), true);
    assert.equal(await ownsCampaign("someone-else", campaignId), false);
  });
});

test("bounces refused at send time count against the bounce rate", async () => {
  await withDatabase(async (ownerEmail) => {
    const user = await createUser({ name: "Ada", email: ownerEmail, password: "password123" });
    await updateSettings(user.id, SETTINGS);
    const listId = await createList(user.id, "Readers");
    await addContact(user.id, { email: "ok@example.com", firstName: "", lastName: "", listId });
    await addContact(user.id, { email: "gone@example.com", firstName: "", lastName: "", listId });
    const campaignId = await saveCampaign(user.id, { name: "X", subject: "Hi", html: "<p>Hi</p>", listId, fromName: "", fromEmail: "owner@postroom.test", replyTo: "" });
    await queueCampaign(user.id, campaignId, "http://localhost:3010");
    await runBatch(10);
    // Make one of the two look like a refusal from the SMTP server (see deliverability.test.ts for the real path).
    const sql = await readySql();
    await sql.prepare("UPDATE recipients SET status = 'bounced', sent_at = NULL WHERE campaign_id = ? AND email = ?").run(campaignId, "gone@example.com");
    const report = await buildReport(campaignId);
    assert.equal(report.totals.sent, 1);
    assert.equal(report.totals.attempted, 2);
    assert.equal(report.totals.bounces, 1);
    assert.equal(report.rates.bounce, 0.5);
  });
});

test("an automation report covers every email in the series", async () => {
  await withDatabase(async (ownerEmail) => {
    const user = await createUser({ name: "Ada", email: ownerEmail, password: "password123" });
    await updateSettings(user.id, SETTINGS);
    const [template] = await listTemplates(user.id);
    const listId = await createList(user.id, "Welcome");
    const id = await createAutomation(user.id, { name: "Welcome", listId });
    await addEmailStep(user.id, id, template.id);
    await addEmailStep(user.id, id, template.id);
    await activateAutomation(user.id, id, "http://localhost:3010");
    await addContact(user.id, { email: "x@example.com", firstName: "X", lastName: "", listId });
    await addContact(user.id, { email: "y@example.com", firstName: "Y", lastName: "", listId });
    for (let i = 0; i < 2; i += 1) {
      await runAutomationCycle();
      await runBatch(10);
    }
    const automation = (await getAutomation(user.id, id))!;
    const sql = await readySql();
    const firstToken = (await sql
      .prepare("SELECT token FROM recipients WHERE campaign_id = ? AND email = ? ORDER BY created_at LIMIT 1")
      .get(automation.campaignId, "x@example.com")) as { token: string };
    await recordOpen(firstToken.token);
    const report = await buildReport(automation.campaignId);
    assert.equal(report.totals.sent, 4, "two people, two emails each");
    assert.equal(report.totals.uniqueOpens, 1);
    assert.equal(report.rates.open, 0.25);
    assert.equal(report.days.length, 1);
    assert.equal(await ownsCampaign(user.id, automation.campaignId), true);
    // The other campaigns report is untouched by automation traffic.
    const campaignId = await saveCampaign(user.id, { name: "Solo", subject: "Hi", html: "<p>Hi</p>", listId, fromName: "", fromEmail: "owner@postroom.test", replyTo: "" });
    assert.equal((await buildReport(campaignId)).totals.recipients, 0);
  });
});
