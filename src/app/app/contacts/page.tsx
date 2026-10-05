import type { Metadata } from "next";
import { ConfirmSubmit, Flash, PageHeader, Pager, Pill, SubmitButton } from "@/components/ui";
import { addContactAction, deleteContactAction, eraseContactAction, setStatusAction } from "@/lib/actions/contacts";
import { importCsvAction } from "@/lib/actions/lists";
import { consentByContactIds } from "@/lib/consent";
import { listContacts } from "@/lib/queries";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = { title: "Contacts" };

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string; q?: string; page?: string }>;
}) {
  const user = await requireUser();
  const query = await searchParams;
  const contacts = await listContacts(user.id, Number(query.page || 1), query.q || "");
  const consentMap = await consentByContactIds(contacts.rows.map((row) => row.id));
  return (
    <div className="stack">
      <PageHeader
        title="Contacts"
        lede="Everyone you have added. A person who unsubscribed is skipped by future campaigns."
        action={
          <a className="btn btn-ghost" href="/app/contacts/export">
            Export CSV
          </a>
        }
      />
      <Flash error={query.error} notice={query.notice} />
      <div className="two">
        <form action={addContactAction} className="panel stack">
          <h2>Add a person</h2>
          <label className="field">
            <span>Email</span>
            <input name="email" type="email" required />
          </label>
          <div className="two">
            <label className="field">
              <span>First name</span>
              <input name="firstName" />
            </label>
            <label className="field">
              <span>Last name</span>
              <input name="lastName" />
            </label>
          </div>
          <SubmitButton>Add contact</SubmitButton>
        </form>
        <form action={importCsvAction} className="panel stack">
          <h2>Import CSV</h2>
          <label className="check">
            <input type="checkbox" name="consentAttested" value="1" required />
            I confirm everyone in this file consented to receive email from me.
          </label>
          <p className="fine">Header row with an email column. Optional first name and last name. Up to 5,000 rows.</p>
          <input name="file" type="file" accept=".csv,text/csv" required />
          <SubmitButton pendingLabel="Importing…">Import</SubmitButton>
        </form>
      </div>
      <form action="/app/contacts" method="get" className="inline-form">
        <input name="q" defaultValue={query.q || ""} placeholder="Search email or name" aria-label="Search contacts" style={{ maxWidth: 320 }} />
        <button className="btn btn-ghost" type="submit">
          Search
        </button>
      </form>
      {contacts.rows.length === 0 ? (
        <p className="empty">No contacts match.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Name</th>
                <th>Lists</th>
                <th>Status</th>
                <th>Consent</th>
                <th className="actions"> </th>
              </tr>
            </thead>
            <tbody>
              {contacts.rows.map((contact) => (
                <tr key={contact.id}>
                  <td>{contact.email}</td>
                  <td>
                    {contact.firstName} {contact.lastName}
                  </td>
                  <td>{contact.listNames || "—"}</td>
                  <td>
                    <Pill status={contact.status} />
                  </td>
                  <td className="fine">
                    {(() => {
                      const consent = consentMap.get(contact.id);
                      if (!consent) return "—";
                      const when = consent.confirmedAt || consent.consentedAt;
                      return `${consent.source}${consent.confirmedAt ? "" : consent.source === "form" ? " (unconfirmed)" : ""} · ${when.slice(0, 10)}`;
                    })()}
                  </td>
                  <td className="actions">
                    <div className="row-actions">
                      <form action={setStatusAction}>
                        <input type="hidden" name="id" value={contact.id} />
                        <input type="hidden" name="back" value="/app/contacts" />
                        <input type="hidden" name="status" value={contact.status === "subscribed" ? "unsubscribed" : "subscribed"} />
                        <button className="btn btn-ghost" type="submit">
                          {contact.status === "subscribed" ? "Unsubscribe" : "Resubscribe"}
                        </button>
                      </form>
                      <a className="btn btn-ghost" href={`/app/contacts/${contact.id}/export`}>
                        Export
                      </a>
                      <form action={eraseContactAction}>
                        <input type="hidden" name="id" value={contact.id} />
                        <input type="hidden" name="back" value="/app/contacts" />
                        <ConfirmSubmit
                          label="Erase"
                          message={`Erase ${contact.email}? Removes the contact, anonymizes send history, and adds the address to Suppressions.`}
                        />
                      </form>
                      <form action={deleteContactAction}>
                        <input type="hidden" name="id" value={contact.id} />
                        <input type="hidden" name="back" value="/app/contacts" />
                        <ConfirmSubmit label="Delete" message={`Delete ${contact.email}? Old unsubscribe links will still resolve.`} />
                      </form>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager path="/app/contacts" page={contacts.page} total={contacts.total} pageSize={contacts.pageSize} query={query.q || ""} />
    </div>
  );
}
