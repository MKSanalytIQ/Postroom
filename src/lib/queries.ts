import bcrypt from "bcryptjs";
import { readContactCsv, toCsv } from "./csv";
import { decryptSecret, encryptSecret, newId, newToken } from "./crypto";
import { readySql, type Sql } from "./sql";
import { STARTER_TEMPLATES } from "./templates";
import { addDaysIso, nowIso } from "./time";
import type {
  Account,
  Campaign,
  CampaignStats,
  ClickStat,
  Contact,
  ContactList,
  Dashboard,
  DeliveryView,
  FailureRow,
  ImportResult,
  Page,
  SendJob,
  SettingsInput,
  Template,
} from "./types";
import { UserError } from "./user-error";
import { isEmail, normalizeEmail, sendBlockers } from "./validators";

// Every query here must run on both SQLite (local) and Postgres (production):
// - use `?` placeholders (sql.ts rewrites them for Postgres) and never a literal `?`
// - COUNT/SUM come back as strings from Postgres (bigint), so wrap them in Number()
// - use ON CONFLICT instead of INSERT OR IGNORE / INSERT OR REPLACE
// - Postgres LIKE is case sensitive; compare LOWER(column) with a lowercased pattern

const PAGE_SIZE = 50;

/** SQL condition: contact `c` is not on the account's suppression list (hard bounce, complaint, or manual). */
const NOT_SUPPRESSED = `NOT EXISTS (SELECT 1 FROM suppressed_addresses sa WHERE sa.user_id = c.user_id AND sa.email = c.email)`;

function listNamesAgg(sql: Sql): string {
  return sql.dialect === "postgres" ? "string_agg(l.name, ', ')" : "GROUP_CONCAT(l.name, ', ')";
}

/** Case-insensitive "contains" pattern, the same on SQLite and Postgres. Use with `LIKE ? ESCAPE '\'`. */
function containsPattern(query: string): string {
  const cleaned = query.trim().replace(/[%_]/g, "").toLowerCase().replace(/\\/g, "\\\\");
  return `%${cleaned}%`;
}

type UserRow = {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  company_name: string;
  postal_address: string;
  from_name: string;
  from_email: string;
  reply_to: string;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: number;
  smtp_user: string;
  smtp_pass: string;
  created_at: string;
};

const USER_COLUMNS = `id, email, password_hash, name, company_name, postal_address, from_name, from_email, reply_to,
  smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass, created_at`;

function toAccount(row: UserRow): Account {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    companyName: row.company_name,
    postalAddress: row.postal_address,
    fromName: row.from_name,
    fromEmail: row.from_email,
    replyTo: row.reply_to,
    smtpHost: row.smtp_host,
    smtpPort: Number(row.smtp_port),
    smtpSecure: Number(row.smtp_secure) === 1,
    smtpUser: row.smtp_user,
    smtpConfigured: row.smtp_host.trim() !== "",
    hasSmtpPassword: row.smtp_pass.trim() !== "",
    createdAt: row.created_at,
  };
}

async function userById(id: string): Promise<UserRow | null> {
  const sql = await readySql();
  return (await sql.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(id)) as UserRow | null;
}

async function requireOwnedUser(id: string): Promise<UserRow> {
  const row = await userById(id);
  if (!row) throw new UserError("Account not found.");
  return row;
}

export async function createUser(input: { name: string; email: string; password: string }): Promise<Account> {
  const email = normalizeEmail(input.email);
  const name = input.name.trim();
  if (name.length < 1 || name.length > 80) throw new UserError("Enter your name.");
  if (!isEmail(email)) throw new UserError("Enter a valid email.");
  if (input.password.length < 8) throw new UserError("Use at least 8 characters for the password.");
  const sql = await readySql();
  const existing = await sql.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) throw new UserError("An account with that email already exists.");
  const id = newId();
  const createdAt = nowIso();
  const passwordHash = bcrypt.hashSync(input.password, 10);
  await sql.transaction(async (tx) => {
    await tx
      .prepare(
        `INSERT INTO users (id, email, password_hash, name, from_name, from_email, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, email, passwordHash, name, name, email, createdAt);
    const insertTemplate = tx.prepare(
      `INSERT INTO templates (id, user_id, name, subject, html, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const template of STARTER_TEMPLATES) {
      await insertTemplate.run(newId(), id, template.name, template.subject, template.html.trim(), createdAt, createdAt);
    }
  });
  return toAccount(await requireOwnedUser(id));
}

let dummyHash: string | null = null;

