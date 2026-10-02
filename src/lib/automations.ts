import { newId, newToken } from "./crypto";
import { getAccount, getList, getTemplate } from "./queries";
import { readySql, type Sql } from "./sql";
import { addMinutesIso, nowIso } from "./time";
import type {
  Automation,
  AutomationStatus,
  AutomationStep,
  EnrollmentCounts,
  EnrollmentRow,
} from "./types";
import { UserError } from "./user-error";
import { isEmail, normalizeEmail } from "./validators";

// Automations = a trigger (a contact lands on a list) plus an ordered list of steps.
//
// - Every automation owns one hidden campaign (status 'automation'). Its recipients, deliveries,
//   open/click events and unsubscribe events reuse the normal send pipeline and tracking.
// - The worker (runAutomationCycle) does two things each pass:
//     1. enrollNewMembers: enrolls subscribed people who joined the list after the automation was
//        activated. UNIQUE(automation_id, contact_id) means nobody is enrolled twice.
//     2. processDueEnrollments: runs the next step of each due enrollment. A step is claimed with a
//        compare-and-swap UPDATE inside a transaction, so two workers cannot run the same step.
//        An email step only inserts a 'pending' recipient; claimBatch/processJob deliver it exactly
//        like a campaign message (tracking, signed links, unsubscribe, company footer, capture mode).
// Same dialect rules as queries.ts: `?` placeholders, Number() around COUNT/SUM, ON CONFLICT.

export const MAX_DELAY_MINUTES = 365 * 24 * 60;
export const MAX_STEPS = 30;

const UNIT_MINUTES = { minutes: 1, hours: 60, days: 24 * 60 } as const;
export type DelayUnit = keyof typeof UNIT_MINUTES;

export function isDelayUnit(value: string): value is DelayUnit {
  return value in UNIT_MINUTES;
}

export function delayToMinutes(amount: number, unit: string): number {
  if (!isDelayUnit(unit)) throw new UserError("Choose minutes, hours, or days.");
  if (!Number.isInteger(amount) || amount < 1) throw new UserError("Enter a whole number of 1 or more.");
  const minutes = amount * UNIT_MINUTES[unit];
  if (minutes > MAX_DELAY_MINUTES) throw new UserError("A delay can be at most 365 days.");
  return minutes;
}

/** "2 days", "90 minutes": the largest unit that divides the delay evenly. */
export function describeDelay(minutes: number): string {
  const unit: DelayUnit = minutes % UNIT_MINUTES.days === 0 ? "days" : minutes % UNIT_MINUTES.hours === 0 ? "hours" : "minutes";
  const amount = minutes / UNIT_MINUTES[unit];
  return `${amount} ${amount === 1 ? unit.slice(0, -1) : unit}`;
}

type CountRow = { n: number | string };

type AutomationRow = {
  id: string;
  name: string;
  status: string;
  list_id: string | null;
  list_name: string | null;
  campaign_id: string;
  created_at: string;
  updated_at: string;
  step_count: number | string | null;
  email_count: number | string | null;
};

const AUTOMATION_SELECT = `SELECT a.id, a.name, a.status, a.list_id, l.name AS list_name, a.campaign_id, a.created_at, a.updated_at,
    (SELECT COUNT(*) FROM automation_steps s WHERE s.automation_id = a.id) AS step_count,
    (SELECT COUNT(*) FROM automation_steps s WHERE s.automation_id = a.id AND s.kind = 'email') AS email_count
  FROM automations a LEFT JOIN lists l ON l.id = a.list_id`;

function mapAutomation(row: AutomationRow): Automation {
  return {
    id: row.id,
    name: row.name,
    status: row.status as AutomationStatus,
    listId: row.list_id,
    listName: row.list_name,
    campaignId: row.campaign_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stepCount: Number(row.step_count ?? 0),
    emailCount: Number(row.email_count ?? 0),
  };
}

function cleanName(value: string): string {
  const name = value.trim();
  if (name.length < 1 || name.length > 120) throw new UserError("Give the automation a name under 120 characters.");
  return name;
}

