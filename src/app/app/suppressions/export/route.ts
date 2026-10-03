import { NextResponse } from "next/server";
import { suppressionsCsv } from "@/lib/deliverability";
import { currentUser } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.redirect(new URL("/login", request.url));
  return new Response(await suppressionsCsv(user.id), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": "attachment; filename=suppressions.csv",
    },
  });
}
