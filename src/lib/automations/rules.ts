import { and, asc, eq, inArray, isNull, lt, lte, notInArray, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { events, jobs, leads, quotes } from "@/db/schema";
import type { AutomationSettings } from "@/lib/constants";
import { formatDate } from "@/lib/utils";

export type RuleCandidate = {
  ruleKey: string;
  entityId: string;
  title: string;
  detail: string | null;
  dueAt: string; // YYYY-MM-DD
  assignedToId: string | null;
  link: string;
  leadId?: string | null;
  contactId?: string | null;
  quoteId?: string | null;
  jobId?: string | null;
};

export type RuleContext = { db: Db; settings: AutomationSettings; now: Date; today: string };

export type Rule = {
  key: string;
  name: string;
  description: (s: AutomationSettings) => string;
  evaluate: (ctx: RuleContext) => Promise<RuleCandidate[]>;
};

const OPEN_LEAD = ["new", "contacted", "site_visit", "quote_required", "quote_sent"] as const;

function ago(now: Date, ms: number) {
  return new Date(now.getTime() - ms);
}
const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** Follow-up rules. Each produces at most one open task per entity; the runner dedupes and auto-resolves. */
export const RULES: Rule[] = [
  {
    key: "lead_not_contacted",
    name: "New lead not contacted",
    description: (s) => `A lead still in New ${s.new_lead_contact_hours} hours after it was created.`,
    async evaluate({ db, settings, now, today }) {
      const rows = await db.query.leads.findMany({
        where: and(eq(leads.status, "new"), isNull(leads.archivedAt), lt(leads.createdAt, ago(now, settings.new_lead_contact_hours * HOUR))),
        columns: { id: true, name: true, company: true, assignedToId: true, createdAt: true, phone: true },
        orderBy: [asc(leads.createdAt)],
      });
      return rows.map((l) => ({
        ruleKey: "lead_not_contacted",
        entityId: l.id,
        title: `Contact new lead: ${l.name}${l.company ? ` (${l.company})` : ""}`,
        detail: `Created ${formatDate(l.createdAt)} and still New${l.phone ? ` · ${l.phone}` : ""}`,
        dueAt: today,
        assignedToId: l.assignedToId,
        link: `/leads/${l.id}`,
        leadId: l.id,
      }));
    },
  },
  {
    key: "site_visit_no_quote",
    name: "Site visit done, no quote sent",
    description: (s) => `A site visit finished ${s.site_visit_quote_days} days ago and the lead has no quote yet.`,
    async evaluate({ db, settings, now, today }) {
      const rows = await db
        .select({ leadId: leads.id, name: leads.name, assignedToId: leads.assignedToId, endsAt: sql<Date>`max(${events.endsAt})` })
        .from(events)
        .innerJoin(leads, eq(events.leadId, leads.id))
        .where(
          and(
            eq(events.kind, "site_visit"),
            lt(events.endsAt, ago(now, settings.site_visit_quote_days * DAY)),
            inArray(leads.status, ["site_visit", "quote_required"]),
            isNull(leads.archivedAt),
            sql`not exists (select 1 from ${quotes} q where q.lead_id = ${leads.id} and q.status <> 'draft')`,
          ),
        )
        .groupBy(leads.id, leads.name, leads.assignedToId);
      return rows.map((r) => ({
        ruleKey: "site_visit_no_quote",
        entityId: r.leadId,
        title: `Send quote: ${r.name}`,
        detail: `Site visit was on ${formatDate(r.endsAt)} and no quote has been sent.`,
        dueAt: today,
        assignedToId: r.assignedToId,
        link: `/leads/${r.leadId}`,
        leadId: r.leadId,
      }));
    },
  },
  {
    key: "quote_no_response",
    name: "Quote sent, no response",
    description: (s) => `A quote marked Sent ${s.quote_followup_days} days ago with no accept/decline.`,
    async evaluate({ db, settings, now, today }) {
      const rows = await db.query.quotes.findMany({
        where: and(eq(quotes.status, "sent"), lt(quotes.sentAt, ago(now, settings.quote_followup_days * DAY))),
        with: { contact: { columns: { id: true, name: true } }, lead: { columns: { id: true, assignedToId: true } } },
        orderBy: [asc(quotes.sentAt)],
      });
      return rows.map((q) => ({
        ruleKey: "quote_no_response",
        entityId: q.id,
        title: `Follow up quote Q-${q.number}: ${q.contact.name}`,
        detail: `Sent ${formatDate(q.sentAt)}, no response yet.`,
        dueAt: today,
        assignedToId: q.lead?.assignedToId ?? null,
        link: `/quotes/${q.id}`,
        quoteId: q.id,
        leadId: q.lead?.id ?? null,
        contactId: q.contact.id,
      }));
    },
  },
  {
    key: "job_not_invoiced",
    name: "Job done, not invoiced",
    description: (s) => `A job marked Done ${s.job_invoice_days} days ago that is not yet Invoiced.`,
    async evaluate({ db, settings, now, today }) {
      const rows = await db.query.jobs.findMany({
        where: and(eq(jobs.status, "done"), sql`coalesce(${jobs.doneAt}, ${jobs.updatedAt}) < ${ago(now, settings.job_invoice_days * DAY).toISOString()}::timestamptz`),
        with: { contact: { columns: { id: true, name: true } } },
        columns: { id: true, number: true, title: true, assignedToId: true, doneAt: true },
      });
      return rows.map((j) => ({
        ruleKey: "job_not_invoiced",
        entityId: j.id,
        title: `Invoice job J-${j.number}: ${j.contact.name}`,
        detail: `${j.title} was done on ${j.doneAt ? formatDate(j.doneAt) : "an earlier date"}.`,
        dueAt: today,
        assignedToId: null,
        link: `/jobs/${j.id}`,
        jobId: j.id,
        contactId: j.contact.id,
      }));
    },
  },
  {
    key: "lead_followup_due",
    name: "Follow-up date reached",
    description: () => "A lead whose Follow-up date is today or earlier.",
    async evaluate({ db, today }) {
      const rows = await db.query.leads.findMany({
        where: and(lte(leads.followUpAt, today), inArray(leads.status, [...OPEN_LEAD]), isNull(leads.archivedAt)),
        columns: { id: true, name: true, company: true, followUpAt: true, assignedToId: true, status: true },
        orderBy: [asc(leads.followUpAt)],
      });
      return rows.map((l) => ({
        ruleKey: "lead_followup_due",
        entityId: l.id,
        title: `Follow up: ${l.name}${l.company ? ` (${l.company})` : ""}`,
        detail: `Follow-up date ${l.followUpAt}`,
        dueAt: l.followUpAt!,
        assignedToId: l.assignedToId,
        link: `/leads/${l.id}`,
        leadId: l.id,
      }));
    },
  },
];

export const RULE_BY_KEY = Object.fromEntries(RULES.map((r) => [r.key, r]));
export { notInArray };
