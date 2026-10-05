import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import fs from "fs";
import net from "net";
import test from "node:test";
import os from "os";
import path from "path";
import { classifyDeliveryError } from "./bounces";
import {
  addContact,
  createList,
  createUser,
  deleteAccount,
  queueCampaign,
  saveCampaign,
  updateSettings,
} from "./queries";
import { backoffMs, getRecipientAttempts, MAX_SEND_ATTEMPTS, retryBaseMs, scheduleTransientRetry } from "./retries";
import { closeSql, readySql } from "./sql";
import { runBatch } from "./worker-cycle";

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
  smtpHost: "127.0.0.1",
  smtpPort: 0,
  smtpSecure: false,
  smtpUser: "",
  smtpPass: "",
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

type Flaky = { port: number; close: () => Promise<void> };

function startFlakySmtp(opts: { failTimes: number; refuse?: string }): Promise<Flaky> {
  let fails = 0;
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      let buf = "";
      let dataMode = false;
      socket.write("220 flaky ready\r\n");
      socket.on("data", (chunk) => {
        buf += chunk.toString("binary");
        for (;;) {
          if (dataMode) {
            const end = buf.indexOf("\r\n.\r\n");
            if (end < 0) return;
            buf = buf.slice(end + 5);
            dataMode = false;
            if (fails < opts.failTimes) {
              fails += 1;
              socket.write("451 Temporary failure, try later\r\n");
            } else {
              socket.write("250 OK\r\n");
            }
            continue;
          }
          const nl = buf.indexOf("\r\n");
          if (nl < 0) return;
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          const u = line.toUpperCase();
          if (u.startsWith("EHLO") || u.startsWith("HELO")) socket.write("250-flaky\r\n250 OK\r\n");
          else if (u.startsWith("MAIL ")) socket.write("250 OK\r\n");
          else if (u.startsWith("RCPT ")) {
            if (opts.refuse && line.toLowerCase().includes(opts.refuse.toLowerCase())) {
              socket.write("550 5.1.1 User unknown\r\n");
            } else socket.write("250 OK\r\n");
          } else if (u === "DATA") {
            dataMode = true;
            socket.write("354 Go ahead\r\n");
          } else if (u === "QUIT") {
            socket.write("221 bye\r\n");
            socket.end();
          } else socket.write("250 OK\r\n");
        }
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") return reject(new Error("no port"));
      resolve({
        port: addr.port,
        close: () => new Promise((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
  });
}

test("backoff doubles up to a 30 minute cap", () => {
  process.env.POSTROOM_RETRY_BASE_MS = "1000";
  assert.equal(retryBaseMs(), 1000);
  assert.equal(backoffMs(1), 1000);
  assert.equal(backoffMs(2), 2000);
  assert.equal(backoffMs(3), 4000);
  assert.equal(backoffMs(20), 30 * 60_000);
  process.env.POSTROOM_RETRY_BASE_MS = "0";
});

test("classifyDeliveryError labels 4xx and connection errors as transient", () => {
  assert.equal(classifyDeliveryError(Object.assign(new Error("451"), { responseCode: 451, response: "451 try later" })).kind, "transient");
  assert.equal(classifyDeliveryError(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })).kind, "transient");
  assert.equal(classifyDeliveryError(Object.assign(new Error("535 auth"), { responseCode: 535, response: "535 Authentication failed" })).kind, "permanent");
});

test("scheduleTransientRetry backs off then gives up at the attempt cap", async () => {
  await withDatabase(async (ownerEmail) => {
    const user = await createUser({ name: "Ada", email: ownerEmail, password: "password123" });
    await updateSettings(user.id, { ...SETTINGS, smtpHost: "" });
    const listId = await createList(user.id, "L");
    await addContact(user.id, { email: "a@example.com", firstName: "", lastName: "", listId });
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
    const sql = await readySql();
    const recipient = (await sql.prepare("SELECT id FROM recipients WHERE campaign_id = ?").get(campaignId)) as { id: string };
    await sql.prepare("UPDATE recipients SET status = 'sending', claimed_at = ? WHERE id = ?").run(new Date().toISOString(), recipient.id);

    for (let i = 1; i < MAX_SEND_ATTEMPTS; i += 1) {
      const result = await scheduleTransientRetry(recipient.id, `temp ${i}`);
      assert.equal(result.scheduled, true);
      assert.equal(result.attemptCount, i);
      const row = (await sql.prepare("SELECT status FROM recipients WHERE id = ?").get(recipient.id)) as { status: string };
      assert.equal(row.status, "pending");
      await sql.prepare("UPDATE recipients SET status = 'sending', claimed_at = ? WHERE id = ?").run(new Date().toISOString(), recipient.id);
    }
    const last = await scheduleTransientRetry(recipient.id, "final");
    assert.equal(last.scheduled, false);
    assert.equal(last.attemptCount, MAX_SEND_ATTEMPTS);
    assert.equal((await getRecipientAttempts(recipient.id))?.attemptCount, MAX_SEND_ATTEMPTS);
  });
});

test("a flaky SMTP server is retried until it accepts the message", async () => {
  await withDatabase(async (ownerEmail) => {
    const smtp = await startFlakySmtp({ failTimes: 2 });
    try {
      const user = await createUser({ name: "Ada", email: ownerEmail, password: "password123" });
      await updateSettings(user.id, { ...SETTINGS, smtpPort: smtp.port });
      const listId = await createList(user.id, "L");
      await addContact(user.id, { email: "ok@example.com", firstName: "", lastName: "", listId });
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
      assert.equal(await runBatch(5), 1);
      const sql = await readySql();
      let row = (await sql.prepare("SELECT status, error FROM recipients WHERE campaign_id = ?").get(campaignId)) as {
        status: string;
        error: string;
      };
      assert.equal(row.status, "pending");
      assert.match(row.error, /Retry 1/);
      assert.equal(await runBatch(5), 1);
      row = (await sql.prepare("SELECT status FROM recipients WHERE campaign_id = ?").get(campaignId)) as { status: string; error: string };
      assert.equal(row.status, "pending");
      assert.equal(await runBatch(5), 1);
      row = (await sql.prepare("SELECT status FROM recipients WHERE campaign_id = ?").get(campaignId)) as { status: string; error: string };
      assert.equal(row.status, "sent");
      const id = ((await sql.prepare("SELECT id FROM recipients WHERE campaign_id = ?").get(campaignId)) as { id: string }).id;
      assert.equal(await getRecipientAttempts(id), null);
    } finally {
      await smtp.close();
    }
  });
});

test("a permanent hard bounce is not retried", async () => {
  await withDatabase(async (ownerEmail) => {
    const smtp = await startFlakySmtp({ failTimes: 0, refuse: "gone@" });
    try {
      const user = await createUser({ name: "Ada", email: ownerEmail, password: "password123" });
      await updateSettings(user.id, { ...SETTINGS, smtpPort: smtp.port });
      const listId = await createList(user.id, "L");
      await addContact(user.id, { email: "gone@example.com", firstName: "", lastName: "", listId });
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
      const row = (await sql.prepare("SELECT status FROM recipients WHERE campaign_id = ?").get(campaignId)) as { status: string };
      assert.equal(row.status, "bounced");
      assert.equal(Number(((await sql.prepare("SELECT COUNT(*) AS n FROM recipient_attempts").get()) as { n: number }).n), 0);
    } finally {
      await smtp.close();
    }
  });
});
