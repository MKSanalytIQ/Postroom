import { createHash, timingSafeEqual } from "crypto";
import { newToken } from "./crypto";
import { sendSystemMail } from "./system-mail";
import { readySql } from "./sql";
import { addMinutesIso, nowIso } from "./time";
import { UserError } from "./user-error";
import { assertAuthAllowed } from "./abuse";

const VERIFY_TTL_MINUTES = 60 * 24; // 24 hours

function hashToken(token: string): string {
  return createHash("sha256").update(`postroom-email-verify-v1:${token}`, "utf8").digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function escape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

/** True when the account may send campaigns / activate automations. */
export async function isEmailVerified(userId: string): Promise<boolean> {
  const sql = await readySql();
  const row = (await sql.prepare("SELECT email_verified_at FROM users WHERE id = ?").get(userId)) as
    | { email_verified_at: string | null }
    | null;
  return Boolean(row?.email_verified_at);
}

export async function requireEmailVerified(userId: string): Promise<void> {
  if (!(await isEmailVerified(userId))) {
    throw new UserError("Verify your email address before sending campaigns or activating automations.");
  }
}

export async function markEmailVerified(userId: string): Promise<void> {
  const sql = await readySql();
  await sql
    .prepare("UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?")
    .run(nowIso(), userId);
  await sql.prepare("DELETE FROM email_verification_tokens WHERE user_id = ?").run(userId);
}

/**
 * Creates a hashed expiring token and emails the link (SYSTEM_SMTP_* or console in dev).
 * Rate-limited via auth abuse buckets when ip is provided.
 */
export async function sendVerificationEmail(input: {
  userId: string;
  origin: string;
  ip?: string;
}): Promise<void> {
  const sql = await readySql();
  const user = (await sql.prepare("SELECT id, email, name, email_verified_at FROM users WHERE id = ?").get(input.userId)) as
    | { id: string; email: string; name: string; email_verified_at: string | null }
    | null;
  if (!user) throw new UserError("Account not found.");
  if (user.email_verified_at) return;

  if (input.ip) {
    await assertAuthAllowed("signup", { email: user.email, ip: input.ip });
  }

  const token = newToken();
  const tokenHash = hashToken(token);
  const now = nowIso();
  const expires = addMinutesIso(VERIFY_TTL_MINUTES);
  await sql.transaction(async (tx) => {
    await tx.prepare("DELETE FROM email_verification_tokens WHERE user_id = ? OR expires_at < ?").run(user.id, now);
    await tx
      .prepare("INSERT INTO email_verification_tokens (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .run(tokenHash, user.id, expires, now);
  });

  const link = `${input.origin.replace(/\/$/, "")}/verify-email?token=${token}`;
  await sendSystemMail({
    to: user.email,
    subject: "Verify your Postroom email",
    text: `Hi ${user.name || "there"},\n\nConfirm this email address for your Postroom account:\n\n${link}\n\nThis link expires in 24 hours.\n`,
    html: `<p>Hi ${escape(user.name || "there")},</p><p><a href="${escape(link)}">Verify your email</a> (expires in 24 hours).</p>`,
  });
}

export async function verifyEmailWithToken(token: string): Promise<void> {
  if (!token || token.length > 200) throw new UserError("This verification link is not valid or has expired.");
  const tokenHash = hashToken(token);
  const sql = await readySql();
  const row = (await sql
    .prepare("SELECT token_hash, user_id, expires_at, used_at FROM email_verification_tokens WHERE token_hash = ?")
    .get(tokenHash)) as { token_hash: string; user_id: string; expires_at: string; used_at: string | null } | null;

  if (!row || !safeEqualHex(row.token_hash, tokenHash) || row.used_at || row.expires_at < nowIso()) {
    throw new UserError("This verification link is not valid or has expired.");
  }

  const now = nowIso();
  await sql.transaction(async (tx) => {
    const used = await tx
      .prepare(
        "UPDATE email_verification_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at >= ?",
      )
      .run(now, tokenHash, now);
    if (used === 0) throw new UserError("This verification link is not valid or has expired.");
    await tx.prepare("UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?").run(now, row.user_id);
    await tx.prepare("DELETE FROM email_verification_tokens WHERE user_id = ?").run(row.user_id);
  });
}
