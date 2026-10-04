/**
 * Turning an email or a Plaud recording into the one InspectorInput shape, and collecting identity
 * signals and CRM state from the database.
 */
import { and, desc, eq, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { commitments, contacts, emails, events, facts, jobs, leads, quotes, recordings, tasks, users } from "@/db/schema";
import { OPEN_JOB_STATUSES } from "@/lib/constants";
import { stripQuotedReply } from "@/lib/email/parse";
import { parseWebsiteLead } from "@/lib/email/website-lead";
import { datePartsIn, zonedToUtc } from "@/lib/calendar/ics";
import { TZ } from "./dates";
import { SIGNAL_WEIGHTS } from "./identity";
import type { Known } from "./missing";
import { normalisePhone, parseTranscript, phonesIn } from "./text";
import type { FactKey, IdentitySignal, InspectorInput, Understanding } from "./types";

/** A recording counts as part of an appointment from 30 minutes before it starts to an hour after it ends. */
const CALENDAR_BEFORE_MS = 30 * 60000;
const CALENDAR_AFTER_MS = 60 * 60000;

export async function emailInput(emailId: string): Promise<InspectorInput | null> {
  const e = await db.query.emails.findFirst({ where: eq(emails.id, emailId), with: { thread: true } });
  if (!e) return null;
  const prior = await db.query.emails.findMany({ where: and(eq(emails.threadId, e.threadId), lt(emails.receivedAt, e.receivedAt)), orderBy: [desc(emails.receivedAt)], limit: 4, columns: { fromAddress: true, fromName: true, receivedAt: true, textBody: true } });
  const t = e.thread;
  const web = e.direction === "inbound" ? parseWebsiteLead({ subject: e.subject ?? "", text: e.textBody ?? "", fromAddress: e.fromAddress }) : null;
  const leadId = e.leadId ?? t?.leadId ?? null;
  const contactId = e.contactId ?? t?.contactId ?? null;
  return {
    sourceType: "email",
    sourceId: e.id,
    direction: e.direction === "outbound" ? "outbound" : "inbound",
    at: e.receivedAt,
    title: e.subject ?? "",
    text: stripQuotedReply(e.textBody ?? "") || (e.textBody ?? ""),
    utterances: [],
    // A website form is sent by a robot: the enquirer is whoever the form names.
    from: web
      ? { name: web.extraction.contact_name, email: web.extraction.email?.toLowerCase() ?? null, phone: web.extraction.phone }
      : { name: e.fromName, email: e.direction === "outbound" ? null : e.fromAddress.toLowerCase(), phone: null },
    form: web ? { fields: web.fields, name: web.extraction.contact_name, email: web.extraction.email, phone: web.extraction.phone, service: web.extraction.service, address: web.extraction.site_address } : null,
    context: prior.map((p) => ({ from: p.fromName ?? p.fromAddress, at: p.receivedAt.toISOString(), text: stripQuotedReply(p.textBody ?? "").slice(0, 1500) })),
    rulesClassification: e.classification,
    linked: { leadId, contactId, jobId: t?.jobId ?? null, how: leadId || contactId ? (t?.leadId || t?.contactId ? "the email thread" : "the email pipeline") : null },
  };
}

export async function recordingInput(recordingId: string): Promise<InspectorInput | null> {
  const r = await db.query.recordings.findFirst({ where: eq(recordings.id, recordingId) });
  if (!r) return null;
  // Only Chris filing it counts as a link: the old automatic matcher could file on a name alone.
  const chosen = !!r.matchedBy && /^chosen by|^Inspector/.test(r.matchedBy);
  return {
    sourceType: "recording",
    sourceId: r.id,
    direction: "conversation",
    at: r.recordedAt ?? r.createdAt,
    title: r.title,
    text: r.transcript,
    utterances: parseTranscript(r.transcript),
    from: { name: null, email: null, phone: null },
    context: [],
    linked: chosen ? { leadId: r.leadId, contactId: r.contactId, jobId: null, how: r.matchedBy } : { leadId: null, contactId: null, jobId: null, how: null },
  };
}

type Raw = { leadId: string | null; contactId: string | null; jobId: string | null; label: string; signal: IdentitySignal };
const sig = (kind: IdentitySignal["kind"], detail: string): IdentitySignal => ({ kind, detail, weight: SIGNAL_WEIGHTS[kind] });
const digitsSql = (col: unknown) => sql`regexp_replace(coalesce(${col}, ''), '\\D', '', 'g')`;

async function openLeadFor(contactId: string) {
  return db.query.leads.findFirst({ where: and(eq(leads.contactId, contactId), isNull(leads.archivedAt), ne(leads.status, "lost")), orderBy: [desc(leads.updatedAt)], columns: { id: true, name: true } });
}

/** Everything in the CRM that points at a lead or customer, as weighted signals. */
export async function collectSignals(input: InspectorInput, u: Understanding): Promise<Raw[]> {
  const out: Raw[] = [];
  const pushContact = async (contactId: string, s: IdentitySignal) => {
    const c = await db.query.contacts.findFirst({ where: eq(contacts.id, contactId), columns: { id: true, name: true } });
    if (!c) return;
    const lead = await openLeadFor(c.id);
    out.push({ leadId: lead?.id ?? null, contactId: c.id, jobId: null, label: c.name, signal: s });
  };
  const pushLead = async (leadId: string, s: IdentitySignal) => {
    const l = await db.query.leads.findFirst({ where: eq(leads.id, leadId), columns: { id: true, name: true, contactId: true } });
    if (l) out.push({ leadId: l.id, contactId: l.contactId, jobId: null, label: l.name, signal: s });
  };

  // Already linked: by the thread, the email pipeline, or Chris.
  if (input.linked.leadId) await pushLead(input.linked.leadId, sig(input.linked.how === "the email thread" ? "thread" : "linked", `linked by ${input.linked.how}`));
  else if (input.linked.contactId) await pushContact(input.linked.contactId, sig(input.linked.how === "the email thread" ? "thread" : "linked", `linked by ${input.linked.how}`));

  // Email addresses: the sender, and any written in the text.
  const addrs = new Set<string>([input.from.email, ...u.facts.filter((f) => f.key === "email").map((f) => String(f.value))].filter((x): x is string => !!x && !/noreply|no-reply|wordpress|website/i.test(x)));
  for (const a of addrs) {
    for (const c of await db.query.contacts.findMany({ where: sql`lower(${contacts.email}) = ${a}`, columns: { id: true }, limit: 3 })) await pushContact(c.id, sig("email", `email ${a}`));
    for (const l of await db.query.leads.findMany({ where: and(sql`lower(${leads.email}) = ${a}`, isNull(leads.archivedAt)), columns: { id: true }, limit: 3 })) await pushLead(l.id, sig("email", `email ${a}`));
  }
  // Phone numbers said or written.
  const phones = new Set([...phonesIn(`${input.title}\n${input.text}`), ...u.facts.filter((f) => f.key === "phone").map((f) => String(f.value))].map(normalisePhone));
  for (const p of phones) {
    const alt = p.startsWith("0") ? `64${p.slice(1)}` : p;
    for (const c of await db.query.contacts.findMany({ where: sql`${digitsSql(contacts.phone)} in (${p}, ${alt})`, columns: { id: true }, limit: 3 })) await pushContact(c.id, sig("phone", `phone ${p}`));
    for (const l of await db.query.leads.findMany({ where: and(sql`${digitsSql(leads.phone)} in (${p}, ${alt})`, isNull(leads.archivedAt)), columns: { id: true }, limit: 3 })) await pushLead(l.id, sig("phone", `phone ${p}`));
  }
  // A quote number mentioned.
  if (u.quoteRefs.length) {
    for (const q of await db.query.quotes.findMany({ where: inArray(quotes.number, u.quoteRefs), columns: { number: true, leadId: true, contactId: true } })) {
      if (q.leadId) await pushLead(q.leadId, sig("quote_ref", `quote Q-${q.number}`));
      else if (q.contactId) await pushContact(q.contactId, sig("quote_ref", `quote Q-${q.number}`));
    }
  }
  // A conversation recorded during (or just around) a site visit or appointment with someone. Only
  // the time counts: a busy day with several appointments must not point at all of them.
  if (input.sourceType === "recording") {
    const d = datePartsIn(input.at, TZ);
    const start = zonedToUtc({ ...d, hour: 0 }, TZ);
    const end = new Date(start.getTime() + 86400000);
    const at = input.at.getTime();
    const evs = (
      await db.query.events.findMany({ where: and(gte(events.startsAt, start), lt(events.startsAt, end), or(sql`${events.leadId} is not null`, sql`${events.contactId} is not null`, sql`${events.jobId} is not null`)), columns: { title: true, startsAt: true, endsAt: true, leadId: true, contactId: true, jobId: true } })
    ).filter((e) => at >= e.startsAt.getTime() - CALENDAR_BEFORE_MS && at <= e.endsAt.getTime() + CALENDAR_AFTER_MS);
    for (const e of evs) {
      const s = sig("calendar", `recorded during appointment: ${e.title}`);
      if (e.leadId) await pushLead(e.leadId, s);
      else if (e.contactId) await pushContact(e.contactId, s);
      else if (e.jobId) {
        const j = await db.query.jobs.findFirst({ where: eq(jobs.id, e.jobId), columns: { contactId: true, leadId: true } });
        if (j?.leadId) await pushLead(j.leadId, s);
        else if (j?.contactId) await pushContact(j.contactId, s);
      }
    }
  }
  // Address, company and name: supporting evidence only.
  const addr = u.facts.find((f) => f.key === "site_address");
  if (addr) {
    const key = String(addr.value).toLowerCase().split(",")[0].trim();
    if (key.length >= 6) {
      for (const l of await db.query.leads.findMany({ where: and(sql`lower(coalesce(${leads.site}, '')) like ${`${key}%`}`, isNull(leads.archivedAt)), columns: { id: true }, limit: 3 })) await pushLead(l.id, sig("address", `address ${addr.value}`));
      for (const c of await db.query.contacts.findMany({ where: sql`lower(coalesce(${contacts.address}, '')) like ${`${key}%`}`, columns: { id: true }, limit: 3 })) await pushContact(c.id, sig("address", `address ${addr.value}`));
    }
  }
  const company = u.facts.find((f) => f.key === "company");
  if (company) for (const c of await db.query.contacts.findMany({ where: sql`lower(coalesce(${contacts.company}, '')) = lower(${String(company.value)})`, columns: { id: true }, limit: 3 })) await pushContact(c.id, sig("company", `company ${company.value}`));
  const names = new Set<string>([...u.facts.filter((f) => f.key === "contact_name").map((f) => String(f.value)), ...(input.sourceType === "recording" ? nameCandidatesIn(`${input.title}\n${input.text}`) : [])]);
  for (const n of names) {
    if (n.split(/\s+/).length < 2) continue;
    for (const c of await db.query.contacts.findMany({ where: sql`lower(${contacts.name}) = lower(${n})`, columns: { id: true }, limit: 3 })) await pushContact(c.id, sig("name", `name ${n}`));
    for (const l of await db.query.leads.findMany({ where: and(sql`lower(${leads.name}) = lower(${n})`, isNull(leads.archivedAt)), columns: { id: true }, limit: 3 })) await pushLead(l.id, sig("name", `name ${n}`));
  }
  return out;
}

function nameCandidatesIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b([A-Z][a-z']{2,})\s+([A-Z][a-z']{2,})\b/g)) if (!/^(Speaker|Get Secure|Grey Lynn)$/i.test(m[0])) out.add(m[0]);
  return [...out];
}

