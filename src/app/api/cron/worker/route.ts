import { authorizeCronRequest, runCronWorker } from "@/lib/cron-worker";

export const runtime = "nodejs";

/** Soft cap under Hobby's default function limit; Pro can raise this in the dashboard. */
export const maxDuration = 60;

/**
 * Vercel Cron entrypoint. Protected by `Authorization: Bearer ${CRON_SECRET}`
 * (Vercel sends this automatically when CRON_SECRET is set on the project).
 * Runs one or more worker cycles with a time/work budget so the invocation
 * finishes before the platform timeout.
 */
export async function GET(request: Request) {
  if (!authorizeCronRequest(request)) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const result = await runCronWorker();
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Worker cycle failed";
    console.error("cron worker failed:", message);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
