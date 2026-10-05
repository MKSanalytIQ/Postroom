import { readySql } from "./sql";
import { nowIso } from "./time";
import { UserError } from "./user-error";
import { normalizeEmail } from "./validators";

export type AbuseAction = "login" | "signup" | "forgot_password";

type Limit = { limit: number; windowMs: number };

const LIMITS: Record<AbuseAction, { email?: Limit; ip: Limit }> = {
  login: { email: { limit: 10, windowMs: 15 * 60_000 }, ip: { limit: 30, windowMs: 15 * 60_000 } },
  signup: { email: { limit: 5, windowMs: 60 * 60_000 }, ip: { limit: 10, windowMs: 60 * 60_000 } },
  forgot_password: { email: { limit: 5, windowMs: 15 * 60_000 }, ip: { limit: 10, windowMs: 15 * 60_000 } },
};

/** Progressive lockout after consecutive failures on login (per email and per IP). */
function lockDurationMs(failures: number): number {
  if (failures >= 20) return 60 * 60_000;
  if (failures >= 12) return 15 * 60_000;
  if (failures >= 8) return 5 * 60_000;
  if (failures >= 5) return 60_000;
  return 0;
}

function windowStart(now: number, windowMs: number): number {
  // Store seconds so the value fits in a 32-bit INTEGER on Postgres.
  return Math.floor(Math.floor(now / windowMs) * windowMs / 1000);
}

async function bumpBucket(bucketKey: string, windowMs: number, limit: number): Promise<{ allowed: boolean; count: number; retryAfterSeconds: number }> {
  const sql = await readySql();
  const now = Date.now();
  const start = windowStart(now, windowMs);
  // Opportunistic cleanup of old windows (best-effort).
  await sql.prepare("DELETE FROM rate_limit_buckets WHERE window_start < ?").run(Math.floor((now - 7 * 24 * 60 * 60_000) / 1000));
  await sql
    .prepare(
      `INSERT INTO rate_limit_buckets (bucket_key, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT (bucket_key, window_start) DO UPDATE SET count = rate_limit_buckets.count + 1`,
    )
    .run(bucketKey, start);
  const row = (await sql
    .prepare("SELECT count FROM rate_limit_buckets WHERE bucket_key = ? AND window_start = ?")
    .get(bucketKey, start)) as { count: number };
  const count = Number(row.count);
  const windowEndMs = (start * 1000) + windowMs;
  const retryAfterSeconds = Math.max(1, Math.ceil((windowEndMs - now) / 1000));
  return { allowed: count <= limit, count, retryAfterSeconds };
}

async function getLockout(lockKey: string): Promise<{ failures: number; lockedUntil: string | null }> {
  const sql = await readySql();
  const row = (await sql.prepare("SELECT failures, locked_until FROM auth_lockouts WHERE lock_key = ?").get(lockKey)) as
    | { failures: number; locked_until: string | null }
    | null;
  return { failures: Number(row?.failures ?? 0), lockedUntil: row?.locked_until ?? null };
}

async function assertNotLocked(lockKey: string): Promise<void> {
  const { lockedUntil } = await getLockout(lockKey);
  if (lockedUntil && lockedUntil > nowIso()) {
    throw new UserError("Too many attempts. Wait a few minutes and try again.");
  }
}

/**
 * Call before handling a sensitive auth action. Throws a generic UserError when rate-limited or locked.
 * Does not reveal whether an email exists.
 */
export async function assertAuthAllowed(action: AbuseAction, input: { email?: string; ip: string }): Promise<void> {
  const ip = (input.ip || "unknown").slice(0, 80);
  const email = input.email ? normalizeEmail(input.email) : "";
  const cfg = LIMITS[action];

  await assertNotLocked(`ip:${ip}`);
  if (email) await assertNotLocked(`email:${email}`);

  const ipHit = await bumpBucket(`${action}:ip:${ip}`, cfg.ip.windowMs, cfg.ip.limit);
  if (!ipHit.allowed) throw new UserError("Too many attempts. Wait a few minutes and try again.");

  if (email && cfg.email) {
    const emailHit = await bumpBucket(`${action}:email:${email}`, cfg.email.windowMs, cfg.email.limit);
    if (!emailHit.allowed) throw new UserError("Too many attempts. Wait a few minutes and try again.");
  }
}

/** Record a failed login (wrong password). Progressive lockout on email + IP. */
export async function recordAuthFailure(input: { email: string; ip: string }): Promise<void> {
  const sql = await readySql();
  const now = nowIso();
  const keys = [`email:${normalizeEmail(input.email)}`, `ip:${(input.ip || "unknown").slice(0, 80)}`];
  for (const lockKey of keys) {
    const current = await getLockout(lockKey);
    const failures = current.failures + 1;
    const lockMs = lockDurationMs(failures);
    const lockedUntil = lockMs > 0 ? new Date(Date.now() + lockMs).toISOString() : null;
    await sql
      .prepare(
        `INSERT INTO auth_lockouts (lock_key, failures, locked_until, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (lock_key) DO UPDATE SET failures = excluded.failures, locked_until = excluded.locked_until, updated_at = excluded.updated_at`,
      )
      .run(lockKey, failures, lockedUntil, now);
  }
}

/** Clear lockout counters after a successful login. */
export async function clearAuthFailures(input: { email: string; ip: string }): Promise<void> {
  const sql = await readySql();
  await sql.prepare("DELETE FROM auth_lockouts WHERE lock_key = ? OR lock_key = ?").run(
    `email:${normalizeEmail(input.email)}`,
    `ip:${(input.ip || "unknown").slice(0, 80)}`,
  );
}

/** Test helper. */
export async function getAuthLockoutState(lockKey: string): Promise<{ failures: number; lockedUntil: string | null }> {
  return getLockout(lockKey);
}
