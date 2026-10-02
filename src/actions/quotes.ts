"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { quotes } from "@/db/schema";
import { computeTotals } from "@/lib/quotes";
import { requireOffice as requireUser } from "@/lib/auth";
import { logActivity } from "@/lib/activity";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { nextNumber } from "@/lib/numbering";
import { humanFromUser } from "@/lib/guard/actor";
import { approveQuote, returnQuoteForReview, setQuoteStatus as setStatus, updateQuoteContent } from "@/lib/quotes/workflow";

const lineItem = z.object({
  description: z.string().trim().min(1, "Line description is required").max(500),
  quantity: z.coerce.number().min(0).max(1_000_000),
  unitPrice: z.coerce.number().min(-1_000_000).max(10_000_000),
});

const quoteInput = z.object({
  title: z.string().trim().min(1, "Title is required").max(200),
  contactId: z.string().uuid("Choose a customer"),
  leadId: z.string().uuid().nullable().optional(),
  taxRate: z.coerce.number().min(0).max(100).default(15),
  lineItems: z.array(lineItem).default([]),
  notes: z.string().trim().max(10000).optional(),
});
export type QuoteInput = z.input<typeof quoteInput>;

export async function createQuote(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  const parsed = quoteInput.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");
  const d = parsed.data;
  const totals = computeTotals(d.lineItems, d.taxRate);
  const id = await db.transaction(async (tx) => {
    const number = await nextNumber(tx, "quotes");
    const [row] = await tx
      .insert(quotes)
      .values({
        number,
        title: d.title,
        contactId: d.contactId,
        leadId: d.leadId ?? null,
        taxRate: d.taxRate.toFixed(2),
        lineItems: d.lineItems,
        subtotal: totals.subtotal,
        total: totals.total,
        notes: d.notes ?? null,
      })
      .returning({ id: quotes.id });
    return row.id;
  });
  await logActivity({ entity: "quote", entityId: id, actorId: user.id, action: "created" });
  revalidatePath("/quotes");
  return ok({ id });
}

export async function updateQuote(id: string, input: unknown): Promise<ActionResult<{ approvalVoided: boolean }>> {
  const user = await requireUser();
  const parsed = quoteInput.partial().safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");
  try {
    const r = await updateQuoteContent(id, parsed.data, humanFromUser(user));
    revalidatePath("/quotes");
    revalidatePath(`/quotes/${id}`);
    revalidatePath("/approvals");
    return ok(r);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** Mark sent, accepted, declined, or reopen as draft. Customer-facing: a person only. */
export async function setQuoteStatus(id: string, status: string): Promise<ActionResult<{ jobId: string | null }>> {
  const user = await requireUser();
  const parsedStatus = z.enum(["draft", "sent", "accepted", "declined"]).safeParse(status);
  if (!parsedStatus.success) return fail("Invalid status");
  try {
    const r = await setStatus(id, parsedStatus.data, humanFromUser(user));
    revalidatePath("/quotes");
    revalidatePath(`/quotes/${id}`);
    revalidatePath("/jobs");
    revalidatePath("/leads");
    revalidatePath("/approvals");
    return ok(r);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** Chris approves a prepared quote exactly as it stands. */
export async function approveQuoteAction(id: string): Promise<ActionResult<undefined>> {
  const user = await requireUser();
  try {
    await approveQuote(id, humanFromUser(user));
    revalidatePath(`/quotes/${id}`);
    revalidatePath("/quotes");
    revalidatePath("/approvals");
    return ok(undefined);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export async function returnQuoteAction(id: string, note: string): Promise<ActionResult<undefined>> {
  const user = await requireUser();
  try {
    await returnQuoteForReview(id, humanFromUser(user), note.trim() || null);
    revalidatePath(`/quotes/${id}`);
    revalidatePath("/approvals");
    return ok(undefined);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
