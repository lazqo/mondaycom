/**
 * Sent-folder sync against a real IMAP server (Dovecot, tests/support/dovecot/start.sh): mail sent
 * from webmail, a phone or Outlook is picked up from Sent and filed on the right conversation and
 * lead, and a message the CRM sent itself is never stored twice.
 * Run: pnpm test:integration   (skipped when Dovecot is not running)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { ImapFlow } from "imapflow";

process.env.AI_PROVIDER = "rules";
process.env.AI_LEAD_CONFIDENCE_THRESHOLD = "0.75";

const { db } = await import("@/db");
const { mailboxes, emails, emailThreads, leads, contacts, users } = await import("@/db/schema");
const { encryptSecret } = await import("@/lib/crypto");
const { syncMailboxOnce, testImapConnection } = await import("@/lib/email/imap");
const { sendReply } = await import("@/lib/email/smtp");
const { startSmtpSink } = await import("../support/smtp-sink");

const RUN = `ss${Date.now().toString(36)}`;
const IMAP_PORT = Number(process.env.DOVECOT_TEST_PORT ?? 1143);
const SMTP_PORT = 2526;
const IMAP_USER = "crm@test.local";
const IMAP_PASS = "crm-password";
const MAILBOX_ADDRESS = `chris+${RUN}@getsecure.test`;
const CUSTOMER = `kiri+${RUN}@example.com`;

const dovecotUp = await testImapConnection({ imapHost: "127.0.0.1", imapPort: IMAP_PORT, imapSecure: false, smtpHost: "127.0.0.1", smtpPort: SMTP_PORT, smtpSecure: false, username: IMAP_USER, password: IMAP_PASS, folder: "INBOX" }).then(
  () => true,
  () => false,
);

function imap() {
  return new ImapFlow({ host: "127.0.0.1", port: IMAP_PORT, secure: false, auth: { user: IMAP_USER, pass: IMAP_PASS }, logger: false });
}

/** Put a message straight into a folder, the way a phone or webmail files what it sends. */
async function append(folder: "INBOX" | "Sent", raw: string) {
  const c = imap();
  await c.connect();
  try {
    await c.append(folder, raw, folder === "Sent" ? ["\\Seen"] : []);
  } finally {
    await c.logout();
  }
}

function message(o: { from: string; to: string; subject: string; id: string; body: string; inReplyTo?: string; headers?: string[] }) {
  return [
    `From: ${o.from}`,
    `To: ${o.to}`,
    `Subject: ${o.subject}`,
    `Message-ID: ${o.id}`,
    `Date: ${new Date().toUTCString()}`,
    ...(o.inReplyTo ? [`In-Reply-To: ${o.inReplyTo}`, `References: ${o.inReplyTo}`] : []),
    ...(o.headers ?? []),
    "Content-Type: text/plain; charset=utf-8",
    "",
    o.body,
    "",
  ].join("\r\n");
}

let mailboxId: string;
let userId: string;
let contactId: string;

