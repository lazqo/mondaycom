import "server-only";
import { and, asc, desc, eq, gte, isNull, lte } from "drizzle-orm";
import { db } from "@/db";
import { activityLog, contacts, events, jobs, leads, quotes, users } from "@/db/schema";

export async function listUsers() {
  return db.query.users.findMany({
    columns: { id: true, name: true, email: true, role: true, active: true, createdAt: true },
    orderBy: [asc(users.name)],
  });
}

export async function listActiveUsers() {
  return db.query.users.findMany({
    columns: { id: true, name: true },
    where: eq(users.active, true),
    orderBy: [asc(users.name)],
  });
}

export async function listLeads() {
  return db.query.leads.findMany({
    where: isNull(leads.archivedAt),
    with: { assignedTo: { columns: { id: true, name: true } }, contact: { columns: { id: true, name: true } } },
    orderBy: [asc(leads.position), asc(leads.createdAt)],
  });
}
export type LeadRow = Awaited<ReturnType<typeof listLeads>>[number];

export async function getLead(id: string) {
  return db.query.leads.findFirst({
    where: eq(leads.id, id),
    with: {
      assignedTo: { columns: { id: true, name: true } },
      contact: true,
      quotes: { orderBy: [desc(quotes.createdAt)] },
      jobs: { orderBy: [desc(jobs.createdAt)], with: { events: true } },
      events: { orderBy: [desc(events.startsAt)] },
    },
  });
}

export async function getActivity(entity: string, entityId: string, limit = 50) {
  return db
    .select({
      id: activityLog.id,
      action: activityLog.action,
      detail: activityLog.detail,
      createdAt: activityLog.createdAt,
      actorName: users.name,
    })
    .from(activityLog)
    .leftJoin(users, eq(activityLog.actorId, users.id))
    .where(and(eq(activityLog.entity, entity), eq(activityLog.entityId, entityId)))
    .orderBy(desc(activityLog.createdAt))
    .limit(limit);
}

export async function listContacts() {
  return db.query.contacts.findMany({ orderBy: [asc(contacts.name)] });
}

export async function getContact(id: string) {
  return db.query.contacts.findFirst({
    where: eq(contacts.id, id),
    with: {
      leads: { orderBy: [desc(leads.createdAt)] },
      quotes: { orderBy: [desc(quotes.createdAt)] },
      jobs: { orderBy: [desc(jobs.createdAt)], with: { events: true, assignedTo: { columns: { id: true, name: true } } } },
    },
  });
}

export async function listQuotes() {
  return db.query.quotes.findMany({
    with: { contact: { columns: { id: true, name: true, company: true } } },
    orderBy: [desc(quotes.number)],
  });
}

export async function getQuote(id: string) {
  return db.query.quotes.findFirst({
    where: eq(quotes.id, id),
    with: { contact: true, lead: { columns: { id: true, name: true } }, jobs: { columns: { id: true, number: true, title: true } } },
  });
}

export async function listJobs() {
  return db.query.jobs.findMany({
    with: {
      contact: { columns: { id: true, name: true, company: true } },
      assignedTo: { columns: { id: true, name: true } },
      events: { columns: { id: true, startsAt: true, endsAt: true } },
    },
    orderBy: [desc(jobs.number)],
  });
}
export type JobRow = Awaited<ReturnType<typeof listJobs>>[number];

export async function getJob(id: string) {
  return db.query.jobs.findFirst({
    where: eq(jobs.id, id),
    with: {
      contact: true,
      lead: { columns: { id: true, name: true } },
      quote: { columns: { id: true, number: true, title: true, total: true, status: true } },
      assignedTo: { columns: { id: true, name: true } },
      events: true,
      noteEntries: { orderBy: (n, { desc: d }) => [d(n.createdAt)], with: { author: { columns: { id: true, name: true } } } },
      photos: { columns: { id: true, filename: true, caption: true, createdAt: true, contentType: true, size: true }, orderBy: (p, { desc: d }) => [d(p.createdAt)] },
    },
  });
}

export async function listEventsBetween(from: Date, to: Date) {
  return db.query.events.findMany({
    where: and(gte(events.endsAt, from), lte(events.startsAt, to)),
    with: {
      assignedTo: { columns: { id: true, name: true } },
      job: { columns: { id: true, number: true, status: true, siteAddress: true, title: true }, with: { contact: { columns: { name: true } } } },
      lead: { columns: { id: true, name: true, site: true } },
    },
    orderBy: [asc(events.startsAt)],
  });
}
export type EventRow = Awaited<ReturnType<typeof listEventsBetween>>[number];

export async function getEvent(id: string) {
  return db.query.events.findFirst({
    where: eq(events.id, id),
    with: { assignedTo: { columns: { id: true, name: true } }, job: { columns: { id: true, number: true, title: true } } },
  });
}
