import { createHash } from "crypto";
import { newId } from "./crypto";
import { getConsent } from "./consent";
import { readySql } from "./sql";
import { nowIso } from "./time";
import { UserError } from "./user-error";
import { normalizeEmail } from "./validators";

function hashEmail(email: string): string {
  return createHash("sha256").update(`postroom-erased:${normalizeEmail(email)}`).digest("hex").slice(0, 24);
}

/** Full JSON export for one contact (GDPR subject access). */
export async function exportContactData(userId: string, contactId: string): Promise<Record<string, unknown>> {
  const sql = await readySql();
  const contact = (await sql
    .prepare("SELECT id, email, first_name, last_name, status, unsub_token, created_at FROM contacts WHERE id = ? AND user_id = ?")
    .get(contactId, userId)) as Record<string, unknown> | null;
  if (!contact) throw new UserError("Contact not found.");

  const lists = (await sql
    .prepare(
      `SELECT l.id, l.name, lc.created_at AS joined_at
       FROM list_contacts lc JOIN lists l ON l.id = lc.list_id
       WHERE lc.contact_id = ? AND l.user_id = ? ORDER BY l.name`,
    )
    .all(contactId, userId)) as Record<string, unknown>[];

  const recipients = (await sql
    .prepare(
      `SELECT r.id, r.campaign_id, c.name AS campaign_name, r.email, r.status, r.error, r.sent_at, r.opened_at, r.clicked_at,
              r.open_count, r.click_count, r.created_at
       FROM recipients r
       JOIN campaigns c ON c.id = r.campaign_id
       WHERE r.contact_id = ? AND c.user_id = ?
       ORDER BY r.created_at`,
    )
    .all(contactId, userId)) as { id: string }[];

  const recipientIds = recipients.map((row) => row.id);
  let events: Record<string, unknown>[] = [];
  let deliveries: Record<string, unknown>[] = [];
  if (recipientIds.length) {
    const ph = recipientIds.map(() => "?").join(", ");
    events = (await sql
      .prepare(
        `SELECT e.id, e.campaign_id, e.recipient_id, e.type, e.url, e.created_at
         FROM events e WHERE e.recipient_id IN (${ph}) ORDER BY e.created_at`,
      )
      .all(...recipientIds)) as Record<string, unknown>[];
    deliveries = (await sql
      .prepare(
        `SELECT d.id, d.recipient_id, d.mode, d.to_email, d.subject, d.created_at
         FROM deliveries d WHERE d.recipient_id IN (${ph}) ORDER BY d.created_at`,
      )
      .all(...recipientIds)) as Record<string, unknown>[];
  }

  const consent = await getConsent(contactId);
  const suppressed = (await sql
    .prepare("SELECT email, reason, source, detail, created_at FROM suppressed_addresses WHERE user_id = ? AND email = ?")
    .get(userId, String(contact.email))) as Record<string, unknown> | null;

  return {
    exportedAt: nowIso(),
    contact,
    consent,
    lists,
    recipients,
    events,
    deliveries: deliveries.map((row) => ({ ...row, html: undefined })),
    suppression: suppressed,
  };
}

/**
 * Erases a contact for GDPR.
 * - Deletes the contact (cascades list membership, consent, enrollments).
 * - Anonymizes recipient/delivery email and strips names; keeps rows so campaign aggregates stay intact.
 * - Adds the original address to the suppression list (plain email) so it cannot be re-imported and mailed.
 */
