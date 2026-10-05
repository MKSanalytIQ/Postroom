import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ReportView } from "@/components/report";
import { Pill } from "@/components/ui";
import { getCampaign } from "@/lib/queries";
import { buildReportForUser } from "@/lib/reports";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = { title: "Campaign report" };

export default async function CampaignReportPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const campaign = await getCampaign(user.id, id);
  if (!campaign) notFound();
  const report = await buildReportForUser(user.id, campaign.id);
  return (
    <div className="stack">
      <p className="fine">
        <Link href={`/app/campaigns/${campaign.id}`}>Back to campaign</Link>
      </p>
      <div className="page-header">
        <div>
          <h1>{campaign.name}: report</h1>
          <p className="muted">
            <Pill status={campaign.status} /> {campaign.listName ? `sent to ${campaign.listName}` : "no list"}
          </p>
        </div>
      </div>
      <ReportView report={report} exportBase={`/app/campaigns/${campaign.id}/report/export`} />
    </div>
  );
}
