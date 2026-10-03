/**
 * The branded proposal PDF for an approved quote.
 *
 *   Business Brain prepares the quote → Chris reviews and approves it → the CRM renders the PDF from
 *   exactly what he approved and stores it → the prepared email to the customer carries it →
 *   Chris approves and sends the email separately.
 *
 * Generating a PDF never sends anything. A PDF is valid only while its quote is still approved with
 * the same fingerprint; repricing, editing or sending the quote back voids it (see void.ts), and a
 * new approval makes a new one. An email whose PDF is no longer valid cannot be approved or sent.
 */
import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { catalogueImages, cctvAssessments, contacts, drafts, leads, products, quoteDocuments, quotes, type Quote, type QuoteDocument } from "@/db/schema";
import { logActivity } from "@/lib/activity";
import { type Actor, GuardrailError } from "@/lib/guard/actor";
import { quoteFingerprint } from "@/lib/quotes/workflow";
import { applyStarterContent } from "./content";
import { withAttachmentLine, withoutAttachmentLine } from "./email-line";
import { buildProposalData, type ProposalData } from "./data";
import { getProposalSettings } from "./settings";
import { voidProposals } from "./void";

export class ProposalError extends Error {}

/** Quote statuses in which an approved PDF stands. */
export const PROPOSAL_STATUSES: Quote["status"][] = ["approved", "sent", "accepted"];

export function documentIsCurrent(doc: Pick<QuoteDocument, "voidedAt" | "approvalHash">, quote: Quote): boolean {
  return !doc.voidedAt && PROPOSAL_STATUSES.includes(quote.status) && !!quote.approvalHash && quote.approvalHash === doc.approvalHash && quoteFingerprint(quote) === doc.approvalHash;
}

const fileSafe = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 40);

/** Everything the PDF prints, read from the approved quote. */
export async function proposalInputs(quoteId: string, opts: { draft?: boolean } = {}): Promise<{ quote: Quote; data: ProposalData; images: Record<string, { data: Buffer; contentType: string }> }> {
  const quote = await db.query.quotes.findFirst({ where: eq(quotes.id, quoteId) });
  if (!quote) throw new ProposalError("Quote not found.");
  await applyStarterContent().catch(() => {});
  const lead = quote.leadId ? await db.query.leads.findFirst({ where: eq(leads.id, quote.leadId) }) : null;
  const contact = quote.contactId ? await db.query.contacts.findFirst({ where: eq(contacts.id, quote.contactId) }) : null;
  const assessment = quote.assessmentId ? await db.query.cctvAssessments.findFirst({ where: eq(cctvAssessments.id, quote.assessmentId), columns: { input: true } }) : null;
  const ids = [...new Set((((quote.internalCosting as { lines?: { productId?: string | null }[] } | null)?.lines ?? []).map((l) => l.productId).filter(Boolean) as string[]))];
  const rows = ids.length
    ? await db
        .select({
          id: products.id,
          manufacturer: products.manufacturer,
          model: products.model,
          category: products.category,
          specs: products.specs,
          quoteDisplayName: products.quoteDisplayName,
          quoteDescription: products.quoteDescription,
          quoteHighlights: products.quoteHighlights,
          quoteFeatureNotes: products.quoteFeatureNotes,
          quoteImageId: products.quoteImageId,
          quoteShowCard: products.quoteShowCard,
        })
        .from(products)
        .where(inArray(products.id, ids))
    : [];
  const settings = await getProposalSettings();
  const data = buildProposalData({
    quote,
    products: rows,
    customer: { name: contact?.name ?? lead?.name ?? "Customer", site: lead?.site ?? null },
    coverage: ((assessment?.input as { areas?: string[] } | undefined)?.areas ?? []).slice(0, 12),
    settings,
    draft: opts.draft,
  });
  const imageIds = [...new Set(data.products.map((p) => p.imageId).filter(Boolean) as string[])];
  const imgs = imageIds.length ? await db.select({ id: catalogueImages.id, content: catalogueImages.content, contentType: catalogueImages.contentType }).from(catalogueImages).where(inArray(catalogueImages.id, imageIds)) : [];
  const images = Object.fromEntries(imgs.map((i) => [i.id, { data: Buffer.from(i.content), contentType: i.contentType }]));
  // A card whose image is gone simply has no picture.
  for (const p of data.products) if (p.imageId && !images[p.imageId]) p.imageId = null;
  return { quote, data, images };
}

async function render(data: ProposalData, images: Record<string, { data: Buffer; contentType: string }>) {
  const { renderProposalPdf } = await import("./render");
  return renderProposalPdf(data, images);
}

