"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { jobs, leads, quotes } from "@/db/schema";
import { computeTotals } from "@/lib/quotes";
import { requireOffice as requireUser } from "@/lib/auth";
import { logActivity } from "@/lib/activity";
import { QUOTE_STATUSES } from "@/lib/constants";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { nextNumber } from "@/lib/numbering";

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

export async function updateQuote(id: string, input: unknown): Promise<ActionResult<undefined>> {
  const user = await requireUser();
  const parsed = quoteInput.partial().safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");
  const existing = await db.query.quotes.findFirst({ where: eq(quotes.id, id) });
  if (!existing) return fail("Quote not found");
  const lineItems = parsed.data.lineItems ?? existing.lineItems;
  const taxRate = parsed.data.taxRate ?? Number(existing.taxRate);
  const totals = computeTotals(lineItems, taxRate);
  await db
    .update(quotes)
    .set({
      ...parsed.data,
      lineItems,
      taxRate: taxRate.toFixed(2),
      subtotal: totals.subtotal,
      total: totals.total,
      updatedAt: new Date(),
    })
    .where(eq(quotes.id, id));
  await logActivity({ entity: "quote", entityId: id, actorId: user.id, action: "updated" });
  revalidatePath("/quotes");
  revalidatePath(`/quotes/${id}`);
  return ok(undefined);
}

export async function setQuoteStatus(id: string, status: string): Promise<ActionResult<{ jobId: string | null }>> {
  const user = await requireUser();
  const parsedStatus = z.enum(QUOTE_STATUSES).safeParse(status);
  if (!parsedStatus.success) return fail("Invalid status");
  const quote = await db.query.quotes.findFirst({ where: eq(quotes.id, id), with: { jobs: true } });
  if (!quote) return fail("Quote not found");
  const s = parsedStatus.data;

  const jobId = await db.transaction(async (tx) => {
    await tx
      .update(quotes)
      .set({
        status: s,
        sentAt: s === "sent" && !quote.sentAt ? new Date() : quote.sentAt,
        acceptedAt: s === "accepted" ? new Date() : quote.acceptedAt,
        updatedAt: new Date(),
      })
      .where(eq(quotes.id, id));

    // Keep the originating lead in step with the quote.
    if (quote.leadId) {
      const leadStatus = s === "sent" ? "quote_sent" : s === "accepted" ? "won" : s === "declined" ? "lost" : null;
      if (leadStatus) {
        await tx.update(leads).set({ status: leadStatus, updatedAt: new Date() }).where(eq(leads.id, quote.leadId));
        await logActivity({
          entity: "lead",
          entityId: quote.leadId,
          actorId: user.id,
          action: "status_changed",
          detail: { changes: { status: { to: leadStatus } }, via: `quote #${quote.number}` },
        });
      }
    }

    // Accepting a quote creates the job if there isn't one yet.
    if (s === "accepted" && quote.jobs.length === 0) {
      const number = await nextNumber(tx, "jobs");
      const lead = quote.leadId ? await tx.query.leads.findFirst({ where: eq(leads.id, quote.leadId) }) : null;
      const [row] = await tx
        .insert(jobs)
        .values({
          number,
          title: quote.title,
          contactId: quote.contactId,
          leadId: quote.leadId,
          quoteId: quote.id,
          service: lead?.service ?? null,
          siteAddress: lead?.site ?? null,
          assignedToId: lead?.assignedToId ?? null,
        })
        .returning({ id: jobs.id });
      await logActivity({ entity: "job", entityId: row.id, actorId: user.id, action: "created", detail: { fromQuoteId: id } });
      return row.id;
    }
    return quote.jobs[0]?.id ?? null;
  });

  await logActivity({ entity: "quote", entityId: id, actorId: user.id, action: "status_changed", detail: { to: s } });
  revalidatePath("/quotes");
  revalidatePath(`/quotes/${id}`);
  revalidatePath("/jobs");
  revalidatePath("/leads");
  return ok({ jobId });
}
