/**
 * Quote states and the rules that move between them.
 *
 *   Person-written:  draft → sent → accepted | declined
 *   System-prepared: ai_prepared → needs_review → approved (Chris) → sent → accepted | declined
 *                    any newer revision → superseded
 *
 * Approval records a fingerprint of what Chris saw: title, customer, lines, tax, notes, total. If
 * any of it changes afterwards the approval is void and the quote goes back to needs_review, so an
 * approved quote can never change quietly before it is sent.
 *
 * Sending, accepting and declining are customer-facing and need a person; an agent or automation
 * is refused in code.
 */
import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { jobs, leads, quotes, type Quote, type QuoteLineItem } from "@/db/schema";
import { logActivity } from "@/lib/activity";
import { computeTotals } from "@/lib/quotes";
import { nextNumber } from "@/lib/numbering";
import { type Actor, GuardrailError, assertAgentMay, assertApprover, assertMayActOnCustomer } from "@/lib/guard/actor";

export class QuoteWorkflowError extends Error {}

const actorId = (a: Actor) => (a.kind === "human" ? a.userId : null);

export function quoteFingerprint(q: Pick<Quote, "title" | "contactId" | "leadId" | "lineItems" | "taxRate" | "notes" | "total">): string {
  const canonical = JSON.stringify({
    title: q.title,
    contactId: q.contactId,
    leadId: q.leadId,
    lineItems: q.lineItems.map((l) => ({ d: l.description, q: Number(l.quantity), p: Number(l.unitPrice) })),
    taxRate: Number(q.taxRate).toFixed(2),
    notes: q.notes ?? "",
    total: Number(q.total).toFixed(2),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

async function load(id: string) {
  const q = await db.query.quotes.findFirst({ where: eq(quotes.id, id), with: { jobs: true } });
  if (!q) throw new QuoteWorkflowError("Quote not found");
  return q;
}

export type QuoteContent = { title?: string; contactId?: string | null; leadId?: string | null; taxRate?: number; lineItems?: QuoteLineItem[]; notes?: string | null };

/**
 * Change a quote's content. An approved quote whose content changes goes back to needs_review; a
 * sent or superseded system quote cannot be edited (make a revision instead).
 */
export async function updateQuoteContent(id: string, patch: QuoteContent, actor: Actor): Promise<{ approvalVoided: boolean }> {
  const q = await load(id);
  if (q.status === "superseded") throw new QuoteWorkflowError("This quote has been superseded by a newer revision.");
  if (q.origin === "brain" && ["sent", "accepted", "declined"].includes(q.status)) throw new QuoteWorkflowError("A sent quote cannot be edited. Make a revision instead.");
  const lineItems = patch.lineItems ?? q.lineItems;
  const taxRate = patch.taxRate ?? Number(q.taxRate);
  const totals = computeTotals(lineItems, taxRate);
  const next = {
    title: patch.title ?? q.title,
    contactId: patch.contactId === undefined ? q.contactId : patch.contactId,
    leadId: patch.leadId === undefined ? q.leadId : patch.leadId,
    lineItems,
    taxRate: taxRate.toFixed(2),
    notes: patch.notes === undefined ? q.notes : patch.notes,
    subtotal: totals.subtotal,
    total: totals.total,
  };
  const voids = q.status === "approved" && quoteFingerprint(next) !== q.approvalHash;
  await db
    .update(quotes)
    .set({ ...next, updatedAt: new Date(), ...(voids ? { status: "needs_review" as const, approvedById: null, approvedAt: null, approvalHash: null } : {}) })
    .where(eq(quotes.id, id));
  await logActivity({ entity: "quote", entityId: id, actorId: actorId(actor), action: "updated" });
  if (voids) await logActivity({ entity: "quote", entityId: id, actorId: actorId(actor), action: "approval_invalidated", detail: { reason: "changed after approval" } });
  return { approvalVoided: voids };
}

/** Chris approves a system-prepared quote exactly as it stands. */
/** Priced hardware in a prepared quote's snapshot whose supplier price is stale or undated. */
export function staleSupplierPrices(internalCosting: unknown): string[] {
  const lines = (internalCosting as { lines?: { priced?: boolean; productId?: string | null; model?: string | null; supplier?: string | null; freshness?: string | null }[] } | null)?.lines ?? [];
  return lines
    .filter((l) => l.priced && l.productId && (l.freshness === "stale" || l.freshness === "unknown"))
    .map((l) => `${l.model ?? "item"}${l.supplier ? ` (${l.supplier}, ${l.freshness})` : ""}`);
}

export async function approveQuote(id: string, actor: Actor): Promise<void> {
  assertApprover(actor);
  const q = await load(id);
  if (!["ai_prepared", "needs_review"].includes(q.status)) throw new QuoteWorkflowError(`A quote that is ${q.status.replace(/_/g, " ")} cannot be approved.`);
  if (!q.lineItems.length) throw new QuoteWorkflowError("The quote has no lines.");
  // A Business Brain quote with stale prices, or that is not fully priced, cannot be approved.
  const problems: string[] = [];
  const stale = staleSupplierPrices(q.internalCosting);
  if (stale.length) problems.push(`Refresh supplier price before final quote approval: ${stale.join("; ")}.`);
  const snap = q.internalCosting as { complete?: boolean; unpriced?: string[] } | null;
  if (snap && snap.complete === false) problems.push(`Not fully priced: ${(snap.unpriced ?? []).join("; ") || "some inputs are missing"}.`);
  if (problems.length) throw new QuoteWorkflowError(`${problems.join(" ")} Fix that, re-run the assessment and prepare the quote again.`);
  await db
    .update(quotes)
    .set({ status: "approved", approvedById: actor.userId, approvedAt: new Date(), approvalHash: quoteFingerprint(q), updatedAt: new Date() })
    .where(eq(quotes.id, id));
  await logActivity({ entity: "quote", entityId: id, actorId: actor.userId, action: "status_changed", detail: { to: "approved" } });
}

/** Send back for changes (the reason is kept on the quote's history). */
export async function returnQuoteForReview(id: string, actor: Actor, note: string | null): Promise<void> {
  assertApprover(actor);
  const q = await load(id);
  if (!["ai_prepared", "needs_review", "approved"].includes(q.status)) throw new QuoteWorkflowError("Only an unsent quote can be sent back for review.");
  await db.update(quotes).set({ status: "needs_review", approvedById: null, approvedAt: null, approvalHash: null, updatedAt: new Date() }).where(eq(quotes.id, id));
  await logActivity({ entity: "quote", entityId: id, actorId: actor.userId, action: "returned_for_review", detail: { note } });
}

const LEAD_STATUS_FOR: Partial<Record<Quote["status"], "quote_sent" | "won" | "lost">> = { sent: "quote_sent", accepted: "won", declined: "lost" };

/**
 * Move a quote to sent, accepted, declined or back to draft. All of these are customer-facing or
 * record a customer decision, so only a person can do it; a system quote must be approved, and
 * unchanged since, before it can be marked sent.
 */
export async function setQuoteStatus(id: string, status: "draft" | "sent" | "accepted" | "declined", actor: Actor): Promise<{ jobId: string | null }> {
  assertMayActOnCustomer(actor, status === "sent" ? "send_quote" : "accept_or_decline_terms");
  const q = await load(id);

  if (status === "sent") {
    if (q.origin === "brain") {
      if (q.status !== "approved") throw new GuardrailError("This quote has not been approved by Chris, so it cannot be sent.");
      if (quoteFingerprint(q) !== q.approvalHash) throw new GuardrailError("The quote changed after it was approved. It needs approving again.");
    } else if (q.status !== "draft") {
      throw new QuoteWorkflowError(`A quote that is ${q.status.replace(/_/g, " ")} cannot be marked sent.`);
    }
  }
  if (status === "accepted" && !q.contactId) throw new QuoteWorkflowError("Convert the lead to a customer before accepting the quote, so the job has a customer.");
  if (status === "draft" && q.origin === "brain") throw new QuoteWorkflowError("A system-prepared quote goes back to Needs review, not Draft.");
  if (q.status === "superseded") throw new QuoteWorkflowError("This quote has been superseded.");

  const jobId = await db.transaction(async (tx) => {
    await tx
      .update(quotes)
      .set({
        status,
        sentAt: status === "sent" && !q.sentAt ? new Date() : q.sentAt,
        acceptedAt: status === "accepted" ? new Date() : q.acceptedAt,
        updatedAt: new Date(),
      })
      .where(eq(quotes.id, id));

    const leadStatus = LEAD_STATUS_FOR[status];
    if (q.leadId && leadStatus) {
      await tx.update(leads).set({ status: leadStatus, updatedAt: new Date() }).where(eq(leads.id, q.leadId));
      await logActivity({ entity: "lead", entityId: q.leadId, actorId: actor.userId, action: "status_changed", detail: { changes: { status: { to: leadStatus } }, via: `quote #${q.number}` } });
    }

    if (status === "accepted" && q.jobs.length === 0) {
      const number = await nextNumber(tx, "jobs");
      const lead = q.leadId ? await tx.query.leads.findFirst({ where: eq(leads.id, q.leadId) }) : null;
      const [row] = await tx
        .insert(jobs)
        .values({
          number,
          title: q.title,
          contactId: q.contactId!,
          leadId: q.leadId,
          quoteId: q.id,
          service: lead?.service ?? null,
          siteAddress: lead?.site ?? null,
          assignedToId: lead?.assignedToId ?? null,
        })
        .returning({ id: jobs.id });
      await logActivity({ entity: "job", entityId: row.id, actorId: actor.userId, action: "created", detail: { fromQuoteId: id } });
      return row.id;
    }
    return q.jobs[0]?.id ?? null;
  });
  await logActivity({ entity: "quote", entityId: id, actorId: actor.userId, action: "status_changed", detail: { to: status } });
  return { jobId };
}

/**
 * A quote prepared from a CCTV assessment. It goes straight to needs_review; nothing reaches the
 * customer. Earlier unsent system quotes for the same lead are superseded by it.
 */
export async function createPreparedQuote(
  input: { leadId: string; contactId: string | null; assessmentId: string; title: string; lineItems: QuoteLineItem[]; taxRatePct: number; notes: string; internalCosting: Record<string, unknown>; confidence: Record<string, unknown> },
  actor: Actor,
): Promise<{ id: string; number: number; superseded: string[] }> {
  assertAgentMay(actor, "create_quote_draft");
  const totals = computeTotals(input.lineItems, input.taxRatePct);
  const result = await db.transaction(async (tx) => {
    const open = await tx.query.quotes.findMany({
      where: and(eq(quotes.leadId, input.leadId), eq(quotes.origin, "brain"), inArray(quotes.status, ["ai_prepared", "needs_review", "approved"])),
      columns: { id: true, version: true },
    });
    const number = await nextNumber(tx, "quotes");
    const version = open.reduce((m, q) => Math.max(m, q.version), 0) + 1;
    const [row] = await tx
      .insert(quotes)
      .values({
        number,
        title: input.title,
        contactId: input.contactId,
        leadId: input.leadId,
        status: "ai_prepared",
        origin: "brain",
        assessmentId: input.assessmentId,
        version,
        revisionOfId: open[0]?.id ?? null,
        lineItems: input.lineItems,
        taxRate: input.taxRatePct.toFixed(2),
        subtotal: totals.subtotal,
        total: totals.total,
        notes: input.notes,
        internalCosting: input.internalCosting,
        confidence: input.confidence,
      })
      .returning({ id: quotes.id, number: quotes.number });
    if (open.length) await tx.update(quotes).set({ status: "superseded", updatedAt: new Date() }).where(inArray(quotes.id, open.map((q) => q.id)));
    // Prepared → waiting for Chris.
    await tx.update(quotes).set({ status: "needs_review" }).where(eq(quotes.id, row.id));
    return { ...row, superseded: open.map((q) => q.id) };
  });
  await logActivity({ entity: "quote", entityId: result.id, actorId: actorId(actor), action: "created", detail: { prepared: true, by: actor.kind === "agent" ? actor.agent : actor.kind } });
  for (const s of result.superseded) await logActivity({ entity: "quote", entityId: s, actorId: actorId(actor), action: "superseded", detail: { by: result.id } });
  return result;
}
