import { toCsv } from "./csv";
import { newId, newToken } from "./crypto";
import { parseWebhookPayload, type WebhookEvent } from "./bounces";
import { markRecipient } from "./queries";
import { readySql } from "./sql";
import { nowIso } from "./time";
import type { Page, Suppression, SuppressionReason } from "./types";
import { UserError } from "./user-error";
import { isEmail, normalizeEmail } from "./validators";

// Suppression list, bounce and complaint intake, and per-account deliverability settings.
// Same dialect rules as queries.ts: `?` placeholders, Number() around COUNT, ON CONFLICT.

const PAGE_SIZE = 50;

export const REASON_LABELS: Record<SuppressionReason, string> = {
  hard_bounce: "Hard bounce",
  complaint: "Complaint",
  manual: "Added by hand",
};

type CountRow = { n: number | string };

// ---------- suppression list ----------

/**
 * Adds an address to the account's suppression list (a no-op if it is already there) and, either way,
 * makes sure nothing more is sent to it: queued campaign messages are skipped and automation enrollments stop.
 * A complaint also unsubscribes the contact. Returns true when a new entry was created.
 */
export async function addSuppression(
  userId: string,
  address: string,
  reason: SuppressionReason,
  options: { detail?: string; source?: "smtp" | "webhook" | "manual" } = {},
): Promise<boolean> {
  const email = normalizeEmail(address);
  if (!isEmail(email)) throw new UserError(`"${address.trim().slice(0, 80)}" is not a valid email address.`);
  const sql = await readySql();
  const now = nowIso();
  return sql.transaction(async (tx) => {
    const created =
      (await tx
        .prepare(
          `INSERT INTO suppressed_addresses (id, user_id, email, reason, source, detail, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, email) DO NOTHING`,
        )
        .run(newId(), userId, email, reason, options.source ?? "manual", (options.detail ?? "").slice(0, 500), now)) === 1;
    if (reason === "complaint") {
      await tx.prepare("UPDATE contacts SET status = 'unsubscribed' WHERE user_id = ? AND email = ?").run(userId, email);
    }
    await tx
      .prepare(
        `UPDATE automation_enrollments SET status = 'stopped', stop_reason = 'suppressed', updated_at = ?
         WHERE status = 'active' AND contact_id IN (SELECT id FROM contacts WHERE user_id = ? AND email = ?)`,
      )
      .run(now, userId, email);
    await tx
      .prepare(
        `UPDATE recipients SET status = 'skipped', error = 'Suppressed', claimed_at = NULL
         WHERE status = 'pending' AND email = ? AND campaign_id IN (SELECT id FROM campaigns WHERE user_id = ?)`,
      )
      .run(email, userId);
    return created;
  });
}

/** Adds several addresses typed or pasted by hand. Returns how many were new, already listed, or not valid. */
export async function addManualSuppressions(
  userId: string,
  raw: string,
  detail: string,
): Promise<{ added: number; existing: number; invalid: number }> {
  const parts = raw.split(/[\s,;]+/).filter(Boolean);
  if (parts.length === 0) throw new UserError("Enter at least one email address.");
  if (parts.length > 1000) throw new UserError("Add up to 1,000 addresses at a time.");
  const unique = [...new Set(parts.map(normalizeEmail))];
  let added = 0;
  let existing = 0;
  let invalid = 0;
  for (const email of unique) {
    if (!isEmail(email)) {
      invalid += 1;
      continue;
    }
    if (await addSuppression(userId, email, "manual", { detail, source: "manual" })) added += 1;
    else existing += 1;
  }
  return { added, existing, invalid };
}

export async function removeSuppression(userId: string, id: string): Promise<void> {
  const sql = await readySql();
  const changed = await sql.prepare("DELETE FROM suppressed_addresses WHERE id = ? AND user_id = ?").run(id, userId);
  if (changed === 0) throw new UserError("That address is not on the list.");
}

/** Why an address is suppressed, or null when it is free to mail. */
export async function suppressionReason(userId: string, email: string): Promise<SuppressionReason | null> {
  const sql = await readySql();
  const row = (await sql
    .prepare("SELECT reason FROM suppressed_addresses WHERE user_id = ? AND email = ?")
    .get(userId, normalizeEmail(email))) as { reason: SuppressionReason } | null;
  return row?.reason ?? null;
}