export async function listAutomations(userId: string): Promise<Automation[]> {
  const sql = await readySql();
  const rows = await sql.prepare(`${AUTOMATION_SELECT} WHERE a.user_id = ? ORDER BY a.updated_at DESC`).all(userId);
  return rows.map((row) => mapAutomation(row as AutomationRow));
}

export async function getAutomation(userId: string, id: string): Promise<Automation | null> {
  const sql = await readySql();
  const row = await sql.prepare(`${AUTOMATION_SELECT} WHERE a.id = ? AND a.user_id = ?`).get(id, userId);
  return row ? mapAutomation(row as AutomationRow) : null;
}

async function requireAutomation(userId: string, id: string): Promise<Automation> {
  const automation = await getAutomation(userId, id);
  if (!automation) throw new UserError("Automation not found.");
  return automation;
}

/** Steps and the list can only change while the automation is not running. */
function requireNotActive(automation: Automation): void {
  if (automation.status === "active") throw new UserError("Pause the automation before changing it.");
}

export async function createAutomation(userId: string, input: { name: string; listId: string | null }): Promise<string> {
  const name = cleanName(input.name);
  if (input.listId && !(await getList(userId, input.listId))) throw new UserError("List not found.");
  const account = await getAccount(userId);
  const id = newId();
  const campaignId = newId();
  const now = nowIso();
  const sql = await readySql();
  await sql.transaction(async (tx) => {
    await tx
      .prepare(
        `INSERT INTO campaigns (id, user_id, list_id, name, subject, html, from_name, from_email, reply_to, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, '', '', ?, ?, ?, 'automation', ?, ?)`,
      )
      .run(campaignId, userId, input.listId, `Automation: ${name}`.slice(0, 120), account.fromName, account.fromEmail || account.email, account.replyTo, now, now);
    await tx
      .prepare(
        `INSERT INTO automations (id, user_id, list_id, campaign_id, name, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)`,
      )
      .run(id, userId, input.listId, campaignId, name, now, now);
  });
  return id;
}

export async function updateAutomation(
  userId: string,
  id: string,
  input: { name: string; listId: string | null },
): Promise<void> {
  const automation = await requireAutomation(userId, id);
  requireNotActive(automation);
  const name = cleanName(input.name);
  if (input.listId && !(await getList(userId, input.listId))) throw new UserError("List not found.");
  const now = nowIso();
  const sql = await readySql();
  await sql.transaction(async (tx) => {
    await tx
      .prepare("UPDATE automations SET name = ?, list_id = ?, updated_at = ? WHERE id = ? AND user_id = ? AND status != 'active'")
      .run(name, input.listId, now, id, userId);
    await tx
      .prepare("UPDATE campaigns SET name = ?, list_id = ?, updated_at = ? WHERE id = ?")
      .run(`Automation: ${name}`.slice(0, 120), input.listId, now, automation.campaignId);
  });
}

export async function deleteAutomation(userId: string, id: string): Promise<void> {
  const automation = await getAutomation(userId, id);
  if (!automation) return;
  const sql = await readySql();
  // Deleting the hidden campaign removes its recipients, tracking events and stored messages;
  // the automation, steps and enrollments go with it (ON DELETE CASCADE).
  await sql.prepare("DELETE FROM campaigns WHERE id = ? AND user_id = ? AND status = 'automation'").run(automation.campaignId, userId);
}

// ---------- steps ----------

type StepRow = {
  id: string;
  position: number | string;
  kind: string;
  template_id: string | null;
  template_name: string | null;
  delay_minutes: number | string;
};

export async function listSteps(userId: string, automationId: string): Promise<AutomationStep[]> {
  const sql = await readySql();
  const rows = (await sql
    .prepare(
      `SELECT s.id, s.position, s.kind, s.template_id, t.name AS template_name, s.delay_minutes
       FROM automation_steps s
       JOIN automations a ON a.id = s.automation_id
       LEFT JOIN templates t ON t.id = s.template_id
       WHERE s.automation_id = ? AND a.user_id = ? ORDER BY s.position`,
    )
    .all(automationId, userId)) as StepRow[];
  return rows.map((row) => ({
    id: row.id,
    position: Number(row.position),
    kind: row.kind === "delay" ? "delay" : "email",
    templateId: row.template_id,
    templateName: row.template_name,
    delayMinutes: Number(row.delay_minutes),
  }));
}

