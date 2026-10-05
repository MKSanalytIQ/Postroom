import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import fs from "fs";
import net from "net";
import test from "node:test";
import os from "os";
import path from "path";
import {
  activateAutomation,
  addEmailStep,
  createAutomation,
  enrollmentCounts,
  enrollNewMembers,
  runAutomationCycle,
} from "./automations";
import {
  addManualSuppressions,
  addSuppression,
  clearWebhookToken,
  getDeliverabilitySettings,
  handleWebhook,
  listSuppressions,
  removeSuppression,
  rotateWebhookToken,
  saveDkimSelector,
  suppressionCounts,
  suppressionReason,
  suppressionsCsv,
} from "./deliverability";
import {
  addContact,
  campaignStats,
  createList,
  createUser,
  deleteAccount,
  importContacts,
  listTemplates,
  queueCampaign,
  saveCampaign,
  subscribedCount,
  updateSettings,
} from "./queries";
import { closeSql, readySql } from "./sql";
import { makeSnsKit } from "./sns-test-helpers";
import { runBatch } from "./worker-cycle";

// SQLite by default; set DATABASE_URL to run the same tests against Postgres.

process.env.APP_SECRET = "test-secret-test-secret-test-secret";
process.env.SEND_DELAY_MS = "0";
process.env.POSTROOM_RETRY_BASE_MS = "0";

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

async function count(query: string, ...params: unknown[]): Promise<number> {
  const sql = await readySql();
  return Number(((await sql.prepare(query).get(...params)) as { n: number | string }).n);
}

async function recipientRow(email: string): Promise<{ status: string; error: string }> {
  const sql = await readySql();
  const row = (await sql.prepare("SELECT status, error FROM recipients WHERE email = ? ORDER BY created_at DESC").get(email)) as {
    status: string;
    error: string;
  } | null;
  assert.ok(row, `recipient ${email}`);
  return { status: row.status, error: row.error };
}

async function campaignFor(userId: string, listId: string, name = "Hello"): Promise<string> {
  return saveCampaign(userId, { name, subject: "Hi {{first_name}}", html: "<p>Hello</p>", listId, fromName: "Ada", fromEmail: "owner@postroom.test", replyTo: "" });
}

