import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import fs from "fs";
import test from "node:test";
import os from "os";
import path from "path";
import {
  confirmSubscribe,
  getConsent,
  getListByPublicToken,
  getListPublicSettings,
  publicSubscribe,
  setListDoubleOptIn,
} from "./consent";
import {
  addContact,
  contactsCsv,
  createList,
  createUser,
  deleteAccount,
  importContacts,
  listContacts,
} from "./queries";
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

test("manual add and attested import record consent; import without attestation is refused", async () => {
  await withDatabase(async (ownerEmail) => {
    const user = await createUser({ name: "Ada", email: ownerEmail, password: "password123" });
    const listId = await createList(user.id, "Readers");
    await assert.rejects(importContacts(user.id, listId, "email\na@example.com\n"), /consented/);
    await addContact(user.id, {
      email: "manual@example.com",
      firstName: "M",
      lastName: "",
      listId,
      consentSource: "manual",
      consentIp: "127.0.0.1",
      consentNote: "Added in Postroom",
    });
    const consent = await getConsent(((await listContacts(user.id, 1, "manual@example.com")).rows[0]).id);
    assert.equal(consent?.source, "manual");
    assert.ok(consent?.confirmedAt);
    assert.equal(consent?.ip, "127.0.0.1");

    await importContacts(user.id, listId, "email,first name\nimp@example.com,Imp\n", {
      consentAttested: true,
      consentIp: "10.0.0.1",
      consentUserAgent: "test",
    });
    const imported = (await listContacts(user.id, 1, "imp@example.com")).rows[0];
    const ic = await getConsent(imported.id);
    assert.equal(ic?.source, "import");
    assert.equal(ic?.ip, "10.0.0.1");

    const csv = await contactsCsv(user.id, listId);
    assert.match(csv || "", /consent_source/);
    assert.match(csv || "", /manual/);
    assert.match(csv || "", /import/);
  });
});

test("public subscribe without double opt-in subscribes immediately", async () => {
  await withDatabase(async (ownerEmail) => {
    const user = await createUser({ name: "Ada", email: ownerEmail, password: "password123" });
    const listId = await createList(user.id, "News");
    const pub = await getListPublicSettings(user.id, listId);
    assert.ok(pub);
    const result = await publicSubscribe({
      publicToken: pub!.publicToken,
      email: "form@example.com",
      firstName: "F",
      origin: "http://localhost:3010",
      ip: "9.9.9.9",
    });
    assert.equal(result.status, "subscribed");
    const contact = (await listContacts(user.id, 1, "form@example.com")).rows[0];
    assert.equal(contact.status, "subscribed");
    const consent = await getConsent(contact.id);
    assert.equal(consent?.source, "form");
    assert.ok(consent?.confirmedAt);
  });
});

test("double opt-in keeps the contact pending until the confirmation link is used", async () => {
  await withDatabase(async (ownerEmail) => {
    const user = await createUser({ name: "Ada", email: ownerEmail, password: "password123" });
    const listId = await createList(user.id, "News");
    await setListDoubleOptIn(user.id, listId, true);
    const pub = (await getListPublicSettings(user.id, listId))!;
    assert.equal(pub.doubleOptIn, true);
    assert.equal((await getListByPublicToken(pub.publicToken))?.listName, "News");

    const result = await publicSubscribe({
      publicToken: pub.publicToken,
      email: "pending@example.com",
      origin: "http://localhost:3010",
      ip: "8.8.8.8",
    });
    assert.equal(result.status, "pending");
    const contact = (await listContacts(user.id, 1, "pending@example.com")).rows[0];
    assert.equal(contact.status, "pending");
    assert.equal((await getConsent(contact.id))?.confirmedAt, null);

    const sql = await readySql();
    // Plant a known confirmation token
    const { createHash } = await import("crypto");
    const token = "confirm-token-value-yyyyyyyyyyyy";
    const tokenHash = createHash("sha256").update(`postroom-subscribe-confirm-v1:${token}`, "utf8").digest("hex");
    await sql.prepare("DELETE FROM subscribe_confirmations WHERE contact_id = ?").run(contact.id);
    await sql
      .prepare(
        "INSERT INTO subscribe_confirmations (token_hash, contact_id, list_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(tokenHash, contact.id, listId, new Date(Date.now() + 86400_000).toISOString(), new Date().toISOString());

    const confirmed = await confirmSubscribe(token);
    assert.equal(confirmed?.email, "pending@example.com");
    assert.equal((await listContacts(user.id, 1, "pending@example.com")).rows[0].status, "subscribed");
    assert.ok((await getConsent(contact.id))?.confirmedAt);
    assert.deepEqual(await confirmSubscribe(token), confirmed, "confirming again is idempotent");
  });
});
