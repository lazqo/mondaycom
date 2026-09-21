import "server-only";
import { and, asc, desc, eq, inArray, or } from "drizzle-orm";
import { db } from "@/db";
import { formatDateTime } from "@/lib/utils";
import { activityLog, contacts, emailThreads, events, jobs, leads, quotes, users } from "@/db/schema";

export type HistoryItem = {
  id: string;
  at: Date;
  kind: "email" | "lead" | "quote" | "job" | "site_visit" | "appointment" | "note" | "activity";
  title: string;
  detail?: string | null;
  href?: string | null;
  meta?: string | null;
};

/** Everything that happened with a customer, newest first. */
export async function getContactHistory(contactId: string): Promise<HistoryItem[]> {
  const contact = await db.query.contacts.findFirst({ where: eq(contacts.id, contactId), columns: { id: true, email: true } });
  if (!contact) return [];
  const leadRows = await db.query.leads.findMany({ where: eq(leads.contactId, contactId), columns: { id: true, name: true, status: true, createdAt: true, service: true, source: true } });
  const leadIds = leadRows.map((l) => l.id);
  const [quoteRows, jobRows, eventRows, threadRows, notes] = await Promise.all([
    db.query.quotes.findMany({ where: eq(quotes.contactId, contactId), columns: { id: true, number: true, title: true, status: true, total: true, createdAt: true, sentAt: true, acceptedAt: true } }),
    db.query.jobs.findMany({ where: eq(jobs.contactId, contactId), columns: { id: true, number: true, title: true, status: true, createdAt: true, doneAt: true, invoicedAt: true, siteAddress: true } }),
    leadIds.length
      ? db.query.events.findMany({
          where: or(inArray(events.leadId, leadIds), inArray(events.jobId, (await db.query.jobs.findMany({ where: eq(jobs.contactId, contactId), columns: { id: true } })).map((j) => j.id).concat(["00000000-0000-0000-0000-000000000000"]))),
          with: { assignedTo: { columns: { name: true } }, job: { columns: { id: true, number: true } }, lead: { columns: { id: true, name: true } } },
        })
      : db.query.events.findMany({
          where: inArray(events.jobId, (await db.query.jobs.findMany({ where: eq(jobs.contactId, contactId), columns: { id: true } })).map((j) => j.id).concat(["00000000-0000-0000-0000-000000000000"])),
          with: { assignedTo: { columns: { name: true } }, job: { columns: { id: true, number: true } }, lead: { columns: { id: true, name: true } } },
        }),
    db.query.emailThreads.findMany({
      where: or(eq(emailThreads.contactId, contactId), leadIds.length ? inArray(emailThreads.leadId, leadIds) : eq(emailThreads.contactId, contactId)),
      with: { emails: { orderBy: [asc(emailThreads.createdAt)], columns: { id: true, direction: true, fromName: true, fromAddress: true, subject: true, snippet: true, receivedAt: true } } },
    }),
    db
      .select({ id: activityLog.id, action: activityLog.action, detail: activityLog.detail, createdAt: activityLog.createdAt, actor: users.name })
      .from(activityLog)
      .leftJoin(users, eq(activityLog.actorId, users.id))
      .where(and(eq(activityLog.entity, "contact"), eq(activityLog.entityId, contactId)))
      .orderBy(desc(activityLog.createdAt))
      .limit(100),
  ]);

  const items: HistoryItem[] = [];
  for (const l of leadRows) items.push({ id: `lead-${l.id}`, at: l.createdAt, kind: "lead", title: `Lead: ${l.service ?? l.name}`, detail: `Came in via ${l.source}`, href: `/leads/${l.id}`, meta: l.status });
  for (const q of quoteRows) {
    items.push({ id: `quote-${q.id}`, at: q.createdAt, kind: "quote", title: `Quote Q-${q.number} created: ${q.title}`, detail: null, href: `/quotes/${q.id}`, meta: q.status });
    if (q.sentAt) items.push({ id: `quote-sent-${q.id}`, at: q.sentAt, kind: "quote", title: `Quote Q-${q.number} sent`, href: `/quotes/${q.id}`, meta: q.status });
    if (q.acceptedAt) items.push({ id: `quote-acc-${q.id}`, at: q.acceptedAt, kind: "quote", title: `Quote Q-${q.number} accepted`, href: `/quotes/${q.id}`, meta: "accepted" });
  }
  for (const j of jobRows) {
    items.push({ id: `job-${j.id}`, at: j.createdAt, kind: "job", title: `Job J-${j.number} created: ${j.title}`, detail: j.siteAddress, href: `/jobs/${j.id}`, meta: j.status });
    if (j.doneAt) items.push({ id: `job-done-${j.id}`, at: j.doneAt, kind: "job", title: `Job J-${j.number} done`, href: `/jobs/${j.id}`, meta: "done" });
    if (j.invoicedAt) items.push({ id: `job-inv-${j.id}`, at: j.invoicedAt, kind: "job", title: `Job J-${j.number} invoiced`, href: `/jobs/${j.id}`, meta: "invoiced" });
  }
  for (const e of eventRows) {
    const isVisit = e.kind === "site_visit";
    items.push({
      id: `event-${e.id}`,
      at: e.startsAt,
      kind: isVisit ? "site_visit" : e.job ? "job" : "appointment",
      title: isVisit ? `Site visit${e.lead ? ` for ${e.lead.name}` : ""}` : e.job ? `Job J-${e.job.number} scheduled` : e.title,
      detail: `${formatDateTime(e.startsAt)}${e.assignedTo ? ` · ${e.assignedTo.name}` : ""}`,
      href: e.job ? `/jobs/${e.job.id}` : e.lead ? `/leads/${e.lead.id}` : null,
      meta: e.endsAt < new Date() ? "completed" : "upcoming",
    });
  }
  for (const t of threadRows) {
    for (const m of t.emails) {
      items.push({
        id: `email-${m.id}`,
        at: m.receivedAt,
        kind: "email",
        title: m.direction === "outbound" ? `We emailed: ${m.subject || "(no subject)"}` : `They emailed: ${m.subject || "(no subject)"}`,
        detail: m.snippet,
        href: `/inbox/${t.id}`,
        meta: m.direction,
      });
    }
  }
  for (const n of notes) {
    if (n.action === "note") items.push({ id: `note-${n.id}`, at: n.createdAt, kind: "note", title: String((n.detail as { body?: string } | null)?.body ?? ""), detail: n.actor ? `Note by ${n.actor}` : "Note", meta: null });
    else items.push({ id: `act-${n.id}`, at: n.createdAt, kind: "activity", title: describeActivity(n.action, n.actor), meta: null });
  }
  items.sort((a, b) => b.at.getTime() - a.at.getTime());
  return items;
}

const ACTIVITY_WORDS: Record<string, string> = {
  created: "added this customer",
  updated: "updated the customer's details",
  converted: "converted the lead to this customer",
  archived: "archived this customer",
};

function describeActivity(action: string, actor: string | null): string {
  const what = ACTIVITY_WORDS[action] ?? action.replace(/_/g, " ");
  return `${actor ?? "Get Secure CRM"} ${what}`;
}
