"use server";

import { redirect } from "next/navigation";
import { saveAccountSettings } from "../account-settings";
import { saveSendLimits } from "../send-limits";
import { smtpCredentials, updateSettings } from "../queries";
import { requireUser } from "../session";
import { verifySmtp } from "../send";
import { UserError } from "../user-error";
import { isEmail, normalizeEmail, withMessage } from "../validators";
import type { SettingsInput } from "../types";

function readSettings(formData: FormData, blankPassword: "keep" | "clear"): SettingsInput {
  const port = Number(formData.get("smtpPort") || 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new UserError("SMTP port must be between 1 and 65535.");
  }
  const fromEmail = String(formData.get("fromEmail") || "");
  const replyTo = String(formData.get("replyTo") || "");
  if (fromEmail.trim() && !isEmail(normalizeEmail(fromEmail))) throw new UserError("From email is not valid.");
  if (replyTo.trim() && !isEmail(normalizeEmail(replyTo))) throw new UserError("Reply-to email is not valid.");
  const name = String(formData.get("name") || "").trim();
  if (!name) throw new UserError("Enter your name.");
  const postedPass = String(formData.get("smtpPass") || "");
  return {
    name,
    companyName: String(formData.get("companyName") || ""),
    postalAddress: String(formData.get("postalAddress") || ""),
    fromName: String(formData.get("fromName") || ""),
    fromEmail,
    replyTo,
    smtpHost: String(formData.get("smtpHost") || ""),
    smtpPort: port,
    smtpSecure: formData.get("smtpSecure") === "1",
    smtpUser: String(formData.get("smtpUser") || ""),
    smtpPass: postedPass ? postedPass : blankPassword === "keep" ? null : "",
  };
}

export async function saveSettingsAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  try {
    await updateSettings(user.id, readSettings(formData, "keep"));
  } catch (error) {
    if (error instanceof UserError) redirect(withMessage("/app/settings", "error", error.message));
    throw error;
  }
  redirect(withMessage("/app/settings", "notice", "Settings saved."));
}

export async function testSmtpAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  try {
    const input = readSettings(formData, "keep");
    if (!input.smtpHost.trim()) throw new UserError("Add an SMTP host first.");
    let pass = input.smtpPass ?? "";
    if (!pass) pass = (await smtpCredentials(user.id)).pass;
    await verifySmtp({
      host: input.smtpHost.trim(),
      port: input.smtpPort,
      secure: input.smtpSecure,
      user: input.smtpUser.trim(),
      pass,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Connection failed.";
    redirect(withMessage("/app/settings", "error", message));
  }
  redirect(withMessage("/app/settings", "notice", "SMTP connection succeeded. Save settings if you have not yet."));
}

export async function saveSendLimitsAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  try {
    await saveSendLimits(user.id, {
      perSecond: Number(formData.get("perSecond")),
      perMinute: Number(formData.get("perMinute")),
      perHour: Number(formData.get("perHour")),
      perDay: Number(formData.get("perDay")),
    });
  } catch (error) {
    if (error instanceof UserError) redirect(withMessage("/app/settings#sending", "error", error.message));
    throw error;
  }
  redirect(withMessage("/app/settings#sending", "notice", "Send rate limits saved."));
}

export async function saveAccountSettingsAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  try {
    await saveAccountSettings(user.id, {
      timezone: String(formData.get("timezone") || "UTC"),
      softBounceThreshold: Number(formData.get("softBounceThreshold")),
      softBounceWindowDays: Number(formData.get("softBounceWindowDays")),
    });
  } catch (error) {
    if (error instanceof UserError) redirect(withMessage("/app/settings#account-prefs", "error", error.message));
    throw error;
  }
  redirect(withMessage("/app/settings#account-prefs", "notice", "Account preferences saved."));
}