async function appendStep(
  userId: string,
  automationId: string,
  step: { kind: "email" | "delay"; templateId: string | null; delayMinutes: number },
): Promise<void> {
  const automation = await requireAutomation(userId, automationId);
  requireNotActive(automation);
  if (automation.stepCount >= MAX_STEPS) throw new UserError(`An automation can have at most ${MAX_STEPS} steps.`);
  const sql = await readySql();
  await sql
    .prepare(
      `INSERT INTO automation_steps (id, automation_id, position, kind, template_id, delay_minutes, created_at)
       VALUES (?, ?, (SELECT COUNT(*) FROM automation_steps WHERE automation_id = ?), ?, ?, ?, ?)`,
    )
    .run(newId(), automationId, automationId, step.kind, step.templateId, step.delayMinutes, nowIso());
  await sql.prepare("UPDATE automations SET updated_at = ? WHERE id = ?").run(nowIso(), automationId);
}

export async function addEmailStep(userId: string, automationId: string, templateId: string): Promise<void> {
  if (!(await getTemplate(userId, templateId))) throw new UserError("Choose a template for the email step.");
  await appendStep(userId, automationId, { kind: "email", templateId, delayMinutes: 0 });
}

export async function addDelayStep(userId: string, automationId: string, amount: number, unit: string): Promise<void> {
  await appendStep(userId, automationId, { kind: "delay", templateId: null, delayMinutes: delayToMinutes(amount, unit) });
}

export async function removeStep(userId: string, automationId: string, stepId: string): Promise<void> {
  requireNotActive(await requireAutomation(userId, automationId));
  const sql = await readySql();
  await sql.transaction(async (tx) => {
    const step = (await tx
      .prepare("SELECT position FROM automation_steps WHERE id = ? AND automation_id = ?")
      .get(stepId, automationId)) as { position: number | string } | null;
    if (!step) throw new UserError("Step not found.");
    const position = Number(step.position);
    await tx.prepare("DELETE FROM automation_steps WHERE id = ?").run(stepId);
    await tx
      .prepare("UPDATE automation_steps SET position = position - 1 WHERE automation_id = ? AND position > ?")
      .run(automationId, position);
    // Keep people who are part-way through pointing at the same step they were waiting for.
    await tx
      .prepare(
        `UPDATE automation_enrollments SET current_step = current_step - 1
         WHERE automation_id = ? AND status = 'active' AND current_step > ?`,
      )
      .run(automationId, position);
    await tx.prepare("UPDATE automations SET updated_at = ? WHERE id = ?").run(nowIso(), automationId);
  });
}

export async function moveStep(userId: string, automationId: string, stepId: string, direction: "up" | "down"): Promise<void> {
  requireNotActive(await requireAutomation(userId, automationId));
  const sql = await readySql();
  await sql.transaction(async (tx) => {
    const step = (await tx
      .prepare("SELECT position FROM automation_steps WHERE id = ? AND automation_id = ?")
      .get(stepId, automationId)) as { position: number | string } | null;
    if (!step) throw new UserError("Step not found.");
    const from = Number(step.position);
    const to = direction === "up" ? from - 1 : from + 1;
    const neighbour = (await tx
      .prepare("SELECT id FROM automation_steps WHERE automation_id = ? AND position = ?")
      .get(automationId, to)) as { id: string } | null;
    if (!neighbour) return;
    await tx.prepare("UPDATE automation_steps SET position = ? WHERE id = ?").run(to, stepId);
    await tx.prepare("UPDATE automation_steps SET position = ? WHERE id = ?").run(from, neighbour.id);
    await tx.prepare("UPDATE automations SET updated_at = ? WHERE id = ?").run(nowIso(), automationId);
  });
}

// ---------- status ----------

