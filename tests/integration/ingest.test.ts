/**
 * Integration tests for email ingestion against the real Postgres database and, when a local
 * Dovecot is running (tests/support/dovecot/start.sh), the real IMAP + SMTP path.
 * Run: pnpm test:integration   (needs DATABASE_URL; uses AI_PROVIDER=rules)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";

process.env.AI_PROVIDER = "rules";
process.env.AI_LEAD_CONFIDENCE_THRESHOLD = "0.75";

const { db } = await import("@/db");
const { mailboxes, emails, emailThreads, leads, contacts, users } = await import("@/db/schema");
const { encryptSecret } = await import("@/lib/crypto");
const { ingestRawMessage } = await import("@/lib/email/store");
const { processEmail, createLeadFromEmail } = await import("@/lib/email/pipeline");
const { syncMailboxOnce, testImapConnection, watchMailbox } = await import("@/lib/email/imap");
const { sendReply } = await import("@/lib/email/smtp");
const { startSmtpSink } = await import("../support/smtp-sink");

// Each run rewrites sender addresses and Message-IDs so tests never collide with seeded or earlier data.
const RUN = `it${Date.now().toString(36)}`;
function fx(name: string): Buffer {
  let raw = readFileSync(`tests/fixtures/emails/${name}`).toString();
  const from = raw.match(/^From: .*?<?([\w.+-]+@[\w.-]+)>?\s*$/m)?.[1];
  if (from) {
    const [local, domain] = from.split("@");
    raw = raw.split(from).join(`${local}+${RUN}@${domain}`);
  }
  raw = raw.replace(/^(Message-ID|In-Reply-To|References): (.*)$/gm, (_m, h, v) => `${h}: ${v.replace(/@/g, `.${RUN}@`)}`);
  return Buffer.from(raw);
}
const addr = (a: string) => a.replace("@", `+${RUN}@`);
const mid = (m: string) => m.replace("@", `.${RUN}@`);
const IMAP_PORT = Number(process.env.DOVECOT_TEST_PORT ?? 1143);
const SMTP_PORT = 2525;
const dovecotUp = await (async () => {
  try {
    await testImapConnection({ imapHost: "127.0.0.1", imapPort: IMAP_PORT, imapSecure: false, smtpHost: "127.0.0.1", smtpPort: SMTP_PORT, smtpSecure: false, username: "crm@test.local", password: "crm-password", folder: "INBOX" });
    return true;
  } catch {
    return false;
  }
})();

let mailboxId: string;
let userId: string;
const createdLeadIds: string[] = [];

beforeAll(async () => {
  // A user to attribute replies to (CI runs this suite before the seed).
  const [u] = await db
    .insert(users)
    .values({ email: `it-${RUN}@test.local`, name: "Integration Tester", passwordHash: "x", role: "member" })
    .returning({ id: users.id });
  userId = u.id;
  const [m] = await db
    .insert(mailboxes)
    .values({
      name: "Integration test",
      emailAddress: `it-${Date.now()}@test.local`,
      imapHost: "127.0.0.1",
      imapPort: IMAP_PORT,
      imapSecure: false,
      smtpHost: "127.0.0.1",
      smtpPort: SMTP_PORT,
      smtpSecure: false,
      username: "crm@test.local",
      passwordEncrypted: encryptSecret("crm-password"),
    })
    .returning({ id: mailboxes.id });
  mailboxId = m.id;
});

afterAll(async () => {
  // Cascade removes threads, emails, attachments and classifications; leads/contacts are cleaned explicitly.
  const rows = await db.query.leads.findMany({ where: eq(leads.source, "email"), columns: { id: true, emailThreadId: true } });
  const threadIds = new Set((await db.query.emailThreads.findMany({ where: eq(emailThreads.mailboxId, mailboxId), columns: { id: true } })).map((t) => t.id));
  const ours = rows.filter((r) => r.emailThreadId && threadIds.has(r.emailThreadId)).map((r) => r.id).concat(createdLeadIds);
  if (ours.length) await db.delete(leads).where(inArray(leads.id, ours));
  await db.delete(mailboxes).where(eq(mailboxes.id, mailboxId));
  await db.delete(users).where(eq(users.id, userId));
});

describe("store + classify", () => {
  it("creates a lead automatically from a confident enquiry, with the original email attached", async () => {
    const r = await ingestRawMessage({ mailboxId, raw: fx("01-cctv-quote.eml") });
    expect(r.created).toBe(true);
    const out = await processEmail(r.emailId);
    expect(out.classification).toBe("lead");
    expect(out.leadId).toBeTruthy();
    const lead = await db.query.leads.findFirst({ where: eq(leads.id, out.leadId!), with: { sourceEmail: true } });
    expect(lead?.name).toBe("Sarah Mitchell");
    expect(lead?.company).toBe("Harbourview Apartments");
    expect(lead?.phone).toBe("021 555 0142");
    expect(lead?.email).toBe(addr("sarah@harbourview.co.nz"));
    expect(lead?.service).toBe("CCTV");
    expect(lead?.site).toContain("12 Quay St");
    expect(lead?.source).toBe("email");
    expect(lead?.status).toBe("new");
    expect(lead?.summary).toBeTruthy();
    expect(lead?.emailThreadId).toBe(r.threadId);
    expect(lead?.sourceEmail?.rawMime).toContain(`Message-ID: ${mid("<cctv-quote-001@harbourview.co.nz>")}`);
    const thread = await db.query.emailThreads.findFirst({ where: eq(emailThreads.id, r.threadId) });
    expect(thread?.leadId).toBe(out.leadId);
  });

  it("is idempotent on Message-ID", async () => {
    const again = await ingestRawMessage({ mailboxId, raw: fx("01-cctv-quote.eml") });
    expect(again.created).toBe(false);
    const n = await db.query.emails.findMany({ where: eq(emails.messageId, mid("<cctv-quote-001@harbourview.co.nz>")) });
    expect(n.filter((e) => e.mailboxId === mailboxId)).toHaveLength(1);
  });

  it("threads a reply and attaches it to the existing lead instead of creating another", async () => {
    const r = await ingestRawMessage({ mailboxId, raw: fx("10-reply-on-thread.eml") });
    expect(r.created).toBe(true);
    const first = await db.query.emails.findFirst({ where: eq(emails.messageId, mid("<cctv-quote-001@harbourview.co.nz>")) });
    expect(r.threadId).toBe(first!.threadId);
    const out = await processEmail(r.emailId);
    expect(out.classification).toBe("existing");
    expect(out.leadId).toBe(first!.leadId);
    const thread = await db.query.emailThreads.findFirst({ where: eq(emailThreads.id, r.threadId) });
    expect(thread?.messageCount).toBe(2);
    const lead = await db.query.leads.findFirst({ where: eq(leads.id, out.leadId!) });
    expect(lead?.lastContactAt).toBe("2026-09-22"); // 08:30 NZST on the 22nd, in app timezone not UTC
  });

  it("sends a vague enquiry to Needs review without creating a lead", async () => {
    const before = (await db.query.leads.findMany({ columns: { id: true } })).length;
    const r = await ingestRawMessage({ mailboxId, raw: fx("09-vague.eml") });
    const out = await processEmail(r.emailId);
    expect(out.classification).toBe("needs_review");
    expect(out.leadId).toBeNull();
    const after = (await db.query.leads.findMany({ columns: { id: true } })).length;
    expect(after).toBe(before);
  });

  it("files newsletters and invoices as not_lead (newsletter never reaches the model)", async () => {
    const a = await processEmail((await ingestRawMessage({ mailboxId, raw: fx("07-newsletter.eml") })).emailId);
    expect(a.classification).toBe("not_lead");
    expect(a.detail).toMatch(/list-unsubscribe|bulk/);
    const b = await processEmail((await ingestRawMessage({ mailboxId, raw: fx("08-invoice.eml") })).emailId);
    expect(b.classification).toBe("not_lead");
    const inv = await db.query.emails.findFirst({ where: eq(emails.messageId, mid("<inv-008@accounts.wholesaler.example>")), with: { attachments: true } });
    expect(inv?.attachments[0]?.filename).toBe("INV-20419.pdf");
  });

  it("classifies the other realistic enquiries as leads with the right service", async () => {
    const expected: Record<string, string> = {
      "02-ajax-alarm.eml": "Ajax alarm",
      "03-access-control.eml": "Access control",
      "04-intercom.eml": "Intercom",
      "05-service-call.eml": "Alarm service",
      "06-maintenance.eml": "CCTV service",
    };
    for (const [file, service] of Object.entries(expected)) {
      const out = await processEmail((await ingestRawMessage({ mailboxId, raw: fx(file) })).emailId);
      expect(out.classification, file).toBe("lead");
      const lead = await db.query.leads.findFirst({ where: eq(leads.id, out.leadId!) });
      expect(lead?.service, file).toBe(service);
      if (file === "05-service-call.eml") expect(lead?.urgency).toBe("urgent");
    }
  });

  it("attaches mail from an existing customer to their open lead (no duplicate)", async () => {
    const karen = addr("office@stjohnsschool.school.nz");
    const [c] = await db.insert(contacts).values({ name: "Karen Liu", email: karen }).returning({ id: contacts.id });
    const existing = await db.query.leads.findFirst({ where: eq(leads.email, karen) });
    expect(existing).toBeTruthy();
    const raw = fx("06-maintenance.eml").toString().replace(mid("<maint-006@stjohnsschool.school.nz>"), mid("<maint-006b@stjohnsschool.school.nz>")).replace("Subject: Annual maintenance check on cameras and alarm", "Subject: Camera fogging photos");
    const r = await ingestRawMessage({ mailboxId, raw });
    const out = await processEmail(r.emailId);
    expect(out.classification).toBe("existing");
    expect(out.leadId).toBe(existing!.id);
    await db.delete(contacts).where(eq(contacts.id, c.id));
  });

  it("lets a reviewer accept a Needs review email with edits", async () => {
    const e = await db.query.emails.findFirst({ where: eq(emails.messageId, mid("<vague-009@hotmail.com>")) });
    const leadId = await createLeadFromEmail(e!.id, { actorId: null, overrides: { contact_name: "J Brown", service: "CCTV", site_address: "West Auckland" } });
    createdLeadIds.push(leadId);
    const lead = await db.query.leads.findFirst({ where: eq(leads.id, leadId) });
    expect(lead?.name).toBe("J Brown");
    expect(lead?.service).toBe("CCTV");
    const updated = await db.query.emails.findFirst({ where: eq(emails.id, e!.id) });
    expect(updated?.classification).toBe("lead");
    expect(updated?.leadId).toBe(leadId);
  });
});

describe.skipIf(!dovecotUp)("IMAP + SMTP against local Dovecot", () => {
  const deliver = (file: string) => execFileSync("tests/support/dovecot/deliver.sh", [`tests/fixtures/emails/${file}`]).toString().trim();
  const rewrite = (file: string, id: string, subject: string) => {
    const raw = fx(file).toString().replace(/^Message-ID: .*$/m, `Message-ID: <${id}@imap.test>`).replace(/^Subject: .*$/m, `Subject: ${subject}`);
    // A different sender per message so it never links to an earlier lead.
    const from = raw.match(/^From: .*?<?([\w.+-]+@[\w.-]+)>?\s*$/m)![1];
    const unique = from.replace("@", `.${id}@`);
    const path = `/tmp/imap-${id}.eml`;
    writeFileSync(path, raw.split(from).join(unique));
    return path;
  };

  it("fetches new mail over IMAP incrementally and creates the lead", async () => {
    const id = `imap-${Date.now()}`;
    execFileSync("tests/support/dovecot/deliver.sh", [rewrite("02-ajax-alarm.eml", id, `Ajax alarm quote ${id}`)]);
    const s1 = await syncMailboxOnce(mailboxId);
    expect(s1.stored).toBeGreaterThanOrEqual(1);
    const stored = await db.query.emails.findFirst({ where: eq(emails.messageId, `<${id}@imap.test>`) });
    expect(stored?.imapUid).toBeGreaterThan(0);
    expect(stored?.classification).toBe("lead");
    // Nothing new → nothing stored, cursor unchanged.
    const s2 = await syncMailboxOnce(mailboxId);
    expect(s2.stored).toBe(0);
    expect(s2.duplicates).toBe(0);
    const mb = await db.query.mailboxes.findFirst({ where: eq(mailboxes.id, mailboxId) });
    expect(mb?.lastUid).toBe(stored?.imapUid);
    expect(mb?.lastError).toBeNull();
    void deliver;
  });

  it("the watcher notices new mail without polling (IMAP IDLE)", async () => {
    const controller = new AbortController();
    const logs: string[] = [];
    const watcher = watchMailbox(mailboxId, { pollSeconds: 3600, signal: controller.signal, log: (m) => logs.push(m) });
    await new Promise((r) => setTimeout(r, 1500)); // let it connect and run the initial sync
    const id = `idle-${Date.now()}`;
    execFileSync("tests/support/dovecot/deliver.sh", [rewrite("04-intercom.eml", id, `Intercom ${id}`)]);
    const deadline = Date.now() + 15_000;
    let stored = null;
    while (Date.now() < deadline && !stored) {
      await new Promise((r) => setTimeout(r, 500));
      stored = await db.query.emails.findFirst({ where: eq(emails.messageId, `<${id}@imap.test>`) });
    }
    controller.abort();
    await watcher;
    expect(stored, logs.join("\n")).toBeTruthy();
    expect(stored?.classification).toBe("lead");
  });

  it("sends a reply over SMTP and stores it on the same thread", async () => {
    const sink = await startSmtpSink(SMTP_PORT);
    try {
      const original = await db.query.emails.findFirst({ where: eq(emails.messageId, mid("<cctv-quote-001@harbourview.co.nz>")) });
      const res = await sendReply({
        mailboxId,
        threadId: original!.threadId,
        inReplyToEmailId: original!.id,
        to: [addr("sarah@harbourview.co.nz")],
        subject: "Re: CCTV quote for apartment block",
        text: "Hi Sarah, Tuesday 2pm works for us. See you then.",
        sentById: userId,
        fromName: "Get Secure",
      });
      expect(sink.messages).toHaveLength(1);
      expect(sink.messages[0].to).toEqual([addr("sarah@harbourview.co.nz")]);
      expect(sink.messages[0].raw).toContain(`In-Reply-To: ${mid("<cctv-quote-001@harbourview.co.nz>")}`);
      expect(sink.messages[0].raw).toContain("Tuesday 2pm works");
      const stored = await db.query.emails.findFirst({ where: eq(emails.id, res.emailId) });
      expect(stored?.direction).toBe("outbound");
      expect(stored?.threadId).toBe(original!.threadId);
      expect(stored?.classification).toBe("outbound");
      expect(stored?.rawMime).toContain("Tuesday 2pm works");
    } finally {
      await sink.stop();
    }
  });
});
