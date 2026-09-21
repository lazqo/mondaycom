import "server-only";
import { and, asc, count, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { emailClassifications, emailThreads, emails, mailboxes } from "@/db/schema";
import type { EmailClassification } from "@/lib/constants";

export type InboxFilter = "all" | "needs_review" | "lead" | "not_lead" | "existing" | "error";

export async function listInbox(opts: { filter: InboxFilter; q?: string; limit?: number }) {
  const conds: SQL[] = [eq(emails.direction, "inbound")];
  if (opts.filter !== "all") conds.push(eq(emails.classification, opts.filter as EmailClassification));
  if (opts.q?.trim()) {
    const term = `%${opts.q.trim()}%`;
    conds.push(
      or(
        ilike(emails.subject, term),
        ilike(emails.fromAddress, term),
        ilike(emails.fromName, term),
        ilike(emails.textBody, term),
      )!,
    );
  }
  return db.query.emails.findMany({
    where: and(...conds),
    with: {
      lead: { columns: { id: true, name: true, status: true } },
      contact: { columns: { id: true, name: true } },
      thread: { columns: { id: true, messageCount: true, leadId: true, contactId: true, jobId: true } },
      mailbox: { columns: { id: true, emailAddress: true } },
    },
    orderBy: [desc(emails.receivedAt)],
    limit: opts.limit ?? 200,
  });
}
export type InboxRow = Awaited<ReturnType<typeof listInbox>>[number];

export async function inboxCounts() {
  const rows = await db
    .select({ classification: emails.classification, n: count() })
    .from(emails)
    .where(eq(emails.direction, "inbound"))
    .groupBy(emails.classification);
  const out: Record<string, number> = {};
  for (const r of rows) out[r.classification] = Number(r.n);
  return out;
}

export async function needsReviewCount() {
  const [{ n }] = await db
    .select({ n: count() })
    .from(emails)
    .where(and(eq(emails.direction, "inbound"), inArray(emails.classification, ["needs_review", "error"])));
  return Number(n);
}

export async function getThread(threadId: string) {
  const thread = await db.query.emailThreads.findFirst({
    where: eq(emailThreads.id, threadId),
    with: {
      mailbox: { columns: { id: true, emailAddress: true, name: true } },
      lead: { columns: { id: true, name: true, status: true } },
      contact: { columns: { id: true, name: true, company: true } },
      job: { columns: { id: true, number: true, title: true, status: true } },
      emails: {
        orderBy: [asc(emails.receivedAt)],
        with: {
          attachments: { columns: { id: true, filename: true, contentType: true, size: true } },
          sentBy: { columns: { id: true, name: true } },
          classifications: { orderBy: [desc(emailClassifications.createdAt)], limit: 1 },
        },
        columns: { rawMime: false },
      },
    },
  });
  return thread;
}
export type ThreadDetail = NonNullable<Awaited<ReturnType<typeof getThread>>>;

export async function getThreadForLead(leadId: string) {
  return db.query.emailThreads.findFirst({
    where: eq(emailThreads.leadId, leadId),
    with: {
      emails: {
        orderBy: [asc(emails.receivedAt)],
        columns: { id: true, direction: true, fromName: true, fromAddress: true, subject: true, snippet: true, textBody: true, receivedAt: true, hasAttachments: true },
      },
    },
    orderBy: [desc(emailThreads.lastMessageAt)],
  });
}

export async function listMailboxes() {
  return db.query.mailboxes.findMany({
    columns: { passwordEncrypted: false },
    orderBy: [asc(mailboxes.createdAt)],
  });
}
export type MailboxRow = Awaited<ReturnType<typeof listMailboxes>>[number];

export async function getAttachment(id: string) {
  return db.query.emailAttachments.findFirst({ where: (a, { eq }) => eq(a.id, id) });
}

export async function mailboxStats() {
  const [row] = await db
    .select({ total: count(), latest: sql<Date | null>`max(${emails.receivedAt})` })
    .from(emails)
    .where(eq(emails.direction, "inbound"));
  return row;
}
