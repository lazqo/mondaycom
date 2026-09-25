import { randomUUID } from "node:crypto";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { emails, mailboxes, type Mailbox } from "@/db/schema";
import { connectionFromMailbox, createImapClient, type MailboxConnection } from "./imap";
import { CRM_MESSAGE_HEADER, ingestRawMessage } from "./store";

export function createSmtpTransport(c: MailboxConnection) {
  return nodemailer.createTransport({
    host: c.smtpHost,
    port: c.smtpPort,
    secure: c.smtpSecure,
    auth: { user: c.username, pass: c.password },
    tls: { rejectUnauthorized: process.env.SMTP_TLS_REJECT_UNAUTHORIZED !== "false" },
  });
}

export async function testSmtpConnection(c: MailboxConnection): Promise<void> {
  await createSmtpTransport(c).verify();
}

export type SendReplyInput = {
  mailboxId: string;
  threadId: string;
  inReplyToEmailId?: string | null;
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  sentById: string;
  fromName?: string | null;
};

/**
 * Send a reply through the mailbox's SMTP server, store the exact message we sent as an
 * outbound email on the same thread, and (best effort) copy it to the IMAP Sent folder so
 * the mailbox's own webmail shows it too.
 */
export async function sendReply(input: SendReplyInput): Promise<{ emailId: string; messageId: string }> {
  const mailbox = await db.query.mailboxes.findFirst({ where: eq(mailboxes.id, input.mailboxId) });
  if (!mailbox) throw new Error("Mailbox not found");
  const conn = connectionFromMailbox(mailbox);

  const parent = input.inReplyToEmailId ? await db.query.emails.findFirst({ where: eq(emails.id, input.inReplyToEmailId) }) : null;
  const references = parent ? [...parent.references, parent.messageId].filter(Boolean) : [];
  const domain = mailbox.emailAddress.split("@")[1] ?? "get-secure-crm";
  const messageId = `<${randomUUID()}@${domain}>`;

  const composer = new MailComposer({
    from: input.fromName ? { name: input.fromName, address: mailbox.emailAddress } : mailbox.emailAddress,
    to: input.to,
    cc: input.cc?.length ? input.cc : undefined,
    subject: input.subject,
    text: input.text,
    messageId,
    inReplyTo: parent?.messageId,
    references: references.length ? references : undefined,
    date: new Date(),
    headers: { [CRM_MESSAGE_HEADER]: messageId },
  });
  const raw = await composer.compile().build();

  const transport = createSmtpTransport(conn);
  await transport.sendMail({
    envelope: { from: mailbox.emailAddress, to: [...input.to, ...(input.cc ?? [])] },
    raw,
  });

  const stored = await ingestRawMessage({
    mailboxId: mailbox.id,
    raw,
    direction: "outbound",
    origin: "crm",
    sentById: input.sentById,
    mailboxAddress: mailbox.emailAddress,
  });
  // Outbound replies always belong to the thread they were written from.
  if (stored.threadId !== input.threadId) {
    await db.update(emails).set({ threadId: input.threadId }).where(eq(emails.id, stored.emailId));
  }

  await appendToSent(mailbox, conn, raw).catch(() => {});
  return { emailId: stored.emailId, messageId };
}

async function appendToSent(mailbox: Mailbox, conn: MailboxConnection, raw: Buffer) {
  const client = createImapClient(conn);
  try {
    await client.connect();
    const boxes = await client.list();
    const sent = boxes.find((b) => b.specialUse === "\\Sent") ?? boxes.find((b) => /^sent/i.test(b.name));
    if (sent) await client.append(sent.path, raw, ["\\Seen"]);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

/** Plain internal email (staff notifications) from the first active mailbox. Never used for customers. */
export async function sendInternalEmail(input: { to: string; subject: string; text: string }): Promise<void> {
  const mailbox = await db.query.mailboxes.findFirst({ where: eq(mailboxes.active, true) });
  if (!mailbox) throw new Error("No active mailbox to send from");
  const conn = connectionFromMailbox(mailbox);
  await createSmtpTransport(conn).sendMail({
    from: { name: "Get Secure CRM", address: mailbox.emailAddress },
    to: input.to,
    subject: input.subject,
    text: input.text,
  });
}