export async function eraseContact(userId: string, contactId: string): Promise<{ email: string }> {
  const sql = await readySql();
  const contact = (await sql
    .prepare("SELECT id, email FROM contacts WHERE id = ? AND user_id = ?")
    .get(contactId, userId)) as { id: string; email: string } | null;
  if (!contact) throw new UserError("Contact not found.");

  const email = normalizeEmail(contact.email);
  const redacted = `erased-${hashEmail(email)}@invalid.local`;
  const now = nowIso();

  await sql.transaction(async (tx) => {
    await tx
      .prepare(
        `UPDATE recipients SET email = ?, first_name = '', last_name = '', unsub_token = '', error = CASE WHEN error = '' THEN error ELSE 'redacted' END
         WHERE contact_id = ? AND campaign_id IN (SELECT id FROM campaigns WHERE user_id = ?)`,
      )
      .run(redacted, contactId, userId);
    await tx
      .prepare(
        `UPDATE deliveries SET to_email = ?, subject = '[redacted]', html = ''
         WHERE recipient_id IN (
           SELECT r.id FROM recipients r JOIN campaigns c ON c.id = r.campaign_id
           WHERE r.contact_id = ? AND c.user_id = ?
         )`,
      )
      .run(redacted, contactId, userId);
    await tx
      .prepare(
        `INSERT INTO suppressed_addresses (id, user_id, email, reason, source, detail, created_at)
         VALUES (?, ?, ?, 'manual', 'manual', ?, ?)
         ON CONFLICT (user_id, email) DO NOTHING`,
      )
      .run(newId(), userId, email, "GDPR erase", now);
    // Skip pending sends for this contact.
    await tx
      .prepare(
        `UPDATE recipients SET status = 'skipped', error = 'Contact erased', claimed_at = NULL
         WHERE contact_id = ? AND status IN ('pending', 'sending')`,
      )
      .run(contactId);
    await tx.prepare("DELETE FROM contacts WHERE id = ? AND user_id = ?").run(contactId, userId);
  });

  return { email };
}

/** Account-wide JSON export (settings without secrets, lists, contacts+consent, campaigns metadata, recipients, events). */
export async function exportAccountData(userId: string): Promise<Record<string, unknown>> {
  const sql = await readySql();
  const user = (await sql
    .prepare(
      `SELECT id, email, name, company_name, postal_address, from_name, from_email, reply_to,
              smtp_host, smtp_port, smtp_secure, smtp_user, created_at
       FROM users WHERE id = ?`,
    )
    .get(userId)) as Record<string, unknown> | null;
  if (!user) throw new UserError("Account not found.");

  const lists = await sql.prepare("SELECT id, name, created_at FROM lists WHERE user_id = ? ORDER BY name").all(userId);
  const contacts = await sql
    .prepare("SELECT id, email, first_name, last_name, status, created_at FROM contacts WHERE user_id = ? ORDER BY email")
    .all(userId);
  const contactIds = (contacts as { id: string }[]).map((row) => row.id);
  let consent: Record<string, unknown>[] = [];
  if (contactIds.length) {
    const ph = contactIds.map(() => "?").join(", ");
    consent = (await sql
      .prepare(`SELECT * FROM contact_consent WHERE contact_id IN (${ph})`)
      .all(...contactIds)) as Record<string, unknown>[];
  }
  const campaigns = await sql
    .prepare(
      `SELECT id, name, subject, list_id, from_name, from_email, reply_to, status, created_at, started_at, finished_at
       FROM campaigns WHERE user_id = ? AND status != 'automation' ORDER BY created_at`,
    )
    .all(userId);
  const suppressions = await sql
    .prepare("SELECT email, reason, source, detail, created_at FROM suppressed_addresses WHERE user_id = ? ORDER BY created_at")
    .all(userId);
  const automations = await sql
    .prepare("SELECT id, name, list_id, status, created_at, updated_at FROM automations WHERE user_id = ?")
    .all(userId);

  const campaignIds = (
    await sql.prepare("SELECT id FROM campaigns WHERE user_id = ?").all(userId)
  ).map((row) => (row as { id: string }).id);
  let recipients: Record<string, unknown>[] = [];
  let events: Record<string, unknown>[] = [];
  if (campaignIds.length) {
    const ph = campaignIds.map(() => "?").join(", ");
    recipients = (await sql
      .prepare(
        `SELECT id, campaign_id, contact_id, email, status, sent_at, opened_at, clicked_at, open_count, click_count, created_at
         FROM recipients WHERE campaign_id IN (${ph})`,
      )
      .all(...campaignIds)) as Record<string, unknown>[];
    events = (await sql
      .prepare(`SELECT id, campaign_id, recipient_id, type, url, created_at FROM events WHERE campaign_id IN (${ph})`)
      .all(...campaignIds)) as Record<string, unknown>[];
  }

  return {
    exportedAt: nowIso(),
    account: { ...user, smtp_pass: undefined },
    lists,
    contacts,
    consent,
    suppressions,
    campaigns,
    automations,
    recipients,
    events,
  };
}