/** A preview of the PDF as the quote stands now (marked DRAFT unless it is approved). Not stored. */
export async function previewProposal(quoteId: string): Promise<{ filename: string; content: Buffer }> {
  const q = await db.query.quotes.findFirst({ where: eq(quotes.id, quoteId), columns: { status: true, approvalHash: true, number: true } });
  if (!q) throw new ProposalError("Quote not found.");
  const approved = PROPOSAL_STATUSES.includes(q.status) && !!q.approvalHash;
  const { data, images } = await proposalInputs(quoteId, { draft: !approved });
  return { filename: `Get-Secure-Proposal-Q-${q.number}-preview.pdf`, content: await render(data, images) };
}

/**
 * Render and store the proposal for an approved quote, replacing any earlier one, and attach it to
 * the prepared customer email(s) for the lead. Nothing is sent; an email that was already approved
 * goes back to Chris because its attachment changed.
 */
export async function generateProposal(quoteId: string, actor: Actor): Promise<{ documentId: string; attachedTo: string[] }> {
  if (actor.kind !== "human") throw new GuardrailError("Only a person can finalise a customer proposal.");
  const { quote, data, images } = await proposalInputs(quoteId);
  if (!PROPOSAL_STATUSES.includes(quote.status) || !quote.approvalHash) throw new ProposalError("Approve the quote first: the proposal is made from the approved quote.");
  if (quoteFingerprint(quote) !== quote.approvalHash) throw new ProposalError("The quote changed after it was approved. It needs approving again.");
  const content = await render(data, images);
  const customer = fileSafe(data.customer.name);
  const filename = `Get-Secure-Proposal-Q-${quote.number}${customer ? `-${customer}` : ""}.pdf`;

  await voidProposals(quote.id, "replaced by a newer proposal", actor.userId);
  const [doc] = await db
    .insert(quoteDocuments)
    .values({
      quoteId: quote.id,
      kind: "proposal",
      approvalHash: quote.approvalHash,
      filename,
      size: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
      data: data as unknown as Record<string, unknown>,
      content,
      generatedById: actor.userId,
    })
    .returning({ id: quoteDocuments.id });

  // Attach to the lead's prepared, unsent customer emails: Brain-prepared ones without an attachment,
  // and any that carried an earlier proposal for this quote.
  const attachedTo: string[] = [];
  if (quote.leadId) {
    const earlier = await db.select({ id: quoteDocuments.id }).from(quoteDocuments).where(and(eq(quoteDocuments.quoteId, quote.id), isNotNull(quoteDocuments.voidedAt)));
    const open = await db.query.drafts.findMany({
      where: and(
        eq(drafts.leadId, quote.leadId),
        eq(drafts.kind, "email"),
        inArray(drafts.status, ["draft", "ready_for_review", "revision_requested", "approved"]),
        or(and(isNull(drafts.quoteDocumentId), isNotNull(drafts.assessmentId)), earlier.length ? inArray(drafts.quoteDocumentId, earlier.map((e) => e.id)) : undefined),
      ),
      orderBy: [desc(drafts.createdAt)],
    });
    for (const d of open) {
      await db
        .update(drafts)
        .set({
          quoteDocumentId: doc.id,
          body: withAttachmentLine(d.body),
          updatedAt: new Date(),
          ...(d.status === "approved" ? { status: "ready_for_review" as const, approvedById: null, approvedAt: null, approvalHash: null, reviewNote: "Proposal PDF attached: approve the email again." } : {}),
        })
        .where(eq(drafts.id, d.id));
      attachedTo.push(d.id);
    }
  }
  await logActivity({ entity: "quote", entityId: quote.id, actorId: actor.userId, action: "proposal_generated", detail: { documentId: doc.id, filename, attachedTo } });
  if (quote.leadId) await logActivity({ entity: "lead", entityId: quote.leadId, actorId: actor.userId, action: "proposal_generated", detail: { quoteNumber: quote.number, filename } });
  return { documentId: doc.id, attachedTo };
}

/** The current (valid) proposal for a quote, without its bytes. */
export async function currentProposal(quoteId: string) {
  const quote = await db.query.quotes.findFirst({ where: eq(quotes.id, quoteId) });
  if (!quote) return null;
  const doc = await db.query.quoteDocuments.findFirst({
    where: and(eq(quoteDocuments.quoteId, quoteId), isNull(quoteDocuments.voidedAt)),
    orderBy: [desc(quoteDocuments.generatedAt)],
    columns: { content: false, data: false },
  });
  return doc && documentIsCurrent(doc, quote) ? doc : null;
}

/** The proposal file for download or sending; refused unless it is still valid. */
export async function proposalFile(documentId: string): Promise<{ filename: string; content: Buffer; current: boolean; quoteId: string }> {
  const doc = await db.query.quoteDocuments.findFirst({ where: eq(quoteDocuments.id, documentId) });
  if (!doc) throw new ProposalError("Proposal not found.");
  const quote = await db.query.quotes.findFirst({ where: eq(quotes.id, doc.quoteId) });
  return { filename: doc.filename, content: Buffer.from(doc.content), current: !!quote && documentIsCurrent(doc, quote), quoteId: doc.quoteId };
}