export async function activateAutomation(userId: string, id: string, origin: string): Promise<void> {
  const automation = await requireAutomation(userId, id);
  if (automation.status === "active") throw new UserError("This automation is already active.");
  if (!automation.listId) throw new UserError("Choose a list for the trigger.");
  const steps = await listSteps(userId, id);
  if (!steps.some((step) => step.kind === "email")) throw new UserError("Add at least one email step.");
  if (steps.some((step) => step.kind === "email" && !step.templateId)) {
    throw new UserError("An email step has lost its template. Remove it and add it again.");
  }
  const account = await getAccount(userId);
  const fromEmail = normalizeEmail(account.fromEmail || account.email);
  if (!isEmail(fromEmail)) throw new UserError("Add a valid from email in Settings.");
  if (!account.companyName.trim()) throw new UserError("Add your company name in Settings.");
  if (!account.postalAddress.trim()) throw new UserError("Add your postal address in Settings.");
  const now = nowIso();
  const cleanOrigin = origin.replace(/\/$/, "");
  const sql = await readySql();
  await sql.transaction(async (tx) => {
    // trigger_since is reset on every activation: only people who join the list from now on are enrolled.
    const changed = await tx
      .prepare(
        `UPDATE automations SET status = 'active', origin = ?, trigger_since = ?, updated_at = ?
         WHERE id = ? AND user_id = ? AND status != 'active'`,
      )
      .run(cleanOrigin, now, now, id, userId);
    if (changed === 0) throw new UserError("This automation is already active.");
    await tx
      .prepare("UPDATE campaigns SET from_name = ?, from_email = ?, reply_to = ?, origin = ?, updated_at = ? WHERE id = ?")
      .run(account.fromName, fromEmail, account.replyTo, cleanOrigin, now, automation.campaignId);
  });
}

export async function pauseAutomation(userId: string, id: string): Promise<void> {
  const sql = await readySql();
  const changed = await sql
    .prepare("UPDATE automations SET status = 'paused', updated_at = ? WHERE id = ? AND user_id = ? AND status = 'active'")
    .run(nowIso(), id, userId);
  if (changed === 0) throw new UserError("That automation is not running.");
}

// ---------- enrollments (read side) ----------

export async function enrollmentCounts(automationId: string): Promise<EnrollmentCounts> {
  const sql = await readySql();
  const e = (await sql
    .prepare(
      `SELECT COUNT(*) AS total,
         SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN status = 'stopped' THEN 1 ELSE 0 END) AS stopped
       FROM automation_enrollments WHERE automation_id = ?`,
    )
    .get(automationId)) as Record<string, number | string | null>;
  const m = (await sql
    .prepare(
      `SELECT
         SUM(CASE WHEN r.status = 'sent' THEN 1 ELSE 0 END) AS sent,
         SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN r.status IN ('pending', 'sending') THEN 1 ELSE 0 END) AS waiting
       FROM recipients r JOIN automations a ON a.campaign_id = r.campaign_id WHERE a.id = ?`,
    )
    .get(automationId)) as Record<string, number | string | null>;
  return {
    total: Number(e.total ?? 0),
    active: Number(e.active ?? 0),
    completed: Number(e.completed ?? 0),
    stopped: Number(e.stopped ?? 0),
    emailsSent: Number(m.sent ?? 0),
    emailsFailed: Number(m.failed ?? 0),
    emailsWaiting: Number(m.waiting ?? 0),
  };
}

export async function recentEnrollments(userId: string, automationId: string, limit = 50): Promise<EnrollmentRow[]> {
  const sql = await readySql();
  const rows = (await sql
    .prepare(
      `SELECT e.id, c.email, e.status, e.current_step, e.next_run_at, e.stop_reason, e.created_at, e.completed_at
       FROM automation_enrollments e
       JOIN automations a ON a.id = e.automation_id
       JOIN contacts c ON c.id = e.contact_id
       WHERE e.automation_id = ? AND a.user_id = ? ORDER BY e.created_at DESC, e.id LIMIT ?`,
    )
    .all(automationId, userId, limit)) as {
    id: string;
    email: string;
    status: string;
    current_step: number | string;
    next_run_at: string;
    stop_reason: string;
    created_at: string;
    completed_at: string | null;
  }[];
  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    status: row.status as EnrollmentRow["status"],
    currentStep: Number(row.current_step),
    nextRunAt: row.next_run_at,
    stopReason: row.stop_reason,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  }));
}

