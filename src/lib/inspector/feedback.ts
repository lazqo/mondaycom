/**
 * Learning-ready feedback: every decision Chris makes on what the Inspector recommended, and what
 * happened afterwards, stored next to what Hermes recommended at the time. Nothing here changes a
 * rule, a price or a workflow; it is the record a later learning layer will read (and propose
 * changes from, for Chris to approve). Never throws: feedback must not break the action it records.
 */
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { inspections, inspectorFeedback, inspectorRuns } from "@/db/schema";

export type FeedbackKind =
  | "action_accepted"
  | "action_dismissed"
  | "identity_confirmed"
  | "not_a_customer"
  | "fact_applied"
  | "fact_rejected"
  | "review_resolved"
  | "commitment_done"
  | "commitment_cancelled"
  | "quote_approved"
  | "quote_edited"
  | "draft_edited"
  | "draft_sent"
  | "lead_won"
  | "lead_lost";

export async function recordFeedback(f: { inspectionId?: string | null; leadId?: string | null; contactId?: string | null; kind: FeedbackKind; subject?: string | null; value?: Record<string, unknown>; userId?: string | null }): Promise<void> {
  try {
    let inspectionId = f.inspectionId ?? null;
    let leadId = f.leadId ?? null;
    let contactId = f.contactId ?? null;
    // An outcome on a lead belongs to the latest Hermes reading of that lead.
    if (!inspectionId && leadId) {
      const latest = await db.query.inspections.findFirst({ where: and(eq(inspections.leadId, leadId), eq(inspections.engine, "hermes")), orderBy: [desc(inspections.createdAt)], columns: { id: true } });
      inspectionId = latest?.id ?? null;
    }
    let runId: string | null = null;
    let recommendation: string | null = null;
    if (inspectionId) {
      const ins = await db.query.inspections.findFirst({ where: eq(inspections.id, inspectionId), columns: { leadId: true, contactId: true } });
      leadId ??= ins?.leadId ?? null;
      contactId ??= ins?.contactId ?? null;
      const run = await db.query.inspectorRuns.findFirst({ where: and(eq(inspectorRuns.inspectionId, inspectionId), isNotNull(inspectorRuns.recommendedAction)), orderBy: [desc(inspectorRuns.createdAt)], columns: { id: true, recommendedAction: true } });
      runId = run?.id ?? null;
      recommendation = run?.recommendedAction ?? null;
    }
    if (!inspectionId && !leadId && !contactId) return;
    await db.insert(inspectorFeedback).values({ inspectionId, runId, leadId, contactId, kind: f.kind, subject: f.subject ?? null, hermesRecommendation: recommendation, value: f.value ?? null, userId: f.userId ?? null });
  } catch (err) {
    console.error(`[inspector] feedback ${f.kind}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
