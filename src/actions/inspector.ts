"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireOffice } from "@/lib/auth";
import { humanFromUser } from "@/lib/guard/actor";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import * as inspector from "@/lib/inspector/inspect";
import type { SourceType } from "@/lib/inspector/types";

const id = z.string().uuid();

async function run<T>(fn: (actor: ReturnType<typeof humanFromUser>) => Promise<T>): Promise<ActionResult<T>> {
  const user = await requireOffice();
  try {
    const r = await fn(humanFromUser(user));
    for (const p of ["/inspector", "/dashboard", "/approvals", "/recordings", "/leads", "/jobs", "/contacts"]) revalidatePath(p, "layout");
    return ok(r);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** Chris says who an uncertain email or conversation is about, or that it is nobody. */
export async function confirmIdentityAction(inspectionId: string, choice: { leadId?: string | null; contactId?: string | null } | "not_a_customer"): Promise<ActionResult<{ status: string | null }>> {
  if (!id.safeParse(inspectionId).success) return fail("Invalid inspection");
  if (choice !== "not_a_customer" && !(choice.leadId && id.safeParse(choice.leadId).success) && !(choice.contactId && id.safeParse(choice.contactId).success)) return fail("Choose a lead or a customer");
  return run(async (actor) => ({ status: (await inspector.confirmIdentity(inspectionId, choice, actor))?.status ?? null }));
}

/** Accept a recommendation that waits for Chris. Accepting never contacts the customer. */
export async function acceptInspectorAction(actionId: string): Promise<ActionResult<undefined>> {
  if (!id.safeParse(actionId).success) return fail("Invalid action");
  return run(async (actor) => void (await inspector.acceptAction(actionId, actor)));
}

export async function dismissInspectorAction(actionId: string, note: string): Promise<ActionResult<undefined>> {
  if (!id.safeParse(actionId).success) return fail("Invalid action");
  return run(async (actor) => void (await inspector.dismissAction(actionId, actor, note.trim() || null)));
}

/** A fact that conflicts with the CRM: use the new value, or keep the current one. */
export async function resolveFactAction(factId: string, decision: "apply" | "reject"): Promise<ActionResult<undefined>> {
  if (!id.safeParse(factId).success || !["apply", "reject"].includes(decision)) return fail("Invalid fact");
  return run(async (actor) => void (await inspector.resolveFact(factId, decision, actor)));
}

export async function setCommitmentStatusAction(commitmentId: string, status: "done" | "cancelled" | "outstanding"): Promise<ActionResult<undefined>> {
  if (!id.safeParse(commitmentId).success || !["done", "cancelled", "outstanding"].includes(status)) return fail("Invalid commitment");
  return run(async (actor) => void (await inspector.setCommitmentStatus(commitmentId, status, actor)));
}

/** Read an email or conversation again (after correcting something). */
export async function reinspectAction(sourceType: SourceType, sourceId: string): Promise<ActionResult<{ status: string | null }>> {
  if (!["email", "recording"].includes(sourceType) || !id.safeParse(sourceId).success) return fail("Invalid source");
  return run(async () => ({ status: (await inspector.inspect(sourceType, sourceId, { force: true }))?.status ?? null }));
}
