"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { humanFromUser } from "@/lib/guard/actor";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { decidePackage, detectPackagePatterns, packageEditSchema } from "@/lib/brain/packages";

/** Chris approves (as proposed or edited) or rejects a candidate package. Only an approver can. */
export async function decidePackageAction(id: string, decision: "approve" | "reject", edits: unknown, note: string): Promise<ActionResult<{ kitId: string | null }>> {
  const user = await requireAdmin();
  if (!z.string().uuid().safeParse(id).success) return fail("Invalid candidate");
  if (!user.canApprove) return fail("Only an approver can decide packages.");
  const e = edits == null ? null : packageEditSchema.safeParse(edits);
  if (e && !e.success) return fail(`${e.error.issues[0]?.path.join(".")}: ${e.error.issues[0]?.message}`);
  try {
    const r = await decidePackage(id, decision, humanFromUser(user), { edits: e?.data ?? null, note: note.trim() || null });
    revalidatePath("/settings/brain/packages");
    revalidatePath("/settings/brain");
    return ok({ kitId: r.kitId });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** Look now for configurations Get Secure keeps quoting with no approved kit (the worker does this daily). */
export async function detectPackagePatternsAction(): Promise<ActionResult<{ proposed: number }>> {
  await requireAdmin();
  try {
    const r = await detectPackagePatterns();
    revalidatePath("/settings/brain/packages");
    return ok({ proposed: r.proposed.length });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
