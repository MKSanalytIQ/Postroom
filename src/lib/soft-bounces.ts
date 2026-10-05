import { addSuppression } from "./deliverability";
import { getAccountSettings } from "./account-settings";
import { newId } from "./crypto";
import { readySql } from "./sql";
import { nowIso } from "./time";
import { normalizeEmail, isEmail } from "./validators";

export type SoftBounceCount = { email: string; count: number; lastAt: string };

/**
 * Records a soft/transient bounce. After N events for the address within the account window
 * (default 3 in 30 days), the address is auto-suppressed with reason soft_bounce.
 */
export async function recordSoftBounce(input: {
  userId: string;
  email: string;
  source: "smtp" | "webhook";
  detail?: string;
}): Promise<{ count: number; suppressed: boolean }> {
  const email = normalizeEmail(input.email);
  if (!isEmail(email)) return { count: 0, suppressed: false };

  const settings = await getAccountSettings(input.userId);
  const sql = await readySql();
  const now = nowIso();
  const windowStart = new Date(Date.now() - settings.softBounceWindowDays * 86_400_000).toISOString();

  await sql
    .prepare(
      `INSERT INTO soft_bounce_events (id, user_id, email, source, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(newId(), input.userId, email, input.source, (input.detail ?? "").slice(0, 500), now);

  const row = (await sql
    .prepare(
      `SELECT COUNT(*) AS n FROM soft_bounce_events
       WHERE user_id = ? AND email = ? AND created_at >= ?`,
    )
    .get(input.userId, email, windowStart)) as { n: number | string };
  const count = Number(row.n);

  let suppressed = false;
  if (count >= settings.softBounceThreshold) {
    suppressed = await addSuppression(input.userId, email, "soft_bounce", {
      detail: `Auto-suppressed after ${count} soft bounces within ${settings.softBounceWindowDays} days. ${input.detail ?? ""}`.slice(
        0,
        500,
      ),
      source: input.source === "webhook" ? "webhook" : "smtp",
    });
  }
  return { count, suppressed };
}

export async function softBounceCountFor(userId: string, email: string): Promise<number> {
  const settings = await getAccountSettings(userId);
  const windowStart = new Date(Date.now() - settings.softBounceWindowDays * 86_400_000).toISOString();
  const sql = await readySql();
  const row = (await sql
    .prepare(
      `SELECT COUNT(*) AS n FROM soft_bounce_events
       WHERE user_id = ? AND email = ? AND created_at >= ?`,
    )
    .get(userId, normalizeEmail(email), windowStart)) as { n: number | string };
  return Number(row.n);
}

/** Recent soft-bounce tallies for contacts/suppressions UI (top N by count). */
export async function listSoftBounceCounts(userId: string, limit = 50): Promise<SoftBounceCount[]> {
  const settings = await getAccountSettings(userId);
  const windowStart = new Date(Date.now() - settings.softBounceWindowDays * 86_400_000).toISOString();
  const sql = await readySql();
  const rows = (await sql
    .prepare(
      `SELECT email, COUNT(*) AS n, MAX(created_at) AS last_at
       FROM soft_bounce_events
       WHERE user_id = ? AND created_at >= ?
       GROUP BY email
       ORDER BY n DESC, last_at DESC
       LIMIT ?`,
    )
    .all(userId, windowStart, limit)) as { email: string; n: number | string; last_at: string }[];
  return rows.map((row) => ({ email: row.email, count: Number(row.n), lastAt: row.last_at }));
}
