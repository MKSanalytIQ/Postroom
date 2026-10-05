import { recordOpen } from "@/lib/queries";

export const runtime = "nodejs";

const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

function metaFrom(request: Request) {
  return {
    userAgent: request.headers.get("user-agent") ?? undefined,
    method: request.method,
  };
}

export async function GET(request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  await recordOpen(token, metaFrom(request));
  return new Response(GIF, {
    headers: {
      "Content-Type": "image/gif",
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
    },
  });
}

export async function HEAD(request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  await recordOpen(token, metaFrom(request));
  return new Response(null, { status: 200, headers: { "Cache-Control": "no-store" } });
}
