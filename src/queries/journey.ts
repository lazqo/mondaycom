import "server-only";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { events, jobs, leads, quotes } from "@/db/schema";
import type { JourneyInput } from "@/lib/journey";

async function forLead(leadId: string | null, contactId: string | null): Promise<JourneyInput> {
  const lead = leadId ? await db.query.leads.findFirst({ where: eq(leads.id, leadId), columns: { id: true, status: true, contactId: true } }) : null;
  const [visits, qs, js] = await Promise.all([
    leadId ? db.query.events.findMany({ where: eq(events.leadId, leadId), columns: { startsAt: true, endsAt: true, kind: true } }) : Promise.resolve([]),
    leadId ? db.query.quotes.findMany({ where: eq(quotes.leadId, leadId), columns: { id: true, status: true, number: true }, orderBy: [desc(quotes.createdAt)] }) : contactId ? db.query.quotes.findMany({ where: eq(quotes.contactId, contactId), columns: { id: true, status: true, number: true }, orderBy: [desc(quotes.createdAt)] }) : Promise.resolve([]),
    leadId ? db.query.jobs.findMany({ where: eq(jobs.leadId, leadId), with: { events: { columns: { id: true } } }, orderBy: [desc(jobs.createdAt)] }) : contactId ? db.query.jobs.findMany({ where: eq(jobs.contactId, contactId), with: { events: { columns: { id: true } } }, orderBy: [desc(jobs.createdAt)] }) : Promise.resolve([]),
  ]);
  return {
    lead: lead ?? null,
    siteVisits: visits.filter((v) => v.kind === "site_visit"),
    quotes: qs,
    jobs: js.map((j) => ({ id: j.id, status: j.status, number: j.number, scheduled: j.events.length > 0 })),
    contactId: contactId ?? lead?.contactId ?? null,
  };
}

export async function getJourneyForQuote(q: { leadId: string | null; contactId: string }) {
  return forLead(q.leadId, q.contactId);
}
export async function getJourneyForJob(j: { leadId: string | null; contactId: string }) {
  return forLead(j.leadId, j.contactId);
}
