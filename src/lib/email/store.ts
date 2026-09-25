import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { db } from "@/db";
import { emailAttachments, emailThreads, emails } from "@/db/schema";
import { makeSnippet, normalizeSubject, parseRawEmail, type ParsedEmail } from "./parse";
import { isWebsiteLeadSender } from "./website-lead";

export type IngestResult = { emailId: string; threadId: string; created: boolean; parsed: ParsedEmail };

const THREAD_BY_SUBJECT_WINDOW_DAYS = 30;

/**
 * Header the CRM puts on every message it sends. Some servers give a message a new Message-ID when
 * they file the sent copy; this header survives that, so the copy in Sent is still recognised.
 */
export const CRM_MESSAGE_HEADER = "X-GetSecure-CRM-Message";

/** How close in time a Sent-folder copy must be to a CRM-sent message to be the same message. */
const SENT_COPY_WINDOW_MS = 15 * 60_000;

/**
 * Is this message from the Sent folder a copy of one the CRM already sent and stored? Message-ID is
 * checked first by the caller; this catches the copy a server re-stamped with a new one.
 */
async function findCrmSentCopy(mailboxId: string, parsed: ParsedEmail): Promise<{ id: string; threadId: string } | null> {
  const tagged = parsed.headers[CRM_MESSAGE_HEADER.toLowerCase()]?.trim();
  if (tagged) {
    const byTag = await db.query.emails.findFirst({
      where: and(eq(emails.mailboxId, mailboxId), eq(emails.messageId, tagged)),
      columns: { id: true, threadId: true },
    });
    if (byTag) return byTag;
  }
  const firstTo = parsed.to[0]?.address;
  if (!firstTo) return null;
  const candidates = await db.query.emails.findMany({
    where: and(
      eq(emails.mailboxId, mailboxId),
      eq(emails.direction, "outbound"),
      eq(emails.origin, "crm"),
      gte(emails.receivedAt, new Date(parsed.date.getTime() - SENT_COPY_WINDOW_MS)),
      lte(emails.receivedAt, new Date(parsed.date.getTime() + SENT_COPY_WINDOW_MS)),
    ),
    columns: { id: true, threadId: true, subject: true, to: true, textBody: true },
  });
  const body = (t: string | null) => (t ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  return (
    candidates.find(
      (c) =>
        normalizeSubject(c.subject) === normalizeSubject(parsed.subject) &&
        c.to[0]?.address?.toLowerCase() === firstTo.toLowerCase() &&
        body(c.textBody) === body(parsed.text),
    ) ?? null
  );
}

/**
 * Store one raw RFC822 message for a mailbox: parse, dedupe on Message-ID, attach to the right
 * thread (References / In-Reply-To first, then subject + counterpart within 30 days), save
 * attachments. Idempotent: re-ingesting the same message returns the existing row.
 */
export async function ingestRawMessage(opts: {
  mailboxId: string;
  raw: Buffer | string;
  imapUid?: number | null;
  direction?: "inbound" | "outbound";
  sentById?: string | null;
  mailboxAddress?: string;
  origin?: "inbox" | "sent_folder" | "crm";
}): Promise<IngestResult> {
  const parsed = await parseRawEmail(opts.raw);
  const direction = opts.direction ?? "inbound";
  const origin = opts.origin ?? (direction === "outbound" ? "crm" : "inbox");

  const existing = await db.query.emails.findFirst({
    where: and(eq(emails.mailboxId, opts.mailboxId), eq(emails.messageId, parsed.messageId)),
    columns: { id: true, threadId: true },
  });
  if (existing) return { emailId: existing.id, threadId: existing.threadId, created: false, parsed };
  if (origin === "sent_folder") {
    const copy = await findCrmSentCopy(opts.mailboxId, parsed);
    if (copy) return { emailId: copy.id, threadId: copy.threadId, created: false, parsed };
  }

  // The other party: the sender of inbound mail, the first outside recipient of outbound mail.
  const own = opts.mailboxAddress?.toLowerCase();
  const recipients = [...parsed.to, ...parsed.cc].map((a) => a.address).filter((a) => a && a.toLowerCase() !== own);
  const counterpart = direction === "inbound" ? parsed.from.address : (recipients[0] ?? parsed.to[0]?.address ?? null);
  const normalized = normalizeSubject(parsed.subject);
  const rawText = typeof opts.raw === "string" ? opts.raw : opts.raw.toString("utf8");

  const result = await db.transaction(async (tx) => {
    // 1. Thread by message references.
    let threadId: string | null = null;
    const refs = [parsed.inReplyTo, ...parsed.references].filter((r): r is string => !!r);
    if (refs.length) {
      const parent = await tx.query.emails.findFirst({
        where: and(eq(emails.mailboxId, opts.mailboxId), inArray(emails.messageId, refs)),
        columns: { threadId: true },
        orderBy: [desc(emails.receivedAt)],
      });
      threadId = parent?.threadId ?? null;
    }
    // 2. Thread by normalised subject + counterpart within the window.
    //
    // Never for the website's sending robot: every enquiry comes from that one address, often with
    // the same subject ("New Lead · Home Page"), so this would merge different customers'
    // enquiries into one conversation and the newest lead would take over the older emails.
    if (!threadId && normalized && counterpart && !isWebsiteLeadSender(counterpart)) {
      const since = new Date(parsed.date.getTime() - THREAD_BY_SUBJECT_WINDOW_DAYS * 86400000);
      const t = await tx.query.emailThreads.findFirst({
        where: and(
          eq(emailThreads.mailboxId, opts.mailboxId),
          eq(emailThreads.normalizedSubject, normalized),
          eq(emailThreads.counterpartAddress, counterpart),
          gte(emailThreads.lastMessageAt, since),
        ),
        columns: { id: true },
        orderBy: [desc(emailThreads.lastMessageAt)],
      });
      threadId = t?.id ?? null;
    }
    // 3. New thread.
    if (!threadId) {
      const [t] = await tx
        .insert(emailThreads)
        .values({
          mailboxId: opts.mailboxId,
          subject: parsed.subject,
          normalizedSubject: normalized,
          counterpartAddress: counterpart,
          firstMessageAt: parsed.date,
          lastMessageAt: parsed.date,
          messageCount: 0,
        })
        .returning({ id: emailThreads.id });
      threadId = t.id;
    }

    const [row] = await tx
      .insert(emails)
      .values({
        mailboxId: opts.mailboxId,
        threadId,
        direction,
        messageId: parsed.messageId,
        inReplyTo: parsed.inReplyTo,
        references: parsed.references,
        imapUid: opts.imapUid ?? null,
        fromName: parsed.from.name,
        fromAddress: parsed.from.address,
        to: parsed.to,
        cc: parsed.cc,
        subject: parsed.subject,
        textBody: parsed.text,
        htmlBody: parsed.html,
        snippet: makeSnippet(parsed.text),
        rawMime: rawText,
        headers: parsed.headers,
        hasAttachments: parsed.attachments.length > 0,
        receivedAt: parsed.date,
        classification: direction === "outbound" ? "outbound" : "pending",
        sentById: opts.sentById ?? null,
        origin,
      })
      .returning({ id: emails.id });

    if (parsed.attachments.length) {
      await tx.insert(emailAttachments).values(
        parsed.attachments.map((a) => ({
          emailId: row.id,
          filename: a.filename,
          contentType: a.contentType,
          size: a.size,
          contentId: a.contentId,
          content: a.content,
        })),
      );
    }

    const thread = await tx.query.emailThreads.findFirst({ where: eq(emailThreads.id, threadId) });
    await tx
      .update(emailThreads)
      .set({
        messageCount: (thread?.messageCount ?? 0) + 1,
        lastMessageAt: thread && thread.lastMessageAt > parsed.date ? thread.lastMessageAt : parsed.date,
        firstMessageAt: thread && thread.firstMessageAt < parsed.date ? thread.firstMessageAt : parsed.date,
        subject: thread?.subject || parsed.subject,
        updatedAt: new Date(),
      })
      .where(eq(emailThreads.id, threadId));

    return { emailId: row.id, threadId };
  });

  return { ...result, created: true, parsed };
}
