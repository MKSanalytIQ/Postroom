"use server";

import { redirect } from "next/navigation";
import { createList, deleteList, importContacts, removeFromList, renameList } from "../queries";
import { requireUser } from "../session";
import { UserError } from "../user-error";
import { withMessage } from "../validators";

export async function createListAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  try {
    const id = await createList(user.id, String(formData.get("name") || ""));
    redirect(`/app/lists/${id}`);
  } catch (error) {
    if (error instanceof UserError) redirect(withMessage("/app/lists", "error", error.message));
    throw error;
  }
}

export async function renameListAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = String(formData.get("id") || "");
  try {
    await renameList(user.id, id, String(formData.get("name") || ""));
  } catch (error) {
    if (error instanceof UserError) redirect(withMessage(`/app/lists/${id}`, "error", error.message));
    throw error;
  }
  redirect(withMessage(`/app/lists/${id}`, "notice", "List renamed."));
}

export async function deleteListAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  await deleteList(user.id, String(formData.get("id") || ""));
  redirect(withMessage("/app/lists", "notice", "List deleted. Contacts were kept."));
}

export async function removeMemberAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const listId = String(formData.get("listId") || "");
  await removeFromList(user.id, listId, String(formData.get("contactId") || ""));
  redirect(withMessage(`/app/lists/${listId}`, "notice", "Removed from this list."));
}

export async function importCsvAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const listId = String(formData.get("listId") || "") || null;
  const back = listId ? `/app/lists/${listId}` : "/app/contacts";
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    redirect(withMessage(back, "error", "Choose a CSV file."));
  }
  if (file.size > 2_000_000) redirect(withMessage(back, "error", "CSV files must be under 2 MB."));
  try {
    const result = await importContacts(user.id, listId, await file.text());
    const parts = [
      `${result.created} new`,
      `${result.updated} updated`,
      listId ? `${result.addedToList} added to the list` : "",
      result.invalid ? `${result.invalid} invalid rows skipped` : "",
      result.keptUnsubscribed ? `${result.keptUnsubscribed} stayed unsubscribed` : "",
      result.suppressed ? `${result.suppressed} skipped because they are on the suppression list` : "",
    ].filter(Boolean);
    redirect(withMessage(back, "notice", `Import finished: ${parts.join(", ")}.`));
  } catch (error) {
    if (error instanceof UserError) redirect(withMessage(back, "error", error.message));
    throw error;
  }
}
