"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { humanFromUser } from "@/lib/guard/actor";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { decideCandidate, requestResearch, RESEARCH_KINDS } from "@/lib/hermes/research";

/** Chris asks Hermes's research profile a question; the answer is stored with its sources. */
export async function requestResearchAction(question: string, kind: string): Promise<ActionResult<{ status: string; error: string | null }>> {
  const user = await requireAdmin();
  const q = z.string().trim().min(5).max(1000).safeParse(question);
  if (!q.success) return fail("Write the question (at least a few words).");
  const k = z.enum(RESEARCH_KINDS).catch("other").parse(kind);
  try {
    const r = await requestResearch({ question: q.data, kind: k, requestedBy: `user:${user.id}` });
    revalidatePath("/settings/brain/research");
    return ok({ status: r.status, error: r.error });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export async function decideCandidateAction(id: string, decision: "accepted" | "rejected", note: string): Promise<ActionResult<undefined>> {
  const user = await requireAdmin();
  if (!z.string().uuid().safeParse(id).success) return fail("Invalid candidate");
  try {
    await decideCandidate(id, decision, note.trim() || null, humanFromUser(user));
    revalidatePath("/settings/brain/research");
    return ok(undefined);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
