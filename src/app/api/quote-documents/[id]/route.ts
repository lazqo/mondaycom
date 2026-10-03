import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { proposalFile } from "@/lib/proposals/workflow";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** A specific proposal PDF (e.g. the one attached to an email), current or not (office staff only). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });
  if (user.role === "field") return new NextResponse("Forbidden", { status: 403 });
  const { id } = await ctx.params;
  try {
    const f = await proposalFile(id);
    return new NextResponse(new Uint8Array(f.content), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(f.content.length),
        "Content-Disposition": `inline; filename="${(f.current ? f.filename : f.filename.replace(/\.pdf$/, "-VOID.pdf")).replace(/"/g, "")}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
