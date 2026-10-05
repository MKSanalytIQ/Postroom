"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { requestOrigin } from "../origin";
import { changePassword, requestPasswordReset, resetPasswordWithToken } from "../password-reset";
import { createSession, createUser, deleteAccount, deleteSession, verifyPassword } from "../queries";
import { SESSION_COOKIE, requireUser, setSessionCookie } from "../session";
import { UserError } from "../user-error";
import { normalizeEmail, safeNext, withMessage } from "../validators";

const attempts = new Map<string, { count: number; reset: number }>();

function tooMany(email: string): boolean {
  const now = Date.now();
  const key = normalizeEmail(email);
  const row = attempts.get(key);
  if (!row || row.reset < now) {
    attempts.set(key, { count: 1, reset: now + 15 * 60 * 1000 });
    return false;
  }
  row.count += 1;
  return row.count > 8;
}

async function clientIp(): Promise<string> {
  const list = await headers();
  return list.get("x-real-ip")?.trim() || list.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

export async function signupAction(formData: FormData): Promise<void> {
  const next = safeNext(String(formData.get("next") || "/app"));
  try {
    const user = await createUser({
      name: String(formData.get("name") || ""),
      email: String(formData.get("email") || ""),
      password: String(formData.get("password") || ""),
    });
    await setSessionCookie(await createSession(user.id));
  } catch (error) {
    if (error instanceof UserError) redirect(withMessage("/signup", "error", error.message));
    throw error;
  }
  redirect(next);
}

export async function loginAction(formData: FormData): Promise<void> {
  const email = String(formData.get("email") || "");
  const next = safeNext(String(formData.get("next") || "/app"));
  if (tooMany(email)) {
    redirect(withMessage("/login", "error", "Too many sign-in attempts. Wait a few minutes and try again."));
  }
  const user = await verifyPassword(email, String(formData.get("password") || ""));
  if (!user) redirect(withMessage(`/login?next=${encodeURIComponent(next)}`, "error", "Email or password is wrong."));
  attempts.delete(normalizeEmail(email));
  await setSessionCookie(await createSession(user.id));
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
  await deleteAccount(user.id);
  if (id) await deleteSession(id);
  jar.delete(SESSION_COOKIE);
  redirect("/");
}

/** Always shows the same confirmation whether or not the email has an account. */
export async function forgotPasswordAction(formData: FormData): Promise<void> {
  try {
    await requestPasswordReset({
      email: String(formData.get("email") || ""),
      origin: await requestOrigin(),
      ipKey: await clientIp(),
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
  // All sessions were revoked; sign in again on this device.
  await setSessionCookie(await createSession(user.id));
  redirect(withMessage("/app/settings#password", "notice", "Password changed. Other devices were signed out."));
}
