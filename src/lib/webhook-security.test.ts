import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import fs from "fs";
import test from "node:test";
import os from "os";
import path from "path";
import { POST } from "../app/api/webhooks/deliverability/route";
import { hashWebhookToken } from "./crypto";
import {
  clearWebhookToken,
  getDeliverabilitySettings,
  handleWebhook,
  rotateWebhookToken,
  saveDkimSelector,
  suppressionReason,
} from "./deliverability";
import { createUser, deleteAccount } from "./queries";
import { makeSnsKit } from "./sns-test-helpers";
import { closeSql, readySql } from "./sql";

// SQLite by default; set DATABASE_URL to run the same tests against Postgres.

process.env.APP_SECRET = "test-secret-test-secret-test-secret";

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

const bounceFor = (email: string) =>
  JSON.stringify({ notificationType: "Bounce", bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: email }] } });

test("only a hash of the webhook token is stored, and it still authenticates", async () => {
  await withDatabase(async (ownerEmail) => {
    const user = await createUser({ name: "Ada", email: ownerEmail, password: "password123" });
    const token = await rotateWebhookToken(user.id);
    assert.equal(hashWebhookToken(token), hashWebhookToken(token));
    assert.notEqual(hashWebhookToken(token), hashWebhookToken(`${token}x`));
    assert.match(hashWebhookToken(token), /^[0-9a-f]{64}$/);

    const sql = await readySql();
    const stored = (await sql.prepare("SELECT token_hash, hint FROM webhook_tokens WHERE user_id = ?").get(user.id)) as { token_hash: string; hint: string };
    assert.equal(stored.token_hash, hashWebhookToken(token));
    assert.equal(stored.hint, token.slice(-4));
    for (const table of ["webhook_tokens", "deliverability_settings"]) {
      const rows = await sql.prepare(`SELECT * FROM ${table}`).all();
      assert.ok(!JSON.stringify(rows).includes(token), `${table} must not contain the plaintext token`);
    }
    const settings = await getDeliverabilitySettings(user.id);
    assert.equal(settings.hasWebhookToken, true);
    assert.equal(settings.webhookTokenHint, token.slice(-4));
    assert.equal(settings.webhookTokenLastUsedAt, null);
    assert.ok(!JSON.stringify(settings).includes(token));

    assert.equal((await handleWebhook(token, "{}")).status, 200);
    assert.equal((await handleWebhook(`${token}x`, "{}")).status, 401);
    assert.equal((await handleWebhook(token.toUpperCase(), "{}")).status, 401);
    assert.equal((await handleWebhook(stored.token_hash, "{}")).status, 401, "the stored hash is not a credential");
    assert.equal((await handleWebhook("a".repeat(5000), "{}")).status, 401);
    assert.ok((await getDeliverabilitySettings(user.id)).webhookTokenLastUsedAt, "use is recorded");

    // Rotating replaces it, resets last use, and the old one stops working.
    const next = await rotateWebhookToken(user.id);
    assert.equal((await handleWebhook(token, "{}")).status, 401);
    assert.equal((await handleWebhook(next, "{}")).status, 200);
    await saveDkimSelector(user.id, "s1");
    assert.equal((await handleWebhook(next, "{}")).status, 200);
    await clearWebhookToken(user.id);
    assert.equal((await handleWebhook(next, "{}")).status, 401);
    assert.equal((await getDeliverabilitySettings(user.id)).hasWebhookToken, false);
    assert.equal((await getDeliverabilitySettings(user.id)).dkimSelector, "s1");
  });
});

