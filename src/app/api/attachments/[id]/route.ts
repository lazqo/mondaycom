import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getAttachment } from "@/queries/email";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });
  const { id } = await ctx.params;
  const a = await getAttachment(id);
  if (!a || !a.content) return new NextResponse("Not found", { status: 404 });
  const safeName = a.filename.replace(/[^\w.\-() ]+/g, "_");
  return new NextResponse(new Uint8Array(a.content), {
    headers: {
      "Content-Type": a.contentType.startsWith("text/html") ? "text/plain" : a.contentType,
      "Content-Disposition": `attachment; filename="${safeName}"`,
      "Content-Length": String(a.content.length),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}
