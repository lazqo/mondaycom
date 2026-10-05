/**
 * Identity signals: the one place the CRM finds who an email or a recording might be about.
 *
 * Pure extractors first (phone numbers, email addresses, street addresses, quote numbers, names
 * written in the text), then the lookup against the CRM: linked threads, customers and leads by
 * email or phone, quotes by number, appointments around a recording, sites by street address (a
 * lead's site, a customer's address, a job's site), companies and names. Each hit is a weighted
 * signal; identity.ts turns them into a decision. A name alone never files anything.
 *
 * Used by the Inspector (every email and recording), the recordings importer and the inbox.
 */
import { and, desc, eq, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { contacts, events, jobs, leads, quotes } from "@/db/schema";
import { datePartsIn, zonedToUtc } from "@/lib/calendar/ics";
import { TZ } from "./dates";
import { SIGNAL_WEIGHTS } from "./identity";
import { normalisePhone, phonesIn } from "./text";
import type { IdentitySignal, InspectorInput } from "./types";

/** A recording counts as part of an appointment from 30 minutes before it starts to an hour after it ends. */
const CALENDAR_BEFORE_MS = 30 * 60000;
const CALENDAR_AFTER_MS = 60 * 60000;

// ---------------- pure extractors ----------------

const STREET = "Road|Rd|Street|St|Avenue|Ave|Drive|Dr|Place|Pl|Crescent|Cres|Terrace|Tce|Lane|Ln|Way|Close|Court|Ct|Grove|Parade|Highway|Hwy|Boulevard|Rise|Heights|Mews|Glade|View|Quay|Esplanade";
const ADDRESS = new RegExp(`\\b(?:(?:Unit|Flat|Level|Shop|Suite)\\s+\\w+,?\\s+)?\\d{1,5}[A-Za-z]?(?:/\\d{1,5})?\\s+(?:[A-Z][a-zA-Z']+\\s){1,3}(?:${STREET})\\b(?:,?\\s+(?!(?:and|but|in|on|at|for|with|is|are|was)\\b)[A-Z][a-zA-Z]+(?:\\s[A-Z][a-zA-Z]+)?)?`, "g");

/** Street addresses written in the text ("138 Wiri Station Road, Manukau"). */
export function addressesIn(text: string): string[] {
  return [...new Set([...text.matchAll(ADDRESS)].map((m) => m[0].trim()))];
}

/** "138 Wiri Station Road, Manukau" → "138 wiri station road": the number and the street, for matching. */
export function addressKey(address: string): string | null {
  const first = address.toLowerCase().replace(/^(unit|flat|level|shop|suite)\s+\w+,?\s+/, "").split(",")[0].trim();
  const m = first.match(/^(\d{1,5}[a-z]?(?:\/\d{1,5})?)\s+(.+)$/);
  if (!m) return null;
  const street = m[2].replace(/\b(road|street|avenue|drive|place|crescent|terrace|lane|way|close|court|grove|parade|highway|boulevard|rise|heights|mews|glade|view|quay|esplanade)\b.*$/, "").trim();
  return street.length >= 3 ? `${m[1].replace(/^\d+\//, "")} ${street}` : null;
}

const STREET_NAME = new RegExp(`\\b([A-Z][a-z']+(?: [A-Z][a-z']+){0,2}) (?:${STREET})\\b`, "g");
/** Street names written without a number ("Great South Road"), lower-cased. */
export function streetsIn(text: string): string[] {
  return [...new Set([...text.matchAll(STREET_NAME)].map((m) => m[0].toLowerCase()).filter((s) => !/^(the|our|your|this|that|at|in|on) /.test(s)))];
}

/** The open records on a street: a street alone places a message only when there is exactly one. */
export async function recordsOnStreet(street: string): Promise<{ leadId: string | null; contactId: string | null; jobId: string | null; label: string }[]> {
  const like = `%${street.toLowerCase()}%`;
  const [l, c, j] = await Promise.all([
    db.query.leads.findMany({ where: and(sql`lower(coalesce(${leads.site}, '')) like ${like}`, isNull(leads.archivedAt), ne(leads.status, "lost")), columns: { id: true, name: true, contactId: true }, limit: 5 }),
    db.query.contacts.findMany({ where: sql`lower(coalesce(${contacts.address}, '')) like ${like}`, columns: { id: true, name: true }, limit: 5 }),
    db.query.jobs.findMany({ where: sql`lower(coalesce(${jobs.siteAddress}, '')) like ${like}`, columns: { id: true, leadId: true, contactId: true, title: true }, limit: 5 }),
  ]);
  const out = [
    ...l.map((x) => ({ leadId: x.id, contactId: x.contactId, jobId: null, label: x.name })),
    ...c.map((x) => ({ leadId: null, contactId: x.id, jobId: null, label: x.name })),
    ...j.map((x) => ({ leadId: x.leadId, contactId: x.contactId, jobId: x.id, label: x.title })),
  ];
  // The same person through two records (a lead and its customer, a job and its lead) counts once.
  const keys = new Set(out.map((o) => o.leadId ?? o.contactId ?? o.jobId));
  return keys.size === 1 ? [out[0]] : out;
}

export function emailsIn(text: string): string[] {
  return [...new Set([...text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)].map((m) => m[0].toLowerCase()))].filter((x) => !/noreply|no-reply|wordpress|website|mailer-daemon/i.test(x));
}

