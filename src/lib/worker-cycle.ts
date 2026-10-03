import { signClick } from "./crypto";
import { composeEmail, formatAddress } from "./render";
import { classifyDeliveryError } from "./bounces";
import { runAutomationCycle } from "./automations";
import { recordHardBounce, REASON_LABELS, suppressionReason } from "./deliverability";
import {
  campaignIsSending,
  claimBatch,
  finishCampaigns,
  getAccount,
  markRecipient,
  releaseStaleClaims,
  saveDelivery,
  smtpCredentials,
} from "./queries";
import { deliverMessage } from "./send";
import type { SendJob } from "./types";
import { UserError } from "./user-error";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processJob(job: SendJob): Promise<void> {
  if (!(await campaignIsSending(job.campaignId))) {
    await markRecipient(job.recipientId, "pending", "");
    return;
  }
  if (!job.html.trim() || !job.subject.trim()) {
    // An automation step whose template was deleted after the message was queued.
    await markRecipient(job.recipientId, "failed", "The template for this step no longer exists.");
    return;
  }
  if (job.contactStatus !== "subscribed") {
    await markRecipient(job.recipientId, "skipped", job.contactStatus === "unsubscribed" ? "Unsubscribed" : "Contact removed");
    return;
  }
  // Last line of defence: suppression is checked again at send time, so anything queued before an
  // address bounced, complained, or was added by hand is still held back.
  const suppressed = await suppressionReason(job.userId, job.email);
  if (suppressed) {
    await markRecipient(job.recipientId, "skipped", `Suppressed (${REASON_LABELS[suppressed].toLowerCase()})`);
    return;
  }
  const account = await getAccount(job.userId);
  const origin = job.origin || "http://localhost:3010";
  const unsubscribeUrl = `${origin}/u/${job.unsubToken}?c=${job.campaignId}`;
  const composed = composeEmail({
    html: job.html,
    subject: job.subject,
    fields: {
      firstName: job.firstName,
      lastName: job.lastName,
      email: job.email,
      unsubscribeUrl,
      companyName: account.companyName,
      postalAddress: account.postalAddress,
      unsubToken: job.unsubToken,
    },
    track: (url) => {
      const signed = signClick(job.token, url);
      return `${origin}/t/c/${job.token}?u=${signed.payload}&s=${signed.signature}`;
    },
    pixelUrl: `${origin}/t/o/${job.token}`,
  });
  try {
    if (!account.smtpConfigured) {
      await saveDelivery({
        recipientId: job.recipientId,
        mode: "capture",
        to: job.email,
        subject: composed.subject,
        html: composed.html,
      });
    } else {
      const smtp = await smtpCredentials(job.userId);
      await deliverMessage({
        smtp,
        from: formatAddress(job.fromName, job.fromEmail),
        to: job.email,
        replyTo: job.replyTo,
        subject: composed.subject,
        html: composed.html,
        text: composed.text,
        unsubscribeUrl,
      });
      await saveDelivery({
        recipientId: job.recipientId,
        mode: "smtp",
        to: job.email,
        subject: composed.subject,
        html: composed.html,
      });
    }
    await markRecipient(job.recipientId, "sent", "");
    if (process.env.POSTROOM_WORKER) {
      console.log(`${account.smtpConfigured ? "smtp" : "capture"} ${job.email}`);
    }
  } catch (error) {
    const failure = classifyDeliveryError(error);
    if (failure.kind === "hard_bounce") {
      await recordHardBounce({
        recipientId: job.recipientId,
        campaignId: job.campaignId,
        userId: job.userId,
        email: job.email,
        message: failure.message,
      });
      if (process.env.POSTROOM_WORKER) console.log(`bounced ${job.email}: ${failure.message}`);
      return;
    }
    const message = error instanceof UserError || error instanceof Error ? error.message : "Send failed";
    await markRecipient(job.recipientId, "failed", message);
    if (process.env.POSTROOM_WORKER) console.log(`failed ${job.email}: ${message}`);
  }
}

export async function runBatch(limit = 5): Promise<number> {
  await releaseStaleClaims();
  const jobs = await claimBatch(limit);
  const delay = Number(process.env.SEND_DELAY_MS || 250);
  for (const job of jobs) {
    await processJob(job);
    if (delay > 0) await sleep(delay);
  }
  await finishCampaigns();
  return jobs.length;
}

/** One worker pass: move automations forward, then send whatever is queued. Returns the amount of work done. */
export async function runWorkerCycle(limit = 5): Promise<number> {
  const advanced = await runAutomationCycle();
  const sent = await runBatch(limit);
  return advanced + sent;
}
