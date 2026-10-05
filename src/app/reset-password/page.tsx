import type { Metadata } from "next";
import Link from "next/link";
import { PublicFrame } from "@/components/public-frame";
import { Flash, SubmitButton } from "@/components/ui";
import { resetPasswordAction } from "@/lib/actions/auth";

export const metadata: Metadata = { title: "Reset password" };

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>;
}) {
  const params = await searchParams;
  const token = params.token || "";
  return (
    <PublicFrame>
      <main className="card auth-card stack">
        <h1>Choose a new password</h1>
        <Flash error={params.error} />
        {!token ? (
          <p className="fine">
            This link is missing its token. <Link href="/forgot-password">Request a new reset link</Link>.
          </p>
        ) : (
          <form action={resetPasswordAction} className="stack">
            <input type="hidden" name="token" value={token} />
            <label className="field">
              <span>New password</span>
              <input name="password" type="password" autoComplete="new-password" minLength={8} required />
            </label>
            <SubmitButton pendingLabel="Saving…">Update password</SubmitButton>
          </form>
        )}
        <p className="fine">
          <Link className="link" href="/login">
            Back to sign in
          </Link>
        </p>
      </main>
    </PublicFrame>
  );
}
