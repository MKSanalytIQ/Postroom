import type { Metadata } from "next";
import { ConfirmSubmit, Flash, PageHeader, Pager, SubmitButton } from "@/components/ui";
import { addSuppressionsAction, removeSuppressionAction } from "@/lib/actions/deliverability";
import { listSuppressions, REASON_LABELS, suppressionCounts } from "@/lib/deliverability";
import { requireUser } from "@/lib/session";
import { formatWhen } from "@/lib/time";

export const metadata: Metadata = { title: "Suppressions" };

export default async function SuppressionsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string; q?: string; page?: string }>;
}) {
  const user = await requireUser();
  const query = await searchParams;
  const [suppressions, counts] = await Promise.all([
    listSuppressions(user.id, Number(query.page || 1), query.q || ""),
    suppressionCounts(user.id),
  ]);
  return (
    <div className="stack">
      <PageHeader
        title="Suppressions"
        lede="Addresses that are never mailed, by any campaign or automation. Hard bounces and spam complaints are added for you."
        action={
          <a className="btn btn-ghost" href="/app/suppressions/export">
            Export CSV
          </a>
        }
      />
      <Flash error={query.error} notice={query.notice} />
      <section className="stats">
        <div className="stat">
          <b>{counts.hard_bounce}</b>
          <span>Hard bounces</span>
        </div>
        <div className="stat">
          <b>{counts.complaint}</b>
          <span>Complaints</span>
        </div>
        <div className="stat">
          <b>{counts.manual}</b>
          <span>Added by hand</span>
        </div>
      </section>
      <form action={addSuppressionsAction} className="panel stack">
        <h2>Add addresses</h2>
        <label className="field">
          <span>Email addresses</span>
          <textarea name="emails" required style={{ minHeight: 90 }} placeholder="one@example.com, two@example.com" />
        </label>
        <label className="field">
          <span>Note</span>
          <input name="detail" placeholder="Optional, for your own records" maxLength={200} />
        </label>
        <SubmitButton>Suppress</SubmitButton>
      </form>
      <form action="/app/suppressions" method="get" className="inline-form">
        <input name="q" defaultValue={query.q || ""} placeholder="Search email" aria-label="Search suppressions" style={{ maxWidth: 320 }} />
        <button className="btn btn-ghost" type="submit">
          Search
        </button>
      </form>
      {suppressions.rows.length === 0 ? (
        <p className="empty">{query.q ? "No addresses match." : "Nothing suppressed yet."}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Reason</th>
                <th>Added</th>
                <th className="actions"> </th>
              </tr>
            </thead>
            <tbody>
              {suppressions.rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    {row.email}
                    {row.detail ? <div className="fine">{row.detail}</div> : null}
                  </td>
                  <td>
                    <span className={`pill ${row.reason === "manual" ? "warn" : "bad"}`}>{REASON_LABELS[row.reason]}</span>
                    <div className="fine">via {row.source}</div>
                  </td>
                  <td>{formatWhen(row.createdAt)}</td>
                  <td className="actions">
                    <form action={removeSuppressionAction}>
                      <input type="hidden" name="id" value={row.id} />
                      <ConfirmSubmit label="Remove" message={`Allow mail to ${row.email} again?`} />
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager path="/app/suppressions" page={suppressions.page} total={suppressions.total} pageSize={suppressions.pageSize} query={query.q || ""} />
    </div>
  );
}
