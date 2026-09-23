import { and, asc, desc, eq, inArray, isNull, max, ne, notInArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { contacts, emailClassifications, emailThreads, emails, jobs, leads, type ExtractedLead } from "@/db/schema";
import { env } from "@/lib/env";
import { OPEN_JOB_STATUSES } from "@/lib/constants";
import { logActivity } from "@/lib/activity";
import { getClassifier, type ClassificationInput } from "@/lib/ai";
import { isAutomatedMail, stripQuotedReply } from "./parse";
import { isWebsiteLeadSender, parseWebsiteLead } from "./website-lead";


export type ProcessOutcome = {
  emailId: string;
  classification: "lead" | "needs_review" | "not_lead" | "existing" | "outbound" | "error";
  leadId: string | null;
  contactId: string | null;
  detail: string;
};

/** Classify one stored email and create/link the lead. Safe to re-run: an already classified email is skipped unless `force`. */
export async function processEmail(emailId: string, opts: { force?: boolean } = {}): Promise<ProcessOutcome> {
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
      await recordClassification(emailId, {
        provider: "website-form",
        model: null,
        isLead: true,
        confidence: 1,
        result: website.extraction,
        durationMs: 0,
      });
      const leadId = await createLeadFromEmail(emailId, {
        actorId: null,
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
      await recordClassification(emailId, {
        provider: "prefilter",
        model: null,
        isLead: false,
        confidence: 1,
        result: emptyExtraction(email, `Automated message (${automated}).`),
        durationMs: 0,
      });
      await db
        .update(emails)
        .set({ classification: "not_lead", contactId: contact?.id ?? null, classifiedAt: new Date() })
        .where(eq(emails.id, emailId));
      return { emailId, classification: "not_lead", leadId: null, contactId: contact?.id ?? null, detail: automated };
    }

    // E. Ask the classifier.
    const prior = await db.query.emails.findMany({
      where: and(eq(emails.threadId, thread.id), ne(emails.id, emailId)),
      orderBy: [asc(emails.receivedAt)],
      columns: { fromAddress: true, fromName: true, receivedAt: true, textBody: true },
      limit: 5,
    });
    const input: ClassificationInput = {
      from: { name: email.fromName, address: email.fromAddress },
      to: email.to.map((t) => t.address),
      subject: email.subject,
      receivedAt: email.receivedAt.toISOString(),
      text: stripQuotedReply(email.textBody ?? "") || (email.textBody ?? ""),
      attachments: email.attachments,
      priorMessages: prior.map((p) => ({
        from: p.fromName ? `${p.fromName} <${p.fromAddress}>` : p.fromAddress,
        date: p.receivedAt.toISOString(),
        text: stripQuotedReply(p.textBody ?? ""),
      })),
      knownContact: contact ? { name: contact.name, company: contact.company } : null,
    };
    const classifier = getClassifier();
    const out = await classifier.classify(input);
    const r = out.result;
    await recordClassification(emailId, {
      provider: out.provider,
      model: out.model,
      isLead: r.is_lead,
      confidence: r.confidence,
      result: r,
      raw: out.raw,
      usage: out.usage,
      durationMs: out.durationMs,
    });

    const threshold = env.AI_LEAD_CONFIDENCE_THRESHOLD;
    if (r.is_lead && r.confidence >= threshold) {
      const leadId = await createLeadFromEmail(emailId, { actorId: null, contactId: contact?.id ?? null, jobId: openJob?.id ?? null });
      return { emailId, classification: "lead", leadId, contactId: contact?.id ?? null, detail: `auto-created (confidence ${r.confidence.toFixed(2)})` };
    }
    if (!r.is_lead && r.confidence >= threshold) {
      await db
        .update(emails)
        .set({ classification: "not_lead", contactId: contact?.id ?? null, classifiedAt: new Date() })
        .where(eq(emails.id, emailId));
      if (contact) await db.update(emailThreads).set({ contactId: contact.id }).where(eq(emailThreads.id, thread.id));
      return { emailId, classification: "not_lead", leadId: null, contactId: contact?.id ?? null, detail: r.reason };
    }
    await db
      .update(emails)
      .set({ classification: "needs_review", contactId: contact?.id ?? null, classifiedAt: new Date() })
      .where(eq(emails.id, emailId));
    return { emailId, classification: "needs_review", leadId: null, contactId: contact?.id ?? null, detail: `confidence ${r.confidence.toFixed(2)} below ${threshold}` };
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
    is_lead: false,
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

async function recordClassification(
  emailId: string,
  c: { provider: string; model: string | null; isLead: boolean; confidence: number; result: ExtractedLead; raw?: unknown; usage?: { inputTokens?: number; outputTokens?: number }; durationMs: number },
) {
  await db.insert(emailClassifications).values({
    emailId,
    provider: c.provider,
    model: c.model,
    isLead: c.isLead,
    confidence: Math.max(0, Math.min(1, c.confidence)).toFixed(3),
    result: c.result,
    rawResponse: (c.raw ?? null) as Record<string, unknown> | null,
    inputTokens: c.usage?.inputTokens ?? null,
    outputTokens: c.usage?.outputTokens ?? null,
    durationMs: Math.round(c.durationMs),
  });
}

/** Latest classification for an email (the AI's suggestion), if any. */
export async function latestClassification(emailId: string) {
  return db.query.emailClassifications.findFirst({
    where: eq(emailClassifications.emailId, emailId),
    orderBy: [desc(emailClassifications.createdAt)],
  });
}

/**
 * Create a Lead from an email using the stored extraction (optionally overridden by a reviewer),
 * link the thread and email to it, and mark the email as a lead.
 */
export async function createLeadFromEmail(
  emailId: string,
  opts: { actorId: string | null; overrides?: Partial<ExtractedLead>; contactId?: string | null; jobId?: string | null; assignedToId?: string | null },
): Promise<string> {
  const email = await db.query.emails.findFirst({ where: eq(emails.id, emailId), with: { thread: true } });
  if (!email) throw new Error("Email not found");
  const latest = await latestClassification(emailId);
  const x: ExtractedLead = { ...(latest?.result ?? emptyExtraction(email, "manual")), ...(opts.overrides ?? {}) };
  const contactId = opts.contactId ?? email.contactId ?? null;

  const leadId = await db.transaction(async (tx) => {
    const [{ maxPos }] = await tx.select({ maxPos: max(leads.position) }).from(leads);
    const [row] = await tx
      .insert(leads)
      .values({
        name: x.contact_name?.trim() || email.fromName || email.fromAddress,
        company: x.company,
        phone: x.phone,
        email: x.email ?? email.fromAddress,
        service: x.service,
        site: x.site_address,
        status: "new",
        source: "email",
        summary: x.summary,
        urgency: x.urgency,
        nextAction: x.next_action,
        aiConfidence: latest ? Number(latest.confidence).toFixed(3) : null,
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
    if (latest && opts.actorId) {
      await tx
        .update(emailClassifications)
        .set({ reviewedById: opts.actorId, reviewedAt: new Date(), reviewOutcome: opts.overrides && Object.keys(opts.overrides).length ? "edited" : "accepted" })
        .where(eq(emailClassifications.id, latest.id));
    }
    await logActivity({
      entity: "lead",
      entityId: row.id,
      actorId: opts.actorId,
      action: opts.actorId ? "created_from_email" : "auto_created_from_email",
      detail: { emailId, subject: email.subject, confidence: latest?.confidence ?? null, provider: latest?.provider ?? null },
    });
    return row.id;
  });
  return leadId;
}

export async function markEmailNotLead(emailId: string, actorId: string) {
  const latest = await latestClassification(emailId);
  await db.transaction(async (tx) => {
    await tx.update(emails).set({ classification: "not_lead", classifiedAt: new Date(), classificationError: null }).where(eq(emails.id, emailId));
    if (latest) await tx.update(emailClassifications).set({ reviewedById: actorId, reviewedAt: new Date(), reviewOutcome: "rejected" }).where(eq(emailClassifications.id, latest.id));
  });
}

/** Link a whole thread (and its inbound emails) to an existing lead, customer and/or job. */
export async function linkThread(threadId: string, target: { leadId?: string | null; contactId?: string | null; jobId?: string | null }, actorId: string) {
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
