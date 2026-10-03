import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Flash, SubmitButton } from "@/components/ui";
import { queueCampaignAction } from "@/lib/actions/campaigns";
import { getDeliverabilitySettings } from "@/lib/deliverability";
import { senderWarnings } from "@/lib/dns-check";
import { getAccount, getCampaign, subscribedCount } from "@/lib/queries";
import { requireUser } from "@/lib/session";
import { sendBlockers } from "@/lib/validators";

export const metadata: Metadata = { title: "Review campaign" };

export default async function SendCampaignPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const query = await searchParams;
  const campaign = await getCampaign(user.id, id);
  if (!campaign) notFound();
  const account = await getAccount(user.id);
  const subscribed = await subscribedCount(user.id, campaign.listId);
  const warnings =
    campaign.status === "draft"
      ? await senderWarnings({
          fromEmail: campaign.fromEmail,
          selector: (await getDeliverabilitySettings(user.id)).dkimSelector,
          smtpConfigured: account.smtpConfigured,
        })
      : [];
  const blockers =
    campaign.status === "draft"
      ? sendBlockers({
          subject: campaign.subject,
          html: campaign.html,
          listId: campaign.listId,
          fromEmail: campaign.fromEmail,
          companyName: account.companyName,
          postalAddress: account.postalAddress,
          subscribed,
          smtpConfigured: account.smtpConfigured,
        })
      : ["This campaign has already been queued."];
  return (
    <div className="stack" style={{ maxWidth: 640 }}>
      <h1>Review and send</h1>
      <Flash error={query.error} />
      <div className="panel stack">
        <p>
          <strong>{campaign.name}</strong>
        </p>
        <p>Subject: {campaign.subject || "—"}</p>
        <p>List: {campaign.listName || "—"}</p>
        <p>From: {campaign.fromName ? `${campaign.fromName} ` : ""}&lt;{campaign.fromEmail || "—"}&gt;</p>
        <p>Subscribed recipients: {subscribed}</p>
        <p>
          Delivery: {account.smtpConfigured ? `SMTP ${account.smtpHost}:${account.smtpPort}` : "Capture mode. Messages stay in Postroom."}
        </p>
      </div>
      {!account.smtpConfigured && blockers.length === 0 ? (
        <p className="banner warn">
          No SMTP host is saved, so this send is stored locally instead of delivered. Add a host in{" "}
          <Link href="/app/settings">Settings</Link> if that is not what you want.
        </p>
      ) : null}
      {warnings.length > 0 ? (
        <div className="banner warn">
          <p>
            <strong>Heads-up, this will not stop the send:</strong> {warnings.join("; ")}. Mail from a domain without these records
            is more likely to be marked as spam. See <Link href="/app/settings#sender">sender verification in Settings</Link>.
          </p>
        </div>
      ) : null}
      {blockers.length > 0 ? (
        <div className="banner bad">
          {blockers.map((blocker) => (
            <p key={blocker}>{blocker}</p>
          ))}
        </div>
      ) : (
        <form action={queueCampaignAction}>
          <input type="hidden" name="id" value={campaign.id} />
          <SubmitButton className="btn btn-seal" pendingLabel="Queuing…">
            Send to {subscribed} {subscribed === 1 ? "person" : "people"}
          </SubmitButton>
        </form>
      )}
      <Link href={`/app/campaigns/${campaign.id}`}>Back to the draft</Link>
    </div>
  );
}
