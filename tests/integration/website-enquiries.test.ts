/**
 * Website enquiries all arrive from one robot address, often with the same subject. Each must still
 * become its own conversation and its own lead, and the robot's address must never stick to a
 * customer. Also covers the one-off repair for mail filed by older code.
 * Run: pnpm test:integration   (needs DATABASE_URL)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";

process.env.AI_PROVIDER = "rules";
const RUN = `ws${Date.now().toString(36)}`;
const ROBOT = `noreply+${RUN}@updates.getsecure.co.nz`;
process.env.LEAD_SENDER_ADDRESSES = ROBOT;

const { db } = await import("@/db");
const { mailboxes, emails, emailThreads, leads, contacts } = await import("@/db/schema");
const { encryptSecret } = await import("@/lib/crypto");
const { ingestRawMessage } = await import("@/lib/email/store");
const { processEmail } = await import("@/lib/email/pipeline");
const { repairWebsiteEnquiries } = await import("@/lib/email/website-repair");

let mailboxId: string;
const contactIds: string[] = [];

function enquiry(o: { name: string; email: string; phone: string; id: string; date: string; subject?: string }): Buffer {
  return Buffer.from(
    [
      `From: Get Secure Website <${ROBOT}>`,
      "To: info@getsecure.co.nz",
      `Subject: ${o.subject ?? "New Lead · Home Page"}`,
      `Message-ID: <${o.id}.${RUN}@updates.getsecure.co.nz>`,
      `Date: ${o.date}`,
      "Content-Type: text/plain; charset=utf-8",
      "Auto-Submitted: auto-generated",
      "",
      "New Lead · Home Page",
      "",
      o.name.toUpperCase(),
      "",
      `Phone ${o.phone} tel:${o.phone} Email ${o.email} ServiceCCTV Installation`,
      "",
      "REQUEST SUMMARY",
      "",
      "PropertyResidential HomeTimelinethis-weekLocationPonsonby",
      "",
      `Sent from the Get Secure website. Reply to this email to respond directly to ${o.name}.`,
    ].join("\n"),
  );
}

async function leadsInMailbox() {
  const threadIds = (await db.query.emailThreads.findMany({ where: eq(emailThreads.mailboxId, mailboxId), columns: { id: true } })).map((t) => t.id);
  if (!threadIds.length) return [];
  return db.query.leads.findMany({ where: inArray(leads.emailThreadId, threadIds) });
}

beforeAll(async () => {
  const [m] = await db
    .insert(mailboxes)
    .values({
      name: "Website enquiry test",
      emailAddress: `ws-${RUN}@test.local`,
      imapHost: "127.0.0.1",
      imapPort: 1143,
      imapSecure: false,
      smtpHost: "127.0.0.1",
      smtpPort: 2525,
      smtpSecure: false,
      username: "crm@test.local",
      passwordEncrypted: encryptSecret("x"),
    })
    .returning({ id: mailboxes.id });
  mailboxId = m.id;
});

afterAll(async () => {
  const ours = (await leadsInMailbox()).map((l) => l.id);
  if (ours.length) await db.delete(leads).where(inArray(leads.id, ours));
  await db.delete(mailboxes).where(eq(mailboxes.id, mailboxId));
  if (contactIds.length) await db.delete(contacts).where(inArray(contacts.id, contactIds));
});

describe("website enquiries", () => {
  it("keeps same-subject enquiries in separate conversations, each with its own lead", async () => {
    const a = await ingestRawMessage({ mailboxId, raw: enquiry({ name: "Dave Lincoln", email: `dave+${RUN}@example.com`, phone: "0211111111", id: "same-a", date: "Mon, 21 Sep 2026 09:00:00 +1200" }) });
    const outA = await processEmail(a.emailId);
    const b = await ingestRawMessage({ mailboxId, raw: enquiry({ name: "Mere Tane", email: `mere+${RUN}@example.com`, phone: "0212222222", id: "same-b", date: "Tue, 22 Sep 2026 09:00:00 +1200" }) });
    const outB = await processEmail(b.emailId);

    expect(a.threadId).not.toBe(b.threadId);
    expect(outA.leadId).toBeTruthy();
    expect(outB.leadId).toBeTruthy();
    expect(outA.leadId).not.toBe(outB.leadId);

    // The second enquiry must not take over the first one's email.
    const first = await db.query.emails.findFirst({ where: eq(emails.id, a.emailId) });
    expect(first?.leadId).toBe(outA.leadId);
  });

  it("re-running an enquiry filed on the wrong customer gives it its own lead, not that customer", async () => {
    const [wrong] = await db.insert(contacts).values({ name: `Chris Baker ${RUN}`, email: ROBOT }).returning({ id: contacts.id });
    contactIds.push(wrong.id);
    const r = await ingestRawMessage({ mailboxId, raw: enquiry({ name: "Anubhav Sharma", email: `anubhav+${RUN}@example.com`, phone: "0210747667", id: "rerun", date: "Wed, 23 Sep 2026 02:33:00 +1200", subject: "[CCTV Landing] New Contact Form Submission from Anubhav Sharma" }) });
    // Simulate what older code did: filed against the customer holding the robot's address.
    await db.update(emails).set({ contactId: wrong.id, classification: "existing" }).where(eq(emails.id, r.emailId));
    await db.update(emailThreads).set({ contactId: wrong.id }).where(eq(emailThreads.id, r.threadId));

    const out = await processEmail(r.emailId, { force: true });
    const lead = await db.query.leads.findFirst({ where: eq(leads.id, out.leadId!) });
    expect(lead?.name).toBe("Anubhav Sharma");
    expect(lead?.email).toBe(`anubhav+${RUN}@example.com`);
    expect(lead?.contactId ?? null).toBeNull();
  });

  it("repairs enquiries filed by older code, and shows the plan before changing anything", async () => {
    // Older code: the robot was not recognised, so same-subject enquiries merged into one thread,
    // and a customer created from the first one kept the robot's address and caught the rest.
    process.env.LEAD_SENDER_ADDRESSES = "someone-else@example.com";
    const first = await ingestRawMessage({ mailboxId, raw: enquiry({ name: "Kiri Brown", email: `kiri+${RUN}@example.com`, phone: "0213333333", id: "old-1", date: "Mon, 14 Sep 2026 09:00:00 +1200", subject: "New Lead · CCTV Landing" }) });
    const second = await ingestRawMessage({ mailboxId, raw: enquiry({ name: "Hamesh Chhiba", email: `hamesh+${RUN}@example.com`, phone: "0212990604", id: "old-2", date: "Tue, 15 Sep 2026 09:00:00 +1200", subject: "New Lead · CCTV Landing" }) });
    process.env.LEAD_SENDER_ADDRESSES = ROBOT;
    expect(second.threadId).toBe(first.threadId);

    const [kiri] = await db.insert(contacts).values({ name: "KIRI BROWN", email: ROBOT }).returning({ id: contacts.id });
    contactIds.push(kiri.id);
    const [kiriLead] = await db
      .insert(leads)
      .values({ name: "Get Secure Website", email: ROBOT, status: "new", source: "email", sourceEmailId: first.emailId, emailThreadId: first.threadId, contactId: kiri.id })
      .returning({ id: leads.id });
    await db.update(emailThreads).set({ leadId: kiriLead.id, contactId: kiri.id }).where(eq(emailThreads.id, first.threadId));
    await db.update(emails).set({ leadId: kiriLead.id, contactId: kiri.id, classification: "existing" }).where(eq(emails.threadId, first.threadId));

    // Dry run: says what it would do, changes nothing.
    const plan = await repairWebsiteEnquiries({ apply: false });
    expect(plan.changes).toBeGreaterThan(0);
    expect(plan.lines.every((l) => l.startsWith("would ") || l.startsWith("skip "))).toBe(true);
    expect((await db.query.contacts.findFirst({ where: eq(contacts.id, kiri.id) }))?.email).toBe(ROBOT);

    await repairWebsiteEnquiries({ apply: true });

    // Hamesh has his own conversation and his own lead, not attached to Kiri.
    const hameshEmail = await db.query.emails.findFirst({ where: eq(emails.id, second.emailId) });
    expect(hameshEmail?.threadId).not.toBe(first.threadId);
    const hamesh = await db.query.leads.findFirst({ where: eq(leads.id, hameshEmail!.leadId!) });
    expect(hamesh?.name).toBe("Hamesh Chhiba");
    expect(hamesh?.email).toBe(`hamesh+${RUN}@example.com`);
    expect(hamesh?.contactId ?? null).toBeNull();

    // Kiri's own lead and customer get her real details back.
    const fixedLead = await db.query.leads.findFirst({ where: eq(leads.id, kiriLead.id) });
    expect(fixedLead?.name).toBe("Kiri Brown");
    expect(fixedLead?.email).toBe(`kiri+${RUN}@example.com`);
    expect((await db.query.contacts.findFirst({ where: eq(contacts.id, kiri.id) }))?.email).toBe(`kiri+${RUN}@example.com`);

    // No customer keeps the robot's address (the one from the previous test is cleared too).
    const stuck = await db.query.contacts.findMany({ where: inArray(contacts.id, contactIds) });
    expect(stuck.filter((c) => c.email === ROBOT)).toHaveLength(0);

    // Running again changes nothing.
    const again = await repairWebsiteEnquiries({ apply: true });
    expect(again.changes).toBe(0);
  });
});
