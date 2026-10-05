"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { assertAuthAllowed, clearAuthFailures, recordAuthFailure } from "../abuse";
import { log } from "../log";
import { requestOrigin } from "../origin";
import { changePassword, requestPasswordReset, resetPasswordWithToken } from "../password-reset";
import { sendVerificationEmail } from "../email-verification";
import { createSession, createUser, deleteAccount, deleteSession, verifyPassword } from "../queries";
import { SESSION_COOKIE, requireUser, setSessionCookie } from "../session";
import { UserError } from "../user-error";
import { normalizeEmail, safeNext, withMessage } from "../validators";

const GENERIC_AUTH = "Email or password is wrong.";
const GENERIC_LIMIT = "Too many attempts. Wait a few minutes and try again.";

async function clientIp(): Promise<string> {
  const list = await headers();
  return list.get("x-real-ip")?.trim() || list.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

export async function signupAction(formData: FormData): Promise<void> {
  const next = safeNext(String(formData.get("next") || "/app"));
  const email = String(formData.get("email") || "");
  const ip = await clientIp();
  try {
    await assertAuthAllowed("signup", { email, ip });
    const user = await createUser({
      name: String(formData.get("name") || ""),
      email,
      password: String(formData.get("password") || ""),
    });
    await setSessionCookie(await createSession(user.id));
    try {
      await sendVerificationEmail({ userId: user.id, origin: await requestOrigin(), ip });
    } catch {
      // Account exists; verification can be resent from Settings.
    }
    log.info("signup", { userId: user.id, ip });
  } catch (error) {
    if (error instanceof UserError) redirect(withMessage("/signup", "error", error.message));
    throw error;
  }
  redirect(withMessage(next, "notice", "Check your email for a verification link before sending campaigns."));
}

export async function resendVerificationAction(): Promise<void> {
  const user = await requireUser();
  try {
    await sendVerificationEmail({ userId: user.id, origin: await requestOrigin(), ip: await clientIp() });
  } catch (error) {
    if (error instanceof UserError) redirect(withMessage("/app/settings#verify", "error", error.message));
    throw error;
  }
  redirect(withMessage("/app/settings#verify", "notice", "Verification email sent. Check your inbox (or the server console in development)."));
}

export async function loginAction(formData: FormData): Promise<void> {
  const email = String(formData.get("email") || "");
  const next = safeNext(String(formData.get("next") || "/app"));
  const ip = await clientIp();
  try {
    await assertAuthAllowed("login", { email, ip });
  } catch (error) {
    if (error instanceof UserError) redirect(withMessage("/login", "error", GENERIC_LIMIT));
    throw error;
  }
  const user = await verifyPassword(email, String(formData.get("password") || ""));
  if (!user) {
    await recordAuthFailure({ email, ip });
    log.info("login_failed", { email: normalizeEmail(email), ip });
    redirect(withMessage(`/login?next=${encodeURIComponent(next)}`, "error", GENERIC_AUTH));
  }
  await clearAuthFailures({ email, ip });
  await setSessionCookie(await createSession(user.id));
  log.info("login", { userId: user.id, ip });
  redirect(next);
}

export async function logoutAction(): Promise<void> {
  const jar = await cookies();
  const id = jar.get(SESSION_COOKIE)?.value;
  if (id) await deleteSession(id);
  jar.delete(SESSION_COOKIE);
  redirect("/");
}

export async function deleteAccountAction(): Promise<void> {
  const user = await requireUser();
  const jar = await cookies();
  const id = jar.get(SESSION_COOKIE)?.value;
  log.info("account_deleted", { userId: user.id });
  await deleteAccount(user.id);
  if (id) await deleteSession(id);
  jar.delete(SESSION_COOKIE);
  redirect("/");
}

/** Always shows the same confirmation whether or not the email has an account. */
export async function forgotPasswordAction(formData: FormData): Promise<void> {
  const email = String(formData.get("email") || "");
  const ip = await clientIp();
  try {
    await assertAuthAllowed("forgot_password", { email, ip });
    await requestPasswordReset({
      email,
      origin: await requestOrigin(),
      ipKey: ip,
    });
  } catch (error) {
    if (error instanceof UserError) redirect(withMessage("/forgot-password", "error", error.message));
    throw error;
  }
  redirect(
    withMessage(
      "/forgot-password",
      "notice",
      "If an account exists for that email, we sent a link to reset the password. It expires in one hour.",
    ),
  );
}

export async function resetPasswordAction(formData: FormData): Promise<void> {
  const token = String(formData.get("token") || "");
  try {
    await resetPasswordWithToken({
      token,
      password: String(formData.get("password") || ""),
      ipKey: await clientIp(),
    });
  } catch (error) {
    if (error instanceof UserError) {
      redirect(withMessage(`/reset-password?token=${encodeURIComponent(token)}`, "error", error.message));
    }
    throw error;
  }
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  redirect(withMessage("/login", "notice", "Password updated. Sign in with your new password."));
}

export async function changePasswordAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  try {
    await changePassword(user.id, String(formData.get("currentPassword") || ""), String(formData.get("newPassword") || ""));
  } catch (error) {
    if (error instanceof UserError) redirect(withMessage("/app/settings#password", "error", error.message));
    throw error;
  }
  await setSessionCookie(await createSession(user.id));
  redirect(withMessage("/app/settings#password", "notice", "Password changed. Other devices were signed out."));
}
