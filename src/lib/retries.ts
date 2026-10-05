import { readySql } from "./sql";
import { nowIso } from "./time";

/** Max SMTP attempts (initial try + retries) before a recipient is marked failed. */
export const MAX_SEND_ATTEMPTS = 5;

/**
 * Base delay for exponential backoff. Override with POSTROOM_RETRY_BASE_MS in tests.
 * Attempt 1 → base, 2 → 2×base, 3 → 4×base, … capped at 30 minutes.
 */
export function retryBaseMs(): number {
  const n = Number(process.env.POSTROOM_RETRY_BASE_MS);
  return Number.isFinite(n) && n >= 0 ? n : 60_000;
}

export function backoffMs(attemptCountAfterFailure: number): number {
  const base = retryBaseMs();
  const exp = Math.min(30 * 60_000, base * 2 ** Math.max(0, attemptCountAfterFailure - 1));
  return exp;
}

export type ScheduleRetryResult = {
  scheduled: boolean;
  attemptCount: number;
  nextAttemptAt: string | null;
};

/**
 * Records a transient failure and puts the recipient back on the pending queue after a backoff.
 * Returns scheduled:false when the attempt cap is reached (caller should mark failed).
 * Idempotent with respect to claim CAS: only rows currently `sending` are returned to `pending`.
 */
export async function scheduleTransientRetry(recipientId: string, error: string): Promise<ScheduleRetryResult> {
  const sql = await readySql();
  const now = nowIso();
  return sql.transaction(async (tx) => {
    const row = (await tx
      .prepare("SELECT attempt_count FROM recipient_attempts WHERE recipient_id = ?")
      .get(recipientId)) as { attempt_count: number } | null;
    const previous = Number(row?.attempt_count ?? 0);
    const attemptCount = previous + 1;
    if (attemptCount >= MAX_SEND_ATTEMPTS) {
      await tx
        .prepare(
          `INSERT INTO recipient_attempts (recipient_id, attempt_count, next_attempt_at, last_error)
           VALUES (?, ?, NULL, ?)
           ON CONFLICT (recipient_id) DO UPDATE SET attempt_count = excluded.attempt_count,
             next_attempt_at = NULL, last_error = excluded.last_error`,
        )
        .run(recipientId, attemptCount, error.slice(0, 500));
      return { scheduled: false, attemptCount, nextAttemptAt: null };
    }
    const delay = backoffMs(attemptCount);
    const nextAttemptAt = new Date(Date.now() + delay).toISOString();
    await tx
      .prepare(
        `INSERT INTO recipient_attempts (recipient_id, attempt_count, next_attempt_at, last_error)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (recipient_id) DO UPDATE SET attempt_count = excluded.attempt_count,
           next_attempt_at = excluded.next_attempt_at, last_error = excluded.last_error`,
      )
      .run(recipientId, attemptCount, nextAttemptAt, error.slice(0, 500));
    const changed = await tx
      .prepare(
        `UPDATE recipients SET status = 'pending', error = ?, claimed_at = NULL
         WHERE id = ? AND status = 'sending'`,
      )
      .run(`Retry ${attemptCount}/${MAX_SEND_ATTEMPTS}: ${error}`.slice(0, 500), recipientId);
    if (changed === 0) {
      // Another worker finished or released the claim; keep attempt bookkeeping but do not force pending.
      return { scheduled: true, attemptCount, nextAttemptAt };
    }
    return { scheduled: true, attemptCount, nextAttemptAt };
  });
}

/** Clears retry state after a successful send (optional housekeeping). */
export async function clearRecipientAttempts(recipientId: string): Promise<void> {
  const sql = await readySql();
  await sql.prepare("DELETE FROM recipient_attempts WHERE recipient_id = ?").run(recipientId);
}

export async function getRecipientAttempts(recipientId: string): Promise<{ attemptCount: number; nextAttemptAt: string | null; lastError: string } | null> {
  const sql = await readySql();
  const row = (await sql
    .prepare("SELECT attempt_count, next_attempt_at, last_error FROM recipient_attempts WHERE recipient_id = ?")
    .get(recipientId)) as { attempt_count: number; next_attempt_at: string | null; last_error: string } | null;
  if (!row) return null;
  return { attemptCount: Number(row.attempt_count), nextAttemptAt: row.next_attempt_at, lastError: row.last_error };
}
