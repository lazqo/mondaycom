/**
 * The Decisions queue: everything that waits on Chris, whatever produced it, in one list for Home.
 * Reviews Hermes could not settle, proposals (site visits, bookings, revised quotes, linking a
 * sender), replies and quotes prepared for a click, facts that conflict, candidate Business Brain
 * knowledge and packages. Plus the feed of what Hermes did on its own.
 */
import { and, desc, eq, inArray, ne, notInArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { brainCandidates, drafts, inspections, inspectorActions, packageCandidates, products, quoteDocuments, quotes } from "@/db/schema";
import { documentIsCurrent } from "@/lib/proposals/workflow";
import { formatDateTime } from "@/lib/utils";
import type { DraftView } from "@/components/brain/draft-card";
import { getInspectorQueue, IDENTITY_ACTIONS, type AwaitingItem, type ConflictItem, type ReviewItem } from "./inspector";

export type DecisionKind = "review" | "proposal" | "reply" | "quote" | "fact" | "knowledge" | "package";

export type QuoteDecision = { id: string; number: number; title: string; status: string; total: string; who: string | null; leadId: string | null; updatedAt: Date; origin: string };
export type KnowledgeDecision = typeof brainCandidates.$inferSelect;
export type PackageDecision = typeof packageCandidates.$inferSelect;
export type ProductOption = { id: string; label: string; category: string };

export type Decisions = {
  review: ReviewItem[];
  proposal: AwaitingItem[];
  reply: DraftView[];
  quote: QuoteDecision[];
  fact: ConflictItem[];
  knowledge: KnowledgeDecision[];
  package: PackageDecision[];
  /** Catalogue products, only when a package needs editing. */
  products: ProductOption[];
  total: number;
};

export async function getDecisions(): Promise<Decisions> {
  const [q, openDrafts, openQuotes, knowledge, pkgs] = await Promise.all([
    getInspectorQueue(),
    db.query.drafts.findMany({ where: inArray(drafts.status, ["ready_for_review", "approved", "revision_requested", "draft"]), with: { lead: { columns: { id: true, name: true } } }, orderBy: [desc(drafts.updatedAt)], limit: 50 }),
    db.query.quotes.findMany({ where: inArray(quotes.status, ["ai_prepared", "needs_review", "approved"]), with: { lead: { columns: { id: true, name: true } }, contact: { columns: { name: true } } }, orderBy: [desc(quotes.updatedAt)], limit: 50 }),
    db.select().from(brainCandidates).where(eq(brainCandidates.status, "proposed")).orderBy(desc(brainCandidates.createdAt)).limit(30),
    db.select().from(packageCandidates).where(eq(packageCandidates.status, "candidate")).orderBy(desc(packageCandidates.createdAt)).limit(30),
  ]);
  const docIds = [...new Set(openDrafts.map((d) => d.quoteDocumentId).filter(Boolean) as string[])];
  const docs = docIds.length ? await db.query.quoteDocuments.findMany({ where: inArray(quoteDocuments.id, docIds), columns: { id: true, quoteId: true, filename: true, voidedAt: true, approvalHash: true }, with: { quote: true } }) : [];
  const attachment = (id: string | null) => {
    const doc = docs.find((x) => x.id === id);
    return doc ? { id: doc.id, filename: doc.filename, current: documentIsCurrent(doc, doc.quote) } : null;
  };
  const reply: DraftView[] = openDrafts.map((d) => ({
    id: d.id,
    status: d.status,
    to: d.toAddresses.join(", "),
    cc: d.ccAddresses.join(", "),
    subject: d.subject,
    body: d.body,
    createdBy: d.createdByActor === "user" ? "staff" : d.createdByActor.replace(/^agent:/, "").replace(/^system:/, "system: "),
    createdAt: formatDateTime(d.createdAt),
    reviewNote: d.reviewNote,
    lead: d.lead,
    inTitanDrafts: !!d.mailboxDraftMessageId,
    attachment: attachment(d.quoteDocumentId),
  }));
  const quote: QuoteDecision[] = openQuotes.map((x) => ({ id: x.id, number: x.number, title: x.title, status: x.status, total: x.total, who: x.contact?.name ?? x.lead?.name ?? null, leadId: x.leadId, updatedAt: x.updatedAt, origin: x.origin }));
  const productRows = pkgs.length ? await db.select({ id: products.id, manufacturer: products.manufacturer, model: products.model, category: products.category }).from(products).where(ne(products.status, "deprecated")).orderBy(products.category, products.manufacturer, products.model) : [];
  const total = q.review.length + q.awaiting.length + reply.length + quote.length + q.conflicts.length + knowledge.length + pkgs.length;
  return { review: q.review, proposal: q.awaiting, reply, quote, fact: q.conflicts, knowledge, package: pkgs, products: productRows.map((p) => ({ id: p.id, label: `${p.manufacturer} ${p.model} (${p.category})`, category: p.category })), total };
}

/** How many decisions wait (the one badge). Cheap: counts only. */
export async function decisionsCount(): Promise<number> {
  const [r] = await db
    .select({
      n: sql<number>`
        (select count(*) from ${inspections} i where i.status = 'needs_review'
          and ((i.source_type = 'email' and exists (select 1 from emails e where e.id = i.source_id))
            or (i.source_type = 'recording' and exists (select 1 from recordings r where r.id = i.source_id and r.status <> 'dismissed'))))
        + (select count(*) from ${inspectorActions} a where a.status = 'awaiting_approval' and a.type not in (${sql.join(IDENTITY_ACTIONS.map((t) => sql`${t}`), sql`, `)}))
        + (select count(*) from ${drafts} d where d.status in ('ready_for_review', 'approved', 'revision_requested', 'draft'))
        + (select count(*) from ${quotes} qq where qq.status in ('ai_prepared', 'needs_review', 'approved'))
        + (select count(*) from facts f where f.state in ('conflict', 'proposed'))
        + (select count(*) from ${brainCandidates} b where b.status = 'proposed')
        + (select count(*) from ${packageCandidates} p where p.status = 'candidate')`,
    })
    .from(sql`(select 1) as one`);
  return Number(r?.n ?? 0);
}

export type FeedItem = { id: string; at: Date; type: string; status: string; reason: string; result: Record<string, unknown> | null; summary: string | null; leadId: string | null; contactId: string | null; jobId: string | null };

/** What Hermes did on its own, newest first: the feed on Home. */
export async function getHermesFeed(limit = 25): Promise<FeedItem[]> {
  const rows = await db
    .select({ id: inspectorActions.id, at: inspectorActions.createdAt, type: inspectorActions.type, status: inspectorActions.status, reason: inspectorActions.reason, result: inspectorActions.result, summary: inspections.summary, leadId: inspectorActions.leadId, contactId: inspectorActions.contactId, jobId: inspectorActions.jobId })
    .from(inspectorActions)
    .innerJoin(inspections, eq(inspections.id, inspectorActions.inspectionId))
    .where(and(inArray(inspectorActions.status, ["done", "already_in_hand", "blocked", "accepted"]), notInArray(inspectorActions.type, ["ADD_INTERNAL_NOTE", "NO_ACTION", "OUTSTANDING"]), ne(inspections.status, "superseded")))
    .orderBy(desc(inspectorActions.createdAt))
    .limit(limit);
  return rows.map((r) => ({ ...r, result: (r.result ?? null) as Record<string, unknown> | null }));
}
