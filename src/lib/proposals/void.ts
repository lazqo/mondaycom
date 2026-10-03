/**
 * Voiding a quote's proposal PDF. Called whenever the quote stops being approved as it stood
 * (edited, repriced, sent back, superseded). A voided PDF can no longer be downloaded as current or
 * sent; an approved email carrying it loses its approval, so Chris sees it again with the new PDF.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { drafts, quoteDocuments } from "@/db/schema";
import { logActivity } from "@/lib/activity";

export async function voidProposals(quoteId: string, reason: string, actorId: string | null = null): Promise<number> {
  const current = await db
    .update(quoteDocuments)
    .set({ voidedAt: new Date(), voidReason: reason })
    .where(and(eq(quoteDocuments.quoteId, quoteId), isNull(quoteDocuments.voidedAt)))
    .returning({ id: quoteDocuments.id });
  if (!current.length) return 0;
  const ids = current.map((d) => d.id);
  await db
    .update(drafts)
    .set({ status: "ready_for_review", approvedById: null, approvedAt: null, approvalHash: null, reviewNote: "The attached proposal PDF is no longer valid (the quote changed). Approve the quote again to attach a new one.", updatedAt: new Date() })
    .where(and(inArray(drafts.quoteDocumentId, ids), eq(drafts.status, "approved")));
  await logActivity({ entity: "quote", entityId: quoteId, actorId, action: "proposal_voided", detail: { reason, documents: ids } });
  return ids.length;
}
