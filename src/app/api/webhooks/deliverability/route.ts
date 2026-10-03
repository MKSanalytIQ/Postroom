import { handleWebhook } from "@/lib/deliverability";

export const runtime = "nodejs";

const MAX_BODY = 1_000_000;

/**
 * Bounce and complaint intake. Authenticate with the token from Settings, either as
 * `Authorization: Bearer <token>` or as `?token=<token>` (Amazon SNS cannot send headers).
 * Accepts Amazon SES through SNS, raw SES notifications, and the simple Postroom JSON format.
 */
export async function POST(request: Request) {
  const url = new URL(request.url);
  const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]?.trim();
  const token = bearer || url.searchParams.get("token") || "";
  if (Number(request.headers.get("content-length") || 0) > MAX_BODY) {
    return Response.json({ ok: false, error: "Body too large." }, { status: 413 });
  }
  const body = await request.text();
  if (body.length > MAX_BODY) return Response.json({ ok: false, error: "Body too large." }, { status: 413 });
  const result = await handleWebhook(token, body);
  if (result.confirmUrl) {
    // handleWebhook only hands back an https://sns.<region>.amazonaws.com confirmation link.
    try {
      await fetch(result.confirmUrl, { signal: AbortSignal.timeout(5000) });
    } catch {
      // The sender will retry the confirmation; nothing else to do here.
    }
  }
  return Response.json(result.json, { status: result.status });
}
