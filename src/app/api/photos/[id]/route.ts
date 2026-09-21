import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/db";
import { jobPhotos } from "@/db/schema";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });
  const { id } = await ctx.params;
  const p = await db.query.jobPhotos.findFirst({ where: eq(jobPhotos.id, id) });
  if (!p) return new NextResponse("Not found", { status: 404 });
  return new NextResponse(new Uint8Array(p.content), {
    headers: {
      "Content-Type": p.contentType.startsWith("image/") ? p.contentType : "application/octet-stream",
      "Content-Length": String(p.content.length),
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
