import bcrypt from "bcryptjs";
import { createHash, timingSafeEqual } from "crypto";
import { newToken } from "./crypto";
import { sendSystemMail } from "./system-mail";
import { readySql } from "./sql";
import { addMinutesIso, nowIso } from "./time";
import { UserError } from "./user-error";
import { isEmail, normalizeEmail } from "./validators";
import { createRateLimiter } from "./rate-limit";

const RESET_TTL_MINUTES = 60;
const requests = createRateLimiter(5, 15 * 60_000);
const resets = createRateLimiter(10, 15 * 60_000);

function hashToken(token: string): string {
  return createHash("sha256").update(`postroom-password-reset-v1:${token}`, "utf8").digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export type RequestResetResult = { ok: true };

/**
 * Starts a password reset. Always returns ok (no user enumeration). Rate-limited by email and by ipKey.
 */
export async function requestPasswordReset(input: {
  email: string;
  origin: string;
  ipKey: string;
}): Promise<RequestResetResult> {
  const email = normalizeEmail(input.email);
  if (!requests.take(`email:${email}`).allowed || !requests.take(`ip:${input.ipKey || "unknown"}`).allowed) {
    throw new UserError("Too many reset requests. Wait a few minutes and try again.");
  }
  if (!isEmail(email)) return { ok: true };

  const sql = await readySql();
  const user = (await sql.prepare("SELECT id, email, name FROM users WHERE email = ?").get(email)) as
    | { id: string; email: string; name: string }
    | null;
  if (!user) return { ok: true };

  const token = newToken();
  const tokenHash = hashToken(token);
  const now = nowIso();
  const expires = addMinutesIso(RESET_TTL_MINUTES);
  await sql.transaction(async (tx) => {
    await tx.prepare("DELETE FROM password_reset_tokens WHERE user_id = ? OR expires_at < ?").run(user.id, now);
    await tx
      .prepare("INSERT INTO password_reset_tokens (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .run(tokenHash, user.id, expires, now);
  });

  const link = `${input.origin.replace(/\/$/, "")}/reset-password?token=${token}`;
  await sendSystemMail({
    to: user.email,
    subject: "Reset your Postroom password",
    text: `Hi ${user.name || "there"},\n\nUse this link within ${RESET_TTL_MINUTES} minutes to choose a new password:\n\n${link}\n\nIf you did not ask for this, you can ignore this message.\n`,
    html: `<p>Hi ${escape(user.name || "there")},</p><p><a href="${escape(link)}">Choose a new password</a> (expires in ${RESET_TTL_MINUTES} minutes).</p><p>If you did not ask for this, ignore this message.</p>`,
  });
  return { ok: true };
}

function escape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

export async function resetPasswordWithToken(input: {
  token: string;
  password: string;
  ipKey: string;
}): Promise<void> {
  if (!resets.take(input.ipKey || "unknown").allowed) {
    throw new UserError("Too many attempts. Wait a few minutes and try again.");
  }
  if (!input.token || input.token.length > 200) throw new UserError("This reset link is not valid or has expired.");
  if (input.password.length < 8) throw new UserError("Use at least 8 characters for the password.");

  const tokenHash = hashToken(input.token);
  const sql = await readySql();
  const row = (await sql
    .prepare("SELECT token_hash, user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = ?")
    .get(tokenHash)) as { token_hash: string; user_id: string; expires_at: string; used_at: string | null } | null;

  if (!row || !safeEqualHex(row.token_hash, tokenHash) || row.used_at || row.expires_at < nowIso()) {
    throw new UserError("This reset link is not valid or has expired.");
  }

  const passwordHash = bcrypt.hashSync(input.password, 10);
  const now = nowIso();
  await sql.transaction(async (tx) => {
    const used = await tx
      .prepare("UPDATE password_reset_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at >= ?")
      .run(now, tokenHash, now);
    if (used === 0) throw new UserError("This reset link is not valid or has expired.");
    await tx.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, row.user_id);
    await tx.prepare("DELETE FROM sessions WHERE user_id = ?").run(row.user_id);
    await tx.prepare("DELETE FROM password_reset_tokens WHERE user_id = ?").run(row.user_id);
  });
}

export async function changePassword(userId: string, currentPassword: string, nextPassword: string): Promise<void> {
  if (nextPassword.length < 8) throw new UserError("Use at least 8 characters for the password.");
  const sql = await readySql();
  const row = (await sql.prepare("SELECT password_hash FROM users WHERE id = ?").get(userId)) as { password_hash: string } | null;
  if (!row || !bcrypt.compareSync(currentPassword, row.password_hash)) {
    throw new UserError("Current password is wrong.");
  }
  const passwordHash = bcrypt.hashSync(nextPassword, 10);
  await sql.transaction(async (tx) => {
    await tx.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, userId);
    await tx.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  });
}

/** Test helper: peek whether a reset token row exists for an email (does not reveal via public API). */
export async function countActiveResetTokens(userId: string): Promise<number> {
  const sql = await readySql();
  const row = (await sql
    .prepare("SELECT COUNT(*) AS n FROM password_reset_tokens WHERE user_id = ? AND used_at IS NULL AND expires_at >= ?")
    .get(userId, nowIso())) as { n: number | string };
  return Number(row.n);
}