export function quoteRefsIn(text: string): number[] {
  return [...new Set([...text.matchAll(/\bQ-?(\d{3,6})\b/g)].map((m) => Number(m[1])))];
}

export function jobRefsIn(text: string): number[] {
  return [...new Set([...text.matchAll(/\bJ-?(\d{3,6})\b/g)].map((m) => Number(m[1])))];
}

const NOT_NAMES = /^(Speaker|Get Secure|Grey Lynn|Mt Eden|Site Visit|Kind Regards|Best Regards|Thanks|Hi|Dear|Sent From|New Lead|Request Summary|Alarm Watch|Dicker Data)\b/i;
/** Capitalised two- or three-word phrases that could be a person or company. Supporting evidence only. */
export function namesIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b([A-Z][a-z']{2,})(\s+[A-Z][a-z']{2,}){1,2}\b/g)) if (!NOT_NAMES.test(m[0])) out.add(m[0].trim());
  return [...out];
}

// ---------------- the lookup ----------------

export type RawSignal = { leadId: string | null; contactId: string | null; jobId: string | null; label: string; signal: IdentitySignal };
const sig = (kind: IdentitySignal["kind"], detail: string): IdentitySignal => ({ kind, detail, weight: SIGNAL_WEIGHTS[kind] });
const digitsSql = (col: unknown) => sql`regexp_replace(coalesce(${col}, ''), '\\D', '', 'g')`;

async function openLeadFor(contactId: string) {
  return db.query.leads.findFirst({ where: and(eq(leads.contactId, contactId), isNull(leads.archivedAt), ne(leads.status, "lost")), orderBy: [desc(leads.updatedAt)], columns: { id: true, name: true } });
}