test("a plaintext token from before hashing is hashed on first use and keeps working", async () => {
  await withDatabase(async (ownerEmail) => {
    const user = await createUser({ name: "Ada", email: ownerEmail, password: "password123" });
    const other = await createUser({ name: "Bo", email: `other-${randomUUID().slice(0, 6)}@postroom.test`, password: "password123" });
    const sql = await readySql();
    const legacy = "legacy-plaintext-token-ABCD1234";
    const newer = "legacy-token-that-was-already-replaced";
    const now = new Date().toISOString();
    await sql.prepare("INSERT INTO deliverability_settings (user_id, webhook_token, dkim_selector, updated_at) VALUES (?, ?, 'k1', ?)").run(user.id, legacy, now);
    await sql.prepare("INSERT INTO deliverability_settings (user_id, webhook_token, updated_at) VALUES (?, ?, ?)").run(other.id, newer, now);
    // This account already has a hashed token (a rotation happened between upgrade and the first migration run).
    await sql
      .prepare("INSERT INTO webhook_tokens (user_id, token_hash, hint, created_at) VALUES (?, ?, 'cafe', ?)")
      .run(other.id, hashWebhookToken("the-newer-token"), now);
    await closeSql();

    assert.equal((await handleWebhook(legacy, bounceFor("gone@example.com"))).status, 200, "the old URL keeps working");
    const after = await readySql();
    const rows = (await after.prepare("SELECT user_id, webhook_token FROM deliverability_settings").all()) as { user_id: string; webhook_token: string | null }[];
    assert.ok(rows.every((row) => row.webhook_token === null), "no plaintext is left behind");
    const hashed = (await after.prepare("SELECT token_hash, hint FROM webhook_tokens WHERE user_id = ?").get(user.id)) as { token_hash: string; hint: string };
    assert.equal(hashed.token_hash, hashWebhookToken(legacy));
    assert.equal(hashed.hint, "1234");
    assert.equal((await getDeliverabilitySettings(user.id)).dkimSelector, "k1", "other settings are untouched");
    assert.equal(await suppressionReason(user.id, "gone@example.com"), "hard_bounce");

    const existing = (await after.prepare("SELECT token_hash FROM webhook_tokens WHERE user_id = ?").get(other.id)) as { token_hash: string };
    assert.equal(existing.token_hash, hashWebhookToken("the-newer-token"), "an existing hashed token is never overwritten by the legacy one");
    assert.equal((await handleWebhook(newer, "{}")).status, 401);

    await deleteAccount(other.id);
  });
});

test("SNS messages need a valid signature, and subscriptions confirm only after one", async () => {
  await withDatabase(async (ownerEmail) => {
    const user = await createUser({ name: "Ada", email: ownerEmail, password: "password123" });
    const token = await rotateWebhookToken(user.id);
    const kit = makeSnsKit();
    const hook = (body: unknown) => handleWebhook(token, JSON.stringify(body), { sns: kit.options });
    const link = "https://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription&Token=t";

    // Unsigned, tampered, and wrongly signed messages are refused and change nothing.
    const unsigned = { Type: "Notification", Message: bounceFor("a@example.com"), MessageId: "m", TopicArn: "t", Timestamp: "x" };
    assert.equal((await hook(unsigned)).status, 403);
    const tampered = { ...kit.notification(bounceFor("b@example.com")), Message: bounceFor("victim@example.com") };
    const refused = await hook(tampered);
    assert.equal(refused.status, 403);
    assert.match(String(refused.json.error), /signature/i);
    assert.equal((await hook(kit.sign({ Type: "Notification", MessageId: "m", TopicArn: "t", Timestamp: "x", Message: "{}" }, "2", "https://evil.example/c.pem"))).status, 403);
    const forgedSub = await hook({ Type: "SubscriptionConfirmation", SubscribeURL: link, Token: "t", Message: "m", MessageId: "m", TopicArn: "t", Timestamp: "x" });
    assert.equal(forgedSub.status, 403);
    assert.equal(forgedSub.confirmUrl, undefined, "no confirmation without a valid signature");
    for (const email of ["a@example.com", "b@example.com", "victim@example.com"]) assert.equal(await suppressionReason(user.id, email), null);

    // Valid signatures, both versions, are applied.
    for (const [version, email] of [["1", "v1@example.com"], ["2", "v2@example.com"]] as const) {
      const result = await hook(kit.sign({ Type: "Notification", MessageId: "m", TopicArn: "t", Timestamp: "x", Message: bounceFor(email), Subject: "Amazon SES Email Event Notification" }, version));
      assert.equal(result.status, 200);
      assert.equal(result.json.suppressed, 1);
      assert.equal(await suppressionReason(user.id, email), "hard_bounce");
    }
    assert.ok(kit.fetches.length >= 1);

    // A validly signed subscription hands the confirmation link back; an off-AWS link still does not.
    assert.equal((await hook(kit.subscription(link))).confirmUrl, link);
    assert.equal((await hook(kit.subscription("https://evil.example.com/"))).confirmUrl, undefined);

    // One bad envelope in a batch rejects the whole request.
    const mixed = await hook([kit.notification(bounceFor("ok1@example.com")), unsigned]);
    assert.equal(mixed.status, 403);
    assert.equal(await suppressionReason(user.id, "ok1@example.com"), null);

    // An envelope hidden inside a signed Message is not trusted.
    const nested = await hook(kit.notification(JSON.stringify({ Type: "SubscriptionConfirmation", SubscribeURL: link })));
    assert.equal(nested.status, 200);
    assert.equal(nested.confirmUrl, undefined);
    assert.equal(nested.json.ignored, 1);

    // The generic and raw SES formats are unaffected: they rely on the token alone.
    assert.equal((await hook({ type: "bounce", email: "plain@example.com" })).status, 200);
    assert.equal(await suppressionReason(user.id, "plain@example.com"), "hard_bounce");
    // And a bad token still wins before any signature work happens.
    const before = kit.fetches.length;
    assert.equal((await handleWebhook("wrong", JSON.stringify(kit.notification("{}")), { sns: kit.options })).status, 401);
    assert.equal(kit.fetches.length, before);
  });
});

