import { and, asc, desc, eq, inArray, isNull, max, ne, notInArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { contacts, emailThreads, emails, jobs, leads, users, type ExtractedLead } from "@/db/schema";
import { env } from "@/lib/env";
import { OPEN_JOB_STATUSES } from "@/lib/constants";
import { logActivity } from "@/lib/activity";
import { isAutomatedMail } from "./parse";
import { isWebsiteLeadSender, parseWebsiteLead, personalEmail } from "./website-lead";


export type ProcessOutcome = {
  emailId: string;
  classification: "lead" | "reading" | "needs_review" | "not_lead" | "existing" | "outbound" | "error";
  leadId: string | null;
  contactId: string | null;
  detail: string;
  /** Not a lead because the deterministic pre-filter is sure (automated mail): never sent to Hermes. */
  prefiltered?: boolean;
};

/**
 * File one stored email mechanically, then hand it to Hermes (the Lead + Conversation Inspector,
 * src/lib/inspector/inspect.ts), which is the only thing that decides what it is. The mechanical
 * steps are: a website form is parsed exactly and becomes a lead; a reply on a thread already
 * linked, or from a known sender, is filed on that lead or customer; obvious automated mail
 * (bulk, list, bounce, auto-reply) is filtered. Everything else is marked "reading" until Hermes
 * decides lead / not a lead / existing work / needs Chris. Safe to re-run: an already filed email
 * is skipped unless `force`.
 */
export async function processEmail(emailId: string, opts: { force?: boolean } = {}): Promise<ProcessOutcome> {
  const out = await classifyEmail(emailId, opts);
  // Everything Hermes should read: filed mail (it may still have work in it) and anything undecided.
  // Only mail the pre-filter is sure is automated skips Hermes.
  const forHermes = ["lead", "existing", "reading", "needs_review", "outbound"].includes(out.classification) || (out.classification === "not_lead" && !out.prefiltered);
  if (out.detail !== "already classified" && forHermes) {
    try {
      // Queued, not awaited: ingestion never waits for Hermes. The queue is worked in the background.
      const { enqueueInspection, kickInspectorQueue } = await import("@/lib/inspector/queue");
      await enqueueInspection("email", emailId, { force: opts.force });
      kickInspectorQueue();
    } catch (err) {
      console.error(`[inspector] email ${emailId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

async function classifyEmail(emailId: string, opts: { force?: boolean } = {}): Promise<ProcessOutcome> {
  const email = await db.query.emails.findFirst({
    where: eq(emails.id, emailId),
    with: { thread: true, attachments: { columns: { filename: true, contentType: true, size: true } } },
  });
  if (!email) throw new Error("Email not found");
  if (!opts.force && email.classification !== "pending" && email.classification !== "error") {
    return { emailId, classification: email.classification as ProcessOutcome["classification"], leadId: email.leadId, contactId: email.contactId, detail: "already classified" };
  }
  if (email.direction === "outbound") {
    await db.update(emails).set({ classification: "outbound", classifiedAt: new Date() }).where(eq(emails.id, emailId));
    return { emailId, classification: "outbound", leadId: null, contactId: null, detail: "outbound" };
  }

  try {
    const thread = email.thread;

    // A. Website enquiry forms come first, before any sender or thread matching.
    //
    // They are sent by a robot (noreply@…) with the customer's details in the body. If the sender
    // check ran first, the robot's address would match whichever customer was once created from it
    // and every future enquiry would be filed against that one person — which is exactly what
    // happened before this ran first.
    const website = parseWebsiteLead({
      subject: email.subject ?? "",
      text: email.textBody ?? "",
      fromAddress: email.fromAddress,
    });
    if (website) {
      // Match on the enquirer's own address from the body, never the robot's.
      const enquirerEmail = website.extraction.email?.toLowerCase() ?? null;
      const enquirerContact = enquirerEmail
        ? await db.query.contacts.findFirst({ where: sql`lower(${contacts.email}) = ${enquirerEmail}`, columns: { id: true } })
        : null;
      const leadId = await createLeadFromEmail(emailId, {
        actorId: null,
        overrides: website.extraction,
        contactId: enquirerContact?.id ?? null,
        jobId: null,
      });
      return { emailId, classification: "lead", leadId, contactId: enquirerContact?.id ?? null, detail: "website enquiry form" };
    }

    // B. Thread already linked to a lead / customer / job → attach, no AI needed.
    if (thread.leadId || thread.jobId || thread.contactId) {
      const leadId = thread.leadId ?? null;
      await db.transaction(async (tx) => {
        await tx
          .update(emails)
          .set({ classification: "existing", leadId, contactId: thread.contactId, classifiedAt: new Date() })
          .where(eq(emails.id, emailId));
        if (leadId) await touchLead(tx, leadId, email.receivedAt);
      });
      return { emailId, classification: "existing", leadId, contactId: thread.contactId, detail: "thread already linked" };
    }

    // C. Known sender: match a customer by email, then their open lead / job.
    // A website robot address is never a customer, even if one was mistakenly created from it once.
    const senderAddress = email.fromAddress && !isWebsiteLeadSender(email.fromAddress) ? email.fromAddress : null;
    const contact = senderAddress
      ? await db.query.contacts.findFirst({ where: sql`lower(${contacts.email}) = ${senderAddress.toLowerCase()}` })
      : null;
    const openLead = senderAddress
      ? await db.query.leads.findFirst({
          where: and(
            isNull(leads.archivedAt),
            or(sql`lower(${leads.email}) = ${senderAddress.toLowerCase()}`, contact ? eq(leads.contactId, contact.id) : sql`false`),
            notInArray(leads.status, ["won", "lost"]),
          ),
          orderBy: [desc(leads.updatedAt)],
        })
      : null;
    const openJob = contact
      ? await db.query.jobs.findFirst({
          where: and(eq(jobs.contactId, contact.id), inArray(jobs.status, OPEN_JOB_STATUSES)),
          orderBy: [desc(jobs.updatedAt)],
        })
      : null;

    if (openLead) {
      await db.transaction(async (tx) => {
        await tx
          .update(emailThreads)
          .set({ leadId: openLead.id, contactId: contact?.id ?? openLead.contactId, jobId: openJob?.id ?? null, updatedAt: new Date() })
          .where(eq(emailThreads.id, thread.id));
        await tx
          .update(emails)
          .set({ classification: "existing", leadId: openLead.id, contactId: contact?.id ?? openLead.contactId, classifiedAt: new Date() })
          .where(eq(emails.id, emailId));
        await touchLead(tx, openLead.id, email.receivedAt);
        await logActivity({ entity: "lead", entityId: openLead.id, actorId: null, action: "email_received", detail: { emailId, subject: email.subject } });
      });
      return { emailId, classification: "existing", leadId: openLead.id, contactId: contact?.id ?? openLead.contactId, detail: "matched open lead" };
    }

    // D. Automated mail never goes to the model.
    const automated = isAutomatedMail({ headers: email.headers, from: { name: email.fromName, address: email.fromAddress }, subject: email.subject });
    if (automated) {
      await db
        .update(emails)
        .set({ classification: "not_lead", contactId: contact?.id ?? null, classifiedAt: new Date() })
        .where(eq(emails.id, emailId));
      return { emailId, classification: "not_lead", leadId: null, contactId: contact?.id ?? null, detail: automated, prefiltered: true };
    }

    // E. Everything else is Hermes's to decide. The email is marked "reading" and queued (processEmail).
    await db
      .update(emails)
      .set({ classification: "reading", contactId: contact?.id ?? null, classifiedAt: new Date(), classificationError: null })
      .where(eq(emails.id, emailId));
    if (contact) await db.update(emailThreads).set({ contactId: contact.id }).where(eq(emailThreads.id, thread.id));
    return { emailId, classification: "reading", leadId: null, contactId: contact?.id ?? null, detail: "with Hermes" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.update(emails).set({ classification: "error", classificationError: message, classifiedAt: new Date() }).where(eq(emails.id, emailId));
    return { emailId, classification: "error", leadId: null, contactId: null, detail: message };
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** YYYY-MM-DD for an instant in the app's timezone (date columns must not drift with UTC). */
export function dateInAppTz(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: env.APP_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

async function touchLead(tx: Tx, leadId: string, at: Date) {
  await tx
    .update(leads)
    .set({ lastContactAt: dateInAppTz(at), updatedAt: new Date() })
    .where(eq(leads.id, leadId));
}

function emptyExtraction(email: { fromName: string | null; fromAddress: string; subject: string }, reason: string): ExtractedLead {
  return {
    is_lead: true,
    confidence: 1,
    contact_name: email.fromName,
    company: null,
    email: email.fromAddress,
    phone: null,
    service: null,
    site_address: null,
    summary: email.subject,
    urgency: "normal",
    next_action: "No action needed.",
    reason,
  };
}

/**
 * Create a Lead from an email: from the website form's exact fields, Hermes's checked reading, or a
 * person's edits (the overrides); otherwise from the sender alone. Links the thread and email to it
 * and marks the email as a lead.
 */
export async function createLeadFromEmail(
  emailId: string,
  opts: { actorId: string | null; overrides?: Partial<ExtractedLead>; contactId?: string | null; jobId?: string | null; assignedToId?: string | null },
): Promise<string> {
  const email = await db.query.emails.findFirst({ where: eq(emails.id, emailId), with: { thread: true } });
  if (!email) throw new Error("Email not found");
  const x: ExtractedLead = { ...emptyExtraction(email, "manual"), ...(opts.overrides ?? {}) };
  // A website enquiry is only ever tied to a customer by the enquirer's own details, which the
  // caller has already looked up. Whatever the email was filed under before (by older code that
  // matched the robot's address to a customer) must not carry over.
  const fromWebsite = isWebsiteLeadSender(email.fromAddress);
  const contactId = opts.contactId ?? (fromWebsite ? null : email.contactId) ?? null;

  const leadId = await db.transaction(async (tx) => {
    const [{ maxPos }] = await tx.select({ maxPos: max(leads.position) }).from(leads);
    const [row] = await tx
      .insert(leads)
      .values({
        name: x.contact_name?.trim() || (fromWebsite ? "Website enquiry" : email.fromName || email.fromAddress),
        company: x.company,
        phone: x.phone,
        email: personalEmail(x.email) ?? personalEmail(email.fromAddress),
        service: x.service,
        site: x.site_address,
        status: "new",
        source: "email",
        summary: x.summary,
        urgency: x.urgency,
        nextAction: x.next_action,
        aiConfidence: opts.overrides?.confidence != null ? Number(opts.overrides.confidence).toFixed(3) : null,
        emailThreadId: email.threadId,
        sourceEmailId: email.id,
        contactId,
        assignedToId: opts.assignedToId ?? null,
        lastContactAt: dateInAppTz(email.receivedAt),
        followUpAt: nextBusinessDay(email.receivedAt),
        notes: `From email: ${email.subject}`,
        position: (maxPos ?? 0) + 1,
        createdById: opts.actorId,
      })
      .returning({ id: leads.id });
    await tx
      .update(emailThreads)
      .set({ leadId: row.id, contactId, jobId: opts.jobId ?? email.thread.jobId, updatedAt: new Date() })
      .where(eq(emailThreads.id, email.threadId));
    await tx
      .update(emails)
      .set({ classification: "lead", leadId: row.id, contactId, classifiedAt: new Date(), classificationError: null })
      .where(eq(emails.id, emailId));
    // Any other unclassified messages on the same thread are now part of this lead.
    await tx
      .update(emails)
      .set({ classification: "existing", leadId: row.id, contactId })
      .where(and(eq(emails.threadId, email.threadId), ne(emails.id, emailId), eq(emails.direction, "inbound"), notInArray(emails.classification, ["outbound"])));
    await logActivity({
      entity: "lead",
      entityId: row.id,
      actorId: opts.actorId,
      action: opts.actorId ? "created_from_email" : "auto_created_from_email",
      detail: { emailId, subject: email.subject, confidence: opts.overrides?.confidence ?? null, reason: opts.overrides?.reason ?? null },
    });
    return row.id;
  });
  return leadId;
}

export async function markEmailNotLead(emailId: string, actorId: string | null) {
  await db.update(emails).set({ classification: "not_lead", classifiedAt: new Date(), classificationError: null }).where(eq(emails.id, emailId));
  const e = await db.query.emails.findFirst({ where: eq(emails.id, emailId), columns: { leadId: true, subject: true } });
  if (e?.leadId) await logActivity({ entity: "lead", entityId: e.leadId, actorId, action: "email_not_lead", detail: { emailId, subject: e.subject } });
}

/** Link a whole thread (and its inbound emails) to an existing lead, customer and/or job. */
export async function linkThread(threadId: string, target: { leadId?: string | null; contactId?: string | null; jobId?: string | null }, actorId: string | null) {
  const thread = await db.query.emailThreads.findFirst({ where: eq(emailThreads.id, threadId) });
  if (!thread) throw new Error("Thread not found");
  let leadId = target.leadId === undefined ? thread.leadId : target.leadId;
  let contactId = target.contactId === undefined ? thread.contactId : target.contactId;
  const jobId = target.jobId === undefined ? thread.jobId : target.jobId;
  if (leadId && !contactId) {
    const l = await db.query.leads.findFirst({ where: eq(leads.id, leadId), columns: { contactId: true } });
    contactId = l?.contactId ?? null;
  }
  if (jobId && !contactId) {
    const j = await db.query.jobs.findFirst({ where: eq(jobs.id, jobId), columns: { contactId: true, leadId: true } });
    contactId = j?.contactId ?? null;
    leadId = leadId ?? j?.leadId ?? null;
  }
  await db.transaction(async (tx) => {
    await tx.update(emailThreads).set({ leadId, contactId, jobId, updatedAt: new Date() }).where(eq(emailThreads.id, threadId));
    await tx
      .update(emails)
      .set({ leadId, contactId, classification: "existing", classifiedAt: new Date(), classificationError: null })
      .where(and(eq(emails.threadId, threadId), eq(emails.direction, "inbound")));
    if (leadId) {
      await touchLead(tx, leadId, thread.lastMessageAt);
      await logActivity({ entity: "lead", entityId: leadId, actorId, action: "email_linked", detail: { threadId, subject: thread.subject } });
    }
  });
}

/** Classify every stored email still marked pending. Returns outcomes. */
export async function processPendingEmails(limit = 50): Promise<ProcessOutcome[]> {
  const pending = await db.query.emails.findMany({
    where: eq(emails.classification, "pending"),
    orderBy: [asc(emails.receivedAt)],
    columns: { id: true },
    limit,
  });
  const out: ProcessOutcome[] = [];
  for (const p of pending) out.push(await processEmail(p.id));
  return out;
}

function nextBusinessDay(from: Date): string {
  const [y, m, d] = dateInAppTz(from).split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d + 1));
  while (day.getUTCDay() === 0 || day.getUTCDay() === 6) day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
}

/**
 * Attach a message sent from outside the CRM (webmail, a phone, Outlook) to the right records.
 *
 * Replies thread by Message-ID, In-Reply-To and References when the message is stored, so a reply
 * to a customer's email lands on their conversation and inherits its lead, customer and job. A new
 * message is matched on its recipients: a customer with that address, then a lead with it.
 */
export async function linkOutboundEmail(emailId: string): Promise<{ leadId: string | null; contactId: string | null; detail: string }> {
  const email = await db.query.emails.findFirst({ where: eq(emails.id, emailId), with: { thread: true, mailbox: { columns: { emailAddress: true } } } });
  if (!email) throw new Error("Email not found");

  // Who sent it, when the From address is a member of staff.
  if (!email.sentById && email.fromAddress) {
    const sender = await db.query.users.findFirst({ where: sql`lower(${users.email}) = ${email.fromAddress.toLowerCase()}`, columns: { id: true } });
    if (sender) await db.update(emails).set({ sentById: sender.id }).where(eq(emails.id, emailId));
  }

  const thread = email.thread;
  if (thread.leadId || thread.contactId || thread.jobId) {
    await db.transaction(async (tx) => {
      await tx.update(emails).set({ leadId: thread.leadId, contactId: thread.contactId }).where(eq(emails.id, emailId));
      if (thread.leadId) await touchLead(tx, thread.leadId, email.receivedAt);
    });
    return { leadId: thread.leadId, contactId: thread.contactId, detail: "reply on a linked conversation" };
  }

  const own = new Set([email.mailbox.emailAddress.toLowerCase(), email.fromAddress.toLowerCase()]);
  const staff = new Set((await db.query.users.findMany({ columns: { email: true } })).map((u) => u.email.toLowerCase()));
  const recipients = [...email.to, ...email.cc]
    .map((a) => a.address.toLowerCase())
    .filter((a) => a && !own.has(a) && !staff.has(a) && !isWebsiteLeadSender(a));

  for (const address of recipients) {
    const contact = await db.query.contacts.findFirst({ where: sql`lower(${contacts.email}) = ${address}`, columns: { id: true } });
    // Their most recent lead, preferring one still open, so the email shows on the lead's history too.
    const lead = await db.query.leads.findFirst({
      where: and(isNull(leads.archivedAt), or(sql`lower(${leads.email}) = ${address}`, contact ? eq(leads.contactId, contact.id) : sql`false`)),
      orderBy: [sql`case when ${leads.status} in ('won','lost') then 1 else 0 end`, desc(leads.updatedAt)],
      columns: { id: true, contactId: true },
    });
    if (!contact && !lead) continue;
    const contactId = contact?.id ?? lead?.contactId ?? null;
    const openJob = contactId
      ? await db.query.jobs.findFirst({
          where: and(eq(jobs.contactId, contactId), inArray(jobs.status, OPEN_JOB_STATUSES)),
          orderBy: [desc(jobs.updatedAt)],
          columns: { id: true },
        })
      : null;
    await db.transaction(async (tx) => {
      await tx
        .update(emailThreads)
        .set({ leadId: lead?.id ?? null, contactId, jobId: openJob?.id ?? null, updatedAt: new Date() })
        .where(eq(emailThreads.id, thread.id));
      await tx.update(emails).set({ leadId: lead?.id ?? null, contactId }).where(eq(emails.threadId, thread.id));
      if (lead) await touchLead(tx, lead.id, email.receivedAt);
    });
    return { leadId: lead?.id ?? null, contactId, detail: `matched recipient ${address}` };
  }
  return { leadId: null, contactId: null, detail: "no matching customer or lead" };
}