// ---------------- CRM state ----------------

const LEAD_COLUMNS: Partial<Record<FactKey, "name" | "email" | "phone" | "company" | "site" | "service">> = { contact_name: "name", email: "email", phone: "phone", company: "company", site_address: "site", service: "service" };
const CONTACT_COLUMNS: Partial<Record<FactKey, "name" | "email" | "phone" | "company" | "address">> = { contact_name: "name", email: "email", phone: "phone", company: "company", site_address: "address" };
export { LEAD_COLUMNS, CONTACT_COLUMNS };

/** What the CRM already knows about this lead/customer, as fact values. */
export async function crmKnown(leadId: string | null, contactId: string | null): Promise<Known> {
  const k: Known = {};
  if (leadId) {
    const l = await db.query.leads.findFirst({ where: eq(leads.id, leadId) });
    if (l) for (const [key, col] of Object.entries(LEAD_COLUMNS)) if (l[col!]) k[key as FactKey] = key === "service" ? serviceKey(l[col!] as string) : (l[col!] as string);
  } else if (contactId) {
    const c = await db.query.contacts.findFirst({ where: eq(contacts.id, contactId) });
    if (c) for (const [key, col] of Object.entries(CONTACT_COLUMNS)) if (c[col!]) k[key as FactKey] = c[col!] as string;
  }
  if (leadId || contactId) {
    const applied = await db.query.facts.findMany({ where: and(leadId ? eq(facts.leadId, leadId) : eq(facts.contactId, contactId!), eq(facts.state, "applied")), orderBy: [desc(facts.createdAt)] });
    for (const f of applied) if (k[f.key as FactKey] === undefined) k[f.key as FactKey] = f.value;
  }
  return k;
}

