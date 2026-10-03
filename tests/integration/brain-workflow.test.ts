/**
 * Business Brain workflows against the real database: the customer-contact guardrail, drafts,
 * quote approval, supplier price history and policy approval. Covers brief scenarios 12-14.
 * The Titan Drafts round trip uses the local IMAP server when it is running.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { ImapFlow } from "imapflow";

process.env.AI_PROVIDER = "rules";

const { db } = await import("@/db");
const schema = await import("@/db/schema");
const { leads, users, quotes, drafts, products, supplierProducts, productPriceHistory, suppliers, mailboxes, brainPolicies } = schema;
const { AGENT_CAPABILITIES, CUSTOMER_FACING_ACTIONS, GuardrailError } = await import("@/lib/guard/actor");
const { sendReply } = await import("@/lib/email/smtp");
const { encryptSecret } = await import("@/lib/crypto");
const { syncMailboxOnce, testImapConnection } = await import("@/lib/email/imap");
const drafting = await import("@/lib/drafts/workflow");
const quoting = await import("@/lib/quotes/workflow");
const brain = await import("@/lib/brain/store");

const RUN = `bw${Date.now().toString(36)}`;
const HERMES = { kind: "agent" as const, agent: "hermes" };
const SCHEDULER = { kind: "system" as const, process: "automations" };
let chris: { kind: "human"; userId: string; name: string; canApprove: true };
let staff: { kind: "human"; userId: string; name: string; canApprove: false };
let leadId: string;
const quoteIds: string[] = [];

beforeAll(async () => {
  const [c] = await db.insert(users).values({ email: `chris-${RUN}@test.local`, name: "Chris", passwordHash: "x", role: "admin", canApprove: true }).returning();
  const [s] = await db.insert(users).values({ email: `staff-${RUN}@test.local`, name: "Office", passwordHash: "x", role: "member" }).returning();
  chris = { kind: "human", userId: c.id, name: c.name, canApprove: true };
  staff = { kind: "human", userId: s.id, name: s.name, canApprove: false };
  const [l] = await db
    .insert(leads)
    .values({ name: `Dave Lincoln ${RUN}`, email: `dave+${RUN}@example.com`, phone: "021 555 0101", site: "12 Test St, Ponsonby", service: "CCTV", status: "new", source: "website" })
    .returning();
  leadId = l.id;
});

afterAll(async () => {
  if (quoteIds.length) await db.delete(quotes).where(inArray(quotes.id, quoteIds));
  await db.delete(leads).where(eq(leads.id, leadId));
  await db.delete(products).where(eq(products.manufacturer, `Fixture ${RUN}`));
  await db.delete(users).where(inArray(users.id, [chris.userId, staff.userId]));
});

describe("the customer-contact guardrail", () => {
  it("gives agents no customer-facing capability at all", () => {
    for (const action of CUSTOMER_FACING_ACTIONS) expect(AGENT_CAPABILITIES as readonly string[]).not.toContain(action);
    expect(AGENT_CAPABILITIES.some((c) => /send|confirm|discount|promise|accept/.test(c))).toBe(false);
  });

  it("refuses to send email for an agent or an automation, before touching the mailbox", async () => {
    for (const actor of [HERMES, SCHEDULER]) {
      await expect(sendReply({ mailboxId: "00000000-0000-0000-0000-000000000000", threadId: null, to: ["x@example.com"], subject: "s", text: "t", actor })).rejects.toBeInstanceOf(GuardrailError);
    }
  });
});

describe("Test 12: the system creates an email", () => {
  it("stays a draft, cannot be sent by the agent, and leaves the lead's status alone", async () => {
    const d = await drafting.createDraft({ leadId, to: [`dave+${RUN}@example.com`], subject: "Your CCTV enquiry", body: "Hi Dave, ..." }, HERMES);
    expect(d.status).toBe("ready_for_review");
    expect(d.createdByActor).toBe("agent:hermes");
    await expect(drafting.approveDraft(d.id, HERMES)).rejects.toBeInstanceOf(GuardrailError);
    await expect(drafting.sendDraft(d.id, HERMES)).rejects.toBeInstanceOf(GuardrailError);
    await expect(drafting.sendDraft(d.id, staff)).rejects.toBeInstanceOf(GuardrailError);
    const lead = await db.query.leads.findFirst({ where: eq(leads.id, leadId) });
    expect(lead?.status).toBe("new");
  });

  it("loses its approval if edited after Chris approved it", async () => {
    const d = await drafting.createDraft({ leadId, to: [`dave+${RUN}@example.com`], subject: "Quote", body: "Version 1" }, HERMES);
    await drafting.approveDraft(d.id, chris);
    expect((await db.query.drafts.findFirst({ where: eq(drafts.id, d.id) }))!.status).toBe("approved");
    await drafting.updateDraft(d.id, { body: "Version 2" }, staff);
    const after = (await db.query.drafts.findFirst({ where: eq(drafts.id, d.id) }))!;
    expect(after.status).toBe("ready_for_review");
    expect(after.approvalHash).toBeNull();
    await expect(drafting.sendDraft(d.id, chris)).rejects.toThrow(/Only an approved draft/);
  });

  it("an agent cannot change an approved draft", async () => {
    const d = await drafting.createDraft({ leadId, to: [`dave+${RUN}@example.com`], subject: "Quote", body: "Approved text" }, HERMES);
    await drafting.approveDraft(d.id, chris);
    await expect(drafting.updateDraft(d.id, { body: "Sneaky change" }, HERMES)).rejects.toBeInstanceOf(GuardrailError);
  });
});

const line = (unitPrice: number) => [{ description: "4 MP camera", quantity: 4, unitPrice }];

describe("Test 13: a quote generated automatically", () => {
  it("goes from prepared to needs review, and is not delivered to anyone", async () => {
    const q = await quoting.createPreparedQuote(
      { leadId, contactId: null, assessmentId: "00000000-0000-0000-0000-000000000000", title: "4-camera CCTV", lineItems: line(250), taxRatePct: 15, notes: "", internalCosting: {}, confidence: {} },
      HERMES,
    );
    quoteIds.push(q.id);
    const row = (await db.query.quotes.findFirst({ where: eq(quotes.id, q.id) }))!;
    expect(row.status).toBe("needs_review");
    expect(row.origin).toBe("brain");
    expect(row.sentAt).toBeNull();
    await expect(quoting.setQuoteStatus(q.id, "sent", HERMES)).rejects.toBeInstanceOf(GuardrailError);
    await expect(quoting.setQuoteStatus(q.id, "sent", chris)).rejects.toThrow(/not been approved/);
    await expect(quoting.approveQuote(q.id, staff)).rejects.toBeInstanceOf(GuardrailError);
    await expect(quoting.approveQuote(q.id, HERMES)).rejects.toBeInstanceOf(GuardrailError);
  });
});

describe("Test 14: a quote changed after Chris approved it", () => {
  it("loses its approval and returns to needs review, and cannot be sent until approved again", async () => {
    const q = await quoting.createPreparedQuote(
      { leadId, contactId: null, assessmentId: "00000000-0000-0000-0000-000000000000", title: "4-camera CCTV v2", lineItems: line(250), taxRatePct: 15, notes: "", internalCosting: {}, confidence: {} },
      HERMES,
    );
    quoteIds.push(q.id);
    await quoting.approveQuote(q.id, chris);
    expect((await db.query.quotes.findFirst({ where: eq(quotes.id, q.id) }))!.status).toBe("approved");

    const r = await quoting.updateQuoteContent(q.id, { lineItems: line(230) }, staff);
    expect(r.approvalVoided).toBe(true);
    const after = (await db.query.quotes.findFirst({ where: eq(quotes.id, q.id) }))!;
    expect(after.status).toBe("needs_review");
    expect(after.approvalHash).toBeNull();
    await expect(quoting.setQuoteStatus(q.id, "sent", chris)).rejects.toThrow(/not been approved/);

    // Approved again, unchanged: a person can now mark it sent; the lead follows.
    await quoting.approveQuote(q.id, chris);
    await quoting.setQuoteStatus(q.id, "sent", chris);
    expect((await db.query.quotes.findFirst({ where: eq(quotes.id, q.id) }))!.status).toBe("sent");
    expect((await db.query.leads.findFirst({ where: eq(leads.id, leadId) }))!.status).toBe("quote_sent");
  });

  it("an edit that changes nothing keeps the approval", async () => {
    const q = await quoting.createPreparedQuote(
      { leadId, contactId: null, assessmentId: "00000000-0000-0000-0000-000000000000", title: "Same", lineItems: line(100), taxRatePct: 15, notes: "n", internalCosting: {}, confidence: {} },
      HERMES,
    );
    quoteIds.push(q.id);
    await quoting.approveQuote(q.id, chris);
    const r = await quoting.updateQuoteContent(q.id, { title: "Same" }, staff);
    expect(r.approvalVoided).toBe(false);
  });

  it("a new revision supersedes the unsent one", async () => {
    const a = await quoting.createPreparedQuote(
      { leadId, contactId: null, assessmentId: "00000000-0000-0000-0000-000000000000", title: "Rev A", lineItems: line(100), taxRatePct: 15, notes: "", internalCosting: {}, confidence: {} },
      HERMES,
    );
    const b = await quoting.createPreparedQuote(
      { leadId, contactId: null, assessmentId: "00000000-0000-0000-0000-000000000000", title: "Rev B", lineItems: line(110), taxRatePct: 15, notes: "", internalCosting: {}, confidence: {} },
      HERMES,
    );
    quoteIds.push(a.id, b.id);
    expect((await db.query.quotes.findFirst({ where: eq(quotes.id, a.id) }))!.status).toBe("superseded");
    expect(b.superseded).toContain(a.id);
    await expect(quoting.approveQuote(a.id, chris)).rejects.toThrow(/superseded/);
  });

  it("a quote for a lead that is not yet a customer cannot be accepted", async () => {
    const q = await quoting.createPreparedQuote(
      { leadId, contactId: null, assessmentId: "00000000-0000-0000-0000-000000000000", title: "No customer", lineItems: line(100), taxRatePct: 15, notes: "", internalCosting: {}, confidence: {} },
      HERMES,
    );
    quoteIds.push(q.id);
    await quoting.approveQuote(q.id, chris);
    await quoting.setQuoteStatus(q.id, "sent", chris);
    await expect(quoting.setQuoteStatus(q.id, "accepted", chris)).rejects.toThrow(/Convert the lead/);
  });
});

describe("supplier prices", () => {
  it("keeps history, needs approval for a first price, and holds a big change for review", async () => {
    const [p] = await db.insert(products).values({ manufacturer: `Fixture ${RUN}`, model: "FX-1", category: "camera", specs: { resolutionMp: 4 }, status: "requires_review" }).returning();
    const it = (await db.query.suppliers.findFirst({ where: eq(suppliers.name, "IT Plus") }))!;
    const first = await brain.recordSupplierPrice({ productId: p.id, supplierId: it.id, costIncGst: 115, source: "manual" }, staff);
    let offer = (await db.query.supplierProducts.findFirst({ where: eq(supplierProducts.id, first.offerId) }))!;
    expect(Number(offer.costExGst)).toBe(100); // normalised to ex GST
    expect(offer.priceApproved).toBe(false);
    await expect(brain.approveSupplierPrice(first.offerId, staff)).rejects.toBeInstanceOf(GuardrailError);
    await brain.approveSupplierPrice(first.offerId, chris);

    const big = await brain.recordSupplierPrice({ productId: p.id, supplierId: it.id, costExGst: 130, source: "price list" }, staff);
    expect(big.held).toBe(true);
    offer = (await db.query.supplierProducts.findFirst({ where: eq(supplierProducts.id, first.offerId) }))!;
    expect(Number(offer.costExGst)).toBe(100);
    expect(Number(offer.pendingCostExGst)).toBe(130);

    const history = await db.query.productPriceHistory.findMany({ where: eq(productPriceHistory.supplierProductId, first.offerId) });
    expect(history).toHaveLength(2);
    expect(history.map((h) => Number(h.changedPct)).filter(Boolean)).toEqual([30]);
    await expect(brain.recordSupplierPrice({ productId: p.id, supplierId: it.id, costExGst: 99, source: "llm" }, HERMES)).rejects.toBeInstanceOf(GuardrailError);
  });
});

describe("policies", () => {
  it("only an approver can mark a rule Get Secure approved; agents cannot change rules", async () => {
    await brain.ensurePolicies();
    const before = (await db.query.brainPolicies.findFirst({ where: eq(brainPolicies.key, "priceAgingDays") }))!;
    await expect(brain.savePolicy("priceAgingDays", 12, "getsecure_approved", null, staff)).rejects.toBeInstanceOf(GuardrailError);
    await expect(brain.savePolicy("priceAgingDays", 12, "getsecure_provisional", null, HERMES)).rejects.toBeInstanceOf(GuardrailError);
    // Restore whatever was there.
    await db.update(brainPolicies).set({ value: before.value, status: before.status }).where(eq(brainPolicies.key, "priceAgingDays"));
  });
});

const IMAP_PORT = Number(process.env.DOVECOT_TEST_PORT ?? 1143);
const imapUp = await testImapConnection({ imapHost: "127.0.0.1", imapPort: IMAP_PORT, imapSecure: false, smtpHost: "127.0.0.1", smtpPort: 2527, smtpSecure: false, username: "crm@test.local", password: "crm-password", folder: "INBOX" }).then(
  () => true,
  () => false,
);

describe.skipIf(!imapUp)("drafts placed in Titan and sent from there", () => {
  it("puts the draft in the Drafts folder and marks it sent when it shows up in Sent", async () => {
    const c = new ImapFlow({ host: "127.0.0.1", port: IMAP_PORT, secure: false, auth: { user: "crm@test.local", pass: "crm-password" }, logger: false });
    await c.connect();
    const sentStatus = await c.status("Sent", { uidNext: true, uidValidity: true });
    const inboxStatus = await c.status("INBOX", { uidNext: true, uidValidity: true });
    const [mb] = await db
      .insert(mailboxes)
      .values({
        name: `Drafts test ${RUN}`,
        emailAddress: `chris+${RUN}@getsecure.test`,
        imapHost: "127.0.0.1",
        imapPort: IMAP_PORT,
        imapSecure: false,
        smtpHost: "127.0.0.1",
        smtpPort: 2527,
        smtpSecure: false,
        username: "crm@test.local",
        passwordEncrypted: encryptSecret("crm-password"),
        uidValidity: String(inboxStatus.uidValidity),
        lastUid: (inboxStatus.uidNext ?? 1) - 1,
        sentUidValidity: String(sentStatus.uidValidity),
        sentLastUid: (sentStatus.uidNext ?? 1) - 1,
      })
      .returning();
    try {
      const d = await drafting.createDraft({ leadId, to: [`dave+${RUN}@example.com`], subject: `Your CCTV quote ${RUN}`, body: "Hi Dave, here it is." }, HERMES);
      await drafting.approveDraft(d.id, chris);
      const placed = await drafting.placeInMailboxDrafts(d.id, chris);
      expect(placed.folder).toBe("Drafts");

      // Chris opens it in Titan and presses Send: the server files it in Sent.
      const lock = await c.getMailboxLock("Drafts");
      let raw: Buffer | null = null;
      try {
        const found = (await c.search({ header: { "message-id": placed.messageId } }, { uid: true })) || [];
        expect(found).toHaveLength(1);
        for await (const m of c.fetch(found, { source: true }, { uid: true })) raw = m.source ?? null;
      } finally {
        lock.release();
      }
      expect(raw).not.toBeNull();
      await c.append("Sent", raw!, ["\\Seen"]);
      await syncMailboxOnce(mb.id);

      const after = (await db.query.drafts.findFirst({ where: eq(drafts.id, d.id) }))!;
      expect(after.status).toBe("sent");
      expect(after.sentEmailId).toBeTruthy();
    } finally {
      await c.logout();
      await db.delete(mailboxes).where(eq(mailboxes.id, mb.id));
    }
  });
});
