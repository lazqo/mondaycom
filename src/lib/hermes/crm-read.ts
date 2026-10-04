/**
 * What Hermes may read from the CRM, in one place: the Inspector's context pack and Hermes's MCP
 * read tools use the same functions, so Hermes never sees more by one route than by the other.
 *
 * Deliberately absent: supplier names and SKUs, trade costs, markup, margin, labour rates, supplier
 * credentials and anything from the encrypted credential store. Quotes are shown as the customer
 * sees them (number, title, status, total inc GST); a Business Brain run as its outcome (site visit
 * needed, fully priced or not, what is unpriced), not its costing.
 */
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { cctvAssessments, commitments, contacts, emails, events, facts, inspections, jobs, leads, quotes, recordings, tasks } from "@/db/schema";
import { getContactTimeline, getLeadTimeline } from "@/queries/timeline";

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

export async function readLead(leadId: string) {
  const l = await db.query.leads.findFirst({ where: eq(leads.id, leadId), with: { assignedTo: { columns: { name: true } } } });
  if (!l) return null;
  return {
    id: l.id,
    name: l.name,
    company: l.company,
    phone: l.phone,
    email: l.email,
    service: l.service,
    site: l.site,
    status: l.status,
    source: l.source,
    urgency: l.urgency,
    summary: l.summary,
    followUpAt: l.followUpAt,
    lastContactAt: l.lastContactAt,
    assignedTo: l.assignedTo?.name ?? null,
    customerId: l.contactId,
    createdAt: iso(l.createdAt),
  };
}

export async function readCustomer(contactId: string) {
  const c = await db.query.contacts.findFirst({ where: eq(contacts.id, contactId) });
  if (!c) return null;
  return { id: c.id, name: c.name, company: c.company, phone: c.phone, email: c.email, address: c.address, createdAt: iso(c.createdAt) };
}

/** Leads and customers by name, company, email, phone digits or address (for Hermes's lookups). */
export async function findPeople(q: string, limit = 8) {
  const term = `%${q.trim()}%`;
  const digits = q.replace(/\D/g, "");
  const leadRows = await db
    .select({ id: leads.id, name: leads.name, company: leads.company, status: leads.status, site: leads.site })
    .from(leads)
    .where(and(isNull(leads.archivedAt), or(sql`${leads.name} ilike ${term}`, sql`${leads.company} ilike ${term}`, sql`${leads.email} ilike ${term}`, sql`${leads.site} ilike ${term}`, digits.length >= 6 ? sql`regexp_replace(coalesce(${leads.phone}, ''), '\\D', '', 'g') like ${`%${digits}%`}` : sql`false`)))
    .limit(limit);
  const contactRows = await db
    .select({ id: contacts.id, name: contacts.name, company: contacts.company, address: contacts.address })
    .from(contacts)
    .where(or(sql`${contacts.name} ilike ${term}`, sql`${contacts.company} ilike ${term}`, sql`${contacts.email} ilike ${term}`, sql`${contacts.address} ilike ${term}`, digits.length >= 6 ? sql`regexp_replace(coalesce(${contacts.phone}, ''), '\\D', '', 'g') like ${`%${digits}%`}` : sql`false`))
    .limit(limit);
  return { leads: leadRows, customers: contactRows };
}

type Scope = { leadId?: string | null; contactId?: string | null };
const scopeOr = (t: { leadId: typeof tasks.leadId; contactId: typeof tasks.contactId }, s: Scope) =>
  or(s.leadId ? eq(t.leadId, s.leadId) : sql`false`, s.contactId ? eq(t.contactId, s.contactId) : sql`false`)!;

export async function readOpenTasks(s: Scope) {
  if (!s.leadId && !s.contactId) return [];
  const rows = await db.query.tasks.findMany({ where: and(eq(tasks.status, "open"), scopeOr(tasks, s)), orderBy: [desc(tasks.createdAt)], limit: 20 });
  return rows.map((t) => ({ id: t.id, title: t.title, kind: t.kind, dueAt: t.dueAt, detail: t.detail?.slice(0, 300) ?? null }));
}

export async function readCommitments(s: Scope, opts: { includeDone?: boolean } = {}) {
  if (!s.leadId && !s.contactId) return [];
  const rows = await db.query.commitments.findMany({
    where: and(opts.includeDone ? sql`true` : eq(commitments.status, "outstanding"), or(s.leadId ? eq(commitments.leadId, s.leadId) : sql`false`, s.contactId ? eq(commitments.contactId, s.contactId) : sql`false`)),
    orderBy: [desc(commitments.createdAt)],
    limit: 20,
  });
  return rows.map((c) => ({ id: c.id, owner: c.owner, ownerName: c.ownerName, action: c.action, dueAt: iso(c.dueAt), dueText: c.dueText, status: c.status, said: c.evidence }));
}