type SuppressionRow = {
  id: string;
  email: string;
  reason: SuppressionReason;
  source: string;
  detail: string;
  created_at: string;
};

function mapSuppression(row: SuppressionRow): Suppression {
  return {
    id: row.id,
    email: row.email,
    reason: row.reason,
    source: row.source,
    detail: row.detail,
    createdAt: row.created_at,
  };
}

export async function listSuppressions(userId: string, page: number, query: string): Promise<Page<Suppression>> {
  const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
  const like = `%${query.trim().replace(/[%_]/g, "").toLowerCase().replace(/\\/g, "\\\\")}%`;
  const where = "FROM suppressed_addresses WHERE user_id = ? AND (? = '%%' OR LOWER(email) LIKE ? ESCAPE '\\')";
  const sql = await readySql();
  const total = Number(((await sql.prepare(`SELECT COUNT(*) AS n ${where}`).get(userId, like, like)) as CountRow).n);
  const rows = (await sql
    .prepare(
      `SELECT id, email, reason, source, detail, created_at ${where} ORDER BY created_at DESC, email LIMIT ? OFFSET ?`,
    )
    .all(userId, like, like, PAGE_SIZE, (safePage - 1) * PAGE_SIZE)) as SuppressionRow[];
  return { rows: rows.map(mapSuppression), total, page: safePage, pageSize: PAGE_SIZE };
}

export async function suppressionCounts(userId: string): Promise<Record<SuppressionReason, number>> {
  const sql = await readySql();
  const rows = (await sql
    .prepare("SELECT reason, COUNT(*) AS n FROM suppressed_addresses WHERE user_id = ? GROUP BY reason")
    .all(userId)) as { reason: SuppressionReason; n: number | string }[];
  const counts: Record<SuppressionReason, number> = { hard_bounce: 0, complaint: 0, manual: 0 };
  for (const row of rows) if (row.reason in counts) counts[row.reason] = Number(row.n);
  return counts;
}

export async function suppressionsCsv(userId: string): Promise<string> {
  const sql = await readySql();
  const rows = (await sql
    .prepare("SELECT id, email, reason, source, detail, created_at FROM suppressed_addresses WHERE user_id = ? ORDER BY email")
    .all(userId)) as SuppressionRow[];
  return toCsv([
    ["email", "reason", "source", "detail", "added"],
    ...rows.map((row) => [row.email, row.reason, row.source, row.detail, row.created_at]),
  ]);
}

// ---------- hard bounces found while sending ----------

/** A recipient the SMTP server refused permanently: mark it bounced, log the event, and suppress the address. */
export async function recordHardBounce(input: {
  recipientId: string;
  campaignId: string;
  userId: string;
  email: string;
  message: string;
}): Promise<void> {
  await markRecipient(input.recipientId, "bounced", input.message);
  await recordEventOnce(input.campaignId, input.recipientId, "bounce", input.message);
  await addSuppression(input.userId, input.email, "hard_bounce", { detail: input.message, source: "smtp" });
}

