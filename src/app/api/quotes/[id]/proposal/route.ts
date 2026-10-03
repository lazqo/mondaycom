import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { currentProposal, previewProposal, proposalFile } from "@/lib/proposals/workflow";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const pdf = (content: Buffer, filename: string, inline: boolean) =>
  new NextResponse(new Uint8Array(content), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(content.length),
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${filename.replace(/"/g, "")}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });

/**
 * The quote's current proposal PDF (office staff only). ?preview=1 renders the quote as it stands
 * now, marked DRAFT unless approved; a preview is never stored or attached.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });
  if (user.role === "field") return new NextResponse("Forbidden", { status: 403 });
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const inline = url.searchParams.get("download") !== "1";
  try {
    if (url.searchParams.get("preview") === "1") {
      const p = await previewProposal(id);
      return pdf(p.content, p.filename, inline);
    }
    const doc = await currentProposal(id);
    if (!doc) return new NextResponse("This quote has no current proposal. Approve the quote to make one.", { status: 404 });
    const f = await proposalFile(doc.id);
    return pdf(f.content, f.filename, inline);
  } catch (err) {
    return new NextResponse(err instanceof Error ? err.message : "Could not make the proposal", { status: 400 });
  }
}