/** For sending: the attachment of an email draft, only if it is still the valid proposal. */
export async function attachmentForDraft(documentId: string): Promise<{ filename: string; content: Buffer; contentType: string }> {
  const f = await proposalFile(documentId);
  if (!f.current) throw new GuardrailError("The attached proposal PDF is no longer valid (the quote changed). Approve the quote again to make a new one.");
  return { filename: f.filename, content: f.content, contentType: "application/pdf" };
}

/** Attach the quote's current proposal to an email draft (an approved draft goes back for approval). */
export async function attachProposalToDraft(draftId: string, quoteId: string, actor: Actor): Promise<void> {
  if (actor.kind !== "human") throw new GuardrailError("Only a person can attach a proposal.");
  const doc = await currentProposal(quoteId);
  if (!doc) throw new ProposalError("This quote has no current proposal PDF. Approve the quote to make one.");
  const d = await db.query.drafts.findFirst({ where: eq(drafts.id, draftId) });
  if (!d) throw new ProposalError("Draft not found.");
  if (["sent", "rejected", "cancelled"].includes(d.status)) throw new ProposalError(`A ${d.status} email cannot be changed.`);
  await db
    .update(drafts)
    .set({ quoteDocumentId: doc.id, body: withAttachmentLine(d.body), updatedAt: new Date(), ...(d.status === "approved" && (d.quoteDocumentId !== doc.id || withAttachmentLine(d.body) !== d.body) ? { status: "ready_for_review" as const, approvedById: null, approvedAt: null, approvalHash: null } : {}) })
    .where(eq(drafts.id, draftId));
}

/** Take the proposal off an email draft. */
export async function detachProposal(draftId: string, actor: Actor): Promise<void> {
  if (actor.kind !== "human") throw new GuardrailError("Only a person can change an email's attachments.");
  const d = await db.query.drafts.findFirst({ where: eq(drafts.id, draftId) });
  if (!d) throw new ProposalError("Draft not found.");
  if (["sent", "rejected", "cancelled"].includes(d.status)) throw new ProposalError(`A ${d.status} email cannot be changed.`);
  await db
    .update(drafts)
    .set({ quoteDocumentId: null, body: withoutAttachmentLine(d.body), updatedAt: new Date(), ...(d.status === "approved" ? { status: "ready_for_review" as const, approvedById: null, approvedAt: null, approvalHash: null } : {}) })
    .where(eq(drafts.id, draftId));
}

/** What the quote page shows about the proposal: the current PDF, the customer emails, wording gaps. */
export async function proposalPanelData(quoteId: string) {
  const quote = await db.query.quotes.findFirst({ where: eq(quotes.id, quoteId) });
  if (!quote) return null;
  await applyStarterContent().catch(() => {});
  const current = await currentProposal(quoteId);
  const emails = quote.leadId
    ? await db.query.drafts.findMany({
        where: and(eq(drafts.leadId, quote.leadId), eq(drafts.kind, "email"), inArray(drafts.status, ["draft", "ready_for_review", "revision_requested", "approved", "sent"])),
        orderBy: [desc(drafts.createdAt)],
        columns: { id: true, subject: true, status: true, quoteDocumentId: true },
        limit: 5,
      })
    : [];
  const lines = ((quote.internalCosting as { lines?: { productId?: string | null; internalOnly?: boolean }[] } | null)?.lines ?? []).filter((l) => l.productId && !l.internalOnly);
  const ids = [...new Set(lines.map((l) => l.productId!))];
  const rows = ids.length ? await db.query.products.findMany({ where: inArray(products.id, ids) }) : [];
  const { CARD_CATEGORIES } = await import("./data");
  const contentGaps = rows
    .filter((p) => p.quoteShowCard ?? CARD_CATEGORIES.includes(p.category))
    .map((p) => ({
      productId: p.id,
      name: p.quoteDisplayName ?? `${p.manufacturer} ${p.model}`,
      gaps: [
        !p.quoteDisplayName ? "no customer name" : null,
        !p.quoteDescription ? "no short description" : null,
        !p.quoteHighlights.length ? "no highlights" : null,
        !p.quoteImageId ? "no photo" : null,
        p.quoteDisplayName && p.quoteContentStatus !== "getsecure_approved" ? "wording not reviewed" : null,
      ].filter(Boolean) as string[],
    }))
    .filter((g) => g.gaps.length);
  const settings = await getProposalSettings();
  return {
    validity: { quote: quote.validityDays, standard: settings.validityDays, editable: ["ai_prepared", "needs_review", "approved"].includes(quote.status) },
    approved: PROPOSAL_STATUSES.includes(quote.status) && !!quote.approvalHash,
    current: current ? { id: current.id, filename: current.filename, generatedAt: current.generatedAt, size: current.size } : null,
    emails: emails.map((e) => ({ id: e.id, subject: e.subject, status: e.status, attachment: e.quoteDocumentId ? (current && e.quoteDocumentId === current.id ? ("current" as const) : ("void" as const)) : null })),
    contentGaps,
  };
}