/** Everything in the CRM that points at a lead, customer or job, as weighted signals. */
export async function collectSignals(input: InspectorInput, extra: { emails?: string[]; phones?: string[]; addresses?: string[]; names?: string[]; company?: string | null } = {}): Promise<RawSignal[]> {
  const out: RawSignal[] = [];
  const all = `${input.title}\n${input.text}\n${input.utterances.map((u) => u.text).join("\n")}\n${input.form ? Object.values(input.form.fields).join("\n") : ""}`;
  const pushContact = async (contactId: string, s: IdentitySignal, jobId: string | null = null) => {
    const c = await db.query.contacts.findFirst({ where: eq(contacts.id, contactId), columns: { id: true, name: true } });
    if (!c) return;
    const lead = await openLeadFor(c.id);
    out.push({ leadId: lead?.id ?? null, contactId: c.id, jobId, label: c.name, signal: s });
  };
  const pushLead = async (leadId: string, s: IdentitySignal, jobId: string | null = null) => {
    const l = await db.query.leads.findFirst({ where: eq(leads.id, leadId), columns: { id: true, name: true, contactId: true } });
    if (l) out.push({ leadId: l.id, contactId: l.contactId, jobId, label: l.name, signal: s });
  };

  // Already linked: by the thread, the email pipeline, or Chris.
  if (input.linked.leadId) await pushLead(input.linked.leadId, sig(input.linked.how === "the email thread" ? "thread" : "linked", `linked by ${input.linked.how}`), input.linked.jobId);
  else if (input.linked.contactId) await pushContact(input.linked.contactId, sig(input.linked.how === "the email thread" ? "thread" : "linked", `linked by ${input.linked.how}`), input.linked.jobId);

  // Email addresses: the sender, the form's, and any written in the text.
  const addrs = new Set<string>([input.from.email, input.form?.email?.toLowerCase(), ...emailsIn(all), ...(extra.emails ?? [])].filter((x): x is string => !!x && !/noreply|no-reply|wordpress|website/i.test(x)));
  for (const a of addrs) {
    for (const c of await db.query.contacts.findMany({ where: sql`lower(${contacts.email}) = ${a}`, columns: { id: true }, limit: 3 })) await pushContact(c.id, sig("email", `email ${a}`));
    for (const l of await db.query.leads.findMany({ where: and(sql`lower(${leads.email}) = ${a}`, isNull(leads.archivedAt)), columns: { id: true }, limit: 3 })) await pushLead(l.id, sig("email", `email ${a}`));
  }
  // Phone numbers said or written.
  const phones = new Set([...phonesIn(all), input.from.phone ?? "", input.form?.phone ?? "", ...(extra.phones ?? [])].filter(Boolean).map(normalisePhone).filter((p) => p.length >= 8));
  for (const p of phones) {
    const alt = p.startsWith("0") ? `64${p.slice(1)}` : p;
    for (const c of await db.query.contacts.findMany({ where: sql`${digitsSql(contacts.phone)} in (${p}, ${alt})`, columns: { id: true }, limit: 3 })) await pushContact(c.id, sig("phone", `phone ${p}`));
    for (const l of await db.query.leads.findMany({ where: and(sql`${digitsSql(leads.phone)} in (${p}, ${alt})`, isNull(leads.archivedAt)), columns: { id: true }, limit: 3 })) await pushLead(l.id, sig("phone", `phone ${p}`));
  }
  // A quote or job number mentioned.
  const qrefs = quoteRefsIn(all);
  if (qrefs.length) {
    for (const q of await db.query.quotes.findMany({ where: inArray(quotes.number, qrefs), columns: { number: true, leadId: true, contactId: true } })) {
      if (q.leadId) await pushLead(q.leadId, sig("quote_ref", `quote Q-${q.number}`));
      else if (q.contactId) await pushContact(q.contactId, sig("quote_ref", `quote Q-${q.number}`));
    }
  }
  const jrefs = jobRefsIn(all);
  if (jrefs.length) {
    for (const j of await db.query.jobs.findMany({ where: inArray(jobs.number, jrefs), columns: { id: true, number: true, leadId: true, contactId: true } })) {
      if (j.leadId) await pushLead(j.leadId, sig("job_ref", `job J-${j.number}`), j.id);
      else await pushContact(j.contactId, sig("job_ref", `job J-${j.number}`), j.id);
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
      if (e.leadId) await pushLead(e.leadId, s, e.jobId);
      else if (e.contactId) await pushContact(e.contactId, s, e.jobId);
      else if (e.jobId) {
        const j = await db.query.jobs.findFirst({ where: eq(jobs.id, e.jobId), columns: { contactId: true, leadId: true } });
        if (j?.leadId) await pushLead(j.leadId, s, e.jobId);
        else if (j?.contactId) await pushContact(j.contactId, s, e.jobId);
      }
    }
  }
  // Street addresses: a lead's site, a customer's address, a job's site. Supporting evidence: it
  // points at the work (which Hermes may then choose as the operational context), never at the person.
  const addresses = [...new Set([...addressesIn(all), input.form?.address ?? "", ...(extra.addresses ?? [])].filter(Boolean))];
  for (const a of addresses) {
    const key = addressKey(a);
    if (!key) continue;
    const like = `%${key}%`;
    for (const l of await db.query.leads.findMany({ where: and(sql`lower(coalesce(${leads.site}, '')) like ${like}`, isNull(leads.archivedAt)), columns: { id: true }, limit: 3 })) await pushLead(l.id, sig("address", `address ${a}`));
    for (const c of await db.query.contacts.findMany({ where: sql`lower(coalesce(${contacts.address}, '')) like ${like}`, columns: { id: true }, limit: 3 })) await pushContact(c.id, sig("address", `address ${a}`));
    for (const j of await db.query.jobs.findMany({ where: sql`lower(coalesce(${jobs.siteAddress}, '')) like ${like}`, columns: { id: true, leadId: true, contactId: true }, orderBy: [desc(jobs.createdAt)], limit: 3 })) {
      if (j.leadId) await pushLead(j.leadId, sig("address", `address ${a}`), j.id);
      else await pushContact(j.contactId, sig("address", `address ${a}`), j.id);
    }
  }
  // A street with no number: supporting evidence when exactly one open record is on that street.
  for (const street of streetsIn(all)) {
    if (addresses.some((a) => a.toLowerCase().includes(street))) continue; // the numbered address covered it
    const on = await recordsOnStreet(street);
    if (on.length !== 1) continue;
    const r = on[0];
    if (r.leadId) await pushLead(r.leadId, sig("address", `street ${street} (the only record on it)`), r.jobId);
    else if (r.contactId) await pushContact(r.contactId, sig("address", `street ${street} (the only record on it)`), r.jobId);
  }
  // Company and person names: supporting evidence only (a name never files anything).
  const names = new Set<string>([...(extra.names ?? []), input.from.name ?? "", input.form?.name ?? "", ...(input.sourceType === "recording" ? namesIn(all) : [])].filter((n) => n && n.split(/\s+/).length >= 2));
  const companies = new Set<string>([extra.company ?? ""].filter(Boolean));
  for (const n of names) {
    for (const c of await db.query.contacts.findMany({ where: or(sql`lower(${contacts.name}) = lower(${n})`, sql`lower(coalesce(${contacts.company}, '')) = lower(${n})`), columns: { id: true }, limit: 3 })) await pushContact(c.id, sig("name", `name ${n}`));
    for (const l of await db.query.leads.findMany({ where: and(or(sql`lower(${leads.name}) = lower(${n})`, sql`lower(coalesce(${leads.company}, '')) = lower(${n})`), isNull(leads.archivedAt)), columns: { id: true }, limit: 3 })) await pushLead(l.id, sig("name", `name ${n}`));
  }
  for (const co of companies) for (const c of await db.query.contacts.findMany({ where: sql`lower(coalesce(${contacts.company}, '')) = lower(${co})`, columns: { id: true }, limit: 3 })) await pushContact(c.id, sig("company", `company ${co}`));
  return out;
}
