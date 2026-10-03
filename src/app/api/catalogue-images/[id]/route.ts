import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/db";
import { catalogueImages } from "@/db/schema";

export const dynamic = "force-dynamic";

/** A stored catalogue image (product photo), for the settings screens. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });
  const { id } = await ctx.params;
  const img = await db.query.catalogueImages.findFirst({ where: eq(catalogueImages.id, id) }).catch(() => null);
  if (!img) return new NextResponse("Not found", { status: 404 });
  return new NextResponse(new Uint8Array(img.content), {
    headers: {
      "Content-Type": img.contentType === "image/png" ? "image/png" : "image/jpeg",
      "Content-Length": String(img.content.length),
      "Cache-Control": "private, max-age=86400, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
