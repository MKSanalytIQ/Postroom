import { newId, newToken } from "./crypto";
import { sendSystemMail } from "./system-mail";
import { readySql, type Sql } from "./sql";
import { addDaysIso, nowIso } from "./time";
import type { Contact } from "./types";
import { UserError } from "./user-error";
import { isEmail, normalizeEmail } from "./validators";
import { createRateLimiter } from "./rate-limit";
import { createHash, timingSafeEqual } from "crypto";

export type ConsentSource = "manual" | "import" | "form" | "api";

export const CONSENT_SOURCES: ConsentSource[] = ["manual", "import", "form", "api"];

export function isConsentSource(value: string): value is ConsentSource {
  return (CONSENT_SOURCES as string[]).includes(value);
}

export type ConsentRecord = {
  source: ConsentSource;
  consentedAt: string;
  confirmedAt: string | null;
  ip: string;
  userAgent: string;
  note: string;
};

export type ListPublicSettings = {
  listId: string;
  listName: string;
  userId: string;
  publicToken: string;
  doubleOptIn: boolean;
  companyName: string;
};

const subscribeLimiter = createRateLimiter(20, 15 * 60_000);

function hashConfirmToken(token: string): string {
  return createHash("sha256").update(`postroom-subscribe-confirm-v1:${token}`, "utf8").digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function escape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

async function ensureListSettings(tx: Sql, listId: string): Promise<{ public_token: string; double_opt_in: number }> {
  const existing = (await tx
    .prepare("SELECT public_token, double_opt_in FROM list_settings WHERE list_id = ?")
    .get(listId)) as { public_token: string; double_opt_in: number } | null;
  if (existing) return existing;
  const token = newToken();
  await tx
    .prepare("INSERT INTO list_settings (list_id, public_token, double_opt_in, updated_at) VALUES (?, ?, 0, ?)")
    .run(listId, token, nowIso());
  return { public_token: token, double_opt_in: 0 };
}

export async function getListPublicSettings(userId: string, listId: string): Promise<ListPublicSettings | null> {
  const sql = await readySql();
  const list = (await sql
    .prepare(
      `SELECT l.id, l.name, l.user_id, u.company_name
       FROM lists l JOIN users u ON u.id = l.user_id
       WHERE l.id = ? AND l.user_id = ?`,
    )
    .get(listId, userId)) as { id: string; name: string; user_id: string; company_name: string } | null;
  if (!list) return null;
  const settings = await sql.transaction(async (tx) => ensureListSettings(tx, listId));
  return {
    listId: list.id,
    listName: list.name,
    userId: list.user_id,
    publicToken: settings.public_token,
    doubleOptIn: Number(settings.double_opt_in) === 1,
    companyName: list.company_name || "",
  };
}

export async function setListDoubleOptIn(userId: string, listId: string, enabled: boolean): Promise<void> {
  const sql = await readySql();
  const owned = (await sql.prepare("SELECT id FROM lists WHERE id = ? AND user_id = ?").get(listId, userId)) as { id: string } | null;
  if (!owned) throw new UserError("List not found.");
  await sql.transaction(async (tx) => {
    const settings = await ensureListSettings(tx, listId);
    await tx
      .prepare("UPDATE list_settings SET double_opt_in = ?, updated_at = ? WHERE list_id = ?")
      .run(enabled ? 1 : 0, nowIso(), listId);
    void settings;
  });
}

export async function rotateListPublicToken(userId: string, listId: string): Promise<string> {
  const sql = await readySql();
  const owned = (await sql.prepare("SELECT id FROM lists WHERE id = ? AND user_id = ?").get(listId, userId)) as { id: string } | null;
  if (!owned) throw new UserError("List not found.");
  const token = newToken();
  await sql.transaction(async (tx) => {
    await ensureListSettings(tx, listId);
    await tx.prepare("UPDATE list_settings SET public_token = ?, updated_at = ? WHERE list_id = ?").run(token, nowIso(), listId);
  });
  return token;
}

export async function getListByPublicToken(token: string): Promise<ListPublicSettings | null> {
  if (!token) return null;
  const sql = await readySql();
  const row = (await sql
    .prepare(
      `SELECT l.id, l.name, l.user_id, u.company_name, s.public_token, s.double_opt_in
       FROM list_settings s
       JOIN lists l ON l.id = s.list_id
       JOIN users u ON u.id = l.user_id
       WHERE s.public_token = ?`,
    )
    .get(token)) as
    | { id: string; name: string; user_id: string; company_name: string; public_token: string; double_opt_in: number }
    | null;
  if (!row) return null;
  return {
    listId: row.id,
    listName: row.name,
    userId: row.user_id,
    publicToken: row.public_token,
    doubleOptIn: Number(row.double_opt_in) === 1,
    companyName: row.company_name || "",
  };
}

export async function recordConsent(
  contactId: string,
  input: {
    source: ConsentSource;
    consentedAt?: string;
    confirmedAt?: string | null;
    ip?: string;
    userAgent?: string;
    note?: string;
  },
): Promise<void> {
  const sql = await readySql();
  const now = input.consentedAt || nowIso();
  await sql
    .prepare(
      `INSERT INTO contact_consent (contact_id, source, consented_at, confirmed_at, ip, user_agent, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (contact_id) DO UPDATE SET
         source = excluded.source,
         consented_at = excluded.consented_at,
         confirmed_at = COALESCE(excluded.confirmed_at, contact_consent.confirmed_at),
         ip = CASE WHEN excluded.ip != '' THEN excluded.ip ELSE contact_consent.ip END,
         user_agent = CASE WHEN excluded.user_agent != '' THEN excluded.user_agent ELSE contact_consent.user_agent END,
         note = CASE WHEN excluded.note != '' THEN excluded.note ELSE contact_consent.note END`,
    )
    .run(
      contactId,
      input.source,
      now,
      input.confirmedAt === undefined ? (input.source === "form" ? null : now) : input.confirmedAt,
      (input.ip || "").slice(0, 80),
      (input.userAgent || "").slice(0, 300),
      (input.note || "").slice(0, 300),
    );
}

export async function getConsent(contactId: string): Promise<ConsentRecord | null> {
  const sql = await readySql();
  const row = (await sql
    .prepare("SELECT source, consented_at, confirmed_at, ip, user_agent, note FROM contact_consent WHERE contact_id = ?")
    .get(contactId)) as
    | { source: string; consented_at: string; confirmed_at: string | null; ip: string; user_agent: string; note: string }
    | null;
  if (!row || !isConsentSource(row.source)) return null;
  return {
    source: row.source,
    consentedAt: row.consented_at,
    confirmedAt: row.confirmed_at,
    ip: row.ip,
    userAgent: row.user_agent,
    note: row.note,
  };
}

export async function consentByContactIds(ids: string[]): Promise<Map<string, ConsentRecord>> {
  const map = new Map<string, ConsentRecord>();
  if (ids.length === 0) return map;
  const sql = await readySql();
  const placeholders = ids.map(() => "?").join(", ");
  const rows = (await sql
    .prepare(
      `SELECT contact_id, source, consented_at, confirmed_at, ip, user_agent, note
       FROM contact_consent WHERE contact_id IN (${placeholders})`,
    )
    .all(...ids)) as {
    contact_id: string;
    source: string;
    consented_at: string;
    confirmed_at: string | null;
    ip: string;
    user_agent: string;
    note: string;
  }[];
  for (const row of rows) {
    if (!isConsentSource(row.source)) continue;
    map.set(row.contact_id, {
      source: row.source,
      consentedAt: row.consented_at,
      confirmedAt: row.confirmed_at,
      ip: row.ip,
      userAgent: row.user_agent,
      note: row.note,
    });
  }
  return map;
}

/**
 * Public subscribe. When double opt-in is on, the contact stays `pending` until they confirm.
 * Suppressed addresses are refused. Unsubscribed contacts can re-subscribe (status flips after confirm or immediately).
 */
export async function publicSubscribe(input: {
  publicToken: string;
  email: string;
  firstName?: string;
  lastName?: string;
  ip?: string;
  userAgent?: string;
  origin: string;
}): Promise<{ status: "subscribed" | "pending" | "exists" }> {
  if (!subscribeLimiter.take(input.ip || "unknown").allowed) {
    throw new UserError("Too many subscribe attempts. Try again later.");
  }
  const list = await getListByPublicToken(input.publicToken);
  if (!list) throw new UserError("This subscribe form is not valid.");
  const email = normalizeEmail(input.email);
  if (!isEmail(email)) throw new UserError("Enter a valid email.");

  const sql = await readySql();
  if (await sql.prepare("SELECT 1 AS found FROM suppressed_addresses WHERE user_id = ? AND email = ?").get(list.userId, email)) {
    throw new UserError("That address cannot be subscribed.");
  }

  const now = nowIso();
  const firstName = (input.firstName || "").trim().slice(0, 80);
  const lastName = (input.lastName || "").trim().slice(0, 80);

  return sql.transaction(async (tx) => {
    const existing = (await tx
      .prepare("SELECT id, status FROM contacts WHERE user_id = ? AND email = ?")
      .get(list.userId, email)) as { id: string; status: string } | null;

    let contactId: string;
    if (!existing) {
      contactId = newId();
      const status = list.doubleOptIn ? "pending" : "subscribed";
      await tx
        .prepare(
          `INSERT INTO contacts (id, user_id, email, first_name, last_name, status, unsub_token, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(contactId, list.userId, email, firstName, lastName, status, newToken(), now);
    } else {
      contactId = existing.id;
      if (existing.status === "subscribed" && !list.doubleOptIn) {
        await tx.prepare("INSERT INTO list_contacts (list_id, contact_id, created_at) VALUES (?, ?, ?) ON CONFLICT (list_id, contact_id) DO NOTHING").run(
          list.listId,
          contactId,
          now,
        );
        return { status: "exists" as const };
      }
      if (!list.doubleOptIn) {
        await tx.prepare("UPDATE contacts SET status = 'subscribed', first_name = CASE WHEN ? != '' THEN ? ELSE first_name END, last_name = CASE WHEN ? != '' THEN ? ELSE last_name END WHERE id = ?").run(
          firstName,
          firstName,
          lastName,
          lastName,
          contactId,
        );
      } else if (existing.status !== "subscribed") {
        await tx.prepare("UPDATE contacts SET status = 'pending' WHERE id = ?").run(contactId);
      }
    }

    await tx
      .prepare("INSERT INTO list_contacts (list_id, contact_id, created_at) VALUES (?, ?, ?) ON CONFLICT (list_id, contact_id) DO NOTHING")
      .run(list.listId, contactId, now);

    await tx
      .prepare(
        `INSERT INTO contact_consent (contact_id, source, consented_at, confirmed_at, ip, user_agent, note)
         VALUES (?, 'form', ?, ?, ?, ?, ?)
         ON CONFLICT (contact_id) DO UPDATE SET
           source = 'form',
           consented_at = excluded.consented_at,
           confirmed_at = excluded.confirmed_at,
           ip = excluded.ip,
           user_agent = excluded.user_agent,
           note = excluded.note`,
      )
      .run(
        contactId,
        now,
        list.doubleOptIn ? null : now,
        (input.ip || "").slice(0, 80),
        (input.userAgent || "").slice(0, 300),
        `Public form: ${list.listName}`.slice(0, 300),
      );

    if (!list.doubleOptIn) return { status: existing ? ("exists" as const) : ("subscribed" as const) };

    const confirmToken = newToken();
    await tx.prepare("DELETE FROM subscribe_confirmations WHERE contact_id = ? AND list_id = ? AND confirmed_at IS NULL").run(contactId, list.listId);
    await tx
      .prepare(
        `INSERT INTO subscribe_confirmations (token_hash, contact_id, list_id, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(hashConfirmToken(confirmToken), contactId, list.listId, addDaysIso(2), now);

    const link = `${input.origin.replace(/\/$/, "")}/s/confirm/${confirmToken}`;
    await sendSystemMail({
      to: email,
      subject: `Confirm subscription to ${list.listName}`,
      text: `Please confirm you want emails from ${list.companyName || "us"} (${list.listName}):\n\n${link}\n\nThis link expires in 2 days.\n`,
      html: `<p>Please confirm you want emails from ${escape(list.companyName || "us")} (${escape(list.listName)}).</p><p><a href="${escape(link)}">Confirm subscription</a></p><p>This link expires in 2 days.</p>`,
    });
    return { status: "pending" as const };
  });
}

export async function confirmSubscribe(token: string): Promise<{ email: string; listName: string } | null> {
  if (!token || token.length > 200) return null;
  const tokenHash = hashConfirmToken(token);
  const sql = await readySql();
  const row = (await sql
    .prepare(
      `SELECT sc.token_hash, sc.contact_id, sc.list_id, sc.expires_at, sc.confirmed_at, c.email, l.name AS list_name
       FROM subscribe_confirmations sc
       JOIN contacts c ON c.id = sc.contact_id
       JOIN lists l ON l.id = sc.list_id
       WHERE sc.token_hash = ?`,
    )
    .get(tokenHash)) as
    | {
        token_hash: string;
        contact_id: string;
        list_id: string;
        expires_at: string;
        confirmed_at: string | null;
        email: string;
        list_name: string;
      }
    | null;
  if (!row || !safeEqual(row.token_hash, tokenHash)) return null;
  if (row.confirmed_at) return { email: row.email, listName: row.list_name };
  if (row.expires_at < nowIso()) return null;

  const now = nowIso();
  await sql.transaction(async (tx) => {
    const used = await tx
      .prepare("UPDATE subscribe_confirmations SET confirmed_at = ? WHERE token_hash = ? AND confirmed_at IS NULL AND expires_at >= ?")
      .run(now, tokenHash, now);
    if (used === 0) return;
    await tx.prepare("UPDATE contacts SET status = 'subscribed' WHERE id = ?").run(row.contact_id);
    await tx
      .prepare("UPDATE contact_consent SET confirmed_at = ? WHERE contact_id = ?")
      .run(now, row.contact_id);
    await tx
      .prepare("INSERT INTO list_contacts (list_id, contact_id, created_at) VALUES (?, ?, ?) ON CONFLICT (list_id, contact_id) DO NOTHING")
      .run(row.list_id, row.contact_id, now);
  });
  return { email: row.email, listName: row.list_name };
}

export type ContactWithConsent = Contact & { consent: ConsentRecord | null };
