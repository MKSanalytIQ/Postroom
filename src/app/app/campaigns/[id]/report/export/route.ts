import { NextResponse } from "next/server";
import { getCampaign } from "@/lib/queries";
import { buildReport, isReportKind, reportCsv } from "@/lib/reports";
import { currentUser } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.redirect(new URL("/login", request.url));
  const { id } = await context.params;
  const campaign = await getCampaign(user.id, id);
  if (!campaign) return new Response("Campaign not found.", { status: 404 });
  const requested = new URL(request.url).searchParams.get("kind");
  const kind = isReportKind(requested) ? requested : "summary";
  const csv = await reportCsv(await buildReport(campaign.id), kind);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename=campaign-report-${kind}.csv`,
    },
  });
}
