import { exportContactData } from "@/lib/gdpr";
import { currentUser } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const { id } = await context.params;
  try {
    const data = await exportContactData(user.id, id);
    return new Response(JSON.stringify(data, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename=contact-${id}.json`,
      },
    });
  } catch {
    return new Response("Contact not found.", { status: 404 });
  }
}
