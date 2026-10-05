import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PublicFrame } from "@/components/public-frame";
import { Flash, SubmitButton } from "@/components/ui";
import { publicSubscribeAction } from "@/lib/actions/subscribe";
import { getListByPublicToken } from "@/lib/consent";

export const metadata: Metadata = { title: "Subscribe" };

export default async function PublicSubscribePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { token } = await params;
  const list = await getListByPublicToken(token);
  if (!list) notFound();
  const query = await searchParams;
  return (
    <PublicFrame>
      <main className="card auth-card stack">
        <h1>Join {list.listName}</h1>
        <p className="fine">
          {list.companyName ? `${list.companyName} · ` : ""}
          {list.doubleOptIn ? "We will email you a confirmation link." : "You will be subscribed when you submit."}
        </p>
        <Flash error={query.error} notice={query.notice} />
        <form action={publicSubscribeAction} className="stack">
          <input type="hidden" name="token" value={token} />
          <label className="field">
            <span>Email</span>
            <input name="email" type="email" required autoComplete="email" />
          </label>
          <label className="field">
            <span>First name</span>
            <input name="firstName" autoComplete="given-name" />
          </label>
          <label className="field">
            <span>Last name</span>
            <input name="lastName" autoComplete="family-name" />
          </label>
          <SubmitButton pendingLabel="Saving…">Subscribe</SubmitButton>
        </form>
      </main>
    </PublicFrame>
  );
}
