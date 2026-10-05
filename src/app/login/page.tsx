import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { PublicFrame } from "@/components/public-frame";
import { Flash, SubmitButton } from "@/components/ui";
import { loginAction } from "@/lib/actions/auth";
import { currentUser } from "@/lib/session";
import { safeNext } from "@/lib/validators";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string; next?: string }>;
}) {
  if (await currentUser()) redirect("/app");
  const params = await searchParams;
  const next = safeNext(params.next);
  return (
    <PublicFrame>
      <main className="card auth-card stack">
        <h1>Sign in</h1>
        <Flash error={params.error} notice={params.notice} />
        <form action={loginAction} className="stack">
          <input type="hidden" name="next" value={next} />
          <label className="field">
            <span>Email</span>
            <input name="email" type="email" autoComplete="email" required />
          </label>
          <label className="field">
            <span>Password</span>
            <input name="password" type="password" autoComplete="current-password" required />
          </label>
          <SubmitButton pendingLabel="Signing in…">Sign in</SubmitButton>
        </form>
        <p className="fine">
          <Link className="link" href="/forgot-password">
            Forgot password?
          </Link>
        </p>
        <p className="fine">
          No account yet? <Link className="link" href="/signup">Create one</Link>
        </p>
      </main>
    </PublicFrame>
  );
}
