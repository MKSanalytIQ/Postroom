import { handleWebhook } from "@/lib/deliverability";
import { createRateLimiter } from "@/lib/rate-limit";

export const runtime = "nodejs";

// SNS messages are capped at 256 KB and SES notifications are far smaller, so 512 KB leaves ample room.
const MAX_BODY = 512 * 1024;
// Per client address: 300 requests a minute in all, and 10 failed authentications a minute before it is shut out.
const requests = createRateLimiter(300, 60_000);
const failures = createRateLimiter(10, 60_000);

function clientKey(request: Request): string {
  const real = request.headers.get("x-real-ip")?.trim();
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return real || forwarded || "unknown";
}

function tooMany(seconds: number): Response {
  return Response.json({ ok: false, error: "Too many requests." }, { status: 429, headers: { "Retry-After": String(seconds) } });
}

/** Reads the body, giving up as soon as it passes the limit instead of buffering it all. */
async function readLimited(request: Request): Promise<string | null> {
  if (Number(request.headers.get("content-length") || 0) > MAX_BODY) return null;
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BODY) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Bounce and complaint intake. Authenticate with the token from Settings as `Authorization: Bearer <token>`.
 * `?token=<token>` also works for senders that cannot set headers (Amazon SNS), but it is less safe because
 * URLs end up in logs and proxies. Accepts Amazon SES through SNS (signature verified), raw SES notifications,
 * and the simple Postroom JSON format.
 */
export async function POST(request: Request) {
  const key = clientKey(request);
  const shutOut = failures.blocked(key);
  if (shutOut.blocked) return tooMany(shutOut.retryAfterSeconds);
  const allowance = requests.take(key);
  if (!allowance.allowed) return tooMany(allowance.retryAfterSeconds);

  const url = new URL(request.url);
  const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]?.trim();
  const token = bearer || url.searchParams.get("token") || "";
  const body = await readLimited(request);
  if (body === null) return Response.json({ ok: false, error: "Body too large." }, { status: 413 });

  const result = await handleWebhook(token, body);
  if (result.status === 401 || result.status === 403) failures.take(key);
  if (result.confirmUrl) {
    // handleWebhook only hands back a link from a signature-verified SNS message, and only an
    // https://sns.<region>.amazonaws.com confirmation URL.
    try {
      await fetch(result.confirmUrl, { signal: AbortSignal.timeout(5000), redirect: "error" });
    } catch {
      // The sender will retry the confirmation; nothing else to do here.
    }
  }
  return Response.json(result.json, { status: result.status });
}
