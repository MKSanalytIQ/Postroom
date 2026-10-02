import Link from "next/link";
import type { Metadata } from "next";
import { Flash, PageHeader, Pill } from "@/components/ui";
import { listAutomations } from "@/lib/automations";
import { requireUser } from "@/lib/session";
import { formatWhen } from "@/lib/time";

export const metadata: Metadata = { title: "Automations" };

export default async function AutomationsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const automations = await listAutomations(user.id);
  return (
    <div>
      <PageHeader
        title="Automations"
        lede="A series of letters and waits that starts when someone joins a list. Welcome series and drip campaigns live here."
        action={
          <Link className="btn btn-seal" href="/app/automations/new">
            New automation
          </Link>
        }
      />
      <Flash error={params.error} notice={params.notice} />
      {automations.length === 0 ? (
        <p className="empty">No automations yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Trigger list</th>
                <th>Steps</th>
                <th>Status</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {automations.map((automation) => (
                <tr key={automation.id}>
                  <td>
                    <Link href={`/app/automations/${automation.id}`}>{automation.name}</Link>
                  </td>
                  <td>{automation.listName || "—"}</td>
                  <td>
                    {automation.emailCount} {automation.emailCount === 1 ? "email" : "emails"}
                    <div className="fine">{automation.stepCount} steps in all</div>
                  </td>
                  <td>
                    <Pill status={automation.status} />
                  </td>
                  <td>{formatWhen(automation.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
