/**
 * Reads for the Lead + Conversation Inspector: the review queue, the panels on a lead or job, the
 * commitments on Today, and Jev's shadow answers beside the rules' and Chris's.
 */
import { and, asc, desc, eq, inArray, lt, ne, notInArray, or, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { commitments, contacts, emails, facts, inspections, inspectorActions, jevObservations, jobs, leads, recordings } from "@/db/schema";
import type { CommitmentRow, Fact, Inspection, InspectorActionRow } from "@/db/schema";
import type { IdentityCandidate, IdentityResult, Understanding } from "@/lib/inspector/types";

const NONE = "00000000-0000-0000-0000-000000000000";
const ids = (list: (string | null | undefined)[]) => {
  const out = [...new Set(list.filter((x): x is string => !!x))];
  return out.length ? out : [NONE];
};

/** Decided through identity review, not accept/dismiss. */
export const IDENTITY_ACTIONS = ["NEEDS_REVIEW", "LINK_RECORDING"];

export type SourceRef = { type: string; id: string; title: string; from: string | null; at: Date; href: string; dismissed?: boolean };

/** Where each email or recording came from, for display. */
async function sourcesFor(rows: { sourceType: string; sourceId: string; sourceAt?: Date }[]): Promise<Map<string, SourceRef>> {
  const emailIds = rows.filter((r) => r.sourceType === "email").map((r) => r.sourceId);
  const recIds = rows.filter((r) => r.sourceType === "recording").map((r) => r.sourceId);
  const [es, rs] = await Promise.all([
    db.select({ id: emails.id, subject: emails.subject, fromName: emails.fromName, fromAddress: emails.fromAddress, threadId: emails.threadId, at: emails.receivedAt, direction: emails.direction }).from(emails).where(inArray(emails.id, ids(emailIds))),
    db.select({ id: recordings.id, title: recordings.title, at: recordings.recordedAt, createdAt: recordings.createdAt, status: recordings.status }).from(recordings).where(inArray(recordings.id, ids(recIds))),
  ]);
  const map = new Map<string, SourceRef>();
  for (const e of es) map.set(e.id, { type: "email", id: e.id, title: e.subject || "(no subject)", from: e.direction === "outbound" ? "Get Secure" : (e.fromName ?? e.fromAddress), at: e.at, href: `/inbox/${e.threadId}` });
  for (const r of rs) map.set(r.id, { type: "recording", id: r.id, title: r.title, from: "Plaud conversation", at: r.at ?? r.createdAt, href: "/recordings", dismissed: r.status === "dismissed" });
  return map;
}

async function namesFor(leadIds: (string | null)[], contactIds: (string | null)[], jobIds: (string | null)[] = []) {
  const [ls, cs, js] = await Promise.all([
    db.select({ id: leads.id, name: leads.name }).from(leads).where(inArray(leads.id, ids(leadIds))),
    db.select({ id: contacts.id, name: contacts.name }).from(contacts).where(inArray(contacts.id, ids(contactIds))),
    db.select({ id: jobs.id, number: jobs.number, title: jobs.title }).from(jobs).where(inArray(jobs.id, ids(jobIds))),
  ]);
  return {
    lead: new Map(ls.map((l) => [l.id, l.name])),
    contact: new Map(cs.map((c) => [c.id, c.name])),
    job: new Map(js.map((j) => [j.id, `J-${j.number} ${j.title}`])),
  };
}

export type Subject = { label: string; href: string } | null;
function subjectOf(n: Awaited<ReturnType<typeof namesFor>>, r: { leadId: string | null; contactId: string | null; jobId?: string | null }): Subject {
  if (r.jobId && n.job.has(r.jobId)) return { label: n.job.get(r.jobId)!, href: `/jobs/${r.jobId}` };
  if (r.leadId && n.lead.has(r.leadId)) return { label: n.lead.get(r.leadId)!, href: `/leads/${r.leadId}` };
  if (r.contactId && n.contact.has(r.contactId)) return { label: n.contact.get(r.contactId)!, href: `/contacts/${r.contactId}` };
  return null;
}

export type ReviewItem = {
  inspection: Inspection;
  source: SourceRef | null;
  understanding: Understanding;
  identity: IdentityResult;
  candidates: (IdentityCandidate & { subject: Subject })[];
  /** The review's own action (NEEDS_REVIEW), with Hermes's recommendation in its payload. */
  reviewAction: InspectorActionRow | null;
};
export type AwaitingItem = { action: InspectorActionRow; source: SourceRef | null; subject: Subject };
export type ConflictItem = { fact: Fact; source: SourceRef | null; subject: Subject };
export type CommitmentItem = { commitment: CommitmentRow; source: SourceRef | null; subject: Subject };

const liveSource = sql`((${inspections.sourceType} = 'email' and exists (select 1 from emails e where e.id = ${inspections.sourceId}))
  or (${inspections.sourceType} = 'recording' and exists (select 1 from recordings r where r.id = ${inspections.sourceId} and r.status <> 'dismissed')))`;

/** Everything waiting for Chris in the Inspector. */
export async function getInspectorQueue() {
  const [review, awaiting, conflicts] = await Promise.all([
    // Only reviews whose email or recording still exists (as the badge counts them), so that
    // orphans left by a removed mailbox can never push a real review out of the first 50.
    db.query.inspections.findMany({ where: and(eq(inspections.status, "needs_review"), liveSource), orderBy: [desc(inspections.sourceAt)], limit: 50 }),
    db.query.inspectorActions.findMany({ where: and(eq(inspectorActions.status, "awaiting_approval"), notInArray(inspectorActions.type, IDENTITY_ACTIONS)), orderBy: [desc(inspectorActions.createdAt)], limit: 50 }),
    db.query.facts.findMany({ where: inArray(facts.state, ["conflict", "proposed"]), orderBy: [desc(facts.createdAt)], limit: 50 }),
  ]);
  const reviewActions = review.length
    ? await db.query.inspectorActions.findMany({ where: and(inArray(inspectorActions.inspectionId, ids(review.map((r) => r.id))), eq(inspectorActions.type, "NEEDS_REVIEW"), eq(inspectorActions.status, "awaiting_approval")) })
    : [];
  const actionInspections = awaiting.length ? await db.select({ id: inspections.id, sourceType: inspections.sourceType, sourceId: inspections.sourceId }).from(inspections).where(inArray(inspections.id, ids(awaiting.map((a) => a.inspectionId)))) : [];
  const insById = new Map(actionInspections.map((i) => [i.id, i]));
  const src = await sourcesFor([...review, ...conflicts.map((f) => ({ sourceType: f.sourceType, sourceId: f.sourceId })), ...actionInspections]);
  const candidateLists = review.map((r) => ((r.identity as unknown as IdentityResult).candidates ?? []).slice(0, 5));
  const all = candidateLists.flat();
  const n = await namesFor(
    [...all.map((c) => c.leadId), ...awaiting.map((a) => a.leadId), ...conflicts.map((f) => f.leadId)],
    [...all.map((c) => c.contactId), ...awaiting.map((a) => a.contactId), ...conflicts.map((f) => f.contactId)],
    [...awaiting.map((a) => a.jobId), ...conflicts.map((f) => f.jobId)],
  );
  // An email or recording that has since been deleted or dismissed has nothing left to decide.
  const live = (sourceId: string) => {
    const s = src.get(sourceId);
    return !!s && !s.dismissed;
  };
  return {
    review: review
      .filter((r) => live(r.sourceId))
      .map(
      (r): ReviewItem => ({
        inspection: r,
        source: src.get(r.sourceId) ?? null,
        understanding: r.understanding as unknown as Understanding,
        identity: r.identity as unknown as IdentityResult,
        candidates: ((r.identity as unknown as IdentityResult).candidates ?? []).slice(0, 5).map((c) => ({ ...c, subject: subjectOf(n, c) })),
        reviewAction: reviewActions.find((a) => a.inspectionId === r.id) ?? null,
      }),
    ),
    awaiting: awaiting.map((a): AwaitingItem => {
      const ins = insById.get(a.inspectionId);
      return { action: a, source: ins ? (src.get(ins.sourceId) ?? null) : null, subject: subjectOf(n, a) };
    }),
    conflicts: conflicts.map((f): ConflictItem => ({ fact: f, source: src.get(f.sourceId) ?? null, subject: subjectOf(n, f) })),
  };
}

/** How many things wait for Chris in the Inspector (for the nav badge and Today). */
export async function inspectorReviewCount(): Promise<number> {
  const [r] = await db
    .select({
      n: sql<number>`(select count(*) from inspections i where i.status = 'needs_review' and (
            (i.source_type = 'email' and exists (select 1 from emails e where e.id = i.source_id))
            or (i.source_type = 'recording' and exists (select 1 from recordings r where r.id = i.source_id and r.status <> 'dismissed'))))
        + (select count(*) from ${inspectorActions} where ${inspectorActions.status} = 'awaiting_approval' and ${inspectorActions.type} not in ('NEEDS_REVIEW', 'LINK_RECORDING'))
        + (select count(*) from ${facts} where ${facts.state} in ('conflict', 'proposed'))`,
    })
    .from(sql`(select 1) as one`);
  return Number(r?.n ?? 0);
}

/** Recent inspections, newest first, with what the router did for each. */
export async function getRecentInspections(limit = 30) {
  const rows = await db.query.inspections.findMany({ where: ne(inspections.status, "superseded"), orderBy: [desc(inspections.createdAt)], limit });
  const acts = rows.length ? await db.select().from(inspectorActions).where(inArray(inspectorActions.inspectionId, ids(rows.map((r) => r.id)))).orderBy(asc(inspectorActions.createdAt)) : [];
  const src = await sourcesFor(rows);
  const n = await namesFor(
    rows.map((r) => r.leadId),
    rows.map((r) => r.contactId),
    rows.map((r) => r.jobId),
  );
  return rows.map((r) => ({ inspection: r, source: src.get(r.sourceId) ?? null, subject: subjectOf(n, r), understanding: r.understanding as unknown as Understanding, actions: acts.filter((a) => a.inspectionId === r.id) }));
}

/** Outstanding commitments: Chris's (overdue, today, undated) and the customers'. */
export async function getOutstandingCommitments(scope: { leadIds?: string[]; contactId?: string | null; jobId?: string | null } | null = null) {
  const where = [eq(commitments.status, "outstanding")];
  if (scope) {
    const ors = [
      scope.leadIds?.length ? inArray(commitments.leadId, scope.leadIds) : undefined,
      scope.contactId ? eq(commitments.contactId, scope.contactId) : undefined,
      scope.jobId ? eq(commitments.jobId, scope.jobId) : undefined,
    ].filter(Boolean);
    if (!ors.length) return [];
    where.push(or(...ors)!);
  } else {
    // On Today, only commitments tied to someone: an unconfirmed conversation waits in review first.
    where.push(or(sql`${commitments.leadId} is not null`, sql`${commitments.contactId} is not null`, sql`${commitments.jobId} is not null`)!);
  }
  const rows = await db.query.commitments.findMany({ where: and(...where), orderBy: [sql`${commitments.dueAt} asc nulls last`, desc(commitments.createdAt)], limit: 100 });
  const src = await sourcesFor(rows);
  const n = await namesFor(
    rows.map((r) => r.leadId),
    rows.map((r) => r.contactId),
    rows.map((r) => r.jobId),
  );
  return rows.map((c): CommitmentItem => ({ commitment: c, source: src.get(c.sourceId) ?? null, subject: subjectOf(n, c) }));
}

/** Commitments made by the business that are past due. */
export async function overdueCommitmentCount(now = new Date()): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)` })
    .from(commitments)
    .where(and(eq(commitments.status, "outstanding"), eq(commitments.owner, "get_secure"), lt(commitments.dueAt, now), or(sql`${commitments.leadId} is not null`, sql`${commitments.contactId} is not null`, sql`${commitments.jobId} is not null`)));
  return Number(r?.n ?? 0);
}

/** The Inspector's view of one lead (and its jobs) or one job. */
export async function getInspectorPanel(scope: { leadId?: string | null; jobId?: string | null; contactId?: string | null }) {
  const leadIds = scope.leadId ? [scope.leadId] : [];
  if (scope.jobId) {
    const j = await db.query.jobs.findFirst({ where: eq(jobs.id, scope.jobId), columns: { leadId: true } });
    if (j?.leadId) leadIds.push(j.leadId);
  }
  const match = (t: { leadId: AnyPgColumn; contactId: AnyPgColumn; jobId: AnyPgColumn }) =>
    or(leadIds.length ? inArray(t.leadId, leadIds) : sql`false`, scope.jobId ? eq(t.jobId, scope.jobId) : sql`false`, scope.contactId ? eq(t.contactId, scope.contactId) : sql`false`)!;
  const [latest, awaiting, conflicts, commitmentItems] = await Promise.all([
    db.query.inspections.findFirst({ where: and(match(inspections), ne(inspections.status, "superseded")), orderBy: [desc(inspections.sourceAt)] }),
    db.query.inspectorActions.findMany({ where: and(match(inspectorActions), eq(inspectorActions.status, "awaiting_approval"), notInArray(inspectorActions.type, IDENTITY_ACTIONS)), orderBy: [desc(inspectorActions.createdAt)], limit: 20 }),
    db.query.facts.findMany({ where: and(match(facts), inArray(facts.state, ["conflict", "proposed"])), orderBy: [desc(facts.createdAt)], limit: 20 }),
    getOutstandingCommitments({ leadIds, contactId: scope.contactId, jobId: scope.jobId }),
  ]);
  const src = await sourcesFor([...(latest ? [latest] : []), ...conflicts]);
  const latestActions = latest ? await db.query.inspectorActions.findMany({ where: eq(inspectorActions.inspectionId, latest.id), orderBy: [asc(inspectorActions.createdAt)] }) : [];
  return {
    latest: latest ? { inspection: latest, source: src.get(latest.sourceId) ?? null, understanding: latest.understanding as unknown as Understanding, actions: latestActions } : null,
    awaiting: awaiting.map((a): AwaitingItem => ({ action: a, source: null, subject: null })),
    conflicts: conflicts.map((f): ConflictItem => ({ fact: f, source: src.get(f.sourceId) ?? null, subject: null })),
    commitments: commitmentItems,
  };
}

/** Jev's shadow answers beside the rules' answer and what Chris actually did. */
export async function getJevComparison(limit = 50) {
  const rows = await db
    .select({ obs: jevObservations, sourceType: inspections.sourceType, sourceId: inspections.sourceId, summary: inspections.summary })
    .from(jevObservations)
    .innerJoin(inspections, eq(inspections.id, jevObservations.inspectionId))
    .orderBy(desc(jevObservations.createdAt))
    .limit(limit);
  const src = await sourcesFor(rows);
  const FIELDS = ["intent", "urgency", "quote_readiness", "next_move", "objection_type"] as const;
  const agreement = Object.fromEntries(
    FIELDS.map((f) => {
      const comparable = rows.filter((r) => r.obs.output && r.obs.output[f] !== undefined);
      const same = comparable.filter((r) => r.obs.output![f] === r.obs.deterministic[f]).length;
      return [f, { same, of: comparable.length }];
    }),
  ) as Record<(typeof FIELDS)[number], { same: number; of: number }>;
  return { fields: FIELDS, agreement, rows: rows.map((r) => ({ ...r.obs, source: src.get(r.sourceId) ?? null, summary: r.summary })) };
}
