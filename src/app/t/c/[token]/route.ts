import { readClickTarget } from "@/lib/crypto";
import { recordClick } from "@/lib/queries";

export const runtime = "nodejs";

function metaFrom(request: Request) {
  return {
    userAgent: request.headers.get("user-agent") ?? undefined,
    method: request.method,
  };
}

export async function GET(request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const url = new URL(request.url);
  const target = readClickTarget(token, url.searchParams.get("u") ?? "", url.searchParams.get("s") ?? "");
  if (!target) return new Response("This link is not valid.", { status: 400 });
  await recordClick(token, target, metaFrom(request));
  return Response.redirect(target, 302);
}

export async function HEAD(request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const url = new URL(request.url);
  const target = readClickTarget(token, url.searchParams.get("u") ?? "", url.searchParams.get("s") ?? "");
  if (!target) return new Response(null, { status: 400 });
  await recordClick(token, target, metaFrom(request));
  return new Response(null, { status: 200 });
}
