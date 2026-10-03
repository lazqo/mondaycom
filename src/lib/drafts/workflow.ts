/**
 * Email drafts prepared for a customer: by a person, by the Business Brain, or later by Hermes.
 *
 *   draft → ready_for_review → approved (Chris) → sent
 *                            ↘ revision_requested / rejected
 *
 * Creating or editing a draft is not contact with the customer: it never changes the lead's
 * status. Only an approver can approve or send. A draft edited after approval loses the approval.
 * Chris can send an approved draft from the CRM, or place it in the mailbox's Drafts folder and send
 * it from Titan; either way, when the sent message is seen, the draft is marked sent.
 */
import { createHash, randomUUID } from "node:crypto";
import MailComposer from "nodemailer/lib/mail-composer";
import { and, desc, eq, inArray, lte } from "drizzle-orm";
import { db } from "@/db";
import { drafts, emailThreads, emails, leads, mailboxes, type Draft } from "@/db/schema";
import { logActivity } from "@/lib/activity";
import { type Actor, GuardrailError, actorLabel, assertAgentMay, assertApprover } from "@/lib/guard/actor";
import { connectionFromMailbox, createImapClient } from "@/lib/email/imap";
import { normalizeSubject } from "@/lib/email/parse";
import { sendReply } from "@/lib/email/smtp";
import { attachmentForDraft } from "@/lib/proposals/workflow";

export const DRAFT_HEADER = "X-GetSecure-CRM-Draft";

export class DraftError extends Error {}

const actorId = (a: Actor) => (a.kind === "human" ? a.userId : null);

