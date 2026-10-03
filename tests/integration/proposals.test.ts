/**
 * The branded PDF proposal against the database: made only from an approved quote, stored once,
 * attached to the prepared email, never carrying internal information, voided when the quote is
 * repriced or changed, remade on re-approval, and sent as an attachment only while it is valid.
 *
 * Every cost and package value here is a TEST VALUE; the seeded package is put back afterwards.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray } from "drizzle-orm";

process.env.AI_PROVIDER = "rules";

const { db } = await import("@/db");
const { drafts, emailThreads, installationPackages, leads, mailboxes, products, quoteDocuments, quotes, supplierProducts, suppliers, users, catalogueImages } = await import("@/db/schema");
const brain = await import("@/lib/brain/store");
const quoting = await import("@/lib/quotes/workflow");
const drafting = await import("@/lib/drafts/workflow");
const proposals = await import("@/lib/proposals/workflow");
const { applyStarterContent, resetStarterMarker } = await import("@/lib/proposals/content");
const { applyReferenceCatalogue, resetReferenceMarker } = await import("@/lib/brain/reference/apply");
const { encryptSecret } = await import("@/lib/crypto");
const { GuardrailError } = await import("@/lib/guard/actor");
const { startSmtpSink } = await import("../support/smtp-sink");
const { house } = await import("../unit/brain-fixtures");

const RUN = `pp${Date.now().toString(36)}`;
const SMTP_PORT = 2533;
let chris: { kind: "human"; userId: string; name: string; canApprove: true };
let staff: { kind: "human"; userId: string; name: string; canApprove: false };
const HERMES = { kind: "agent" as const, agent: "hermes" };
let leadId: string;
let mailboxId: string;
let pkgBefore: typeof installationPackages.$inferSelect;
const offerIds: string[] = [];
let quoteId: string;
let draftId: string;

const itPlus = async () => (await db.query.suppliers.findFirst({ where: eq(suppliers.name, "IT Plus") }))!;

beforeAll(async () => {
  resetReferenceMarker();
  await applyReferenceCatalogue();
  resetStarterMarker();
  await applyStarterContent();
  const [c] = await db.insert(users).values({ email: `chris-${RUN}@test.local`, name: "Chris", passwordHash: "x", role: "admin", canApprove: true }).returning();
  const [s] = await db.insert(users).values({ email: `staff-${RUN}@test.local`, name: "Office", passwordHash: "x", role: "member" }).returning();
  chris = { kind: "human", userId: c.id, name: c.name, canApprove: true };
  staff = { kind: "human", userId: s.id, name: s.name, canApprove: false };
  const [l] = await db.insert(leads).values({ name: `Aroha Ngata ${RUN}`, email: `aroha+${RUN}@example.com`, site: "4 Kauri Street, Grey Lynn", service: "CCTV", status: "new", source: "website" }).returning();
  leadId = l.id;

  // TEST VALUE trade prices for the VIGI range and drives, entered by Chris.
  const it = await itPlus();
  const rows = [...(await db.select().from(products).where(eq(products.family, "TP-Link VIGI"))), ...(await db.select().from(products).where(eq(products.category, "hdd")))];
  for (const row of rows) {
    const cost = row.category === "camera" ? 120 : row.category === "nvr" ? 210 : row.category === "hdd" ? 60 + 25 * Number((row.specs as { capacityTb?: number }).capacityTb ?? 1) : null;
    if (cost == null) continue;
    const r = await brain.recordSupplierPrice({ productId: row.id, supplierId: it.id, costExGst: cost, stock: "In stock", source: "integration test" }, chris);
    offerIds.push(r.offerId);
  }
  pkgBefore = (await db.query.installationPackages.findFirst({ where: eq(installationPackages.key, "RES_CCTV_SINGLE_4") }))!;
  await db
    .update(installationPackages)
    .set({ estimatedHours: "6.00", labourRate: "95.00", materialCostExGst: "80.00", complexityAllowanceExGst: "0.00", allowanceExGst: "790.00", status: "getsecure_approved" })
    .where(eq(installationPackages.key, "RES_CCTV_SINGLE_4"));

  const [mb] = await db
    .insert(mailboxes)
    .values({ name: `Proposals ${RUN}`, emailAddress: `chris+${RUN}@getsecure.test`, imapHost: "127.0.0.1", imapPort: 1, imapSecure: false, smtpHost: "127.0.0.1", smtpPort: SMTP_PORT, smtpSecure: false, username: "crm@test.local", passwordEncrypted: encryptSecret("crm-password"), active: false })
    .returning();
  mailboxId = mb.id;

  const a = await brain.runAssessment(leadId, house({ requestedTier: "good", customerName: "Aroha Ngata" }), staff);
  expect(a.packet.costing.complete).toBe(true);
  const prepared = await brain.prepareFromAssessment(a.id, { quote: true, email: true }, staff);
  quoteId = prepared.quoteId!;
  draftId = prepared.draftId!;
  const now = new Date();
  const [t] = await db.insert(emailThreads).values({ mailboxId, subject: "CCTV", normalizedSubject: "cctv", firstMessageAt: now, lastMessageAt: now }).returning();
  await db.update(drafts).set({ threadId: t.id }).where(eq(drafts.id, draftId));
});

afterAll(async () => {
  await db.delete(quotes).where(eq(quotes.leadId, leadId));
  await db.delete(drafts).where(eq(drafts.leadId, leadId));
  await db.delete(leads).where(eq(leads.id, leadId));
  await db.delete(emailThreads).where(eq(emailThreads.mailboxId, mailboxId));
  await db.delete(mailboxes).where(eq(mailboxes.id, mailboxId));
  if (offerIds.length) await db.delete(supplierProducts).where(inArray(supplierProducts.id, offerIds));
  if (pkgBefore) {
    const { id, ...rest } = pkgBefore;
    await db.update(installationPackages).set(rest).where(eq(installationPackages.id, id));
  }
  await db.delete(users).where(inArray(users.id, [chris.userId, staff.userId]));
  resetReferenceMarker();
});

describe("starter proposal content for the VIGI kit", () => {
  it("fills customer-facing name, description, highlights and a stored photo, marked provisional", async () => {
    const p = (await db.query.products.findFirst({ where: and(eq(products.manufacturer, "TP-Link"), eq(products.model, "VIGI InSight S455(2.8mm)")) }))!;
    expect(p.quoteDisplayName).toBe("VIGI 5MP Full-Colour Turret Camera");
    expect(p.quoteHighlights.length).toBeGreaterThanOrEqual(2);
    expect(p.quoteHighlights.length).toBeLessThanOrEqual(4);
    expect(p.quoteContentStatus).not.toBe("getsecure_approved");
    const img = (await db.query.catalogueImages.findFirst({ where: eq(catalogueImages.id, p.quoteImageId!) }))!;
    expect(img.contentType).toMatch(/^image\/(jpeg|png)$/);
    expect(img.sourceUrl).toMatch(/^https:\/\/www\.vigi\.com\//);
    const wd = (await db.query.products.findFirst({ where: eq(products.model, "WD43PURZ") }))!;
    expect(wd.quoteDisplayName).toBe("WD Purple 4 TB Surveillance Hard Drive");
    expect(wd.quoteImageId).toBeTruthy();
  });

  it("never overwrites what Chris entered", async () => {
    const p = (await db.query.products.findFirst({ where: eq(products.model, "VIGI NVR1004H-4P") }))!;
    await db.update(products).set({ quoteDisplayName: `Chris's name ${RUN}` }).where(eq(products.id, p.id));
    resetStarterMarker();
    const content = { version: 99, products: [{ manufacturer: "TP-Link", model: "VIGI NVR1004H-4P", quoteDisplayName: "Other", quoteDescription: "Other", quoteHighlights: ["x"], quoteFeatureNotes: null, image: null, imageSourceUrl: null }] };
    // Even when the product has not been marked done, an entered value stays.
    const { appSettings } = await import("@/db/schema");
    const before = await db.query.appSettings.findFirst({ where: eq(appSettings.key, "proposal_starter_content") });
    await db.update(appSettings).set({ value: { done: [] } }).where(eq(appSettings.key, "proposal_starter_content"));
    await applyStarterContent(content);
    const after = (await db.query.products.findFirst({ where: eq(products.id, p.id) }))!;
    expect(after.quoteDisplayName).toBe(`Chris's name ${RUN}`);
    if (before) await db.update(appSettings).set({ value: before.value }).where(eq(appSettings.key, "proposal_starter_content"));
    await db.update(products).set({ quoteDisplayName: p.quoteDisplayName }).where(eq(products.id, p.id));
    resetStarterMarker();
  });
});

describe("proposal PDF from the approved quote", () => {
  it("is not made before Chris approves the quote; a preview is marked as a draft and stored nowhere", async () => {
    await expect(proposals.generateProposal(quoteId, chris)).rejects.toThrow(/Approve the quote first/);
    const p = await proposals.previewProposal(quoteId);
    expect(p.content.subarray(0, 5).toString()).toBe("%PDF-");
    expect(await db.select().from(quoteDocuments).where(eq(quoteDocuments.quoteId, quoteId))).toHaveLength(0);
    const { data } = await proposals.proposalInputs(quoteId, { draft: true });
    expect(data.draft).toBe(true);
  });

  it("agents cannot make one", async () => {
    await expect(proposals.generateProposal(quoteId, HERMES)).rejects.toBeInstanceOf(GuardrailError);
  });

  it("approval → PDF made from the approved quote, stored, attached to the prepared email; nothing sent", async () => {
    await quoting.approveQuote(quoteId, chris);
    const r = await proposals.generateProposal(quoteId, chris);
    expect(r.attachedTo).toContain(draftId);
    const doc = (await db.query.quoteDocuments.findFirst({ where: eq(quoteDocuments.id, r.documentId) }))!;
    const q = (await db.query.quotes.findFirst({ where: eq(quotes.id, quoteId) }))!;
    expect(doc.approvalHash).toBe(q.approvalHash);
    expect(doc.content.subarray(0, 5).toString()).toBe("%PDF-");
    expect(doc.filename).toBe(`Get-Secure-Proposal-Q-${q.number}-Aroha-Ngata-${RUN}.pdf`);
    expect(await proposals.currentProposal(quoteId)).toMatchObject({ id: doc.id });
    const d = (await db.query.drafts.findFirst({ where: eq(drafts.id, draftId) }))!;
    expect(d).toMatchObject({ quoteDocumentId: doc.id, status: "ready_for_review" });
    expect(q.status).toBe("approved"); // not sent

    // What was printed: the approved lines and totals, friendly product names, and no internal data.
    const data = doc.data as unknown as import("@/lib/proposals/data").ProposalData;
    expect(data.items.map((i) => i.quantity)).toEqual(q.lineItems.map((l) => Number(l.quantity)));
    expect(data.totals.totalIncGst).toBe(Number(q.total));
    expect(data.coverage).toEqual(["Driveway", "Front door", "Side gate", "Backyard"]);
    expect(data.products.map((p) => p.category).sort()).toEqual(expect.arrayContaining(["camera", "hdd", "nvr"]));
    expect(data.products.every((p) => p.category !== "junction_box")).toBe(true);
    expect(data.installation?.description).toBe("Installation, commissioning, cabling and standard installation materials");
    expect(data.notes.flatMap((n) => n.items).join(" ")).toMatch(/Recording duration depends on camera settings, recording configuration and scene activity/i);
    const json = JSON.stringify(data);
    expect(json).not.toMatch(/IT Plus|supplier|sku|costExGst|unitCost|totalInternal|markup|margin|grossProfit|labourCost|labourRate|estimatedHours|"hours"|"rate"|complexity|allowance|routeNote|freshness|unitPrice/i);
    const offers = await db.select({ sku: supplierProducts.supplierSku }).from(supplierProducts).where(inArray(supplierProducts.id, offerIds));
    for (const o of offers) if (o.sku) expect(json).not.toContain(o.sku);
  });

  it("the email can be approved with its PDF; sending attaches exactly that PDF", async () => {
    await drafting.approveDraft(draftId, chris);
    const sink = await startSmtpSink(SMTP_PORT);
    try {
      await drafting.sendDraft(draftId, chris);
      expect(sink.messages).toHaveLength(1);
      const raw = sink.messages[0].raw;
      const doc = (await proposals.currentProposal(quoteId))!;
      expect(raw).toContain(`filename=${doc.filename}`);
      expect(raw).toMatch(/Content-Type: application\/pdf/);
      expect(raw).toContain(Buffer.from((await proposals.proposalFile(doc.id)).content).toString("base64").slice(0, 60));
    } finally {
      await sink.stop();
    }
  });

  it("repricing voids the PDF; an email carrying it cannot be approved or sent until the quote is approved again", async () => {
    // A fresh prepared email for the same lead, attached to the current PDF and approved.
    const d2 = await drafting.createDraft({ leadId, assessmentId: null, to: [`aroha+${RUN}@example.com`], subject: `Follow-up ${RUN}`, body: "Hi Aroha" }, staff, { submit: true });
    await proposals.attachProposalToDraft(d2.id, quoteId, staff);
    await drafting.approveDraft(d2.id, chris);
    const old = (await proposals.currentProposal(quoteId))!;

    await brain.repriceQuote(quoteId, staff);
    expect(await proposals.currentProposal(quoteId)).toBeNull();
    expect((await db.query.quoteDocuments.findFirst({ where: eq(quoteDocuments.id, old.id) }))!.voidedAt).toBeTruthy();
    const after = (await db.query.drafts.findFirst({ where: eq(drafts.id, d2.id) }))!;
    expect(after.status).toBe("ready_for_review");
    expect(after.approvalHash).toBeNull();
    await expect(drafting.approveDraft(d2.id, chris)).rejects.toThrow(/no longer valid/);
    await expect(proposals.attachmentForDraft(old.id)).rejects.toBeInstanceOf(GuardrailError);

    // Approve again: a new PDF from the new snapshot, and the email moves to it.
    await quoting.approveQuote(quoteId, chris);
    const r = await proposals.generateProposal(quoteId, chris);
    expect(r.documentId).not.toBe(old.id);
    expect(r.attachedTo).toContain(d2.id);
    expect((await db.query.drafts.findFirst({ where: eq(drafts.id, d2.id) }))!.quoteDocumentId).toBe(r.documentId);
    await drafting.approveDraft(d2.id, chris);
  });

  it("editing the approved quote voids the PDF too", async () => {
    const q = (await db.query.quotes.findFirst({ where: eq(quotes.id, quoteId) }))!;
    const doc = (await proposals.currentProposal(quoteId))!;
    await quoting.updateQuoteContent(quoteId, { lineItems: q.lineItems.map((l, i) => (i === 0 ? { ...l, quantity: Number(l.quantity) + 1 } : l)) }, chris);
    expect(await proposals.currentProposal(quoteId)).toBeNull();
    expect((await proposals.proposalFile(doc.id)).current).toBe(false);
  });
});