function request(init: { token?: string; header?: string; body?: BodyInit; ip: string; length?: string }): Request {
  const headers: Record<string, string> = { "x-real-ip": init.ip, "content-type": "application/json" };
  if (init.header) headers.authorization = init.header;
  if (init.length) headers["content-length"] = init.length;
  const url = `http://localhost/api/webhooks/deliverability${init.token ? `?token=${init.token}` : ""}`;
  return new Request(url, { method: "POST", headers, body: init.body ?? "{}", ...(typeof init.body === "object" ? ({ duplex: "half" } as object) : {}) });
}

test("the route prefers the Bearer header, still accepts ?token=, and caps the body", async () => {
  await withDatabase(async (ownerEmail) => {
    const user = await createUser({ name: "Ada", email: ownerEmail, password: "password123" });
    const token = await rotateWebhookToken(user.id);
    const ip = `10.0.0.${Math.floor(Math.random() * 200)}`;
    const body = JSON.stringify({ type: "bounce", email: "hdr@example.com" });

    assert.equal((await POST(request({ header: `Bearer ${token}`, body, ip }))).status, 200);
    assert.equal(await suppressionReason(user.id, "hdr@example.com"), "hard_bounce");
    assert.equal((await POST(request({ token, body: JSON.stringify({ type: "bounce", email: "qs@example.com" }), ip }))).status, 200);
    assert.equal(await suppressionReason(user.id, "qs@example.com"), "hard_bounce");
    // A valid header wins over a wrong query token.
    assert.equal((await POST(request({ header: `Bearer ${token}`, token: "wrong", ip }))).status, 200);

    // Too big, whether announced up front or streamed without a length.
    const big = JSON.stringify({ pad: "x".repeat(600 * 1024) });
    const announced = await POST(request({ header: `Bearer ${token}`, body: big, ip, length: String(big.length) }));
    assert.equal(announced.status, 413);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
        for (let i = 0; i < 10; i += 1) controller.enqueue(chunk);
        controller.close();
      },
    });
    assert.equal((await POST(request({ header: `Bearer ${token}`, body: stream, ip }))).status, 413);
    assert.equal((await POST(request({ header: `Bearer ${token}`, body: "x".repeat(500 * 1024), ip }))).status, 400, "just under the cap is read, then rejected as not JSON");
  });
});

test("repeated bad tokens from one address are shut out with 429 and Retry-After", async () => {
  await withDatabase(async (ownerEmail) => {
    const user = await createUser({ name: "Ada", email: ownerEmail, password: "password123" });
    const token = await rotateWebhookToken(user.id);
    const attacker = "203.0.113.77";
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) statuses.push((await POST(request({ header: "Bearer wrong", ip: attacker }))).status);
    assert.deepEqual(statuses.slice(0, 10), Array(10).fill(401));
    assert.deepEqual(statuses.slice(10), [429, 429]);
    const blocked = await POST(request({ header: `Bearer ${token}`, ip: attacker }));
    assert.equal(blocked.status, 429, "even the right token is refused while shut out");
    assert.ok(Number(blocked.headers.get("retry-after")) >= 1);
    // Someone else is unaffected.
    assert.equal((await POST(request({ header: `Bearer ${token}`, ip: "203.0.113.78" }))).status, 200);
  });
});
