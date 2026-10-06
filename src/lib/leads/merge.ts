/**
 * Merge one lead into another: everything filed on the duplicate (emails, threads, recordings,
 * tasks, promises, quotes, jobs, visits, readings, facts, drafts, research) moves to the lead that
 * stays; blanks on it are filled from the duplicate; the duplicate is archived with a note of where
 * it went. Both timelines record it. Only a person merges.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { cctvAssessments, commitments, drafts, emailThreads, emails, events, facts, inspections, inspectorActions, inspectorFeedback, jobs, leads, quotes, recordings, researchFindings, tasks } from "@/db/schema";
import { logActivity } from "@/lib/activity";

const FILL: (keyof typeof leads.$inferSelect)[] = ["phone", "email", "company", "site", "service", "summary", "notes", "assignedToId", "contactId", "urgency"];

export async function mergeLeads(sourceId: string, targetId: string, actorId: string): Promise<{ moved: Record<string, number>; filled: string[] }> {
  if (sourceId === targetId) throw new Error("Choose a different lead to merge into.");
  const [source, target] = await Promise.all([db.query.leads.findFirst({ where: eq(leads.id, sourceId) }), db.query.leads.findFirst({ where: eq(leads.id, targetId) })]);
  if (!source || !target) throw new Error("Lead not found.");
  if (target.archivedAt) throw new Error("The lead to keep is archived; merge the other way round.");
  const moved: Record<string, number> = {};
  const filled: string[] = [];
  await db.transaction(async (tx) => {
    const move = async (name: string, table: { leadId: unknown }, col: Parameters<typeof eq>[0]) => {
      const rows = await tx.update(table as never).set({ leadId: targetId } as never).where(eq(col, sourceId)).returning({ id: (table as unknown as { id: unknown }).id as never });
      if (rows.length) moved[name] = rows.length;
    };
    await move("emails", emails, emails.leadId);
    await move("threads", emailThreads, emailThreads.leadId);
    await move("recordings", recordings, recordings.leadId);
    await move("tasks", tasks, tasks.leadId);
    await move("commitments", commitments, commitments.leadId);
    await move("quotes", quotes, quotes.leadId);
    await move("jobs", jobs, jobs.leadId);
    await move("events", events, events.leadId);
    await move("assessments", cctvAssessments, cctvAssessments.leadId);
    await move("drafts", drafts, drafts.leadId);
    await move("readings", inspections, inspections.leadId);
    await move("actions", inspectorActions, inspectorActions.leadId);
    await move("facts", facts, facts.leadId);
    await move("feedback", inspectorFeedback, inspectorFeedback.leadId);
    await move("research", researchFindings, researchFindings.leadId);
    // Blanks on the lead that stays are filled from the duplicate; nothing on it is overwritten.
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of FILL) {
      const have = target[k];
      const theirs = source[k];
      if ((have == null || have === "") && theirs != null && theirs !== "") {
        patch[k] = theirs;
        filled.push(String(k));
      }
    }
    if (!target.emailThreadId && source.emailThreadId) patch.emailThreadId = source.emailThreadId;
    if (!target.sourceEmailId && source.sourceEmailId) patch.sourceEmailId = source.sourceEmailId;
    await tx.update(leads).set(patch).where(eq(leads.id, targetId));
    await tx
      .update(leads)
      .set({ archivedAt: new Date(), updatedAt: new Date(), notes: `${source.notes ? `${source.notes}\n\n` : ""}Merged into ${target.name} (${targetId}).` })
      .where(eq(leads.id, sourceId));
  });
  await logActivity({ entity: "lead", entityId: targetId, actorId, action: "lead_merged_in", detail: { fromLeadId: sourceId, fromName: source.name, moved, filled } });
  await logActivity({ entity: "lead", entityId: sourceId, actorId, action: "lead_merged_away", detail: { intoLeadId: targetId, intoName: target.name, moved } });
  return { moved, filled };
}
