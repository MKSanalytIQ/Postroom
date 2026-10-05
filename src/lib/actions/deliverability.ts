"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requestOrigin } from "../origin";
import {
  addManualSuppressions,
  clearWebhookToken,
  removeSuppression,
  rotateWebhookToken,
  saveDkimSelector,
} from "../deliverability";
import { requireUser } from "../session";
import { UserError } from "../user-error";
import { withMessage } from "../validators";

export async function addSuppressionsAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const back = "/app/suppressions";
  try {
    const result = await addManualSuppressions(user.id, String(formData.get("emails") || ""), String(formData.get("detail") || "").trim());
    const parts = [
      `${result.added} added`,
      result.existing ? `${result.existing} already listed` : "",
      result.invalid ? `${result.invalid} not valid` : "",
    ].filter(Boolean);
    redirect(withMessage(back, "notice", `${parts.join(", ")}. They will not be mailed again.`));
  } catch (error) {
    if (error instanceof UserError) redirect(withMessage(back, "error", error.message));
    throw error;
  }
}

export async function removeSuppressionAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  try {
    await removeSuppression(user.id, String(formData.get("id") || ""));
  } catch (error) {
    if (error instanceof UserError) redirect(withMessage("/app/suppressions", "error", error.message));
    throw error;
  }
  redirect(withMessage("/app/suppressions", "notice", "Removed. That address can be mailed again."));
}

export async function checkSenderAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  try {
    await saveDkimSelector(user.id, String(formData.get("selector") || ""));
  } catch (error) {
    if (error instanceof UserError) redirect(withMessage("/app/settings#sender", "error", error.message));
    throw error;
  }
  redirect("/app/settings?check=1#sender");
}

export type WebhookTokenState = { token: string | null; webhookUrl: string; endpoint: string };

/** Makes a new token and hands the plaintext back to the form once. It is never stored or put in a URL. */
export async function rotateWebhookTokenAction(): Promise<WebhookTokenState> {
  const user = await requireUser();
  const token = await rotateWebhookToken(user.id);
  revalidatePath("/app/settings");
  const endpoint = `${await requestOrigin()}/api/webhooks/deliverability`;
  return { token, endpoint, webhookUrl: `${endpoint}?token=${token}` };
}

export async function clearWebhookTokenAction(): Promise<void> {
  const user = await requireUser();
  await clearWebhookToken(user.id);
  redirect(withMessage("/app/settings#bounces", "notice", "Webhook turned off."));
}
