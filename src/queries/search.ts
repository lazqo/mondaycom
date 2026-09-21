import "server-only";
import { desc, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { contacts, emails, jobs, leads, quotes } from "@/db/schema";

function digits(s: string) {
  return s.replace(/\D/g, "");
}

/** Search customers, leads, jobs, quotes and emails by name, phone (digits only), email or address. */
export async function globalSearch(q: string) {
  const term = q.trim();
  if (!term) return { contacts: [], leads: [], jobs: [], quotes: [], emails: [] };
  const like = `%${term}%`;
  const d = digits(term);
  const phoneLike = d.length >= 4 ? `%${d}%` : null;
  const phoneCond = (col: SQL) => (phoneLike ? sql`regexp_replace(coalesce(${col}, ''), '\\D', '', 'g') like ${phoneLike}` : sql`false`);

  const [c, l, j, qs, e] = await Promise.all([
    db.query.contacts.findMany({
      where: or(sql`${contacts.name} ilike ${like}`, sql`${contacts.company} ilike ${like}`, sql`${contacts.email} ilike ${like}`, sql`${contacts.address} ilike ${like}`, phoneCond(sql`${contacts.phone}`)),
      orderBy: [desc(contacts.updatedAt)],
      limit: 20,
    }),
    db.query.leads.findMany({
      where: or(sql`${leads.name} ilike ${like}`, sql`${leads.company} ilike ${like}`, sql`${leads.email} ilike ${like}`, sql`${leads.site} ilike ${like}`, phoneCond(sql`${leads.phone}`)),
      with: { contact: { columns: { id: true, name: true } } },
      orderBy: [desc(leads.updatedAt)],
      limit: 20,
    }),
    db.query.jobs.findMany({
      where: or(sql`${jobs.title} ilike ${like}`, sql`${jobs.siteAddress} ilike ${like}`, sql`cast(${jobs.number} as text) = ${term.replace(/^J-?/i, "")}`),
      with: { contact: { columns: { id: true, name: true } } },
      orderBy: [desc(jobs.updatedAt)],
      limit: 20,
    }),
    db.query.quotes.findMany({
      where: or(sql`${quotes.title} ilike ${like}`, sql`cast(${quotes.number} as text) = ${term.replace(/^Q-?/i, "")}`),
      with: { contact: { columns: { id: true, name: true } } },
      orderBy: [desc(quotes.updatedAt)],
      limit: 20,
    }),
    db.query.emails.findMany({
      where: or(sql`${emails.subject} ilike ${like}`, sql`${emails.fromAddress} ilike ${like}`, sql`${emails.fromName} ilike ${like}`),
      columns: { id: true, threadId: true, subject: true, fromName: true, fromAddress: true, receivedAt: true, classification: true },
      orderBy: [desc(emails.receivedAt)],
      limit: 20,
    }),
  ]);
  return { contacts: c, leads: l, jobs: j, quotes: qs, emails: e };
}