async function recordEventOnce(campaignId: string, recipientId: string, type: string, url: string): Promise<boolean> {
  const sql = await readySql();
  const seen = await sql.prepare("SELECT 1 AS found FROM events WHERE recipient_id = ? AND type = ?").get(recipientId, type);
  if (seen) return false;
  await sql
    .prepare("INSERT INTO events (id, campaign_id, recipient_id, type, url, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(newId(), campaignId, recipientId, type, url.slice(0, 500), nowIso());
  return true;
}

// ---------- webhook ----------

export async function getDeliverabilitySettings(userId: string): Promise<{ webhookToken: string | null; dkimSelector: string }> {
  const sql = await readySql();
  const row = (await sql
    .prepare("SELECT webhook_token, dkim_selector FROM deliverability_settings WHERE user_id = ?")
    .get(userId)) as { webhook_token: string | null; dkim_selector: string } | null;
  return { webhookToken: row?.webhook_token ?? null, dkimSelector: row?.dkim_selector || "default" };
}

/** Creates (or replaces) the secret that authorises bounce webhooks for this account. */
export async function rotateWebhookToken(userId: string): Promise<string> {
  const token = newToken();
  const sql = await readySql();
  await sql
    .prepare(
      `INSERT INTO deliverability_settings (user_id, webhook_token, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET webhook_token = excluded.webhook_token, updated_at = excluded.updated_at`,
    )
    .run(userId, token, nowIso());
  return token;
}

export async function clearWebhookToken(userId: string): Promise<void> {
  const sql = await readySql();
  await sql.prepare("UPDATE deliverability_settings SET webhook_token = NULL, updated_at = ? WHERE user_id = ?").run(nowIso(), userId);
}

const SELECTOR = /^[a-z0-9]([a-z0-9._-]{0,60}[a-z0-9])?$/i;

export async function saveDkimSelector(userId: string, selector: string): Promise<string> {
  const value = selector.trim() || "default";
  if (!SELECTOR.test(value)) throw new UserError("The DKIM selector can only use letters, numbers, dots, dashes, and underscores.");
  const sql = await readySql();
  await sql
    .prepare(
      `INSERT INTO deliverability_settings (user_id, dkim_selector, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET dkim_selector = excluded.dkim_selector, updated_at = excluded.updated_at`,
    )
    .run(userId, value, nowIso());
  return value;
}

async function userIdForToken(token: string): Promise<string | null> {
  if (!token) return null;
  const sql = await readySql();
  const row = (await sql.prepare("SELECT user_id FROM deliverability_settings WHERE webhook_token = ?").get(token)) as
    | { user_id: string }
    | null;
  return row?.user_id ?? null;
}

export type WebhookSummary = { bounces: number; complaints: number; deliveries: number; suppressed: number; ignored: number };

/** Records one parsed event. Unknown addresses are still suppressed; they just have no campaign to attach the event to. */
async function applyEvent(userId: string, event: WebhookEvent, summary: WebhookSummary): Promise<void> {
  const sql = await readySql();
  const recipient = (await sql
    .prepare(
      `SELECT r.id, r.campaign_id FROM recipients r JOIN campaigns c ON c.id = r.campaign_id
       WHERE c.user_id = ? AND r.email = ? AND r.status = 'sent' ORDER BY r.sent_at DESC LIMIT 1`,
    )
    .get(userId, event.email)) as { id: string; campaign_id: string } | null;
  if (event.kind === "delivery") {
    summary.deliveries += 1;
    if (recipient) await recordEventOnce(recipient.campaign_id, recipient.id, "delivery", "");
    return;
  }
  if (event.kind === "bounce") {
    summary.bounces += 1;
    if (recipient) await recordEventOnce(recipient.campaign_id, recipient.id, "bounce", event.reason);
    if (event.permanent && (await addSuppression(userId, event.email, "hard_bounce", { detail: event.reason, source: "webhook" }))) {
      summary.suppressed += 1;
    }
    return;
  }
  summary.complaints += 1;
  if (recipient) await recordEventOnce(recipient.campaign_id, recipient.id, "complaint", event.reason);
  if (await addSuppression(userId, event.email, "complaint", { detail: event.reason, source: "webhook" })) summary.suppressed += 1;
}

export type WebhookResult = {
  status: number;
  json: Record<string, unknown>;
  /** For the route to visit: Amazon SNS subscription confirmation. */
  confirmUrl?: string;
};

/** The whole webhook, minus the HTTP plumbing: check the token, parse the body, apply the events. */
export async function handleWebhook(token: string, body: string): Promise<WebhookResult> {
  const userId = await userIdForToken(token);
  if (!userId) return { status: 401, json: { ok: false, error: "Invalid token." } };
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return { status: 400, json: { ok: false, error: "The body must be JSON." } };
  }
  const parsed = parseWebhookPayload(data);
  const summary: WebhookSummary = { bounces: 0, complaints: 0, deliveries: 0, suppressed: 0, ignored: parsed.ignored };
  for (const event of parsed.events) await applyEvent(userId, event, summary);
  return {
    status: 200,
    json: { ok: true, ...summary, ...(parsed.confirmUrl ? { confirming: true } : {}) },
    confirmUrl: parsed.confirmUrl ?? undefined,
  };
}