export async function latestDeliveries(
  userId: string,
  automationId: string,
  limit = 10,
): Promise<{ id: string; email: string; subject: string; createdAt: string }[]> {
  const sql = await readySql();
  const rows = await sql
    .prepare(
      `SELECT d.id, d.to_email, d.subject, d.created_at
       FROM deliveries d
       JOIN recipients r ON r.id = d.recipient_id
       JOIN automations a ON a.campaign_id = r.campaign_id
       WHERE a.id = ? AND a.user_id = ? ORDER BY d.created_at DESC LIMIT ?`,
    )
    .all(automationId, userId, limit);
  return rows.map((row) => {
    const item = row as { id: string; to_email: string; subject: string; created_at: string };
    return { id: item.id, email: item.to_email, subject: item.subject, createdAt: item.created_at };
  });
}

// ---------- worker ----------

/**
 * Enrolls subscribed people who joined an active automation's list since it was activated.
 * Safe to run any number of times: the unique (automation, contact) key makes re-enrolling a no-op.
 */
export async function enrollNewMembers(limit = 200): Promise<number> {
  const sql = await readySql();
  const automations = (await sql
    .prepare(
      "SELECT id, list_id, trigger_since FROM automations WHERE status = 'active' AND list_id IS NOT NULL AND trigger_since IS NOT NULL",
    )
    .all()) as { id: string; list_id: string; trigger_since: string }[];
  let enrolled = 0;
  for (const automation of automations) {
    const people = (await sql
      .prepare(
        `SELECT c.id FROM list_contacts lc
         JOIN contacts c ON c.id = lc.contact_id
         WHERE lc.list_id = ? AND lc.created_at >= ? AND c.status = 'subscribed'
           AND NOT EXISTS (
             SELECT 1 FROM automation_enrollments e WHERE e.automation_id = ? AND e.contact_id = c.id
           )
         ORDER BY lc.created_at LIMIT ?`,
      )
      .all(automation.list_id, automation.trigger_since, automation.id, limit)) as { id: string }[];
    if (people.length === 0) continue;
    const now = nowIso();
    enrolled += await sql.transaction(async (tx) => {
      const insert = tx.prepare(
        `INSERT INTO automation_enrollments (id, automation_id, contact_id, status, current_step, next_run_at, created_at, updated_at)
         VALUES (?, ?, ?, 'active', 0, ?, ?, ?)
         ON CONFLICT (automation_id, contact_id) DO NOTHING`,
      );
      let added = 0;
      for (const person of people) {
        added += await insert.run(newId(), automation.id, person.id, now, now, now);
      }
      return added;
    });
  }
  return enrolled;
}

type DueRow = {
  automation_id: string;
  campaign_id: string;
  contact_id: string;
  contact_status: string;
  email: string;
  first_name: string;
  last_name: string;
  unsub_token: string;
};

async function finish(tx: Sql, id: string, status: "completed" | "stopped", reason: string, now: string): Promise<void> {
  await tx
    .prepare(
      `UPDATE automation_enrollments SET status = ?, stop_reason = ?, updated_at = ?,
         completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END WHERE id = ?`,
    )
    .run(status, reason, now, status, now, id);
}

/**
 * Runs one step for one enrollment. Returns false when someone else already did (or nothing was due).
 * The compare-and-swap UPDATE on (status, current_step, next_run_at) takes the row lock first, so a second
 * worker that read the same row blocks, re-checks, matches nothing, and skips. All writes share one transaction.
 */
