import type { Metadata } from "next";
import { Flash, PageHeader, SubmitButton } from "@/components/ui";
import { createAutomationAction } from "@/lib/actions/automations";
import { listLists } from "@/lib/queries";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = { title: "New automation" };

export default async function NewAutomationPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const lists = await listLists(user.id);
  return (
    <div className="stack">
      <PageHeader
        title="New automation"
        lede="Name it and pick the list that starts it. You will add the emails and waits on the next screen."
      />
      <Flash error={params.error} />
      <form action={createAutomationAction} className="panel stack" style={{ maxWidth: 520 }}>
        <label className="field">
          <span>Name</span>
          <input name="name" placeholder="Welcome series" required />
        </label>
        <label className="field">
          <span>Starts when someone joins</span>
          <select name="listId" defaultValue="">
            <option value="">Choose later</option>
            {lists.map((list) => (
              <option key={list.id} value={list.id}>
                {list.name} ({list.subscribedCount} subscribed)
              </option>
            ))}
          </select>
        </label>
        <SubmitButton>Create automation</SubmitButton>
      </form>
    </div>
  );
}
