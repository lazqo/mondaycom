/**
 * Business Brain v0.2 against the real database: the seeded supplier registry and brand routes,
 * the reference catalogue (applied once, never resurrected), CSV price import, price freshness at
 * quote approval, price snapshots on prepared quotes, and supplier credentials kept from agents.
 *
 * Costs here are TEST VALUES, not real trade prices.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray } from "drizzle-orm";


const { db } = await import("@/db");
const { leads, users, quotes, products, supplierProducts, suppliers, supplierBrandRoutes, supplierCredentials, installationPackages, materialsPackages } = await import("@/db/schema");
const { GuardrailError } = await import("@/lib/guard/actor");
const { encryptSecret } = await import("@/lib/crypto");
const brain = await import("@/lib/brain/store");
const quoting = await import("@/lib/quotes/workflow");
const { applyReferenceCatalogue, resetReferenceMarker, REFERENCE, refKey } = await import("@/lib/brain/reference/apply");
const { getSupplierCredential, SUPPLIER_SYNC_PROCESS } = await import("@/lib/brain/suppliers/credentials");
const { importListings, parseSupplierCsv, syncSupplierPrices } = await import("@/lib/brain/suppliers/adapters");
const { house } = await import("../unit/brain-fixtures");

const RUN = `bc${Date.now().toString(36)}`;
const HERMES = { kind: "agent" as const, agent: "hermes" };
let chris: { kind: "human"; userId: string; name: string; canApprove: true };
let staff: { kind: "human"; userId: string; name: string; canApprove: false };
let leadId: string;
const offerIds: string[] = [];
const quoteIds: string[] = [];
const supplier = async (name: string) => (await db.query.suppliers.findFirst({ where: eq(suppliers.name, name) }))!;
const productId = async (manufacturer: string, model: string) => (await db.query.products.findFirst({ where: and(eq(products.manufacturer, manufacturer), eq(products.model, model)) }))!.id;

beforeAll(async () => {
  resetReferenceMarker();
  await applyReferenceCatalogue();
  const [c] = await db.insert(users).values({ email: `chris-${RUN}@test.local`, name: "Chris", passwordHash: "x", role: "admin", canApprove: true }).returning();
  const [s] = await db.insert(users).values({ email: `staff-${RUN}@test.local`, name: "Office", passwordHash: "x", role: "member" }).returning();
  chris = { kind: "human", userId: c.id, name: c.name, canApprove: true };
  staff = { kind: "human", userId: s.id, name: s.name, canApprove: false };
  const [l] = await db.insert(leads).values({ name: `Aroha Ngata ${RUN}`, email: `aroha+${RUN}@example.com`, site: "3 Rimu Street, Mt Eden", service: "CCTV", status: "new", source: "website" }).returning();
  leadId = l.id;
});

afterAll(async () => {
  if (quoteIds.length) await db.delete(quotes).where(inArray(quotes.id, quoteIds));
  await db.delete(leads).where(eq(leads.id, leadId));
  if (offerIds.length) await db.delete(supplierProducts).where(inArray(supplierProducts.id, offerIds));
  await db.delete(products).where(eq(products.manufacturer, `Test Maker ${RUN}`));
  await db.delete(users).where(inArray(users.id, [chris.userId, staff.userId]));
  resetReferenceMarker();
});

describe("supplier registry", () => {
  it("has the six current Get Secure suppliers approved, IT Plus as default, older ones only as history", async () => {
    const rows = await db.query.suppliers.findMany();
    const current = ["IT Plus", "Clear Digital", "SWL / Security Wholesale", "Atlas Gentech", "IOT Technologies", "Vesta Electrical"];
    for (const n of current) expect(rows.find((r) => r.name === n)?.status, n).toBe("getsecure_approved");
    expect(rows.filter((r) => r.isDefault).map((r) => r.name)).toEqual(["IT Plus"]);
    for (const n of ["Play Digital", "Dicker Data"]) {
      const r = rows.find((x) => x.name === n);
      if (r) expect(r.status).toBe("deprecated");
    }
  });
  it("stores the starting brand routing matrix as editable preference data", async () => {
    const rows = await db.select({ r: supplierBrandRoutes, s: suppliers.name }).from(supplierBrandRoutes).innerJoin(suppliers, eq(supplierBrandRoutes.supplierId, suppliers.id));
    const route = (brand: string) =>
      rows
        .filter((x) => x.r.brand === brand && x.r.market !== "commercial")
        .sort((a, b) => a.r.rank - b.r.rank)
        .map((x) => x.s)
        .join(" / ");
    const expected: Record<string, string> = {
      "TP-Link VIGI": "IT Plus",
      HiLook: "IT Plus",
      Hikvision: "IT Plus",
      TVT: "IT Plus",
      Tiandy: "IOT Technologies",
      Dahua: "Clear Digital / IOT Technologies",
      Ajax: "Clear Digital / IOT Technologies",
      Uniview: "IT Plus / Clear Digital / IOT Technologies",
      Axis: "Atlas Gentech",
      Hanwha: "Atlas Gentech",
      "Inner Range": "Atlas Gentech",
      AAP: "IT Plus",
      Akuvox: "IT Plus / IOT Technologies",
      Gallagher: "Clear Digital",
      Aiphone: "Clear Digital",
      "Provision-ISR": "SWL / Security Wholesale",
    };
    for (const [brand, want] of Object.entries(expected)) expect(route(brand), brand).toBe(want);
    // Commercial-only alternative from the brief.
    expect(rows.filter((x) => x.r.brand === "Hikvision" && x.r.market === "commercial").map((x) => x.s)).toEqual(["Atlas Gentech"]);
    expect(rows.every((x) => x.r.status === "getsecure_approved")).toBe(true);
  });
  it("never quotes from a deprecated supplier's listing", async () => {
    const old = await db.query.suppliers.findFirst({ where: eq(suppliers.name, "Play Digital") });
    if (!old) return;
    const pid = await productId("TP-Link", "VIGI C340(2.8mm)");
    const r = await brain.recordSupplierPrice({ productId: pid, supplierId: old.id, costExGst: 1, source: "test" }, chris);
    offerIds.push(r.offerId);
    const cat = await brain.loadCatalogue();
    expect(cat.products.find((p) => p.id === pid)!.offers!.some((o) => o.supplier === "Play Digital")).toBe(false);
  });
});

describe("installation and materials packages", () => {
  it("has the eight residential packages, unpriced and unapproved, with the $95 rate", async () => {
    const pkgs = await db.query.installationPackages.findMany({ where: eq(installationPackages.propertyType, "residential") });
    const seeded = pkgs.filter((p) => p.name.startsWith("Residential ") && p.installType === "new");
    expect(seeded).toHaveLength(8);
    expect(pkgs.filter((p) => p.installType === "upgrade_ip").map((p) => p.key).sort()).toEqual(["RES_CCTV_UPGRADE_IP_2", "RES_CCTV_UPGRADE_IP_4", "RES_CCTV_UPGRADE_IP_6", "RES_CCTV_UPGRADE_IP_8"]);
    expect(seeded.every((p) => p.estimatedHours == null && p.allowanceExGst == null && p.status === "requires_review" && Number(p.labourRate) === 95)).toBe(true);
    expect(seeded.filter((p) => p.storeys === 2).every((p) => p.conduitIncluded)).toBe(true);
  });
  it("has a standard materials package with contents and no value yet", async () => {
    const m = await db.query.materialsPackages.findFirst({ where: eq(materialsPackages.isDefault, true) });
    expect(m?.customerDescription).toBe("Cabling and standard installation materials");
    expect(m?.items.map((i) => i.description)).toEqual(expect.arrayContaining(["Normal Cat6 allowance", "Connectors", "Weatherproofing and entry consumables"]));
  });
});

describe("reference catalogue", () => {
  it("is in the catalogue as manufacturer-verified products with their sources, unpriced", async () => {
    const keys = new Set((await db.select({ manufacturer: products.manufacturer, model: products.model }).from(products)).map(refKey));
    expect(REFERENCE.products.every((p) => keys.has(refKey(p)))).toBe(true);
    const c445 = await db.query.products.findFirst({ where: eq(products.model, "VIGI C445(2.8mm)") });
    expect(c445).toMatchObject({ status: "manufacturer_verified", family: "TP-Link VIGI", tier: "good", tierStatus: "getsecure_provisional" });
    expect(c445?.sourceUrl).toMatch(/^https:\/\//);
  });
  it("adds each product once and never re-adds one Get Secure deleted", async () => {
    const one = { ...REFERENCE.products[0], manufacturer: `Test Maker ${RUN}`, model: "TM-1" };
    expect((await applyReferenceCatalogue({ version: `${RUN}-a`, products: [one], links: [] })).added).toBe(1);
    expect((await applyReferenceCatalogue({ version: `${RUN}-b`, products: [one], links: [] })).added).toBe(0);
    await db.delete(products).where(eq(products.manufacturer, `Test Maker ${RUN}`));
    expect((await applyReferenceCatalogue({ version: `${RUN}-c`, products: [one], links: [] })).added).toBe(0);
    expect(await db.query.products.findFirst({ where: eq(products.manufacturer, `Test Maker ${RUN}`) })).toBeUndefined();
    resetReferenceMarker();
  });
});

describe("supplier prices", () => {
  it("imports a CSV price list: matched by model, normalised to ex GST, unapproved, big changes held", async () => {
    const it = await supplier("IT Plus");
    const csv = `Manufacturer,Model,SKU,Cost inc GST,Stock\nTP-Link,VIGI C455(2.8mm),TEST-${RUN},230.00,12\nNobody,NOT-A-PRODUCT,X1,10,1\n`;
    const parsed = parseSupplierCsv(csv);
    expect(parsed.listings).toHaveLength(2);
    const r1 = await importListings(it.id, parsed.listings, chris, { type: "csv", label: "test import", confirmedTrade: true });
    expect(r1).toMatchObject({ recorded: 1, held: 0 });
    expect(r1.unmatched).toEqual(["Nobody NOT-A-PRODUCT"]);
    const pid = await productId("TP-Link", "VIGI C455(2.8mm)");
    let offer = (await db.query.supplierProducts.findFirst({ where: and(eq(supplierProducts.productId, pid), eq(supplierProducts.supplierId, it.id)) }))!;
    offerIds.push(offer.id);
    expect(Number(offer.costExGst)).toBe(200);
    expect(offer.priceApproved).toBe(false); // an import is never its own review, even by Chris
    expect(offer.priceSource).toBe("csv");
    await brain.approveSupplierPrice(offer.id, chris);
    const r2 = await importListings(it.id, parseSupplierCsv(`SKU,Cost ex GST\nTEST-${RUN},260\n`).listings, chris, { type: "csv", label: "test import", confirmedTrade: true });
    expect(r2.held).toBe(1);
    offer = (await db.query.supplierProducts.findFirst({ where: eq(supplierProducts.id, offer.id) }))!;
    expect(Number(offer.costExGst)).toBe(200);
    expect(Number(offer.pendingCostExGst)).toBe(260);
    expect(offer.priceApproved).toBe(true);
  });
  it("refuses imports from an agent", async () => {
    await expect(importListings((await supplier("IT Plus")).id, [], HERMES, { type: "csv", label: "x", confirmedTrade: true })).rejects.toBeInstanceOf(GuardrailError);
  });
  it("records price-on-application listings without a cost", async () => {
    const r = await brain.recordSupplierPrice({ productId: await productId("Axis Communications", "AXIS M3216-LVE"), supplierId: (await supplier("Atlas Gentech")).id, priceOnApplication: true, source: "test" }, chris);
    offerIds.push(r.offerId);
    const o = (await db.query.supplierProducts.findFirst({ where: eq(supplierProducts.id, r.offerId) }))!;
    expect(o.priceOnApplication).toBe(true);
    expect(o.costExGst).toBeNull();
  });
  it("loads routes into the catalogue so the preferred supplier is quoted", async () => {
    const pid = await productId("Hikvision", "DS-2CD2386G2-IU (2.8mm)");
    for (const [name, cost] of [
      ["IT Plus", 300],
      ["Atlas Gentech", 250],
    ] as const) {
      const r = await brain.recordSupplierPrice({ productId: pid, supplierId: (await supplier(name)).id, costExGst: cost, source: "test" }, chris);
      offerIds.push(r.offerId);
    }
    const cat = await brain.loadCatalogue();
    const { priceCatalogue } = await import("@/lib/brain/pricing");
    const priced = priceCatalogue(cat, "residential", await brain.loadPolicies(), new Date());
    expect(priced.products.find((p) => p.id === pid)!.price).toMatchObject({ supplier: "IT Plus", costExGst: 300, routeRank: 1 });
  });
});

describe("prepared quotes", () => {
  async function priceVigiSystem(lastChecked: Date) {
    const it = await supplier("IT Plus");
    for (const [m, model, cost] of [
      ["TP-Link", "VIGI C350(2.8mm)", 120],
      ["TP-Link", "VIGI C350(4mm)", 120],
      ["TP-Link", "VIGI C350(6mm)", 120],
      ["TP-Link", "VIGI C445(2.8mm)", 130],
      ["TP-Link", "VIGI NVR1004H-4P", 210],
      ["Seagate", "ST10000VE001", 420],
      ["Western Digital", "WD102PURP", 430],
    ] as const) {
      const r = await brain.recordSupplierPrice({ productId: await productId(m, model), supplierId: it.id, costExGst: cost, source: "test" }, chris);
      offerIds.push(r.offerId);
      await db.update(supplierProducts).set({ lastCheckedAt: lastChecked }).where(eq(supplierProducts.id, r.offerId));
    }
  }

  it("keeps the price snapshot it was prepared with when supplier prices change later", async () => {
    await priceVigiSystem(new Date());
    const a = await brain.runAssessment(leadId, house({ requestedTier: "good", customerName: "Aroha Ngata" }), staff);
    const { quoteId } = await brain.prepareFromAssessment(a.id, { quote: true }, staff);
    quoteIds.push(quoteId!);
    // (Approval needs a fully priced quote; brain-costing covers an approved quote's snapshot.)
    const before = (await db.query.quotes.findFirst({ where: eq(quotes.id, quoteId!) }))!;
    const snap = before.internalCosting as { lines: { model: string | null; supplier: string | null; unitCostExGst: number | null; freshness: string | null }[]; snapshotAt: string };
    expect(snap.snapshotAt).toBeTruthy();
    expect(snap.lines.find((l) => l.model?.includes("NVR1004H"))).toMatchObject({ supplier: "IT Plus", unitCostExGst: 210, freshness: "current" });

    // The recorder's cost changes (approver entry, so it applies immediately).
    await brain.recordSupplierPrice({ productId: await productId("TP-Link", "VIGI NVR1004H-4P"), supplierId: (await supplier("IT Plus")).id, costExGst: 260, source: "test" }, chris);
    const after = (await db.query.quotes.findFirst({ where: eq(quotes.id, quoteId!) }))!;
    expect(after.status).toBe(before.status);
    expect(after.lineItems).toEqual(before.lineItems);
    expect(after.internalCosting).toEqual(before.internalCosting);
  });

  it("will not approve a quote whose supplier prices are stale", async () => {
    await priceVigiSystem(new Date(Date.now() - 60 * 86_400_000));
    const a = await brain.runAssessment(leadId, house({ requestedTier: "good", customerName: "Aroha Ngata" }), staff);
    expect(a.packet.approvals.map((x) => x.key)).toContain("price_refresh");
    const { quoteId } = await brain.prepareFromAssessment(a.id, { quote: true }, staff);
    quoteIds.push(quoteId!);
    await expect(quoting.approveQuote(quoteId!, chris)).rejects.toThrow(/Refresh supplier price before final quote approval/);
  });
});

describe("supplier credentials", () => {
  it("are never available to an agent, only to the price-sync job or an approver", async () => {
    const atlas = await supplier("Atlas Gentech");
    await db
      .insert(supplierCredentials)
      .values({ supplierId: atlas.id, username: "gs", secretEncrypted: encryptSecret(`trade-${RUN}`) })
      .onConflictDoUpdate({ target: supplierCredentials.supplierId, set: { secretEncrypted: encryptSecret(`trade-${RUN}`) } });
    await expect(getSupplierCredential(atlas.id, HERMES)).rejects.toBeInstanceOf(GuardrailError);
    await expect(getSupplierCredential(atlas.id, staff)).rejects.toBeInstanceOf(GuardrailError);
    await expect(getSupplierCredential(atlas.id, { kind: "system", process: "automations" })).rejects.toBeInstanceOf(GuardrailError);
    expect((await getSupplierCredential(atlas.id, { kind: "system", process: SUPPLIER_SYNC_PROCESS }))?.secret).toBe(`trade-${RUN}`);
    await db.delete(supplierCredentials).where(eq(supplierCredentials.supplierId, atlas.id));
  });
  it("a supplier without an automated connector says so instead of scraping; one with a trade-login connector points at it", async () => {
    for (const name of ["IT Plus", "Clear Digital", "SWL / Security Wholesale", "Vesta Electrical"]) await expect(syncSupplierPrices((await supplier(name)).id)).rejects.toThrow(/trade-login connector/);
    await expect(syncSupplierPrices((await supplier("Atlas Gentech")).id)).rejects.toThrow(/no automated connector yet/);
  });
});