export async function advanceEnrollment(enrollmentId: string, expectedStep: number): Promise<boolean> {
  const sql = await readySql();
  return sql.transaction(async (tx) => {
    const now = nowIso();
    const claimed = await tx
      .prepare(
        `UPDATE automation_enrollments SET updated_at = ?
         WHERE id = ? AND status = 'active' AND current_step = ? AND next_run_at <= ?
           AND EXISTS (SELECT 1 FROM automations a WHERE a.id = automation_enrollments.automation_id AND a.status = 'active')`,
      )
      .run(now, enrollmentId, expectedStep, now);
    if (claimed === 0) return false;
    const row = (await tx
      .prepare(
        `SELECT e.automation_id, a.campaign_id, c.id AS contact_id, c.status AS contact_status, c.email, c.first_name, c.last_name, c.unsub_token
         FROM automation_enrollments e
         JOIN automations a ON a.id = e.automation_id
         JOIN contacts c ON c.id = e.contact_id
         WHERE e.id = ?`,
      )
      .get(enrollmentId)) as DueRow | null;
    if (!row) return true;
    if (row.contact_status !== "subscribed") {
      await finish(tx, enrollmentId, "stopped", row.contact_status === "unsubscribed" ? "unsubscribed" : "contact removed", now);
      return true;
    }
    const step = (await tx
      .prepare("SELECT id, kind, template_id, delay_minutes FROM automation_steps WHERE automation_id = ? AND position = ?")
      .get(row.automation_id, expectedStep)) as
      | { id: string; kind: string; template_id: string | null; delay_minutes: number | string }
      | null;
    if (!step) {
      await finish(tx, enrollmentId, "completed", "", now);
      return true;
    }
    let nextRun = now;
    if (step.kind === "delay") {
      nextRun = addMinutesIso(Number(step.delay_minutes), new Date(now));
    } else {
      const already = await tx
        .prepare("SELECT 1 AS found FROM automation_sends WHERE enrollment_id = ? AND step_id = ?")
        .get(enrollmentId, step.id);
      if (!already) {
        const recipientId = newId();
        // A step whose template was deleted is recorded as a failure instead of being silently skipped.
        const missing = step.template_id === null;
        await tx
          .prepare(
            `INSERT INTO recipients (id, campaign_id, contact_id, email, first_name, last_name, unsub_token, token, status, error, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            recipientId,
            row.campaign_id,
            row.contact_id,
            row.email,
            row.first_name,
            row.last_name,
            row.unsub_token,
            newToken(),
            missing ? "failed" : "pending",
            missing ? "The template for this step no longer exists." : "",
            now,
          );
        await tx
          .prepare("INSERT INTO automation_sends (enrollment_id, step_id, recipient_id, created_at) VALUES (?, ?, ?, ?)")
          .run(enrollmentId, step.id, recipientId, now);
      }
    }
    const more = (await tx
      .prepare("SELECT COUNT(*) AS n FROM automation_steps WHERE automation_id = ? AND position > ?")
      .get(row.automation_id, expectedStep)) as CountRow;
    if (Number(more.n) === 0) {
      await finish(tx, enrollmentId, "completed", "", now);
    } else {
      await tx
        .prepare("UPDATE automation_enrollments SET current_step = ?, next_run_at = ?, updated_at = ? WHERE id = ?")
        .run(expectedStep + 1, nextRun, now, enrollmentId);
    }
    return true;
  });
}

export async function processDueEnrollments(limit = 50): Promise<number> {
  const sql = await readySql();
  const due = (await sql
    .prepare(
      `SELECT e.id, e.current_step FROM automation_enrollments e
       JOIN automations a ON a.id = e.automation_id
       WHERE e.status = 'active' AND a.status = 'active' AND e.next_run_at <= ?
       ORDER BY e.next_run_at LIMIT ?`,
    )
    .all(nowIso(), limit)) as { id: string; current_step: number | string }[];
  let done = 0;
  for (const item of due) {
    if (await advanceEnrollment(item.id, Number(item.current_step))) done += 1;
  }
  return done;
}

/** One automation pass for the worker. Returns the number of enrollments created or advanced. */
export async function runAutomationCycle(): Promise<number> {
  const enrolled = await enrollNewMembers();
  const advanced = await processDueEnrollments();
  return enrolled + advanced;
}