/** Quotes as the customer sees them: no cost, margin or supplier. */
export async function readQuotes(s: Scope) {
  if (!s.leadId && !s.contactId) return [];
  const rows = await db.query.quotes.findMany({
    where: or(s.leadId ? eq(quotes.leadId, s.leadId) : sql`false`, s.contactId ? eq(quotes.contactId, s.contactId) : sql`false`),
    orderBy: [desc(quotes.createdAt)],
    limit: 10,
    columns: { id: true, number: true, title: true, status: true, total: true, sentAt: true, createdAt: true, origin: true },
  });
  return rows.map((q) => ({ id: q.id, number: `Q-${q.number}`, title: q.title, status: q.status, totalIncGst: Number(q.total), sentAt: iso(q.sentAt), preparedBy: q.origin, createdAt: iso(q.createdAt) }));
}

export async function readVisitsAndJobs(s: Scope) {
  const visits = s.leadId ? await db.query.events.findMany({ where: and(eq(events.leadId, s.leadId), eq(events.kind, "site_visit")), orderBy: [desc(events.startsAt)], limit: 5, columns: { startsAt: true, title: true } }) : [];
  const jobRows = s.leadId || s.contactId ? await db.query.jobs.findMany({ where: or(s.leadId ? eq(jobs.leadId, s.leadId) : sql`false`, s.contactId ? eq(jobs.contactId, s.contactId) : sql`false`), orderBy: [desc(jobs.createdAt)], limit: 5, columns: { id: true, number: true, title: true, status: true } }) : [];
  return { siteVisits: visits.map((v) => ({ at: iso(v.startsAt), title: v.title })), jobs: jobRows.map((j) => ({ id: j.id, number: `J-${j.number}`, title: j.title, status: j.status })) };
}

/** The latest Business Brain run for a lead, as an outcome: never its costs. */
export async function readBrainOutcome(leadId: string) {
  const a = await db.query.cctvAssessments.findFirst({ where: eq(cctvAssessments.leadId, leadId), orderBy: [desc(cctvAssessments.createdAt)] });
  if (!a) return null;
  const p = a.packet as { siteVisit?: { required?: boolean; reasons?: string[] }; costing?: { complete?: boolean; unpriced?: string[] }; cameras?: unknown[]; nextAction?: string };
  return {
    ranAt: iso(a.createdAt),
    cameras: Array.isArray(p.cameras) ? p.cameras.length : null,
    siteVisitRequired: !!p.siteVisit?.required,
    siteVisitReasons: p.siteVisit?.reasons ?? [],
    fullyPriced: !!p.costing?.complete,
    unpriced: p.costing?.unpriced ?? [],
    nextAction: p.nextAction ?? null,
  };
}

/** The lead's or customer's history as one list of headlines (no email bodies or transcripts). */
export async function readTimeline(s: Scope, limit = 15) {
  const items = s.leadId ? await getLeadTimeline(s.leadId) : s.contactId ? await getContactTimeline(s.contactId) : [];
  return items.slice(-limit).map((i) => ({ at: iso(i.at), kind: i.kind, title: i.title, detail: i.meta ?? null }));
}

/** Facts already on record (applied), with where they came from. */
export async function readFacts(s: Scope) {
  if (!s.leadId && !s.contactId) return [];
  const rows = await db.query.facts.findMany({ where: and(s.leadId ? eq(facts.leadId, s.leadId) : eq(facts.contactId, s.contactId!), inArray(facts.state, ["applied", "conflict", "proposed"])), orderBy: [desc(facts.createdAt)], limit: 40 });
  return rows.map((f) => ({ key: f.key, value: f.value, state: f.state, source: f.sourceType, at: iso(f.sourceAt), evidence: f.evidence }));
}

export async function readEmailThread(threadId: string) {
  const rows = await db.query.emails.findMany({ where: eq(emails.threadId, threadId), orderBy: [desc(emails.receivedAt)], limit: 10, columns: { id: true, direction: true, fromName: true, fromAddress: true, subject: true, receivedAt: true, textBody: true } });
  return rows.map((e) => ({ id: e.id, direction: e.direction, from: e.direction === "outbound" ? "Get Secure" : (e.fromName ?? e.fromAddress), subject: e.subject, at: iso(e.receivedAt), text: (e.textBody ?? "").slice(0, 4000) }));
}

export async function readRecording(recordingId: string) {
  const r = await db.query.recordings.findFirst({ where: eq(recordings.id, recordingId), columns: { id: true, title: true, recordedAt: true, transcript: true, status: true, leadId: true, contactId: true } });
  return r ? { id: r.id, title: r.title, at: iso(r.recordedAt), status: r.status, leadId: r.leadId, customerId: r.contactId, transcript: r.transcript.slice(0, 20000) } : null;
}

export async function readInspection(inspectionId: string) {
  const i = await db.query.inspections.findFirst({ where: eq(inspections.id, inspectionId) });
  if (!i) return null;
  return { id: i.id, source: { type: i.sourceType, id: i.sourceId, at: iso(i.sourceAt) }, status: i.status, engine: i.engine, summary: i.summary, leadId: i.leadId, customerId: i.contactId, hermes: i.hermes, validation: i.validation };
}