export async function verifyPassword(email: string, password: string): Promise<Account | null> {
  const sql = await readySql();
  const row = (await sql.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE email = ?`).get(normalizeEmail(email))) as
    | UserRow
    | null;
  const hash = row?.password_hash ?? (dummyHash ??= bcrypt.hashSync("postroom-dummy-password", 10));
  const ok = bcrypt.compareSync(password, hash);
  if (!row || !ok) return null;
  return toAccount(row);
}

export async function createSession(userId: string): Promise<string> {
  const id = newToken();
  const sql = await readySql();
  await sql.prepare("DELETE FROM sessions WHERE expires_at < ?").run(nowIso());
  await sql.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)").run(id, userId, addDaysIso(30));
  return id;
}

export async function deleteSession(id: string): Promise<void> {
  const sql = await readySql();
  await sql.prepare("DELETE FROM sessions WHERE id = ?").run(id);
}

export async function accountForSession(sessionId: string): Promise<Account | null> {
  const sql = await readySql();
  const row = (await sql
    .prepare(
      `SELECT ${USER_COLUMNS.split(",")
        .map((column) => `u.${column.trim()}`)
        .join(", ")}
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > ?`,
    )
    .get(sessionId, nowIso())) as UserRow | null;
  return row ? toAccount(row) : null;
}

export async function updateSettings(userId: string, input: SettingsInput): Promise<void> {
  const current = await requireOwnedUser(userId);
  const smtpPass = input.smtpPass === null ? current.smtp_pass : encryptSecret(input.smtpPass);
  const sql = await readySql();
  await sql
    .prepare(
      `UPDATE users SET name = ?, company_name = ?, postal_address = ?, from_name = ?, from_email = ?, reply_to = ?,
        smtp_host = ?, smtp_port = ?, smtp_secure = ?, smtp_user = ?, smtp_pass = ? WHERE id = ?`,
    )
    .run(
      input.name.trim().slice(0, 80),
      input.companyName.trim().slice(0, 120),
      input.postalAddress.trim().slice(0, 500),
      input.fromName.trim().slice(0, 80),
      normalizeEmail(input.fromEmail),
      input.replyTo.trim() ? normalizeEmail(input.replyTo) : "",
      input.smtpHost.trim().slice(0, 200),
      input.smtpPort,
      input.smtpSecure ? 1 : 0,
      input.smtpUser.trim().slice(0, 200),
      smtpPass,
      userId,
    );
}

export async function getAccount(userId: string): Promise<Account> {
  return toAccount(await requireOwnedUser(userId));
}

export async function campaignIsSending(campaignId: string): Promise<boolean> {
  const sql = await readySql();
  // An automation's hidden campaign accepts sends while the automation is active.
  const row = (await sql
    .prepare(
      `SELECT c.status, a.status AS automation_status
       FROM campaigns c LEFT JOIN automations a ON a.campaign_id = c.id WHERE c.id = ?`,
    )
    .get(campaignId)) as { status: string; automation_status: string | null } | null;
  if (!row) return false;
  return row.status === "sending" || (row.status === "automation" && row.automation_status === "active");
}

export async function smtpCredentials(userId: string): Promise<{
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}> {
  const row = await requireOwnedUser(userId);
  let pass = "";
  try {
    pass = decryptSecret(row.smtp_pass);
  } catch {
    throw new UserError("The saved SMTP password could not be read. Enter it again in Settings.");
  }
  return {
    host: row.smtp_host.trim(),
    port: Number(row.smtp_port),
    secure: Number(row.smtp_secure) === 1,
    user: row.smtp_user,
    pass,
  };
}

export async function deleteAccount(userId: string): Promise<void> {
  const sql = await readySql();
  await sql.prepare("DELETE FROM users WHERE id = ?").run(userId);
}

type CountRow = { n: number | string };

export async function dashboard(userId: string): Promise<Dashboard> {
  const sql = await readySql();
  const contacts = (await sql
    .prepare(
      `SELECT
         SUM(CASE WHEN status = 'subscribed' THEN 1 ELSE 0 END) AS subscribed,
         SUM(CASE WHEN status = 'unsubscribed' THEN 1 ELSE 0 END) AS unsubscribed
       FROM contacts WHERE user_id = ?`,
    )
    .get(userId)) as { subscribed: number | string | null; unsubscribed: number | string | null };
  const lists = (await sql.prepare("SELECT COUNT(*) AS n FROM lists WHERE user_id = ?").get(userId)) as CountRow;
  const campaigns = (await sql
    .prepare("SELECT COUNT(*) AS n FROM campaigns WHERE user_id = ? AND status = 'sent'")
    .get(userId)) as CountRow;
  const mail = (await sql
    .prepare(
      `SELECT
         SUM(CASE WHEN r.status = 'sent' THEN 1 ELSE 0 END) AS sent,
         SUM(CASE WHEN r.opened_at IS NOT NULL THEN 1 ELSE 0 END) AS opens,
         SUM(CASE WHEN r.clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS clicks
       FROM recipients r JOIN campaigns c ON c.id = r.campaign_id
       WHERE c.user_id = ?`,
    )
    .get(userId)) as { sent: number | string | null; opens: number | string | null; clicks: number | string | null };
  return {
    subscribed: Number(contacts.subscribed ?? 0),
    unsubscribed: Number(contacts.unsubscribed ?? 0),
    lists: Number(lists.n),
    sentCampaigns: Number(campaigns.n),
    sentRecipients: Number(mail.sent ?? 0),
    uniqueOpens: Number(mail.opens ?? 0),
    uniqueClicks: Number(mail.clicks ?? 0),
  };
}

export async function recentCampaigns(userId: string): Promise<Campaign[]> {
  const sql = await readySql();
  const rows = await sql
    .prepare(
      `SELECT c.id, c.name, c.subject, c.html, c.list_id, l.name AS list_name, c.from_name, c.from_email, c.reply_to,
              c.status, c.created_at, c.updated_at, c.started_at, c.finished_at
       FROM campaigns c LEFT JOIN lists l ON l.id = c.list_id
       WHERE c.user_id = ? AND c.status != 'automation' ORDER BY c.updated_at DESC LIMIT 6`,
    )
    .all(userId);
  return rows.map((row) => mapCampaign(row as Record<string, unknown>));
}

export async function listLists(userId: string): Promise<ContactList[]> {
  const sql = await readySql();
  const rows = await sql
    .prepare(
      `SELECT l.id, l.name, l.created_at,
              COUNT(lc.contact_id) AS contact_count,
              SUM(CASE WHEN c.status = 'subscribed' THEN 1 ELSE 0 END) AS subscribed_count
       FROM lists l
       LEFT JOIN list_contacts lc ON lc.list_id = l.id
       LEFT JOIN contacts c ON c.id = lc.contact_id
       WHERE l.user_id = ?
       GROUP BY l.id, l.name, l.created_at
       ORDER BY l.created_at DESC`,
    )
    .all(userId);
  return rows.map((row) => {
    const item = row as {
      id: string;
      name: string;
      created_at: string;
      contact_count: number | string;
      subscribed_count: number | string | null;
    };
    return {
      id: item.id,
      name: item.name,
      createdAt: item.created_at,
      contactCount: Number(item.contact_count),
      subscribedCount: Number(item.subscribed_count ?? 0),
    };
  });
}

export async function createList(userId: string, name: string): Promise<string> {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 80) throw new UserError("Give the list a name.");
  const id = newId();
  const sql = await readySql();
  await sql.prepare("INSERT INTO lists (id, user_id, name, created_at) VALUES (?, ?, ?, ?)").run(id, userId, trimmed, nowIso());
  return id;
}

export async function renameList(userId: string, listId: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 80) throw new UserError("Give the list a name.");
  const sql = await readySql();
  const changed = await sql.prepare("UPDATE lists SET name = ? WHERE id = ? AND user_id = ?").run(trimmed, listId, userId);
  if (changed === 0) throw new UserError("List not found.");
}

export async function getList(userId: string, listId: string): Promise<ContactList | null> {
  return (await listLists(userId)).find((list) => list.id === listId) ?? null;
}

export async function deleteList(userId: string, listId: string): Promise<void> {
  const sql = await readySql();
  // The list reference is cleared by the foreign key, so an automation on it must not keep running.
  await sql
    .prepare("UPDATE automations SET status = 'paused', updated_at = ? WHERE list_id = ? AND user_id = ? AND status = 'active'")
    .run(nowIso(), listId, userId);
  await sql.prepare("DELETE FROM lists WHERE id = ? AND user_id = ?").run(listId, userId);
}

async function pageOf<T>(query: string, countQuery: string, params: unknown[], page: number): Promise<Page<T>> {
  const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
  const sql = await readySql();
  const total = Number(((await sql.prepare(countQuery).get(...params)) as CountRow).n);
  const rows = (await sql
    .prepare(`${query} LIMIT ? OFFSET ?`)
    .all(...params, PAGE_SIZE, (safePage - 1) * PAGE_SIZE)) as T[];
  return { rows, total, page: safePage, pageSize: PAGE_SIZE };
}

type ContactRow = {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  status: string;
  created_at: string;
  list_names: string | null;
};

function mapContact(row: ContactRow): Contact {
  return {
    id: row.id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    status: row.status,
    createdAt: row.created_at,
    listNames: row.list_names ?? "",
  };
}

const CONTACT_SEARCH = `(? = '%%' OR LOWER(c.email) LIKE ? ESCAPE '\\' OR LOWER(c.first_name) LIKE ? ESCAPE '\\'
  OR LOWER(c.last_name) LIKE ? ESCAPE '\\')`;

export async function listContacts(userId: string, page: number, query: string): Promise<Page<Contact>> {
  const sql = await readySql();
  const like = containsPattern(query);
  const where = `FROM contacts c WHERE c.user_id = ? AND ${CONTACT_SEARCH}`;
  const params = [userId, like, like, like, like];
  const result = await pageOf<ContactRow>(
    `SELECT c.id, c.email, c.first_name, c.last_name, c.status, c.created_at,
            (SELECT ${listNamesAgg(sql)} FROM list_contacts lc JOIN lists l ON l.id = lc.list_id WHERE lc.contact_id = c.id) AS list_names
     ${where} ORDER BY c.created_at DESC`,
    `SELECT COUNT(*) AS n ${where}`,
    params,
    page,
  );
  return { ...result, rows: result.rows.map(mapContact) };
}

export async function listMembers(userId: string, listId: string, page: number, query: string): Promise<Page<Contact> | null> {
  if (!(await getList(userId, listId))) return null;
  const like = containsPattern(query);
  const where = `FROM contacts c
    JOIN list_contacts lc ON lc.contact_id = c.id AND lc.list_id = ?
    WHERE c.user_id = ? AND ${CONTACT_SEARCH}`;
  const params = [listId, userId, like, like, like, like];
  const result = await pageOf<ContactRow>(
    `SELECT c.id, c.email, c.first_name, c.last_name, c.status, c.created_at, '' AS list_names
     ${where} ORDER BY c.email`,
    `SELECT COUNT(*) AS n ${where}`,
    params,
    page,
  );
  return { ...result, rows: result.rows.map(mapContact) };
}

const INSERT_CONTACT = `INSERT INTO contacts (id, user_id, email, first_name, last_name, status, unsub_token, created_at)
  VALUES (?, ?, ?, ?, ?, 'subscribed', ?, ?)`;

const UPDATE_CONTACT_NAMES = `UPDATE contacts SET
  first_name = CASE WHEN ? != '' THEN ? ELSE first_name END,
  last_name = CASE WHEN ? != '' THEN ? ELSE last_name END
  WHERE id = ?`;

const LINK_CONTACT = `INSERT INTO list_contacts (list_id, contact_id, created_at) VALUES (?, ?, ?)
  ON CONFLICT (list_id, contact_id) DO NOTHING`;

export async function addContact(
  userId: string,
  input: { email: string; firstName: string; lastName: string; listId?: string | null },
): Promise<{ created: boolean; status: string }> {
  const email = normalizeEmail(input.email);
  if (!isEmail(email)) throw new UserError("Enter a valid email.");
  if (input.listId && !(await getList(userId, input.listId))) throw new UserError("List not found.");
  const sql = await readySql();
  if (await sql.prepare("SELECT 1 AS found FROM suppressed_addresses WHERE user_id = ? AND email = ?").get(userId, email)) {
    throw new UserError("That address is on your suppression list, so it cannot be added. Remove it from Suppressions first if that is a mistake.");
  }
  const existing = (await sql
    .prepare("SELECT id, status FROM contacts WHERE user_id = ? AND email = ?")
    .get(userId, email)) as { id: string; status: string } | null;
  const now = nowIso();
  let id = existing?.id;
  let created = false;
  if (!existing) {
    id = newId();
    created = true;
    await sql
      .prepare(INSERT_CONTACT)
      .run(id, userId, email, input.firstName.trim().slice(0, 80), input.lastName.trim().slice(0, 80), newToken(), now);
  } else {
    await sql
      .prepare(UPDATE_CONTACT_NAMES)
      .run(
        input.firstName.trim(),
        input.firstName.trim().slice(0, 80),
        input.lastName.trim(),
        input.lastName.trim().slice(0, 80),
        existing.id,
      );
  }
  if (input.listId && id) {
    await sql.prepare(LINK_CONTACT).run(input.listId, id, now);
  }
  const status = existing?.status ?? "subscribed";
  return { created, status };
}

export async function setContactStatus(userId: string, contactId: string, status: "subscribed" | "unsubscribed"): Promise<void> {
  const sql = await readySql();
  const changed = await sql
    .prepare("UPDATE contacts SET status = ? WHERE id = ? AND user_id = ?")
    .run(status, contactId, userId);
  if (changed === 0) throw new UserError("Contact not found.");
  if (status === "unsubscribed") {
    await sql
      .prepare(
        `UPDATE automation_enrollments SET status = 'stopped', stop_reason = 'unsubscribed', updated_at = ?
         WHERE contact_id = ? AND status = 'active'`,
      )
      .run(nowIso(), contactId);
  }
}

export async function deleteContact(userId: string, contactId: string): Promise<void> {
  const sql = await readySql();
  const row = (await sql
    .prepare("SELECT id, email, unsub_token FROM contacts WHERE id = ? AND user_id = ?")
    .get(contactId, userId)) as { id: string; email: string; unsub_token: string } | null;
  if (!row) throw new UserError("Contact not found.");
  const now = nowIso();
  await sql.transaction(async (tx) => {
    await tx
      .prepare(
        `INSERT INTO suppressions (token, user_id, email, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (token) DO UPDATE SET user_id = excluded.user_id, email = excluded.email, created_at = excluded.created_at`,
      )
      .run(row.unsub_token, userId, row.email, now);
    await tx
      .prepare(
        `UPDATE recipients SET status = 'skipped', error = 'Contact removed', claimed_at = NULL
         WHERE contact_id = ? AND status IN ('pending', 'sending')`,
      )
      .run(row.id);
    await tx.prepare("DELETE FROM contacts WHERE id = ?").run(row.id);
  });
}

export async function removeFromList(userId: string, listId: string, contactId: string): Promise<void> {
  if (!(await getList(userId, listId))) throw new UserError("List not found.");
  const sql = await readySql();
  await sql.prepare("DELETE FROM list_contacts WHERE list_id = ? AND contact_id = ?").run(listId, contactId);
}

export async function importContacts(userId: string, listId: string | null, csv: string): Promise<ImportResult> {
  if (listId && !(await getList(userId, listId))) throw new UserError("List not found.");
  const parsed = readContactCsv(csv);
  const sql = await readySql();
  const now = nowIso();
  let created = 0;
  let updated = 0;
  let addedToList = 0;
  let keptUnsubscribed = 0;
  let suppressed = 0;
  const blocked = new Set(
    ((await sql.prepare("SELECT email FROM suppressed_addresses WHERE user_id = ?").all(userId)) as { email: string }[]).map(
      (row) => row.email,
    ),
  );
  await sql.transaction(async (tx) => {
    const find = tx.prepare("SELECT id, status FROM contacts WHERE user_id = ? AND email = ?");
    const insert = tx.prepare(INSERT_CONTACT);
    const update = tx.prepare(UPDATE_CONTACT_NAMES);
    const link = tx.prepare(LINK_CONTACT);
    for (const contact of parsed.contacts) {
      if (blocked.has(contact.email)) {
        suppressed += 1;
        continue;
      }
      const existing = (await find.get(userId, contact.email)) as { id: string; status: string } | null;
      let id: string;
      if (!existing) {
        id = newId();
        await insert.run(id, userId, contact.email, contact.firstName, contact.lastName, newToken(), now);
        created += 1;
      } else {
        id = existing.id;
        await update.run(contact.firstName, contact.firstName, contact.lastName, contact.lastName, id);
        updated += 1;
        if (existing.status === "unsubscribed") keptUnsubscribed += 1;
      }
      if (listId) {
        addedToList += await link.run(listId, id, now);
      }
    }
  });
  return {
    created,
    updated,
    addedToList,
    invalid: parsed.invalid,
    keptUnsubscribed,
    suppressed,
  };
}

export async function contactsCsv(userId: string, listId: string | null): Promise<string | null> {
  if (listId && !(await getList(userId, listId))) return null;
  const sql = await readySql();
  const rows = (await (listId
    ? sql
        .prepare(
          `SELECT c.email, c.first_name, c.last_name, c.status
           FROM contacts c JOIN list_contacts lc ON lc.contact_id = c.id
           WHERE lc.list_id = ? AND c.user_id = ? ORDER BY c.email`,
        )
        .all(listId, userId)
    : sql
        .prepare("SELECT email, first_name, last_name, status FROM contacts WHERE user_id = ? ORDER BY email")
        .all(userId))) as { email: string; first_name: string; last_name: string; status: string }[];
  return toCsv([
    ["email", "first_name", "last_name", "status"],
    ...rows.map((row) => [row.email, row.first_name, row.last_name, row.status]),
  ]);
}

export async function listTemplates(userId: string): Promise<Template[]> {
  const sql = await readySql();
  const rows = await sql
    .prepare(
      "SELECT id, name, subject, html, created_at, updated_at FROM templates WHERE user_id = ? ORDER BY updated_at DESC",
    )
    .all(userId);
  return rows.map((row) => mapTemplate(row as Record<string, unknown>));
}

export async function getTemplate(userId: string, id: string): Promise<Template | null> {
  const sql = await readySql();
  const row = await sql
    .prepare("SELECT id, name, subject, html, created_at, updated_at FROM templates WHERE id = ? AND user_id = ?")
    .get(id, userId);
  return row ? mapTemplate(row as Record<string, unknown>) : null;
}

function mapTemplate(row: Record<string, unknown>): Template {
  return {
    id: String(row.id),
    name: String(row.name),
    subject: String(row.subject),
    html: String(row.html),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export async function saveTemplate(
  userId: string,
  input: { id?: string; name: string; subject: string; html: string },
): Promise<string> {
  const name = input.name.trim();
  const subject = input.subject.trim();
  const html = input.html.trim();
  if (!name || name.length > 80) throw new UserError("Give the template a name.");
  if (!subject || subject.length > 180) throw new UserError("Add a subject under 180 characters.");
  if (!html || html.length > 300_000) throw new UserError("Add the template body.");
  const now = nowIso();
  const sql = await readySql();
  if (input.id) {
    const changed = await sql
      .prepare("UPDATE templates SET name = ?, subject = ?, html = ?, updated_at = ? WHERE id = ? AND user_id = ?")
      .run(name, subject, html, now, input.id, userId);
    if (changed === 0) throw new UserError("Template not found.");
    return input.id;
  }
  const id = newId();
  await sql
    .prepare("INSERT INTO templates (id, user_id, name, subject, html, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, userId, name, subject, html, now, now);
  return id;
}

export async function deleteTemplate(userId: string, id: string): Promise<void> {
  const sql = await readySql();
  const inUse = (await sql
    .prepare(
      `SELECT a.name FROM automation_steps s JOIN automations a ON a.id = s.automation_id
       WHERE s.template_id = ? AND a.user_id = ? ORDER BY a.name LIMIT 1`,
    )
    .get(id, userId)) as { name: string } | null;
  if (inUse) throw new UserError(`This template is used by the automation "${inUse.name}". Remove that step first.`);
  await sql.prepare("DELETE FROM templates WHERE id = ? AND user_id = ?").run(id, userId);
}

function mapCampaign(row: Record<string, unknown>): Campaign {
  return {
    id: String(row.id),
    name: String(row.name),
    subject: String(row.subject),
    html: String(row.html),
    listId: row.list_id == null ? null : String(row.list_id),
    listName: row.list_name == null ? null : String(row.list_name),
    fromName: String(row.from_name ?? ""),
    fromEmail: String(row.from_email ?? ""),
    replyTo: String(row.reply_to ?? ""),
    status: String(row.status) as Campaign["status"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    startedAt: row.started_at == null ? null : String(row.started_at),
    finishedAt: row.finished_at == null ? null : String(row.finished_at),
  };
}

const CAMPAIGN_SELECT = `SELECT c.id, c.name, c.subject, c.html, c.list_id, l.name AS list_name, c.from_name, c.from_email,
  c.reply_to, c.status, c.created_at, c.updated_at, c.started_at, c.finished_at
  FROM campaigns c LEFT JOIN lists l ON l.id = c.list_id`;

export async function listCampaigns(userId: string): Promise<Campaign[]> {
  const sql = await readySql();
  const rows = await sql.prepare(`${CAMPAIGN_SELECT} WHERE c.user_id = ? AND c.status != 'automation' ORDER BY c.updated_at DESC`).all(userId);
  return rows.map((row) => mapCampaign(row as Record<string, unknown>));
}

export async function getCampaign(userId: string, id: string): Promise<Campaign | null> {
  const sql = await readySql();
  const row = await sql.prepare(`${CAMPAIGN_SELECT} WHERE c.id = ? AND c.user_id = ? AND c.status != 'automation'`).get(id, userId);
  return row ? mapCampaign(row as Record<string, unknown>) : null;
}

export async function saveCampaign(
  userId: string,
  input: {
    id?: string;
    name: string;
    subject: string;
    html: string;
    listId: string | null;
    fromName: string;
    fromEmail: string;
    replyTo: string;
  },
): Promise<string> {
  const name = input.name.trim() || "Untitled campaign";
  if (name.length > 120) throw new UserError("Campaign name is too long.");
  if (input.subject.trim().length > 180) throw new UserError("Subject is too long.");
  if (input.html.length > 300_000) throw new UserError("The email body is too long.");
  const account = toAccount(await requireOwnedUser(userId));
  const fromEmail = normalizeEmail(input.fromEmail || account.fromEmail || account.email);
  if (fromEmail && !isEmail(fromEmail)) throw new UserError("From email is not valid.");
  const replyTo = input.replyTo.trim() ? normalizeEmail(input.replyTo) : "";
  if (replyTo && !isEmail(replyTo)) throw new UserError("Reply-to email is not valid.");
  if (input.listId && !(await getList(userId, input.listId))) throw new UserError("List not found.");
  const now = nowIso();
  const sql = await readySql();
  if (!input.id) {
    const id = newId();
    await sql
      .prepare(
        `INSERT INTO campaigns (id, user_id, list_id, name, subject, html, from_name, from_email, reply_to, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
      )
      .run(
        id,
        userId,
        input.listId,
        name,
        input.subject.trim(),
        input.html,
        (input.fromName || account.fromName).trim(),
        fromEmail,
        replyTo,
        now,
        now,
      );
    return id;
  }
  const changed = await sql
    .prepare(
      `UPDATE campaigns SET list_id = ?, name = ?, subject = ?, html = ?, from_name = ?, from_email = ?, reply_to = ?, updated_at = ?
       WHERE id = ? AND user_id = ? AND status = 'draft'`,
    )
    .run(
      input.listId,
      name,
      input.subject.trim(),
      input.html,
      input.fromName.trim(),
      fromEmail,
      replyTo,
      now,
      input.id,
      userId,
    );
  if (changed === 0) throw new UserError("Only drafts can be edited.");
  return input.id;
}

export async function duplicateCampaign(userId: string, campaignId: string): Promise<string> {
  const campaign = await getCampaign(userId, campaignId);
  if (!campaign) throw new UserError("Campaign not found.");
  return saveCampaign(userId, {
    name: `${campaign.name} copy`.slice(0, 120),
    subject: campaign.subject,
    html: campaign.html,
    listId: campaign.listId,
    fromName: campaign.fromName,
    fromEmail: campaign.fromEmail,
    replyTo: campaign.replyTo,
  });
}

export async function deleteCampaign(userId: string, campaignId: string): Promise<void> {
  const sql = await readySql();
  await sql.prepare("DELETE FROM campaigns WHERE id = ? AND user_id = ? AND status != 'automation'")
    .run(campaignId, userId);
}

export async function subscribedCount(userId: string, listId: string | null): Promise<number> {
  if (!listId) return 0;
  const sql = await readySql();
  const row = (await sql
    .prepare(
      `SELECT COUNT(*) AS n FROM list_contacts lc
       JOIN contacts c ON c.id = lc.contact_id
       JOIN lists l ON l.id = lc.list_id
       WHERE lc.list_id = ? AND l.user_id = ? AND c.status = 'subscribed' AND ${NOT_SUPPRESSED}`,
    )
    .get(listId, userId)) as CountRow;
  return Number(row.n);
}

export async function queueCampaign(userId: string, campaignId: string, origin: string): Promise<{ queued: number }> {
  const campaign = await getCampaign(userId, campaignId);
  if (!campaign) throw new UserError("Campaign not found.");
  if (campaign.status !== "draft") throw new UserError("This campaign has already been queued.");
  const account = toAccount(await requireOwnedUser(userId));
  const subscribed = await subscribedCount(userId, campaign.listId);
  const blockers = sendBlockers({
    subject: campaign.subject,
    html: campaign.html,
    listId: campaign.listId,
    fromEmail: campaign.fromEmail,
    companyName: account.companyName,
    postalAddress: account.postalAddress,
    subscribed,
    smtpConfigured: account.smtpConfigured,
  });
  if (blockers.length) throw new UserError(blockers[0]);
  if (!campaign.listId) throw new UserError("Choose a list.");
  const listId = campaign.listId;
  const sql = await readySql();
  const people = (await sql
    .prepare(
      `SELECT c.id, c.email, c.first_name, c.last_name, c.unsub_token
       FROM contacts c
       JOIN list_contacts lc ON lc.contact_id = c.id
       WHERE lc.list_id = ? AND c.user_id = ? AND c.status = 'subscribed' AND ${NOT_SUPPRESSED}`,
    )
    .all(listId, userId)) as {
    id: string;
    email: string;
    first_name: string;
    last_name: string;
    unsub_token: string;
  }[];
  if (people.length === 0) throw new UserError("This list has no subscribed contacts.");
  const now = nowIso();
  await sql.transaction(async (tx) => {
    const locked = await tx
      .prepare(
        "UPDATE campaigns SET status = 'sending', origin = ?, started_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND status = 'draft'",
      )
      .run(origin.replace(/\/$/, ""), now, now, campaignId, userId);
    if (locked === 0) throw new UserError("This campaign has already been queued.");
    const insert = tx.prepare(
      `INSERT INTO recipients (id, campaign_id, contact_id, email, first_name, last_name, unsub_token, token, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    );
    for (const person of people) {
      await insert.run(newId(), campaignId, person.id, person.email, person.first_name, person.last_name, person.unsub_token, newToken(), now);
    }
  });
  return { queued: people.length };
}

export async function setCampaignStatus(userId: string, campaignId: string, status: "paused" | "sending"): Promise<void> {
  const expected = status === "paused" ? "sending" : "paused";
  const sql = await readySql();
  const changed = await sql
    .prepare("UPDATE campaigns SET status = ?, updated_at = ? WHERE id = ? AND user_id = ? AND status = ?")
    .run(status, nowIso(), campaignId, userId, expected);
  if (changed === 0) throw new UserError("That campaign cannot be updated.");
}

export async function campaignStats(campaignId: string): Promise<CampaignStats> {
  const sql = await readySql();
  const row = (await sql
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN status IN ('pending', 'sending') THEN 1 ELSE 0 END) AS waiting,
         SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
         SUM(CASE WHEN opened_at IS NOT NULL THEN 1 ELSE 0 END) AS unique_opens,
         SUM(open_count) AS opens,
         SUM(CASE WHEN clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS unique_clicks,
         SUM(click_count) AS clicks
       FROM recipients WHERE campaign_id = ?`,
    )
    .get(campaignId)) as Record<string, number | string | null>;
  const unsubs = (await sql
    .prepare("SELECT COUNT(*) AS n FROM events WHERE campaign_id = ? AND type = 'unsubscribe'")
    .get(campaignId)) as CountRow;
  return {
    total: Number(row.total ?? 0),
    sent: Number(row.sent ?? 0),
    failed: Number(row.failed ?? 0),
    waiting: Number(row.waiting ?? 0),
    skipped: Number(row.skipped ?? 0),
    uniqueOpens: Number(row.unique_opens ?? 0),
    opens: Number(row.opens ?? 0),
    uniqueClicks: Number(row.unique_clicks ?? 0),
    clicks: Number(row.clicks ?? 0),
    unsubscribes: Number(unsubs.n),
  };
}

export async function clickStats(campaignId: string): Promise<ClickStat[]> {
  const sql = await readySql();
  const rows = await sql
    .prepare(
      `SELECT url, COUNT(*) AS hits FROM events WHERE campaign_id = ? AND type = 'click' AND url != ''
       GROUP BY url ORDER BY hits DESC LIMIT 20`,
    )
    .all(campaignId);
  return rows.map((row) => {
    const item = row as { url: string; hits: number | string };
    return { url: item.url, hits: Number(item.hits) };
  });
}

export async function failureRows(campaignId: string): Promise<FailureRow[]> {
  const sql = await readySql();
  return (await sql
    .prepare("SELECT email, error FROM recipients WHERE campaign_id = ? AND status = 'failed' ORDER BY email LIMIT 50")
    .all(campaignId)) as FailureRow[];
}

export async function recentDeliveries(campaignId: string): Promise<{ id: string; email: string; createdAt: string }[]> {
  const sql = await readySql();
  const rows = await sql
    .prepare(
      `SELECT d.id, d.to_email AS email, d.created_at
       FROM deliveries d JOIN recipients r ON r.id = d.recipient_id
       WHERE r.campaign_id = ? ORDER BY d.created_at DESC LIMIT 20`,
    )
    .all(campaignId);
  return rows.map((row) => {
    const item = row as { id: string; email: string; created_at: string };
    return { id: item.id, email: item.email, createdAt: item.created_at };
  });
}

export async function getDelivery(userId: string, deliveryId: string): Promise<DeliveryView | null> {
  const sql = await readySql();
  const row = (await sql
    .prepare(
      `SELECT d.id, d.recipient_id, d.to_email, d.subject, d.html, d.mode, d.created_at, r.token, r.status,
              a.id AS automation_id
       FROM deliveries d
       JOIN recipients r ON r.id = d.recipient_id
       JOIN campaigns c ON c.id = r.campaign_id
       LEFT JOIN automations a ON a.campaign_id = c.id
       WHERE d.id = ? AND c.user_id = ?`,
    )
    .get(deliveryId, userId)) as {
    id: string;
    recipient_id: string;
    to_email: string;
    subject: string;
    html: string;
    mode: string;
    created_at: string;
    token: string;
    status: string;
    automation_id: string | null;
  } | null;
  if (!row) return null;
  return {
    id: row.id,
    recipientId: row.recipient_id,
    email: row.to_email,
    subject: row.subject,
    html: row.html,
    mode: row.mode,
    token: row.token,
    status: row.status,
    createdAt: row.created_at,
    automationId: row.automation_id,
  };
}

export async function releaseStaleClaims(): Promise<void> {
  const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const sql = await readySql();
  await sql
    .prepare(
      `UPDATE recipients SET status = 'pending', claimed_at = NULL
       WHERE status = 'sending' AND claimed_at IS NOT NULL AND claimed_at < ?`,
    )
    .run(cutoff);
}

export async function claimBatch(limit: number): Promise<SendJob[]> {
  const sql = await readySql();
  const claimed = await sql.transaction(async (tx) => {
    const ids = (await tx
      .prepare(
        `SELECT r.id FROM recipients r
         JOIN campaigns c ON c.id = r.campaign_id
         WHERE r.status = 'pending'
           AND (c.status = 'sending'
             OR (c.status = 'automation'
                 AND EXISTS (SELECT 1 FROM automations a WHERE a.campaign_id = c.id AND a.status = 'active')))
         ORDER BY r.created_at LIMIT ?`,
      )
      .all(limit)) as { id: string }[];
    const claim = tx.prepare("UPDATE recipients SET status = 'sending', claimed_at = ? WHERE id = ? AND status = 'pending'");
    const now = nowIso();
    const won: string[] = [];
    for (const row of ids) {
      if ((await claim.run(now, row.id)) === 1) won.push(row.id);
    }
    return won;
  });
  if (claimed.length === 0) return [];
  const placeholders = claimed.map(() => "?").join(", ");
  const rows = await sql
    .prepare(
      `SELECT r.id AS recipient_id, r.campaign_id, r.contact_id, contacts.status AS contact_status, r.email,
              r.first_name, r.last_name, r.unsub_token, r.token,
              CASE WHEN s.recipient_id IS NULL THEN c.subject ELSE COALESCE(t.subject, '') END AS subject,
              CASE WHEN s.recipient_id IS NULL THEN c.html ELSE COALESCE(t.html, '') END AS html,
              c.from_name, c.from_email, c.reply_to,
              CASE WHEN a.origin IS NULL OR a.origin = '' THEN c.origin ELSE a.origin END AS origin,
              c.user_id, c.status AS campaign_status, a.id AS automation_id
       FROM recipients r
       JOIN campaigns c ON c.id = r.campaign_id
       LEFT JOIN contacts ON contacts.id = r.contact_id
       LEFT JOIN automations a ON a.campaign_id = c.id
       LEFT JOIN automation_sends s ON s.recipient_id = r.id
       LEFT JOIN automation_steps st ON st.id = s.step_id
       LEFT JOIN templates t ON t.id = st.template_id
       WHERE r.id IN (${placeholders})`,
    )
    .all(...claimed);
  return rows.map((row) => {
    const item = row as Record<string, string | null>;
    return {
      recipientId: String(item.recipient_id),
      campaignId: String(item.campaign_id),
      contactId: item.contact_id,
      contactStatus: item.contact_status,
      email: String(item.email),
      firstName: String(item.first_name ?? ""),
      lastName: String(item.last_name ?? ""),
      unsubToken: String(item.unsub_token),
      token: String(item.token),
      subject: String(item.subject),
      html: String(item.html),
      fromName: String(item.from_name ?? ""),
      fromEmail: String(item.from_email ?? ""),
      replyTo: String(item.reply_to ?? ""),
      origin: String(item.origin ?? ""),
      userId: String(item.user_id),
      campaignStatus: String(item.campaign_status),
      automationId: item.automation_id,
    };
  });
}

export async function markRecipient(id: string, status: "sent" | "failed" | "skipped" | "pending" | "bounced", error: string): Promise<void> {
  const sentAt = status === "sent" ? nowIso() : null;
  const sql = await readySql();
  await sql
    .prepare("UPDATE recipients SET status = ?, error = ?, sent_at = ?, claimed_at = NULL WHERE id = ?")
    .run(status, error.slice(0, 500), sentAt, id);
}

export async function saveDelivery(input: {
  recipientId: string;
  mode: "smtp" | "capture";
  to: string;
  subject: string;
  html: string;
}): Promise<void> {
  const sql = await readySql();
  // Same effect as SQLite's INSERT OR REPLACE: one delivery per recipient, replaced on resend.
  await sql
    .prepare(
      `INSERT INTO deliveries (id, recipient_id, mode, to_email, subject, html, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (recipient_id) DO UPDATE SET
         id = excluded.id, mode = excluded.mode, to_email = excluded.to_email,
         subject = excluded.subject, html = excluded.html, created_at = excluded.created_at`,
    )
    .run(newId(), input.recipientId, input.mode, input.to, input.subject, input.html, nowIso());
}

export async function finishCampaigns(): Promise<void> {
  const now = nowIso();
  const sql = await readySql();
  await sql
    .prepare(
      `UPDATE campaigns SET status = 'sent', finished_at = ?, updated_at = ?
       WHERE status = 'sending'
       AND NOT EXISTS (
         SELECT 1 FROM recipients r WHERE r.campaign_id = campaigns.id AND r.status IN ('pending', 'sending')
       )`,
    )
    .run(now, now);
}

export async function recordOpen(token: string): Promise<void> {
  const sql = await readySql();
  const row = (await sql.prepare("SELECT id, campaign_id FROM recipients WHERE token = ?").get(token)) as
    | { id: string; campaign_id: string }
    | null;
  if (!row) return;
  const now = nowIso();
  await sql
    .prepare("UPDATE recipients SET open_count = open_count + 1, opened_at = COALESCE(opened_at, ?) WHERE id = ?")
    .run(now, row.id);
  await sql
    .prepare("INSERT INTO events (id, campaign_id, recipient_id, type, url, created_at) VALUES (?, ?, ?, 'open', '', ?)")
    .run(newId(), row.campaign_id, row.id, now);
}

export async function recordClick(token: string, url: string): Promise<void> {
  const sql = await readySql();
  const row = (await sql.prepare("SELECT id, campaign_id FROM recipients WHERE token = ?").get(token)) as
    | { id: string; campaign_id: string }
    | null;
  if (!row) return;
  const now = nowIso();
  await sql
    .prepare("UPDATE recipients SET click_count = click_count + 1, clicked_at = COALESCE(clicked_at, ?) WHERE id = ?")
    .run(now, row.id);
  await sql
    .prepare("INSERT INTO events (id, campaign_id, recipient_id, type, url, created_at) VALUES (?, ?, ?, 'click', ?, ?)")
    .run(newId(), row.campaign_id, row.id, url.slice(0, 2000), now);
  // Automations can be set to stop a person's series as soon as they click any link in it.
  const stopped = await sql
    .prepare(
      `UPDATE automation_enrollments SET status = 'stopped', stop_reason = 'clicked a link', updated_at = ?
       WHERE status = 'active'
         AND id IN (SELECT enrollment_id FROM automation_sends WHERE recipient_id = ?)
         AND automation_id IN (SELECT automation_id FROM automation_settings WHERE exit_on_click = 1)`,
    )
    .run(now, row.id);
  if (stopped > 0) await skipQueuedForStoppedEnrollments();
}

/** Anything still waiting to be delivered for an enrollment that has since been stopped is skipped. */
export async function skipQueuedForStoppedEnrollments(): Promise<number> {
  const sql = await readySql();
  return sql
    .prepare(
      `UPDATE recipients SET status = 'skipped', error = 'Left the automation', claimed_at = NULL
       WHERE status = 'pending'
         AND id IN (
           SELECT s.recipient_id FROM automation_sends s
           JOIN automation_enrollments e ON e.id = s.enrollment_id
           WHERE e.status = 'stopped' AND e.stop_reason != 'unsubscribed'
         )`,
    )
    .run();
}

export type UnsubView = {
  email: string;
  companyName: string;
  status: string;
};

export async function unsubView(token: string): Promise<UnsubView | null> {
  const sql = await readySql();
  const contact = (await sql
    .prepare(
      `SELECT c.email, c.status, u.company_name
       FROM contacts c JOIN users u ON u.id = c.user_id WHERE c.unsub_token = ?`,
    )
    .get(token)) as { email: string; status: string; company_name: string } | null;
  if (contact) {
    return { email: contact.email, companyName: contact.company_name, status: contact.status };
  }
  const suppressed = (await sql
    .prepare(`SELECT s.email, u.company_name FROM suppressions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`)
    .get(token)) as { email: string; company_name: string } | null;
  if (!suppressed) return null;
  return { email: suppressed.email, companyName: suppressed.company_name, status: "unsubscribed" };
}

export async function unsubscribe(token: string, campaignId: string | null): Promise<UnsubView | null> {
  const current = await unsubView(token);
  if (!current) return null;
  const sql = await readySql();
  const changed = await sql
    .prepare("UPDATE contacts SET status = 'unsubscribed' WHERE unsub_token = ? AND status != 'unsubscribed'")
    .run(token);
  if (changed > 0) {
    // Never send another automation step to someone who has unsubscribed.
    await sql
      .prepare(
        `UPDATE automation_enrollments SET status = 'stopped', stop_reason = 'unsubscribed', updated_at = ?
         WHERE status = 'active' AND contact_id IN (SELECT id FROM contacts WHERE unsub_token = ?)`,
      )
      .run(nowIso(), token);
  }
  if (changed > 0 && campaignId) {
    const recipient = (await sql
      .prepare(
        `SELECT r.id FROM recipients r
         JOIN contacts c ON c.id = r.contact_id
         WHERE c.unsub_token = ? AND r.campaign_id = ?`,
      )
      .get(token, campaignId)) as { id: string } | null;
    if (recipient) {
      await sql
        .prepare("INSERT INTO events (id, campaign_id, recipient_id, type, url, created_at) VALUES (?, ?, ?, 'unsubscribe', '', ?)")
        .run(newId(), campaignId, recipient.id, nowIso());
    }
  }
  return { ...current, status: "unsubscribed" };
}
