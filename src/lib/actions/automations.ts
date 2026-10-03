"use server";

import { redirect } from "next/navigation";
import {
  activateAutomation,
  addDelayStep,
  addEmailStep,
  createAutomation,
  deleteAutomation,
  moveStep,
  pauseAutomation,
  removeStep,
  saveRules,
  updateAutomation,
} from "../automations";
import { getDeliverabilitySettings } from "../deliverability";
import { senderWarnings } from "../dns-check";
import { requestOrigin } from "../origin";
import { requireUser } from "../session";
import { UserError } from "../user-error";
import { withMessage } from "../validators";

function field(formData: FormData, name: string): string {
  return String(formData.get(name) || "");
}

/** Runs an edit, then returns to the automation page with a notice, or with the error if it was a UserError. */
async function editAutomation(formData: FormData, notice: string, change: (userId: string, id: string) => Promise<void>): Promise<void> {
  const user = await requireUser();
  const id = field(formData, "id");
  try {
    await change(user.id, id);
  } catch (error) {
    if (error instanceof UserError) redirect(withMessage(`/app/automations/${id}`, "error", error.message));
    throw error;
  }
  redirect(withMessage(`/app/automations/${id}`, "notice", notice));
}

export async function createAutomationAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  try {
    const id = await createAutomation(user.id, {
      name: field(formData, "name"),
      listId: field(formData, "listId") || null,
    });
    redirect(`/app/automations/${id}`);
  } catch (error) {
    if (error instanceof UserError) redirect(withMessage("/app/automations/new", "error", error.message));
    throw error;
  }
}

export async function updateAutomationAction(formData: FormData): Promise<void> {
  await editAutomation(formData, "Automation saved.", (userId, id) =>
    updateAutomation(userId, id, { name: field(formData, "name"), listId: field(formData, "listId") || null }),
  );
}

export async function saveRulesAction(formData: FormData): Promise<void> {
  await editAutomation(formData, "Rules saved.", (userId, id) =>
    saveRules(userId, id, {
      exitOnClick: formData.get("exitOnClick") === "on",
      exitListId: field(formData, "exitListId") || null,
      windowEnabled: formData.get("windowEnabled") === "on",
      windowDays: formData.getAll("days").map((day) => Number(day)),
      windowStartHour: Number(field(formData, "startHour")),
      windowEndHour: Number(field(formData, "endHour")),
      timezone: field(formData, "timezone"),
    }),
  );
}

export async function addEmailStepAction(formData: FormData): Promise<void> {
  await editAutomation(formData, "Email step added.", (userId, id) => addEmailStep(userId, id, field(formData, "templateId")));
}

export async function addDelayStepAction(formData: FormData): Promise<void> {
  await editAutomation(formData, "Delay step added.", (userId, id) =>
    addDelayStep(userId, id, Number(field(formData, "amount")), field(formData, "unit")),
  );
}

export async function removeStepAction(formData: FormData): Promise<void> {
  await editAutomation(formData, "Step removed.", (userId, id) => removeStep(userId, id, field(formData, "stepId")));
}

export async function moveStepAction(formData: FormData): Promise<void> {
  const direction = field(formData, "direction") === "up" ? "up" : "down";
  await editAutomation(formData, "Step moved.", (userId, id) => moveStep(userId, id, field(formData, "stepId"), direction));
}

export async function activateAutomationAction(formData: FormData): Promise<void> {
  const origin = await requestOrigin();
  const user = await requireUser();
  // Non-blocking: the automation is activated either way, the notice just mentions missing DNS records.
  const warnings = await senderWarnings({
    fromEmail: user.fromEmail || user.email,
    selector: (await getDeliverabilitySettings(user.id)).dkimSelector,
    smtpConfigured: user.smtpConfigured,
  });
  const notice = `Automation is active. People who join the list from now on will be enrolled.${
    warnings.length ? ` Heads-up: ${warnings.join("; ")}, so mail may land in spam. See sender verification in Settings.` : ""
  }`;
  await editAutomation(formData, notice, (userId, id) => activateAutomation(userId, id, origin));
}

export async function pauseAutomationAction(formData: FormData): Promise<void> {
  await editAutomation(formData, "Automation paused. Nobody is enrolled or sent to until you resume it.", (userId, id) =>
    pauseAutomation(userId, id),
  );
}

export async function deleteAutomationAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  await deleteAutomation(user.id, field(formData, "id"));
  redirect(withMessage("/app/automations", "notice", "Automation deleted."));
}
