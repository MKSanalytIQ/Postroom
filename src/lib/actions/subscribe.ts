"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { publicSubscribe } from "../consent";
import { requestOrigin } from "../origin";
import { UserError } from "../user-error";
import { withMessage } from "../validators";

export async function publicSubscribeAction(formData: FormData): Promise<void> {
  const token = String(formData.get("token") || "");
  const back = `/s/${token}`;
  try {
    const headerList = await headers();
    const result = await publicSubscribe({
      publicToken: token,
      email: String(formData.get("email") || ""),
      firstName: String(formData.get("firstName") || ""),
      lastName: String(formData.get("lastName") || ""),
      ip: headerList.get("x-real-ip")?.trim() || headerList.get("x-forwarded-for")?.split(",")[0]?.trim() || "",
      userAgent: headerList.get("user-agent")?.trim() || "",
      origin: await requestOrigin(),
    });
    const message =
      result.status === "pending"
        ? "Check your email to confirm your subscription."
        : result.status === "exists"
          ? "You are already on this list."
          : "You are subscribed. Thank you.";
    redirect(withMessage(back, "notice", message));
  } catch (error) {
    if (error instanceof UserError) redirect(withMessage(back, "error", error.message));
    throw error;
  }
}