export function draftFingerprint(d: Pick<Draft, "toAddresses" | "ccAddresses" | "subject" | "body"> & { quoteDocumentId?: string | null }): string {
  const content: Record<string, unknown> = { to: d.toAddresses.map((a) => a.toLowerCase()), cc: d.ccAddresses.map((a) => a.toLowerCase()), subject: d.subject, body: d.body };
  // The attached proposal is part of what Chris approves (only present when there is one, so
  // approvals made before attachments existed still match).
  if (d.quoteDocumentId) content.attachment = d.quoteDocumentId;
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

async function load(id: string) {
  const d = await db.query.drafts.findFirst({ where: eq(drafts.id, id) });
  if (!d) throw new DraftError("Draft not found");
  return d;
}

export type NewDraft = {
  kind?: "email" | "follow_up" | "booking";
  leadId?: string | null;
  contactId?: string | null;
  threadId?: string | null;
  assessmentId?: string | null;
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
};

/**
 * Save a draft. One prepared by an agent or the system goes straight to the review queue; one a
 * person writes stays a draft until they submit it. Nothing on the lead changes.
 */
export async function createDraft(input: NewDraft, actor: Actor, opts: { submit?: boolean } = {}): Promise<Draft> {
  assertAgentMay(actor, "create_email_draft");
  const status = actor.kind === "human" && !opts.submit ? "draft" : "ready_for_review";
  const [row] = await db
    .insert(drafts)
    .values({
      kind: input.kind ?? "email",
      status,
      leadId: input.leadId ?? null,
      contactId: input.contactId ?? null,
      threadId: input.threadId ?? null,
      assessmentId: input.assessmentId ?? null,
      toAddresses: input.to,
      ccAddresses: input.cc ?? [],
      subject: input.subject,
      body: input.body,
      createdByActor: actorLabel(actor),
      createdById: actorId(actor),
    })
    .returning();
  if (input.leadId) await logActivity({ entity: "lead", entityId: input.leadId, actorId: actorId(actor), action: "draft_created", detail: { draftId: row.id, subject: row.subject, by: actorLabel(actor) } });
  return row;
}

/** Edit a draft's content. Editing an approved draft voids the approval. */
export async function updateDraft(id: string, patch: { to?: string[]; cc?: string[]; subject?: string; body?: string }, actor: Actor): Promise<Draft> {
  assertAgentMay(actor, "create_email_draft");
  const d = await load(id);
  if (["sent", "rejected", "cancelled"].includes(d.status)) throw new DraftError(`A ${d.status} draft cannot be edited.`);
  if (actor.kind !== "human" && d.status === "approved") throw new GuardrailError("An approved draft can only be changed by a person.");
  const next = { toAddresses: patch.to ?? d.toAddresses, ccAddresses: patch.cc ?? d.ccAddresses, subject: patch.subject ?? d.subject, body: patch.body ?? d.body, quoteDocumentId: d.quoteDocumentId };
  const changed = draftFingerprint(next) !== draftFingerprint(d);
  const voids = d.status === "approved" && changed;
  const status = voids || (actor.kind !== "human" && d.status === "revision_requested") ? "ready_for_review" : d.status;
  const [row] = await db
    .update(drafts)
    .set({ ...next, status, updatedAt: new Date(), ...(voids ? { approvedById: null, approvedAt: null, approvalHash: null } : {}) })
    .where(eq(drafts.id, id))
    .returning();
  return row;
}

export async function submitDraft(id: string, actor: Actor): Promise<void> {
  const d = await load(id);
  if (!["draft", "revision_requested"].includes(d.status)) throw new DraftError("Only a draft can be submitted for review.");
  await db.update(drafts).set({ status: "ready_for_review", updatedAt: new Date() }).where(eq(drafts.id, id));
  void actor;
}

export async function approveDraft(id: string, actor: Actor): Promise<void> {
  assertApprover(actor);
  const d = await load(id);
  if (!["draft", "ready_for_review"].includes(d.status)) throw new DraftError(`A draft that is ${d.status.replace(/_/g, " ")} cannot be approved.`);
  if (!d.toAddresses.length) throw new DraftError("The draft has no recipient.");
  if (d.quoteDocumentId) await attachmentForDraft(d.quoteDocumentId); // refuses a proposal that is no longer valid
  await db.update(drafts).set({ status: "approved", approvedById: actor.userId, approvedAt: new Date(), approvalHash: draftFingerprint(d), updatedAt: new Date() }).where(eq(drafts.id, id));
}

export async function requestRevision(id: string, actor: Actor, note: string | null): Promise<void> {
  assertApprover(actor);
  const d = await load(id);
  if (["sent", "rejected", "cancelled"].includes(d.status)) throw new DraftError(`A ${d.status} draft cannot be revised.`);
  await db.update(drafts).set({ status: "revision_requested", reviewNote: note, approvedById: null, approvedAt: null, approvalHash: null, updatedAt: new Date() }).where(eq(drafts.id, id));
}

export async function rejectDraft(id: string, actor: Actor, note: string | null): Promise<void> {
  assertApprover(actor);
  const d = await load(id);
  if (d.status === "sent") throw new DraftError("A sent draft cannot be rejected.");
  await db.update(drafts).set({ status: "rejected", reviewNote: note, updatedAt: new Date() }).where(eq(drafts.id, id));
}

async function mailboxFor(d: Draft) {
  if (d.threadId) {
    const t = await db.query.emailThreads.findFirst({ where: eq(emailThreads.id, d.threadId), columns: { mailboxId: true } });
    if (t) return db.query.mailboxes.findFirst({ where: eq(mailboxes.id, t.mailboxId) });
  }
  return db.query.mailboxes.findFirst({ where: eq(mailboxes.active, true) });
}

/** Chris sends an approved draft from the CRM. Refused for anyone else, and if it changed since approval. */
export async function sendDraft(id: string, actor: Actor): Promise<{ emailId: string }> {
  assertApprover(actor);
  const d = await load(id);
  if (d.status !== "approved") throw new GuardrailError("Only an approved draft can be sent.");
  if (draftFingerprint(d) !== d.approvalHash) throw new GuardrailError("The draft changed after it was approved. Approve it again first.");
  // The proposal goes only while it is still the valid PDF for the approved quote.
  const attachment = d.quoteDocumentId ? await attachmentForDraft(d.quoteDocumentId) : null;
  const mailbox = await mailboxFor(d);
  if (!mailbox) throw new DraftError("No mailbox is connected to send from.");
  const replyTo = d.threadId
    ? await db.query.emails.findFirst({ where: and(eq(emails.threadId, d.threadId), eq(emails.direction, "inbound")), orderBy: [desc(emails.receivedAt)], columns: { id: true } })
    : null;
  const res = await sendReply({
    attachments: attachment ? [attachment] : undefined,
    mailboxId: mailbox.id,
    threadId: d.threadId,
    inReplyToEmailId: replyTo?.id ?? null,
    to: d.toAddresses,
    cc: d.ccAddresses,
    subject: d.subject,
    text: d.body,
    actor,
    fromName: actor.name,
    headers: { [DRAFT_HEADER]: d.id },
  });
  await markDraftSent(d.id, res.emailId);
  return res;
}

/** Record that a draft went out, and tie the conversation to the lead. */
export async function markDraftSent(id: string, emailId: string): Promise<void> {
  const d = await load(id);
  if (d.status === "sent") return;
  const email = await db.query.emails.findFirst({ where: eq(emails.id, emailId), columns: { threadId: true, receivedAt: true } });
  await db.update(drafts).set({ status: "sent", sentEmailId: emailId, sentAt: email?.receivedAt ?? new Date(), updatedAt: new Date() }).where(eq(drafts.id, id));
  if (email && d.leadId) {
    const lead = await db.query.leads.findFirst({ where: eq(leads.id, d.leadId), columns: { contactId: true } });
    await db.update(emailThreads).set({ leadId: d.leadId, contactId: lead?.contactId ?? null, updatedAt: new Date() }).where(and(eq(emailThreads.id, email.threadId)));
    await db.update(emails).set({ leadId: d.leadId, contactId: lead?.contactId ?? null }).where(eq(emails.id, emailId));
  }
}

/**
 * Place a draft in the mailbox's Drafts folder, so Chris can review and send it from Titan webmail
 * or his phone. This is not sending: the message only leaves when he presses Send there.
 */
export async function placeInMailboxDrafts(id: string, actor: Actor): Promise<{ messageId: string; folder: string }> {
  if (actor.kind !== "human") throw new GuardrailError("Only a person can place a draft in the mailbox.");
  const d = await load(id);
  if (!["ready_for_review", "approved"].includes(d.status)) throw new DraftError("Submit the draft for review first.");
  const attachment = d.quoteDocumentId ? await attachmentForDraft(d.quoteDocumentId) : null;
  const mailbox = await mailboxFor(d);
  if (!mailbox) throw new DraftError("No mailbox is connected.");
  const domain = mailbox.emailAddress.split("@")[1] ?? "get-secure-crm";
  const messageId = `<draft-${d.id}-${randomUUID().slice(0, 8)}@${domain}>`;
  const replyTo = d.threadId
    ? await db.query.emails.findFirst({ where: and(eq(emails.threadId, d.threadId), eq(emails.direction, "inbound")), orderBy: [desc(emails.receivedAt)], columns: { messageId: true, references: true } })
    : null;
  const raw = await new MailComposer({
    from: { name: actor.name, address: mailbox.emailAddress },
    to: d.toAddresses,
    cc: d.ccAddresses.length ? d.ccAddresses : undefined,
    subject: d.subject,
    text: d.body,
    messageId,
    inReplyTo: replyTo?.messageId,
    references: replyTo ? [...replyTo.references, replyTo.messageId] : undefined,
    headers: { [DRAFT_HEADER]: d.id },
    attachments: attachment ? [attachment] : undefined,
  })
    .compile()
    .build();
  const client = createImapClient(connectionFromMailbox(mailbox));
  try {
    await client.connect();
    const boxes = await client.list();
    const folder = boxes.find((b) => b.specialUse === "\\Drafts") ?? boxes.find((b) => /^drafts?$/i.test(b.name));
    if (!folder) throw new DraftError("The mailbox has no Drafts folder.");
    await client.append(folder.path, raw, ["\\Draft", "\\Seen"]);
    await db.update(drafts).set({ mailboxDraftMessageId: messageId, updatedAt: new Date() }).where(eq(drafts.id, d.id));
    return { messageId, folder: folder.path };
  } finally {
    await client.logout().catch(() => client.close());
  }
}

/**
 * Called for every message found in the Sent folder: if it is one of our drafts going out (sent from
 * Titan), mark the draft sent. Matches on the draft header or Message-ID first, then on recipient
 * and subject for a draft that was waiting.
 */
export async function matchSentEmailToDraft(emailId: string): Promise<string | null> {
  const e = await db.query.emails.findFirst({ where: eq(emails.id, emailId), columns: { id: true, messageId: true, headers: true, to: true, subject: true, receivedAt: true, direction: true } });
  if (!e || e.direction !== "outbound") return null;
  const tagged = e.headers[DRAFT_HEADER.toLowerCase()]?.trim();
  let draft = tagged && /^[0-9a-f-]{36}$/i.test(tagged) ? await db.query.drafts.findFirst({ where: eq(drafts.id, tagged) }) : undefined;
  if (!draft) draft = await db.query.drafts.findFirst({ where: eq(drafts.mailboxDraftMessageId, e.messageId) });
  if (!draft) {
    const first = e.to[0]?.address?.toLowerCase();
    if (first) {
      const waiting = await db.query.drafts.findMany({
        where: and(inArray(drafts.status, ["approved", "ready_for_review"]), lte(drafts.createdAt, e.receivedAt)),
        orderBy: [desc(drafts.updatedAt)],
      });
      draft = waiting.find((d) => d.toAddresses.some((a) => a.toLowerCase() === first) && normalizeSubject(d.subject) === normalizeSubject(e.subject));
    }
  }
  if (!draft || draft.status === "sent") return null;
  await markDraftSent(draft.id, e.id);
  return draft.id;
}
