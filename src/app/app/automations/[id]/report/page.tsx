import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ReportView } from "@/components/report";
import { Pill } from "@/components/ui";
import { getAutomation } from "@/lib/automations";
import { buildReportForUser } from "@/lib/reports";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = { title: "Automation report" };

export default async function AutomationReportPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const automation = await getAutomation(user.id, id);
  if (!automation) notFound();
  const report = await buildReportForUser(user.id, automation.campaignId);
  return (
    <div className="stack">
      <p className="fine">
        <Link href={`/app/automations/${automation.id}`}>Back to automation</Link>
      </p>
      <div className="page-header">
        <div>
          <h1>{automation.name}: report</h1>
          <p className="muted">
            <Pill status={automation.status} /> every email in the series, together. Per-step numbers are on the automation page.
          </p>
        </div>
      </div>
      <ReportView report={report} exportBase={`/app/automations/${automation.id}/report/export`} />
    </div>
  );
}