export function serviceKey(s: string): string {
  const t = s.toLowerCase();
  return /cctv|camera/.test(t) ? "cctv" : /alarm/.test(t) ? "alarm" : /access/.test(t) ? "access_control" : /intercom|doorbell/.test(t) ? "intercom" : t;
}

export async function crmState(leadId: string | null, contactId: string | null, input: InspectorInput) {
  const lead = leadId ? await db.query.leads.findFirst({ where: eq(leads.id, leadId) }) : null;
  const cid = contactId ?? lead?.contactId ?? null;
  const qs = leadId ? await db.query.quotes.findMany({ where: eq(quotes.leadId, leadId), columns: { id: true, status: true, origin: true } }) : [];
  const job = cid ? await db.query.jobs.findFirst({ where: and(eq(jobs.contactId, cid), inArray(jobs.status, OPEN_JOB_STATUSES)), columns: { id: true } }) : null;
  const contact = cid ? await db.query.contacts.findFirst({ where: eq(contacts.id, cid), columns: { email: true, phone: true } }) : null;
  const rec = input.sourceType === "recording" ? await db.query.recordings.findFirst({ where: eq(recordings.id, input.sourceId), columns: { status: true, leadId: true, contactId: true, matchedBy: true } }) : null;
  return {
    lead,
    contactId: cid,
    jobId: job?.id ?? null,
    hasOpenBrainQuote: qs.some((q) => q.origin === "brain" && ["ai_prepared", "needs_review", "approved"].includes(q.status)),
    hasSentQuote: qs.some((q) => ["sent", "accepted"].includes(q.status)),
    hasQuote: qs.some((q) => q.status !== "superseded"),
    hasOpenJob: !!job,
    recordingLinked: !!rec && rec.status === "attached" && !!(rec.leadId || rec.contactId) && /^chosen by|^Inspector/.test(rec.matchedBy ?? ""),
    customerEmail: lead?.email ?? contact?.email ?? null,
    customerPhone: lead?.phone ?? contact?.phone ?? null,
    lifecycle: await lifecycle(leadId, cid, input),
  };
}

