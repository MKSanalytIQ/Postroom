import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ConfirmSubmit, Flash, Pager, Pill, SubmitButton } from "@/components/ui";
import { addContactAction } from "@/lib/actions/contacts";
import { deleteListAction, importCsvAction, removeMemberAction, renameListAction } from "@/lib/actions/lists";
import { getListPublicSettings } from "@/lib/consent";
import { rotateListPublicTokenAction, setListDoubleOptInAction } from "@/lib/actions/lists";
import { getList, listMembers } from "@/lib/queries";
import { requestOrigin } from "@/lib/origin";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = { title: "List" };

export default async function ListDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; notice?: string; q?: string; page?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const query = await searchParams;
  const list = await getList(user.id, id);
  if (!list) notFound();
  const page = Number(query.page || 1);
  const members = await listMembers(user.id, id, page, query.q || "");
  if (!members) notFound();
  const pub = await getListPublicSettings(user.id, id);
  const origin = await requestOrigin();
  const subscribeUrl = pub ? `${origin}/s/${pub.publicToken}` : "";
  return (
    <div className="stack">
      <Flash error={query.error} notice={query.notice} />
      <form action={renameListAction} className="inline-form">
        <input type="hidden" name="id" value={list.id} />
        <input name="name" defaultValue={list.name} aria-label="List name" required style={{ maxWidth: 360 }} />
        <SubmitButton>Rename</SubmitButton>
      </form>
      <p className="muted">
        {list.subscribedCount} subscribed of {list.contactCount}.{" "}
        <a href={`/app/contacts/export?list=${list.id}`}>Export CSV</a>
      </p>
      <div className="two">
        <form action={addContactAction} className="panel stack">
          <h2>Add a person</h2>
          <input type="hidden" name="listId" value={list.id} />
          <label className="field">
            <span>Email</span>
            <input name="email" type="email" required />
          </label>
          <label className="field">
            <span>First name</span>
            <input name="firstName" />
          </label>
          <label className="field">
            <span>Last name</span>
            <input name="lastName" />
          </label>
          <SubmitButton>Add to list</SubmitButton>
        </form>
        <form action={importCsvAction} className="panel stack">
          <h2>Import CSV</h2>
          <p className="fine">Header row required. Use columns email, first name, and last name. Unsubscribed people stay unsubscribed.</p>
          <input type="hidden" name="listId" value={list.id} />
          <input name="file" type="file" accept=".csv,text/csv" required />
          <label className="check">
            <input type="checkbox" name="consentAttested" value="1" required />
            I confirm everyone in this file consented to receive email from me.
          </label>
          <SubmitButton pendingLabel="Importing…">Import</SubmitButton>
        </form>
      </div>
      <section className="panel stack">
        <h2>Public subscribe form</h2>
        <p className="fine">
          Share this link so people can join the list themselves. Consent is recorded with source &quot;form&quot;.
          {pub?.doubleOptIn
            ? " Double opt-in is on: they stay pending until they confirm by email."
            : " They are subscribed as soon as they submit (turn on double opt-in if you need a confirmation email)."}
        </p>
        {subscribeUrl ? (
          <label className="field">
            <span>Subscribe URL</span>
            <input readOnly value={subscribeUrl} aria-label="Public subscribe URL" />
          </label>
        ) : null}
        <div className="action-row">
          <form action={setListDoubleOptInAction}>
            <input type="hidden" name="listId" value={list.id} />
            <input type="hidden" name="enabled" value={pub?.doubleOptIn ? "0" : "1"} />
            <SubmitButton className="btn btn-ghost">{pub?.doubleOptIn ? "Turn off double opt-in" : "Turn on double opt-in"}</SubmitButton>
          </form>
          <form action={rotateListPublicTokenAction}>
            <input type="hidden" name="listId" value={list.id} />
            <ConfirmSubmit label="New link" message="Generate a new subscribe link? The old URL will stop working." />
          </form>
        </div>
      </section>
      <form action={`/app/lists/${list.id}`} method="get" className="inline-form">
        <input name="q" defaultValue={query.q || ""} placeholder="Search this list" aria-label="Search this list" style={{ maxWidth: 280 }} />
        <button className="btn btn-ghost" type="submit">
          Search
        </button>
      </form>
      {members.rows.length === 0 ? (
        <p className="empty">Nobody on this list yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Name</th>
                <th>Status</th>
                <th className="actions"> </th>
              </tr>
            </thead>
            <tbody>
              {members.rows.map((contact) => (
                <tr key={contact.id}>
                  <td>{contact.email}</td>
                  <td>
                    {contact.firstName} {contact.lastName}
                  </td>
                  <td>
                    <Pill status={contact.status} />
                  </td>
                  <td className="actions">
                    <form action={removeMemberAction}>
                      <input type="hidden" name="listId" value={list.id} />
                      <input type="hidden" name="contactId" value={contact.id} />
                      <button className="btn btn-ghost" type="submit">
                        Remove
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager path={`/app/lists/${list.id}`} page={members.page} total={members.total} pageSize={members.pageSize} query={query.q || ""} />
      <form action={deleteListAction} className="danger-zone">
        <input type="hidden" name="id" value={list.id} />
        <p className="fine">Deleting the list does not delete the people on it.</p>
        <ConfirmSubmit label="Delete list" message="Delete this list? Contacts are kept." className="btn btn-danger" />
      </form>
    </div>
  );
}
