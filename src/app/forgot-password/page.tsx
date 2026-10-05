import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { PublicFrame } from "@/components/public-frame";
import { Flash, SubmitButton } from "@/components/ui";
import { forgotPasswordAction } from "@/lib/actions/auth";
import { currentUser } from "@/lib/session";

export const metadata: Metadata = { title: "Forgot password" };

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  if (await currentUser()) redirect("/app");
  const params = await searchParams;
  return (
    <PublicFrame>
      <main className="card auth-card stack">
        <h1>Forgot password</h1>
        <p className="fine">Enter your account email. If it matches an account, we will send a link that works for one hour.</p>
        <Flash error={params.error} notice={params.notice} />
        <form action={forgotPasswordAction} className="stack">
          <label className="field">
            <span>Email</span>
            <input name="email" type="email" autoComplete="email" required />
          </label>
          <SubmitButton pendingLabel="Sending…">Send reset link</SubmitButton>
        </form>
        <p className="fine">
          <Link className="link" href="/login">
            Back to sign in
          </Link>
        </p>
      </main>
    </PublicFrame>
  );
}
