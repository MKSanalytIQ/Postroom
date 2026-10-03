import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { stripOpenPixels } from "@/lib/render";
import { getDelivery } from "@/lib/queries";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = { title: "Stored message" };

export default async function OutboxPage({
  params,
}: {
  params: Promise<{ id: string; deliveryId: string }>;
}) {
  const user = await requireUser();
  const { id, deliveryId } = await params;
  const delivery = await getDelivery(user.id, deliveryId);
  if (!delivery) notFound();
  return (
    <div className="stack">
      <p className="fine">
        {delivery.automationId ? (
          <Link href={`/app/automations/${delivery.automationId}`}>Back to automation</Link>
        ) : (
          <Link href={`/app/campaigns/${id}`}>Back to campaign</Link>
        )}
      </p>
      <h1>{delivery.subject}</h1>
      <p className="muted">
        To {delivery.email} · {delivery.mode === "capture" ? "stored locally, not delivered" : "handed to SMTP"}
      </p>
      <p>
        <a href={`/t/o/${delivery.token}`}>Record a test open</a>
      </p>
      <iframe className="preview-frame" sandbox="" title="Sent message" srcDoc={stripOpenPixels(delivery.html)} />
    </div>
  );
}
