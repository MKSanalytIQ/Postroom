import type { Metadata } from "next";
import Link from "next/link";
import { PublicFrame } from "@/components/public-frame";
import { confirmSubscribe } from "@/lib/consent";

export const metadata: Metadata = { title: "Confirm subscription" };

export default async function ConfirmSubscribePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const result = await confirmSubscribe(token);
  return (
    <PublicFrame>
      <main className="card auth-card stack">
        {result ? (
          <>
            <h1>You are subscribed</h1>
            <p className="fine">
              {result.email} is confirmed on {result.listName}.
            </p>
          </>
        ) : (
          <>
            <h1>Link not valid</h1>
            <p className="fine">This confirmation link is expired or already used.</p>
          </>
        )}
        <p className="fine">
          <Link href="/">Home</Link>
        </p>
      </main>
    </PublicFrame>
  );
}
