import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CampaignEditor } from "@/components/editor";
import { RefreshWhileSending } from "@/components/refresh";
import { ConfirmSubmit, Flash, Pill, SubmitButton } from "@/components/ui";
import {
  deleteCampaignAction,
  duplicateCampaignAction,
  pauseCampaignAction,
  resumeCampaignAction,
} from "@/lib/actions/campaigns";
import { sampleFields } from "@/lib/preview-fields";
import {
  campaignStats,
  clickStats,
  failureRows,
  getCampaign,
  listLists,
  recentDeliveries,
} from "@/lib/queries";
import { requireUser } from "@/lib/session";
import { formatWhen, percent } from "@/lib/time";

export const metadata: Metadata = { title: "Campaign" };

export default async function CampaignPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const query = await searchParams;
  const campaign = await getCampaign(user.id, id);
  if (!campaign) notFound();
  const lists = await listLists(user.id);
  const stats = campaign.status === "draft" ? null : await campaignStats(campaign.id);
  const clicks = stats ? await clickStats(campaign.id) : [];
  const failures = stats ? await failureRows(campaign.id) : [];
  const deliveries = stats ? await recentDeliveries(campaign.id) : [];
  return (
    <div className="stack">
      <RefreshWhileSending active={campaign.status === "sending"} />
      <div className="page-header">
        <div>
          <h1>{campaign.name}</h1>
          <p className="muted">
            <Pill status={campaign.status} /> {campaign.listName ? `to ${campaign.listName}` : "no list yet"}
          </p>
        </div>
        <div className="action-row">
          {campaign.status === "draft" ? null : (
            <Link className="btn btn-ghost" href={`/app/campaigns/${campaign.id}/report`}>
              Full report
            </Link>
          )}
          <form action={duplicateCampaignAction}>
            <input type="hidden" name="id" value={campaign.id} />
            <SubmitButton className="btn btn-ghost">Duplicate</SubmitButton>
          </form>
        </div>
      </div>
      <Flash error={query.error} notice={query.notice} />
      {campaign.status === "draft" ? (
        <CampaignEditor campaign={campaign} lists={lists} fields={sampleFields(user)} />
      ) : (
        <>
          <section className="stats">
            <div className="stat">
              <b>
                {stats?.sent ?? 0}
                <span style={{ fontSize: "1rem", color: "var(--muted)" }}> / {stats?.total ?? 0}</span>
              </b>
              <span>Sent</span>
            </div>
            <div className="stat">
              <b>{percent(stats?.uniqueOpens ?? 0, stats?.sent ?? 0)}</b>
              <span>{stats?.uniqueOpens ?? 0} unique opens</span>
            </div>
            <div className="stat">
              <b>{percent(stats?.uniqueClicks ?? 0, stats?.sent ?? 0)}</b>
              <span>{stats?.uniqueClicks ?? 0} unique clicks</span>
            </div>
            <div className="stat">
              <b>{stats?.unsubscribes ?? 0}</b>
              <span>Unsubscribes · {stats?.failed ?? 0} failed</span>
            </div>
          </section>
          <p className="fine">
            Started {formatWhen(campaign.startedAt)}
            {campaign.finishedAt ? ` · finished ${formatWhen(campaign.finishedAt)}` : ""}
            {stats?.waiting ? ` · ${stats.waiting} still waiting` : ""}
            {stats?.skipped ? ` · ${stats.skipped} skipped` : ""}
          </p>
          <div className="action-row">
            {campaign.status === "sending" ? (
              <form action={pauseCampaignAction}>
                <input type="hidden" name="id" value={campaign.id} />
                <SubmitButton className="btn btn-ghost">Pause</SubmitButton>
              </form>
            ) : null}
            {campaign.status === "paused" ? (
              <form action={resumeCampaignAction}>
                <input type="hidden" name="id" value={campaign.id} />
                <SubmitButton>Resume</SubmitButton>
              </form>
            ) : null}
          </div>
          {clicks.length > 0 ? (
            <section className="panel stack">
              <h2>Clicked links</h2>
              <ul className="number-list">
                {clicks.map((click) => (
                  <li key={click.url}>
                    <span className="num">{click.hits}</span>
                    <span style={{ wordBreak: "break-all" }}>{click.url}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {failures.length > 0 ? (
            <section className="panel stack">
              <h2>Failures</h2>
              {failures.map((failure) => (
                <p key={failure.email}>
                  <strong>{failure.email}</strong> — {failure.error}
                </p>
              ))}
            </section>
          ) : null}
          {deliveries.length > 0 ? (
            <section className="panel stack">
              <h2>Stored messages</h2>
              <p className="fine">Capture mode keeps every letter. SMTP sends are stored too, so you can read what went out.</p>
              <ul>
                {deliveries.map((delivery) => (
                  <li key={delivery.id}>
                    <Link href={`/app/campaigns/${campaign.id}/outbox/${delivery.id}`}>{delivery.email}</Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
      <form action={deleteCampaignAction} className="danger-zone">
        <input type="hidden" name="id" value={campaign.id} />
        <ConfirmSubmit label="Delete campaign" message="Delete this campaign and its tracking?" className="btn btn-danger" />
      </form>
    </div>
  );
}