/** A tiny SMTP server that refuses chosen recipients the way a real mail server does. */
async function fakeSmtp(refusals: Record<string, string>): Promise<{ port: number; accepted: string[]; close: () => Promise<void> }> {
  const accepted: string[] = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    let inData = false;
    let rcpt = "";
    socket.write("220 fake ESMTP\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end === -1) return;
          buffer = buffer.slice(end + 5);
          inData = false;
          accepted.push(rcpt);
          socket.write("250 2.0.0 queued\r\n");
          continue;
        }
        const eol = buffer.indexOf("\r\n");
        if (eol === -1) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === "EHLO" || verb === "HELO") socket.write("250 fake\r\n");
        else if (verb === "MAIL") socket.write("250 2.1.0 ok\r\n");
        else if (verb === "RCPT") {
          rcpt = (/<([^>]+)>/.exec(line)?.[1] ?? "").toLowerCase();
          socket.write(refusals[rcpt] ? `${refusals[rcpt]}\r\n` : "250 2.1.5 ok\r\n");
        } else if (verb === "DATA") {
          inData = true;
          socket.write("354 go ahead\r\n");
        } else if (verb === "QUIT") {
          socket.write("221 bye\r\n");
          socket.end();
        } else socket.write("250 ok\r\n");
      }
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return { port, accepted, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("the suppression list: add, normalize, search, export, remove", async () => {
  await withDatabase(async (ownerEmail) => {
    const user = await createUser({ name: "Ada", email: ownerEmail, password: "password123" });
    const other = await createUser({ name: "Other", email: `other-${randomUUID().slice(0, 6)}@postroom.test`, password: "password123" });
    try {
      assert.equal(await addSuppression(user.id, " Bounced@Example.COM ", "hard_bounce", { detail: "550 user unknown", source: "smtp" }), true);
      assert.equal(await addSuppression(user.id, "bounced@example.com", "complaint"), false, "already listed: the first reason stays");
      assert.equal(await suppressionReason(user.id, "BOUNCED@example.com"), "hard_bounce");
      assert.equal(await suppressionReason(other.id, "bounced@example.com"), null, "lists are per account");
      await assert.rejects(addSuppression(user.id, "nope", "manual"), /not a valid email/);

      const manual = await addManualSuppressions(user.id, "a@example.com, B@example.com\nbounced@example.com; junk; a@example.com", "legal request");
      assert.deepEqual(manual, { added: 2, existing: 1, invalid: 1 });
      await assert.rejects(addManualSuppressions(user.id, "  ", ""), /at least one/);
      assert.deepEqual(await suppressionCounts(user.id), { hard_bounce: 1, soft_bounce: 0, complaint: 0, manual: 2 });

      const all = await listSuppressions(user.id, 1, "");
      assert.equal(all.total, 3);
      assert.equal((await listSuppressions(user.id, 1, "BOUNCED")).total, 1);
      assert.equal((await listSuppressions(user.id, 1, "zzz")).total, 0);
      assert.equal((await listSuppressions(other.id, 1, "")).total, 0);

      const csv = await suppressionsCsv(user.id);
      const lines = csv.split("\n");
      assert.equal(lines[0], "email,reason,source,detail,added");
      assert.equal(lines.length, 4);
      assert.ok(lines.some((line) => line.startsWith("a@example.com,manual,manual,legal request,")));

      const entry = all.rows.find((row) => row.email === "a@example.com")!;
      await assert.rejects(removeSuppression(other.id, entry.id), /not on the list/);
      await removeSuppression(user.id, entry.id);
      assert.equal(await suppressionReason(user.id, "a@example.com"), null);
      assert.equal((await listSuppressions(user.id, 1, "")).total, 2);
    } finally {
      await deleteAccount(other.id);
    }
  });
});

test("suppressed addresses are skipped by imports, manual adds, and campaigns", async () => {
  await withDatabase(async (ownerEmail) => {
    const user = await createUser({ name: "Ada", email: ownerEmail, password: "password123" });
    await updateSettings(user.id, SETTINGS);
    const listId = await createList(user.id, "Readers");
    await addContact(user.id, { email: "ok@example.com", firstName: "Ok", lastName: "", listId });
    await addContact(user.id, { email: "late@example.com", firstName: "Late", lastName: "", listId });
    await addSuppression(user.id, "blocked@example.com", "hard_bounce");

    await assert.rejects(addContact(user.id, { email: "Blocked@example.com", firstName: "", lastName: "", listId }), /suppression list/);
    const imported = await importContacts(user.id, listId, "email,first name\nblocked@example.com,Blocked\nnew@example.com,New\n", { consentAttested: true });
    assert.equal(imported.suppressed, 1);
    assert.equal(imported.created, 1);
    assert.equal(imported.addedToList, 1);
    assert.equal(await count("SELECT COUNT(*) AS n FROM contacts WHERE user_id = ? AND email = ?", user.id, "blocked@example.com"), 0);

    assert.equal(await subscribedCount(user.id, listId), 3);
    const campaignId = await campaignFor(user.id, listId);
    // Suppressed between review and send: excluded from the queue entirely.
    await addSuppression(user.id, "late@example.com", "manual");
    assert.equal(await subscribedCount(user.id, listId), 2);
    assert.equal((await queueCampaign(user.id, campaignId, "http://localhost:3010")).queued, 2);

    // Suppressed after queuing: held back at send time, and the pending message is skipped at once.
    await addSuppression(user.id, "new@example.com", "complaint", { detail: "abuse" });
    assert.deepEqual(await recipientRow("new@example.com"), { status: "skipped", error: "Suppressed" });
    assert.equal(await runBatch(10), 1);
    const stats = await campaignStats(campaignId);
    assert.equal(stats.sent, 1);
    assert.equal(stats.skipped, 1);
    assert.equal(await count("SELECT COUNT(*) AS n FROM deliveries WHERE to_email IN (?, ?, ?)", "late@example.com", "new@example.com", "blocked@example.com"), 0);
    // A complaint also unsubscribes the contact.
    assert.equal(await count("SELECT COUNT(*) AS n FROM contacts WHERE user_id = ? AND email = ? AND status = 'unsubscribed'", user.id, "new@example.com"), 1);
  });
});

test("a message queued before the address was suppressed is skipped by the sender itself", async () => {
  await withDatabase(async (ownerEmail) => {
    const user = await createUser({ name: "Ada", email: ownerEmail, password: "password123" });
    await updateSettings(user.id, SETTINGS);
    const listId = await createList(user.id, "Readers");
    await addContact(user.id, { email: "x@example.com", firstName: "X", lastName: "", listId });
    const campaignId = await campaignFor(user.id, listId);
    await queueCampaign(user.id, campaignId, "http://localhost:3010");
    // Insert the suppression behind the application's back, as another process might.
    const sql = await readySql();
    await sql
      .prepare("INSERT INTO suppressed_addresses (id, user_id, email, reason, source, detail, created_at) VALUES (?, ?, ?, 'hard_bounce', 'webhook', '', ?)")
      .run(randomUUID(), user.id, "x@example.com", new Date().toISOString());
    await runBatch(10);
    assert.deepEqual(await recipientRow("x@example.com"), { status: "skipped", error: "Suppressed (hard bounce)" });
  });
});

test("automations never enroll or send to suppressed addresses", async () => {
  await withDatabase(async (ownerEmail) => {
    const user = await createUser({ name: "Ada", email: ownerEmail, password: "password123" });
    await updateSettings(user.id, SETTINGS);
    const [template] = await listTemplates(user.id);
    const listId = await createList(user.id, "Welcome");
    const id = await createAutomation(user.id, { name: "Welcome", listId });
    await addEmailStep(user.id, id, template.id);
    await addEmailStep(user.id, id, template.id);
    await activateAutomation(user.id, id, "http://localhost:3010");
    await addContact(user.id, { email: "fine@example.com", firstName: "Fine", lastName: "", listId });
    await addContact(user.id, { email: "later@example.com", firstName: "Later", lastName: "", listId });
    await addContact(user.id, { email: "never@example.com", firstName: "Never", lastName: "", listId });
    await sleepMs(5);
    // "never" was suppressed before the worker enrolled anyone.
    await addSuppression(user.id, "never@example.com", "manual");
    assert.equal(await enrollNewMembers(), 2);
    await runAutomationCycle(); // email 1 queued for fine and later
    assert.equal(await count("SELECT COUNT(*) AS n FROM recipients WHERE status = 'pending'"), 2);

    // "later" is suppressed mid-series: enrollment stops and the queued message is skipped.
    await addSuppression(user.id, "later@example.com", "hard_bounce");
    const counts = await enrollmentCounts(id);
    assert.equal(counts.stopped, 1);
    await runBatch(10);
    assert.equal(await count("SELECT COUNT(*) AS n FROM deliveries WHERE to_email = ?", "later@example.com"), 0);
    assert.equal(await count("SELECT COUNT(*) AS n FROM deliveries WHERE to_email = ?", "fine@example.com"), 1);
    await runAutomationCycle(); // fine's email 2
    await runBatch(10);
    assert.equal(await count("SELECT COUNT(*) AS n FROM deliveries WHERE to_email = ?", "fine@example.com"), 2);
    assert.equal(await count("SELECT COUNT(*) AS n FROM automation_enrollments WHERE stop_reason = 'suppressed'"), 1);
  });
});

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("a permanent SMTP refusal marks the recipient bounced and suppresses the address", async () => {
  await withDatabase(async (ownerEmail) => {
    const smtp = await fakeSmtp({
      "gone@example.com": "550 5.1.1 <gone@example.com>: Recipient address rejected: User unknown",
      "spammy@example.com": "550 5.7.1 Message blocked as spam by policy",
      "busy@example.com": "450 4.2.0 Mailbox busy, try later",
    });
    try {
      const user = await createUser({ name: "Ada", email: ownerEmail, password: "password123" });
      await updateSettings(user.id, { ...SETTINGS, smtpHost: "127.0.0.1", smtpPort: smtp.port });
      const listId = await createList(user.id, "Readers");
      for (const email of ["good@example.com", "gone@example.com", "spammy@example.com", "busy@example.com"]) {
        await addContact(user.id, { email, firstName: "", lastName: "", listId });
      }
      const campaignId = await campaignFor(user.id, listId);
      assert.equal((await queueCampaign(user.id, campaignId, "http://localhost:3010")).queued, 4);
      assert.equal(await runBatch(10), 4);

      assert.equal((await recipientRow("good@example.com")).status, "sent");
      const gone = await recipientRow("gone@example.com");
      assert.equal(gone.status, "bounced");
      assert.match(gone.error, /User unknown/);
      assert.equal((await recipientRow("spammy@example.com")).status, "failed", "a policy refusal is not the address's fault");
      const busy = await recipientRow("busy@example.com");
      assert.equal(busy.status, "pending", "a temporary error is retried, not marked failed");
      assert.match(busy.error, /Retry 1/);
      assert.deepEqual(smtp.accepted, ["good@example.com"]);

      assert.equal(await suppressionReason(user.id, "gone@example.com"), "hard_bounce");
      assert.equal(await suppressionReason(user.id, "spammy@example.com"), null);
      assert.equal(await suppressionReason(user.id, "busy@example.com"), null);
      const listed = await listSuppressions(user.id, 1, "");
      assert.equal(listed.rows[0].source, "smtp");
      assert.equal(await count("SELECT COUNT(*) AS n FROM events WHERE campaign_id = ? AND type = 'bounce'", campaignId), 1);
      assert.equal((await campaignStats(campaignId)).failed, 1);
      assert.equal((await campaignStats(campaignId)).waiting, 1, "busy is still waiting to retry");

      // The next campaign leaves the bounced address out.
      const next = await campaignFor(user.id, listId, "Second");
      assert.equal((await queueCampaign(user.id, next, "http://localhost:3010")).queued, 3);
    } finally {
      await smtp.close();
    }
  });
});

test("the webhook needs a valid token and applies SES and generic reports", async () => {
  await withDatabase(async (ownerEmail) => {
    const user = await createUser({ name: "Ada", email: ownerEmail, password: "password123" });
    await updateSettings(user.id, SETTINGS);
    const listId = await createList(user.id, "Readers");
    for (const email of ["hard@example.com", "soft@example.com", "mad@example.com", "ok@example.com", "gen@example.com"]) {
      await addContact(user.id, { email, firstName: "", lastName: "", listId });
    }
    const campaignId = await campaignFor(user.id, listId);
    await queueCampaign(user.id, campaignId, "http://localhost:3010");
    await runBatch(10);

    const kit = makeSnsKit();
    const hook = (token: string, body: string) => handleWebhook(token, body, { sns: kit.options });
    assert.equal((await hook("", "{}")).status, 401);
    assert.equal((await hook("guess", "{}")).status, 401);
    assert.equal((await getDeliverabilitySettings(user.id)).hasWebhookToken, false);
    const token = await rotateWebhookToken(user.id);
    assert.equal((await hook(token, "{not json")).status, 400);
    assert.equal((await hook(token, '"just a string"')).json.ignored, 1);

    const note = (message: unknown) => JSON.stringify(kit.notification(JSON.stringify(message)));
    const bounce = await hook(
      token,
      note({ notificationType: "Bounce", bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "hard@example.com", diagnosticCode: "550 5.1.1 unknown" }] } }),
    );
    assert.equal(bounce.status, 200);
    assert.equal(bounce.json.suppressed, 1);
    assert.equal(await suppressionReason(user.id, "hard@example.com"), "hard_bounce");

    await hook(token, note({ notificationType: "Bounce", bounce: { bounceType: "Transient", bouncedRecipients: [{ emailAddress: "soft@example.com" }] } }));
    assert.equal(await suppressionReason(user.id, "soft@example.com"), null, "a soft bounce is recorded but not suppressed");

    await hook(token, note({ notificationType: "Complaint", complaint: { complaintFeedbackType: "abuse", complainedRecipients: [{ emailAddress: "mad@example.com" }] } }));
    assert.equal(await suppressionReason(user.id, "mad@example.com"), "complaint");
    assert.equal(await count("SELECT COUNT(*) AS n FROM contacts WHERE user_id = ? AND email = ? AND status = 'unsubscribed'", user.id, "mad@example.com"), 1);

    await hook(token, note({ notificationType: "Delivery", delivery: { recipients: ["ok@example.com"] } }));
    const generic = await hook(token, JSON.stringify([{ type: "bounce", email: "gen@example.com", reason: "mailbox gone" }, { type: "bounce", email: "unknown@example.com" }]));
    assert.equal(generic.json.bounces, 2);
    assert.equal(await suppressionReason(user.id, "gen@example.com"), "hard_bounce");
    assert.equal(await suppressionReason(user.id, "unknown@example.com"), "hard_bounce", "even addresses never mailed are suppressed");

    // Events are attached to the campaign that sent the message, once each, however often SNS retries.
    await hook(token, note({ notificationType: "Complaint", complaint: { complainedRecipients: [{ emailAddress: "mad@example.com" }] } }));
    const events = async (type: string) => count("SELECT COUNT(*) AS n FROM events WHERE campaign_id = ? AND type = ?", campaignId, type);
    assert.equal(await events("bounce"), 3);
    assert.equal(await events("complaint"), 1);
    assert.equal(await events("delivery"), 1);
    assert.equal(await count("SELECT COUNT(*) AS n FROM suppressed_addresses WHERE user_id = ?", user.id), 4);

    // SNS subscription handshake hands the link back to the route; a bogus link is ignored.
    const link = "https://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription&Token=t";
    assert.equal((await hook(token, JSON.stringify(kit.subscription(link)))).confirmUrl, link);
    assert.equal((await hook(token, JSON.stringify(kit.subscription("https://evil.example.com/")))).confirmUrl, undefined);

    // A new token replaces the old one; turning the webhook off rejects everything.
    const next = await rotateWebhookToken(user.id);
    assert.notEqual(next, token);
    assert.equal((await hook(token, "{}")).status, 401);
    assert.equal((await hook(next, "{}")).status, 200);
    await clearWebhookToken(user.id);
    assert.equal((await hook(next, "{}")).status, 401);
  });
});

test("deliverability settings keep the DKIM selector and token independently", async () => {
  await withDatabase(async (ownerEmail) => {
    const user = await createUser({ name: "Ada", email: ownerEmail, password: "password123" });
    assert.deepEqual(await getDeliverabilitySettings(user.id), {
      hasWebhookToken: false,
      webhookTokenHint: null,
      webhookTokenCreatedAt: null,
      webhookTokenLastUsedAt: null,
      dkimSelector: "default",
    });
    assert.equal(await saveDkimSelector(user.id, "  "), "default");
    assert.equal(await saveDkimSelector(user.id, "s1"), "s1");
    const token = await rotateWebhookToken(user.id);
    const settings = await getDeliverabilitySettings(user.id);
    assert.equal(settings.hasWebhookToken, true);
    assert.equal(settings.webhookTokenHint, token.slice(-4));
    assert.equal(settings.dkimSelector, "s1");
    await assert.rejects(saveDkimSelector(user.id, "bad selector!"), /selector/);
    await saveDkimSelector(user.id, "k2._x");
    assert.equal((await handleWebhook(token, "{}")).status, 200, "saving the selector keeps the token");
  });
});
