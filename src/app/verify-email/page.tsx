import type { Metadata } from "next";
import Link from "next/link";
import { Flash, PageHeader } from "@/components/ui";
import { verifyEmailWithToken } from "@/lib/email-verification";
import { UserError } from "@/lib/user-error";

export const metadata: Metadata = { title: "Verify email" };

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string; notice?: string }>;
}) {
  const params = await searchParams;
  let error = params.error;
  let notice = params.notice;
  if (params.token && !error && !notice) {
    try {
      await verifyEmailWithToken(params.token);
      notice = "Email verified. You can send campaigns and activate automations.";
    } catch (err) {
      error = err instanceof UserError ? err.message : "This verification link is not valid or has expired.";
    }
  }
  return (
    <div className="auth stack" style={{ maxWidth: 480, margin: "4rem auto" }}>
      <PageHeader title="Verify email" lede="Confirm the address on your Postroom account." />
      <Flash error={error} notice={notice} />
      <p className="fine">
        <Link href="/app/settings">Back to Settings</Link> · <Link href="/login">Sign in</Link>
      </p>
    </div>
  );
}
