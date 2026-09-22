/**
 * Works out who a recording is about.
 *
 * Deliberately conservative. A wrong match files a customer conversation against the wrong person,
 * which is worse than leaving it in review, so a match is only made on evidence that is hard to
 * hit by accident: a phone number, or a distinctive company or person name spoken in the call.
 */
import { and, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { contacts, leads } from "@/db/schema";

export type RecordingMatch = { contactId: string | null; leadId: string | null; matchedBy: string } | null;

/** Digits only, so "021 088 5669" and "02108856692" compare equal. */
export function digits(s: string): string {
  return s.replace(/\D/g, "");
}

/** Every NZ-looking phone number spoken or written in the text, as digit strings. */
export function phoneCandidates(text: string): string[] {
  const found = text.match(/(?:\+?64|0)[\s-]?[2-9][\d\s-]{6,12}\d/g) ?? [];
  return [...new Set(found.map(digits).filter((d) => d.length >= 8))];
}

/**
 * Names worth matching on: capitalised multi-word phrases such as "Greyland Firehouse". Single
 * common words are ignored, because matching a customer on the word "the" would be a disaster.
 */
export function nameCandidates(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b([A-Z][a-z']{2,})(\s+[A-Z][a-z']{2,}){1,3}\b/g)) {
    const phrase = m[0].trim();
    if (phrase.length >= 6) out.add(phrase);
  }
  return [...out];
}

const STOP_PHRASES = /^(speaker|transcript|consultation|meeting|reasoning note|site visit|get secure)\b/i;

/**
 * Find the customer or lead a transcript belongs to. Returns null when nothing is certain enough,
 * which sends the recording to the review list.
 */
export async function matchRecording(input: { title: string; transcript: string }): Promise<RecordingMatch> {
  const text = `${input.title}\n${input.transcript}`;

  // 1. A phone number is the strongest signal.
  for (const phone of phoneCandidates(text)) {
    const contact = await db.query.contacts.findFirst({
      where: sql`regexp_replace(coalesce(${contacts.phone}, ''), '\\D', '', 'g') = ${phone}`,
      columns: { id: true },
    });
    if (contact) return { contactId: contact.id, leadId: null, matchedBy: `phone ${phone}` };

    const lead = await db.query.leads.findFirst({
      where: and(sql`regexp_replace(coalesce(${leads.phone}, ''), '\\D', '', 'g') = ${phone}`, isNull(leads.archivedAt)),
      columns: { id: true, contactId: true },
    });
    if (lead) return { contactId: lead.contactId, leadId: lead.id, matchedBy: `phone ${phone}` };
  }

  // 2. Otherwise a distinctive name spoken in the call, matched against company then person.
  // The stored name may carry a suffix the caller never says ("Greyland Firehouse Ltd"), so a
  // stored name that *starts with* the spoken phrase counts, as long as the phrase is long enough
  // to be distinctive on its own.
  for (const name of nameCandidates(text)) {
    if (STOP_PHRASES.test(name)) continue;
    const prefixOk = name.length >= 8 && name.split(/\s+/).length >= 2;
    const like = `${name.toLowerCase()} %`;

    const contact = await db.query.contacts.findFirst({
      where: sql`lower(coalesce(${contacts.company}, '')) = lower(${name})
        or lower(${contacts.name}) = lower(${name})
        or (${prefixOk} and (lower(coalesce(${contacts.company}, '')) like ${like} or lower(${contacts.name}) like ${like}))`,
      columns: { id: true },
    });
    if (contact) return { contactId: contact.id, leadId: null, matchedBy: `name "${name}"` };

    const lead = await db.query.leads.findFirst({
      where: and(
        sql`lower(coalesce(${leads.company}, '')) = lower(${name})
          or lower(${leads.name}) = lower(${name})
          or (${prefixOk} and (lower(coalesce(${leads.company}, '')) like ${like} or lower(${leads.name}) like ${like}))`,
        isNull(leads.archivedAt),
        ne(leads.status, "lost"),
      ),
      columns: { id: true, contactId: true },
    });
    if (lead) return { contactId: lead.contactId, leadId: lead.id, matchedBy: `name "${name}"` };
  }

  return null;
}

/** First line or two of a transcript, for list views. */
export function transcriptPreview(transcript: string, max = 220): string {
  const spoken = transcript
    .split("\n")
    .map((l) => l.replace(/^\[\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}\]\s*(Speaker \d+:)?\s*/i, "").trim())
    .filter(Boolean)
    .join(" ");
  return spoken.length > max ? spoken.slice(0, max).trimEnd() + "…" : spoken;
}