export type Lifecycle = {
  /** Downstream evidence that the matter has moved on (job done or scheduled, visit held, quote accepted with work). */
  progressed: string[];
  /** Open tasks on this lead, customer or job: already somebody's to-do. */
  openTasks: string[];
  /** Commitments still outstanding in the CRM for this lead or customer. */
  outstanding: { owner: string; action: string; dueText: string | null }[];
  /** Commitments from this very source that the CRM shows as done or cancelled, as "owner:action_key" (how they are stored). */
  settledFromSource: string[];
};

const day = (d: Date) => new Intl.DateTimeFormat("en-NZ", { timeZone: TZ, day: "numeric", month: "short", year: "numeric" }).format(d);

/** Where the enquiry stands in the CRM now, so "no action" on an old conversation can be judged. */
async function lifecycle(leadId: string | null, contactId: string | null, input: InspectorInput): Promise<Lifecycle> {
  const empty: Lifecycle = { progressed: [], openTasks: [], outstanding: [], settledFromSource: [] };
  const settled = await db.query.commitments.findMany({ where: and(eq(commitments.sourceType, input.sourceType), eq(commitments.sourceId, input.sourceId), inArray(commitments.status, ["done", "cancelled"])), columns: { owner: true, actionKey: true } });
  empty.settledFromSource = settled.map((c) => `${c.owner}:${c.actionKey}`);
  if (!leadId && !contactId) return empty;
  const jobRows = await db.query.jobs.findMany({
    where: or(leadId ? eq(jobs.leadId, leadId) : undefined, contactId ? eq(jobs.contactId, contactId) : undefined),
    columns: { id: true, number: true, status: true },
  });
  const progressed: string[] = [];
  for (const j of jobRows) {
    if (j.status === "invoiced") progressed.push(`Job #${j.number} invoiced`);
    else if (j.status === "done") progressed.push(`Job #${j.number} completed`);
    else if (["scheduled", "en_route", "on_site"].includes(j.status)) progressed.push(`Job #${j.number} scheduled`);
  }
  const visits = await db.query.events.findMany({
    where: and(eq(events.kind, "site_visit"), lt(events.endsAt, new Date()), or(leadId ? eq(events.leadId, leadId) : undefined, contactId ? eq(events.contactId, contactId) : undefined)),
    columns: { startsAt: true },
    orderBy: [desc(events.startsAt)],
    limit: 1,
  });
  if (visits[0]) progressed.push(`Site visit held on ${day(visits[0].startsAt)}`);
  if (leadId) {
    const accepted = await db.query.quotes.findFirst({ where: and(eq(quotes.leadId, leadId), eq(quotes.status, "accepted")), columns: { number: true } });
    const work = jobRows.find((j) => j.status !== "cancelled");
    if (accepted && work) progressed.push(`Quote Q-${accepted.number} accepted and job #${work.number} created`);
  }
  const jobIds = jobRows.map((j) => j.id);
  const open = await db.query.tasks.findMany({
    where: and(eq(tasks.status, "open"), or(leadId ? eq(tasks.leadId, leadId) : undefined, contactId ? eq(tasks.contactId, contactId) : undefined, jobIds.length ? inArray(tasks.jobId, jobIds) : undefined)),
    columns: { title: true },
    limit: 10,
  });
  const outstanding = await db.query.commitments.findMany({
    where: and(eq(commitments.status, "outstanding"), or(leadId ? eq(commitments.leadId, leadId) : undefined, contactId ? eq(commitments.contactId, contactId) : undefined)),
    columns: { owner: true, action: true, dueText: true },
    limit: 10,
  });
  return { progressed, openTasks: [...new Set(open.map((t) => t.title))], outstanding, settledFromSource: empty.settledFromSource };
}

/** First names of staff, to recognise Get Secure in transcripts. */
export async function staffNames(): Promise<string[]> {
  const rows = await db.select({ name: users.name }).from(users).where(eq(users.active, true));
  return [...new Set(rows.map((r) => r.name.split(/\s+/)[0]).filter((n) => n.length >= 2))];
}