describe.skipIf(!dovecotUp)("syncing the Sent folder", () => {
  beforeAll(async () => {
    const [u] = await db.insert(users).values({ email: `staff-${RUN}@test.local`, name: "Sent Tester", passwordHash: "x", role: "member" }).returning({ id: users.id });
    userId = u.id;
    // Start both cursors at the current end of each folder, so only this file's messages are read.
    const c = imap();
    await c.connect();
    const inbox = await c.status("INBOX", { uidNext: true, uidValidity: true });
    const sent = await c.status("Sent", { uidNext: true, uidValidity: true });
    await c.logout();
    const [m] = await db
      .insert(mailboxes)
      .values({
        name: `Sent test ${RUN}`,
        emailAddress: MAILBOX_ADDRESS,
        imapHost: "127.0.0.1",
        imapPort: IMAP_PORT,
        imapSecure: false,
        smtpHost: "127.0.0.1",
        smtpPort: SMTP_PORT,
        smtpSecure: false,
        username: IMAP_USER,
        passwordEncrypted: encryptSecret(IMAP_PASS),
        uidValidity: String(inbox.uidValidity),
        lastUid: (inbox.uidNext ?? 1) - 1,
        sentUidValidity: String(sent.uidValidity),
        sentLastUid: (sent.uidNext ?? 1) - 1,
      })
      .returning({ id: mailboxes.id });
    mailboxId = m.id;
    const [contact] = await db.insert(contacts).values({ name: `Known Customer ${RUN}`, email: `known+${RUN}@example.com` }).returning({ id: contacts.id });
    contactId = contact.id;
  });

  afterAll(async () => {
    const threadIds = (await db.query.emailThreads.findMany({ where: eq(emailThreads.mailboxId, mailboxId), columns: { id: true, leadId: true } }));
    const leadIds = threadIds.map((t) => t.leadId).filter((x): x is string => !!x);
    await db.delete(mailboxes).where(eq(mailboxes.id, mailboxId));
    if (leadIds.length) await db.delete(leads).where(inArray(leads.id, leadIds));
    await db.delete(contacts).where(eq(contacts.id, contactId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("files a reply sent from a phone on the customer's conversation and lead", async () => {
    const enquiry = `<enquiry.${RUN}@example.com>`;
    await append(
      "INBOX",
      message({
        from: `Kiri Brown <${CUSTOMER}>`,
        to: MAILBOX_ADDRESS,
        subject: `Quote for 4 CCTV cameras ${RUN}`,
        id: enquiry,
        body: "Hi, could I get a quote to install 4 CCTV cameras at 14 Rimu Road, Titirangi? Call me on 021 555 0199. Thanks, Kiri",
      }),
    );
    const first = await syncMailboxOnce(mailboxId);
    expect(first.stored).toBe(1);
    const inbound = (await db.query.emails.findFirst({ where: and(eq(emails.mailboxId, mailboxId), eq(emails.messageId, enquiry)) }))!;
    expect(inbound.leadId).toBeTruthy();

    // Chris answers from his phone: the message only ever exists in Titan's Sent folder.
    const reply = `<phone-reply.${RUN}@getsecure.test>`;
    await append(
      "Sent",
      message({ from: `Chris <${MAILBOX_ADDRESS}>`, to: `Kiri Brown <${CUSTOMER}>`, subject: `Re: Quote for 4 CCTV cameras ${RUN}`, id: reply, inReplyTo: enquiry, body: "Hi Kiri, happy to come and look on Thursday at 10am. Chris" }),
    );
    const second = await syncMailboxOnce(mailboxId);
    expect(second.sentStored).toBe(1);

    const sent = (await db.query.emails.findFirst({ where: and(eq(emails.mailboxId, mailboxId), eq(emails.messageId, reply)) }))!;
    expect(sent.direction).toBe("outbound");
    expect(sent.origin).toBe("sent_folder");
    expect(sent.threadId).toBe(inbound.threadId);
    expect(sent.leadId).toBe(inbound.leadId);
    expect(sent.textBody).toContain("Thursday at 10am");
    expect(sent.to[0].address).toBe(CUSTOMER);
  });

  it("files a new message to a known customer by its recipient, with no subject match needed", async () => {
    const id = `<new-to-known.${RUN}@getsecure.test>`;
    await append("Sent", message({ from: MAILBOX_ADDRESS, to: `known+${RUN}@example.com`, subject: `Your invoice ${RUN}`, id, body: "Invoice attached." }));
    await syncMailboxOnce(mailboxId);
    const sent = (await db.query.emails.findFirst({ where: and(eq(emails.mailboxId, mailboxId), eq(emails.messageId, id)), with: { thread: true } }))!;
    expect(sent.contactId).toBe(contactId);
    expect(sent.thread.contactId).toBe(contactId);
  });

  it("stores a message sent from the CRM once, even after its copy appears in Sent", async () => {
    const sink = await startSmtpSink(SMTP_PORT);
    try {
      const inbound = (await db.query.emails.findFirst({ where: and(eq(emails.mailboxId, mailboxId), eq(emails.messageId, `<enquiry.${RUN}@example.com>`)) }))!;
      // sendReply also files a copy in the IMAP Sent folder, like a mail client would.
      const { messageId } = await sendReply({
        mailboxId,
        threadId: inbound.threadId,
        inReplyToEmailId: inbound.id,
        to: [CUSTOMER],
        subject: `Re: Quote for 4 CCTV cameras ${RUN}`,
        text: `Thursday at 10am is booked. ${RUN}`,
        sentById: userId,
      });
      const s = await syncMailboxOnce(mailboxId);
      expect(s.sentStored).toBe(0);
      const copies = await db.query.emails.findMany({ where: and(eq(emails.mailboxId, mailboxId), eq(emails.threadId, inbound.threadId), eq(emails.direction, "outbound")) });
      expect(copies.filter((c) => c.textBody?.includes(`Thursday at 10am is booked. ${RUN}`))).toHaveLength(1);
      expect(copies.find((c) => c.messageId === messageId)?.origin).toBe("crm");

      // A server that re-stamps the Sent copy with its own Message-ID is still recognised, by the
      // CRM's header or, failing that, by recipient, subject, body and time.
      const sentRaw = sink.messages.at(-1)!.raw;
      await append("Sent", sentRaw.replace(/^Message-ID: .*$/im, `Message-ID: <restamped.${RUN}@titan.test>`));
      await append(
        "Sent",
        sentRaw.replace(/^Message-ID: .*$/im, `Message-ID: <restamped2.${RUN}@titan.test>`).replace(/^X-GetSecure-CRM-Message: .*\r?\n/im, ""),
      );
      const again = await syncMailboxOnce(mailboxId);
      expect(again.sentStored).toBe(0);
      const after = await db.query.emails.findMany({ where: and(eq(emails.mailboxId, mailboxId), eq(emails.threadId, inbound.threadId), eq(emails.direction, "outbound")) });
      expect(after.filter((c) => c.textBody?.includes(`Thursday at 10am is booked. ${RUN}`))).toHaveLength(1);
    } finally {
      await sink.stop();
    }
  });

  it("names the member of staff who sent it when the From address is theirs", async () => {
    const id = `<staff-sent.${RUN}@getsecure.test>`;
    await append("Sent", message({ from: `staff-${RUN}@test.local`, to: CUSTOMER, subject: `Following up ${RUN}`, id, body: "Just checking in." }));
    await syncMailboxOnce(mailboxId);
    const sent = (await db.query.emails.findFirst({ where: and(eq(emails.mailboxId, mailboxId), eq(emails.messageId, id)) }))!;
    expect(sent.sentById).toBe(userId);
    // Matched to Kiri's lead by recipient, since the subject is new.
    expect(sent.leadId).toBeTruthy();
  });
});
