"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireOffice } from "@/lib/auth";
import { humanFromUser } from "@/lib/guard/actor";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import * as drafting from "@/lib/drafts/workflow";

const id = z.string().uuid();
const splitAddresses = (s: string) =>
  s
    .split(/[,;\s]+/)
    .map((a) => a.trim())
    .filter((a) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a));

async function run<T>(fn: (actor: ReturnType<typeof humanFromUser>) => Promise<T>): Promise<ActionResult<T>> {
  const user = await requireOffice();
  try {
    const r = await fn(humanFromUser(user));
    revalidatePath("/approvals");
    return ok(r);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export async function saveDraftAction(draftId: string, input: { to: string; cc: string; subject: string; body: string }): Promise<ActionResult<{ status: string }>> {
  if (!id.safeParse(draftId).success) return fail("Invalid draft");
  return run(async (actor) => {
    const d = await drafting.updateDraft(draftId, { to: splitAddresses(input.to), cc: splitAddresses(input.cc), subject: input.subject.trim(), body: input.body }, actor);
    return { status: d.status };
  });
}

export async function approveDraftAction(draftId: string): Promise<ActionResult<undefined>> {
  return run(async (actor) => void (await drafting.approveDraft(draftId, actor)));
}

export async function requestDraftRevisionAction(draftId: string, note: string): Promise<ActionResult<undefined>> {
  return run(async (actor) => void (await drafting.requestRevision(draftId, actor, note.trim() || null)));
}

export async function rejectDraftAction(draftId: string, note: string): Promise<ActionResult<undefined>> {
  return run(async (actor) => void (await drafting.rejectDraft(draftId, actor, note.trim() || null)));
}

export async function submitDraftAction(draftId: string): Promise<ActionResult<undefined>> {
  return run(async (actor) => void (await drafting.submitDraft(draftId, actor)));
}

/** Chris sends an approved draft from the CRM. */
export async function sendDraftAction(draftId: string): Promise<ActionResult<{ emailId: string }>> {
  const r = await run(async (actor) => drafting.sendDraft(draftId, actor));
  revalidatePath("/inbox");
  revalidatePath("/leads");
  return r;
}

/** Put the draft in the Titan Drafts folder to send from webmail or the phone. */
export async function placeInTitanDraftsAction(draftId: string): Promise<ActionResult<{ folder: string }>> {
  return run(async (actor) => {
    const r = await drafting.placeInMailboxDrafts(draftId, actor);
    return { folder: r.folder };
  });
}
