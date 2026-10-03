/**
 * Business Brain real costing against the database: exact installation packages, approved CCTV
 * kits and their default HDD, the first fully priced 4-camera quote end to end, Not fully priced
 * when an input is missing, reprice (back to Needs Review), and trade-only price imports.
 *
 * Every cost, kit and package value here is a TEST VALUE, entered the way Chris would;
 * the seeded data has none, and the seeded package is put back afterwards.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray } from "drizzle-orm";

process.env.AI_PROVIDER = "rules";

const { db } = await import("@/db");
const { drafts, installationPackages, leads, products, quotes, cctvKits, supplierProducts, suppliers, users } = await import("@/db/schema");
const brain = await import("@/lib/brain/store");
const quoting = await import("@/lib/quotes/workflow");
const { applyReferenceCatalogue, resetReferenceMarker } = await import("@/lib/brain/reference/apply");
const { importListings, parseSupplierCsv } = await import("@/lib/brain/suppliers/adapters");
const { house } = await import("../unit/brain-fixtures");

const RUN = `rc${Date.now().toString(36)}`;
let chris: { kind: "human"; userId: string; name: string; canApprove: true };
let staff: { kind: "human"; userId: string; name: string; canApprove: false };
let leadId: string;
const kitIds: string[] = [];
let pkgBefore: typeof installationPackages.$inferSelect;
const offerIds: string[] = [];
const quoteIds: string[] = [];

const supplier = async (name: string) => (await db.query.suppliers.findFirst({ where: eq(suppliers.name, name) }))!;
const vigi = async () => db.select().from(products).where(and(eq(products.family, "TP-Link VIGI")));

beforeAll(async () => {
  resetReferenceMarker();
  await applyReferenceCatalogue();
  const [c] = await db.insert(users).values({ email: `chris-${RUN}@test.local`, name: "Chris", passwordHash: "x", role: "admin", canApprove: true }).returning();
  const [s] = await db.insert(users).values({ email: `staff-${RUN}@test.local`, name: "Office", passwordHash: "x", role: "member" }).returning();
  chris = { kind: "human", userId: c.id, name: c.name, canApprove: true };
  staff = { kind: "human", userId: s.id, name: s.name, canApprove: false };
  const [l] = await db.insert(leads).values({ name: `Tama Whaanga ${RUN}`, email: `tama+${RUN}@example.com`, site: "9 Totara Ave, Mt Albert", service: "CCTV", status: "new", source: "website" }).returning();
  leadId = l.id;

  // Trade prices for the VIGI range and drives (TEST VALUES), entered by Chris so they are approved.
  const it = await supplier("IT Plus");
  for (const row of [...(await vigi()), ...(await db.select().from(products).where(eq(products.category, "hdd")))]) {
    const cost = row.category === "camera" ? 120 : row.category === "nvr" ? 210 : row.category === "hdd" ? 60 + 25 * Number((row.specs as { capacityTb?: number }).capacityTb ?? 1) : null;
    if (cost == null) continue;
    const r = await brain.recordSupplierPrice({ productId: row.id, supplierId: it.id, costExGst: cost, stock: "In stock", source: "integration test" }, chris);
    offerIds.push(r.offerId);
  }

  pkgBefore = (await db.query.installationPackages.findFirst({ where: eq(installationPackages.key, "RES_CCTV_SINGLE_4") }))!;
});

afterAll(async () => {
  if (quoteIds.length) await db.delete(quotes).where(inArray(quotes.id, quoteIds));
  await db.delete(drafts).where(eq(drafts.leadId, leadId));
  await db.delete(leads).where(eq(leads.id, leadId));
  if (offerIds.length) await db.delete(supplierProducts).where(inArray(supplierProducts.id, offerIds));
  if (kitIds.length) await db.delete(cctvKits).where(inArray(cctvKits.id, kitIds));
  if (pkgBefore) {
    const { id, ...rest } = pkgBefore;
    await db.update(installationPackages).set(rest).where(eq(installationPackages.id, id));
  }
  await db.delete(users).where(inArray(users.id, [chris.userId, staff.userId]));
  resetReferenceMarker();
});

const fillPackage = (over: Partial<typeof installationPackages.$inferInsert> = {}) =>
  db
    .update(installationPackages)
    .set({ estimatedHours: "6.00", labourRate: "95.00", materialCostExGst: "80.00", complexityAllowanceExGst: "0.00", allowanceExGst: "790.00", status: "getsecure_approved", ...over })
    .where(eq(installationPackages.key, "RES_CCTV_SINGLE_4"));

describe("seeded v0.3 data", () => {
  it("has the eight exact-count residential packages, unpriced", async () => {
    const rows = await db.select().from(installationPackages).where(inArray(installationPackages.key, ["RES_CCTV_SINGLE_2", "RES_CCTV_SINGLE_4", "RES_CCTV_SINGLE_6", "RES_CCTV_SINGLE_8", "RES_CCTV_DOUBLE_2", "RES_CCTV_DOUBLE_4", "RES_CCTV_DOUBLE_6", "RES_CCTV_DOUBLE_8"]));
    expect(rows).toHaveLength(8);
    for (const r of rows) {
      expect(r.cameraCount).toBe(Number(r.key!.split("_").pop()));
      expect(r.storeyType).toBe(r.key!.includes("DOUBLE") ? "double" : "single");
    }
    expect(pkgBefore.estimatedHours).toBeNull();
    expect(pkgBefore.allowanceExGst).toBeNull();
    expect(Number(pkgBefore.labourRate)).toBe(95);
    const ranges = await db.select().from(installationPackages).where(eq(installationPackages.source, "Get Secure CCTV Business Brain v0.2 (Chris): package structure"));
    expect(ranges.every((r) => r.status === "deprecated")).toBe(true);
  });
  it("no longer quotes from recording profiles: the catalogue carries approved kits instead", async () => {
    const cat = await brain.loadCatalogue();
    expect(cat).not.toHaveProperty("recordingProfiles");
    expect(Array.isArray(cat.kits)).toBe(true);
    expect(Object.keys(await brain.loadPolicies())).not.toEqual(expect.arrayContaining(["retentionTargetDays"]));
  });

  it("has the four IP upgrade packages, empty and needing approval", async () => {
    const rows = await db.select().from(installationPackages).where(inArray(installationPackages.key, ["RES_CCTV_UPGRADE_IP_2", "RES_CCTV_UPGRADE_IP_4", "RES_CCTV_UPGRADE_IP_6", "RES_CCTV_UPGRADE_IP_8"]));
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect(r).toMatchObject({ installType: "upgrade_ip", storeyType: null, status: "requires_review", estimatedHours: null, materialCostExGst: null, complexityAllowanceExGst: null, allowanceExGst: null });
      expect(r.cameraCount).toBe(Number(r.key!.split("_").pop()));
    }
  });
});

describe("first genuinely priced 4-camera residential quote", () => {
  it("is Not fully priced, saying why, while the package values are missing", async () => {
    const a = await brain.runAssessment(leadId, house({ requestedTier: "good" }), staff);
    expect(a.packet.costing.complete).toBe(false);
    expect(a.packet.costing.unpriced.join(" ")).toMatch(/RES_CCTV_SINGLE_4: labour hours not set/);
    expect(a.packet.costing.unpriced.join(" ")).toMatch(/customer sell allowance not set/);
  });

  it("with every input entered: real products, BOM, current costs, labour, materials, markup, margin, quote and email drafts, Chris approval", async () => {
    await fillPackage();
    const a = await brain.runAssessment(leadId, house({ requestedTier: "good", customerName: "Tama Whaanga" }), staff);
    const p = a.packet;
    expect(p.cameras.every((c) => c.product?.family === "TP-Link VIGI")).toBe(true);
    expect(p.nvr.selected?.family).toBe("TP-Link VIGI");
    expect(p.kit).toBeNull();
    expect(p.recording.storage).toMatchObject({ selection: "fallback", capacityTb: 2, installedTb: 2 }); // no kit: 4-camera fallback 2 TB
    expect(p.labour.package?.key).toBe("RES_CCTV_SINGLE_4");
    expect(p.costing.complete).toBe(true);
    expect(p.costing.refreshRequired).toEqual([]);
    expect(p.costing.labourCost).toBe(570);
    expect(p.costing.materialsCost).toBe(80);
    expect(p.costing.grossProfit).toBeGreaterThan(0);
    expect(p.costing.grossMarginPct).toBeGreaterThan(0);
    expect(p.approvals.map((x) => x.key)).toEqual(expect.arrayContaining(["customer_email", "quote"]));

    const { quoteId, draftId } = await brain.prepareFromAssessment(a.id, { quote: true, email: true }, staff);
    quoteIds.push(quoteId!);
    expect(draftId).toBeTruthy();
    const q = (await db.query.quotes.findFirst({ where: eq(quotes.id, quoteId!) }))!;
    expect(q.status).toBe("needs_review");
    const snap = q.internalCosting as Record<string, unknown> & { lines: { model: string | null; supplier: string | null; supplierSku: string | null; unitCostExGst: number | null; lastChecked: string | null; markupPct: number | null; unitSellExGst: number | null }[]; labour: Record<string, unknown> };
    expect(snap.complete).toBe(true);
    expect(snap.lines.find((l) => l.model?.includes("NVR"))).toMatchObject({ supplier: "IT Plus", unitCostExGst: 210 });
    expect(snap.lines.every((l) => !l.model || l.lastChecked)).toBe(true);
    expect(snap.labour).toMatchObject({ packageKey: "RES_CCTV_SINGLE_4", hours: 6, rate: 95, labourCost: 570, materialCost: 80, sellAllowance: 790 });
    expect(snap.markupPct).toBe(25);
    expect(typeof snap.sellExGst).toBe("number");
    expect(JSON.stringify(q.lineItems)).not.toMatch(/IT Plus|cost|margin|internal/i);
    await expect(quoting.approveQuote(quoteId!, staff)).rejects.toThrow();
    await quoting.approveQuote(quoteId!, chris);
    expect((await db.query.quotes.findFirst({ where: eq(quotes.id, quoteId!) }))!.status).toBe("approved");
  });

  it("reprice with a new supplier cost replaces the snapshot and sends the quote back to Needs Review", async () => {
    const quoteId = quoteIds[quoteIds.length - 1];
    const before = (await db.query.quotes.findFirst({ where: eq(quotes.id, quoteId) }))!;
    // Every VIGI recorder's cost moves (so whichever is chosen, the new cost shows).
    for (const row of (await vigi()).filter((x) => x.category === "nvr")) {
      await brain.recordSupplierPrice({ productId: row.id, supplierId: (await supplier("IT Plus")).id, costExGst: 215, source: "integration test" }, chris);
    }
    // A price change alone does not touch the approved quote.
    const still = (await db.query.quotes.findFirst({ where: eq(quotes.id, quoteId) }))!;
    expect(still.status).toBe("approved");
    expect(still.internalCosting).toEqual(before.internalCosting);

    const r = await brain.repriceQuote(quoteId, staff);
    expect(r.complete).toBe(true);
    const after = (await db.query.quotes.findFirst({ where: eq(quotes.id, quoteId) }))!;
    expect(after.status).toBe("needs_review");
    expect(after.approvedById).toBeNull();
    expect(after.approvalHash).toBeNull();
    expect((after.internalCosting as { lines: { model: string | null; unitCostExGst: number | null }[] }).lines.find((l) => l.model?.includes("NVR"))?.unitCostExGst).toBe(215);
    expect(after.assessmentId).not.toBe(before.assessmentId);
  });

  it("is Not fully priced again as soon as a required input is removed, and then cannot be approved", async () => {
    await fillPackage({ materialCostExGst: null });
    const a = await brain.runAssessment(leadId, house({ requestedTier: "good" }), staff);
    expect(a.packet.costing.complete).toBe(false);
    expect(a.packet.costing.unpriced).toContain("RES_CCTV_SINGLE_4: standard material cost not set");
    // The labour that is known still counts in the internal cost (6 h x $95).
    expect(a.packet.costing.labourCost).toBe(570);
    expect(a.packet.costing.totalInternalCost).toBe(Math.round((a.packet.costing.equipmentCost + 570 + a.packet.costing.allowancesCost + a.packet.costing.otherCost) * 100) / 100);
    expect(a.packet.readiness.ready).toBe(false);
    expect(a.packet.readiness.items.find((i) => i.key === "installation_package")).toMatchObject({ ok: false, detail: expect.stringMatching(/standard material cost not set/) });
    const { quoteId } = await brain.prepareFromAssessment(a.id, { quote: true }, staff);
    quoteIds.push(quoteId!);
    await expect(quoting.approveQuote(quoteId!, chris)).rejects.toThrow(/Not fully priced: .*standard material cost not set/);
  });

  it("lists every input still to enter or approve before the first real quote", async () => {
    await fillPackage({ status: "requires_review" });
    const a = await brain.runAssessment(leadId, house({ requestedTier: "good" }), staff);
    const r = a.packet.readiness;
    const item = (k: string) => r.items.find((i) => i.key === k)!;
    expect(a.packet.costing.complete).toBe(true); // every value is entered…
    expect(r.ready).toBe(false); // …but not everything is approved
    expect(item("supplier_prices").ok).toBe(true);
    expect(r.items.some((i) => i.key === "recording_profile")).toBe(false);
    expect(item("storage")).toMatchObject({ ok: true, detail: expect.stringMatching(/^2 TB .*fallback by camera count/) });
    expect(item("recorder").ok).toBe(true);
    expect(item("installation_package")).toMatchObject({ ok: false, detail: expect.stringMatching(/RES_CCTV_SINGLE_4: requires review/) });
    expect(item("markup")).toMatchObject({ ok: false, detail: "25% is the provisional suggestion.", fix: expect.stringMatching(/Markup override/) });
    expect(item("rules")).toMatchObject({ ok: false, detail: expect.stringMatching(/priceAgingDays = 14/) });
    // Chris's exact markup for this quote settles the markup item.
    const b = await brain.runAssessment(leadId, house({ requestedTier: "good" }), chris, { markupOverride: 30 });
    expect(b.packet.readiness.items.find((i) => i.key === "markup")).toMatchObject({ ok: true, detail: "30% entered for this quote." });
  });
});

describe("approved CCTV kits", () => {
  const drive = async (tb: number) =>
    (await db.select().from(products).where(eq(products.category, "hdd"))).find((d) => Number((d.specs as { capacityTb?: number }).capacityTb) === tb && (d.specs as { surveillanceRated?: boolean }).surveillanceRated !== false)!;
  const addKit = async (over: Partial<typeof cctvKits.$inferInsert>) => {
    const base = (await brain.runAssessment(leadId, house({ requestedTier: "good" }), staff)).packet;
    const [k] = await db
      .insert(cctvKits)
      .values({
        key: `KIT_${RUN.toUpperCase()}_${kitIds.length}`,
        name: `Test kit ${kitIds.length}`,
        propertyType: "residential",
        tier: "good",
        cameraCount: 4,
        cameraProductId: base.cameras[0].product!.id,
        nvrProductId: base.nvr.selected!.id,
        status: "getsecure_approved",
        approvedById: chris.userId,
        source: "integration test",
        ...over,
      })
      .returning();
    kitIds.push(k.id);
    return k;
  };
  afterAll(async () => {
    if (kitIds.length) await db.delete(cctvKits).where(inArray(cctvKits.id, kitIds));
    kitIds.length = 0;
  });

  it("uses the approved kit's default HDD, never resized by the camera-count fallback", async () => {
    const hdd4 = await drive(4);
    const k = await addKit({ defaultHddProductId: hdd4.id, defaultHddTb: "4.00" });
    const p = (await brain.runAssessment(leadId, house({ requestedTier: "good" }), staff)).packet;
    expect(p.kit).toMatchObject({ id: k.id, name: k.name });
    expect(p.recording.storage).toMatchObject({ selection: "kit", capacityTb: 4, installedTb: 4 });
    expect(p.recording.storage.drives?.product.id).toBe(hdd4.id);
    expect(p.readiness.items.find((i) => i.key === "storage")).toMatchObject({ ok: true, detail: expect.stringMatching(/kit default/) });
    expect(p.readiness.items.find((i) => i.key === "kit")?.detail).toContain(k.name);
    await db.delete(cctvKits).where(eq(cctvKits.id, k.id));
  });

  it("Chris's HDD choice on the assessment beats the kit", async () => {
    const hdd4 = await drive(4);
    await addKit({ defaultHddProductId: hdd4.id, defaultHddTb: "4.00" });
    const p = (await brain.runAssessment(leadId, house({ requestedTier: "good", hddOverride: { capacityTb: 2 } }), staff)).packet;
    expect(p.recording.storage).toMatchObject({ selection: "override", capacityTb: 2, installedTb: 2 });
  });

  it("ignores a kit that is not approved", async () => {
    await db.delete(cctvKits).where(inArray(cctvKits.id, kitIds));
    await addKit({ status: "requires_review", approvedById: null, defaultHddTb: "8.00" });
    const p = (await brain.runAssessment(leadId, house({ requestedTier: "good" }), staff)).packet;
    expect(p.kit).toBeNull();
    expect(p.recording.storage.selection).toBe("fallback");
  });

  it("promises no retention: a customer's days are a custom requirement for Chris", async () => {
    const p = (await brain.runAssessment(leadId, house({ requestedTier: "good", retentionDays: 28 }), staff)).packet;
    expect(p.recording.storage.customerRetentionDays).toBe(28);
    expect(p.approvals.map((a) => a.key)).toContain("custom_retention");
    expect(JSON.stringify(p.sales)).not.toMatch(/28 days|approximately \d+ days/);
  });
});

describe("trade prices only", () => {
  it("refuses an import not confirmed as trade pricing", async () => {
    const it = await supplier("IT Plus");
    const { listings } = parseSupplierCsv("Model,Cost ex GST\nVIGI C340(2.8mm),100\n");
    await expect(importListings(it.id, listings, chris, { type: "csv", label: "t", confirmedTrade: false })).rejects.toThrow(/trade/);
  });
  it("never reads a retail/RRP column as cost", () => {
    expect(parseSupplierCsv("Model,RRP ex GST\nVIGI C340(2.8mm),199\n").errors.join(" ")).toMatch(/Only trade/);
    const both = parseSupplierCsv("Model,Trade ex GST,RRP ex GST\nVIGI C340(2.8mm),100,199\n");
    expect(both.listings[0].costExGst).toBe(100);
  });
});
