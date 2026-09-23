/**
 * One-off repair for website enquiries filed by older code.
 *
 * Before website forms were parsed first, the robot's address (noreply@updates…) could end up
 * saved on a customer, and from then on every enquiry matched that one customer. Enquiries with
 * the same subject were also merged into one conversation. This puts each enquiry back on its own
 * conversation and its own lead, and takes the robot's address off every customer and lead.
 *
 * Safe to run more than once: anything already correct is left alone. Nothing is deleted.
 */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { contacts, emailThreads, emails, leads } from "@/db/schema";
import { digits } from "@/lib/recordings/match";
import { latestClassification, linkThread, processEmail } from "./pipeline";
import { isWebsiteLeadSender, parseWebsiteLead, websiteLeadSenders, type WebsiteLead } from "./website-lead";

export type RepairReport = { lines: string[]; changes: number };

type RobotEmail = typeof emails.$inferSelect;

const same = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

export async function repairWebsiteEnquiries(opts: { apply: boolean }): Promise<RepairReport> {
  const lines: string[] = [];
  let changes = 0;
  const say = (line: string) => lines.push(line);
  const change = (line: string) => {
    changes++;
    say(`${opts.apply ? "" : "would "}${line}`);
  };

  const senders = websiteLeadSenders();
  const robotMail = async () =>
    db
      .select()
      .from(emails)
      .where(and(eq(emails.direction, "inbound"), inArray(sql`lower(${emails.fromAddress})`, senders)))
      .orderBy(asc(emails.receivedAt));

  // 1. One conversation per enquiry. The oldest enquiry keeps the conversation; later ones that
  //    were merged into it get a conversation of their own.
  const byThread = new Map<string, RobotEmail[]>();
  for (const e of await robotMail()) byThread.set(e.threadId, [...(byThread.get(e.threadId) ?? []), e]);
  for (const [threadId, list] of byThread) {
    if (list.length < 2) continue;
    const thread = await db.query.emailThreads.findFirst({ where: eq(emailThreads.id, threadId) });
    if (!thread) continue;
    for (const e of list.slice(1)) {
      change(`separate "${e.subject}" (${e.receivedAt.toISOString().slice(0, 10)}) into its own conversation`);
      if (!opts.apply) continue;
      await db.transaction(async (tx) => {
        const [t] = await tx
          .insert(emailThreads)
          .values({
            mailboxId: thread.mailboxId,
            subject: e.subject,
            normalizedSubject: thread.normalizedSubject,
            counterpartAddress: thread.counterpartAddress,
            firstMessageAt: e.receivedAt,
            lastMessageAt: e.receivedAt,
            messageCount: 1,
          })
          .returning({ id: emailThreads.id });
        await tx.update(emails).set({ threadId: t.id }).where(eq(emails.id, e.id));
        await tx
          .update(emailThreads)
          .set({ messageCount: sql`greatest(${emailThreads.messageCount} - 1, 1)`, updatedAt: new Date() })
          .where(eq(emailThreads.id, threadId));
        // A lead made from this enquiry follows it to the new conversation.
        await tx.update(leads).set({ emailThreadId: t.id }).where(eq(leads.sourceEmailId, e.id));
      });
    }
  }

  // 2. One lead per enquiry, with the enquirer's details.
  const parsed = new Map<string, WebsiteLead>();
  for (const e of await robotMail()) {
    const w = parseWebsiteLead({ subject: e.subject ?? "", text: e.textBody ?? "", fromAddress: e.fromAddress });
    if (!w) {
      say(`skip "${e.subject}": could not read the enquiry details, check it by hand`);
      continue;
    }
    parsed.set(e.id, w);
    const x = w.extraction;
    const who = x.contact_name ?? x.email ?? e.subject;

    // Already has its own lead: just fill in anything the old code got wrong.
    const own = await db.query.leads.findFirst({ where: eq(leads.sourceEmailId, e.id) });
    if (own) {
      const fix: Partial<typeof leads.$inferInsert> = {};
      if ((!own.email || isWebsiteLeadSender(own.email)) && x.email) fix.email = x.email;
      if (isWebsiteLeadSender(own.email) && !x.email) fix.email = null;
      if (x.contact_name && (same(own.name, e.fromName) || isWebsiteLeadSender(own.name) || own.name === "Website enquiry"))
        fix.name = x.contact_name;
      if (!own.phone && x.phone) fix.phone = x.phone;
      if (!own.service && x.service) fix.service = x.service;
      if (!own.site && x.site_address) fix.site = x.site_address;
      // Attached to a customer only because that customer held the robot's address: detach.
      if (own.contactId) {
        const c = await db.query.contacts.findFirst({ where: eq(contacts.id, own.contactId), columns: { name: true, email: true } });
        if (c && isWebsiteLeadSender(c.email) && !same(c.name, x.contact_name)) fix.contactId = null;
      }
      if (Object.keys(fix).length) {
        change(`correct lead "${own.name}" → ${Object.entries(fix).map(([k, v]) => `${k}: ${v ?? "(blank)"}`).join(", ")}`);
        if (opts.apply) await db.update(leads).set({ ...fix, updatedAt: new Date() }).where(eq(leads.id, own.id));
      }
      // Its conversation must point at it, not at whoever the robot's address matched.
      const contactId = fix.contactId !== undefined ? fix.contactId : own.contactId;
      const thread = await db.query.emailThreads.findFirst({ where: eq(emailThreads.id, e.threadId) });
      if (thread && (thread.leadId !== own.id || thread.contactId !== contactId || e.leadId !== own.id)) {
        change(`point "${e.subject}" at its own lead "${fix.name ?? own.name}"`);
        if (opts.apply) {
          await db.update(emailThreads).set({ leadId: own.id, contactId, updatedAt: new Date() }).where(eq(emailThreads.id, e.threadId));
          await db.update(emails).set({ leadId: own.id, contactId }).where(eq(emails.id, e.id));
        }
      }
      continue;
    }

    // Someone decided by hand that this one is not a lead (spam through the form): respect that.
    if (e.classification === "not_lead") {
      const latest = await latestClassification(e.id);
      if (latest?.reviewOutcome === "rejected") {
        say(`skip "${e.subject}": marked "not a lead" by hand`);
        continue;
      }
    }

    // A lead for this person may already exist, for example one typed in by hand.
    const phone = x.phone ? digits(x.phone) : "";
    const existing = await db.query.leads.findFirst({
      where: and(
        isNull(leads.archivedAt),
        sql`(${x.email ? sql`lower(${leads.email}) = ${x.email.toLowerCase()}` : sql`false`}
          or ${phone.length >= 8 ? sql`regexp_replace(coalesce(${leads.phone}, ''), '\\D', '', 'g') = ${phone}` : sql`false`})`,
      ),
      columns: { id: true, name: true, contactId: true },
    });
    if (existing) {
      if (e.leadId === existing.id) continue;
      change(`file "${e.subject}" on the existing lead "${existing.name}" (same email or phone)`);
      if (opts.apply) await linkThread(e.threadId, { leadId: existing.id, contactId: existing.contactId }, null);
      continue;
    }

    change(`create a lead for ${who}${e.leadId ? " (it was filed on someone else's lead)" : ""}`);
    if (!opts.apply) continue;
    await db.transaction(async (tx) => {
      await tx.update(emailThreads).set({ leadId: null, contactId: null, jobId: null, updatedAt: new Date() }).where(eq(emailThreads.id, e.threadId));
      await tx.update(emails).set({ leadId: null, contactId: null }).where(eq(emails.id, e.id));
    });
    await processEmail(e.id, { force: true });
  }

  // 3. Take the robot's address off customers. Where the customer came from a website enquiry,
  //    their real address is in that enquiry, so put it back.
  const robotContacts = await db
    .select({ id: contacts.id, name: contacts.name })
    .from(contacts)
    .where(inArray(sql`lower(${contacts.email})`, senders));
  for (const c of robotContacts) {
    const theirLeads = await db.query.leads.findMany({ where: eq(leads.contactId, c.id), columns: { sourceEmailId: true } });
    const found = new Set<string>();
    for (const l of theirLeads) {
      const w = l.sourceEmailId ? parsed.get(l.sourceEmailId) : undefined;
      if (w?.extraction.email && same(w.extraction.contact_name, c.name)) found.add(w.extraction.email.toLowerCase());
    }
    const real = found.size === 1 ? [...found][0] : null;
    change(
      real
        ? `set customer "${c.name}" email to ${real} (from their own website enquiry)`
        : `clear the website address from customer "${c.name}" (their real email is not known: add it by hand)`,
    );
    if (opts.apply) await db.update(contacts).set({ email: real, updatedAt: new Date() }).where(eq(contacts.id, c.id));
  }

  // 4. And off any lead still holding it.
  const robotLeads = await db
    .select({ id: leads.id, name: leads.name })
    .from(leads)
    .where(inArray(sql`lower(${leads.email})`, senders));
  for (const l of robotLeads) {
    change(`clear the website address from lead "${l.name}"`);
    if (opts.apply) await db.update(leads).set({ email: null, updatedAt: new Date() }).where(eq(leads.id, l.id));
  }

  if (!changes) say("Nothing to repair.");
  return { lines, changes };
}
