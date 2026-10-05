/**
 * Turning an email or a Plaud recording into the one InspectorInput shape, and reading CRM state.
 * Identity signals are collected in signals.ts.
 */
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { db } from "@/db";
import { contacts, emails, facts, jobs, leads, quotes, recordings, users } from "@/db/schema";
import { OPEN_JOB_STATUSES } from "@/lib/constants";
import { stripQuotedReply } from "@/lib/email/parse";
import { parseWebsiteLead } from "@/lib/email/website-lead";
import { parseTranscript } from "./text";
import type { FactKey, InspectorInput, Known } from "./types";

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
  };
}

/** First names of staff, to recognise Get Secure in transcripts. */
export async function staffNames(): Promise<string[]> {
  const rows = await db.select({ name: users.name }).from(users).where(eq(users.active, true));
  return [...new Set(rows.map((r) => r.name.split(/\s+/)[0]).filter((n) => n.length >= 2))];
}
