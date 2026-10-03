/**
 * The IT Plus trade-login connector end to end, against the database and a stand-in for the IT Plus
 * website (tests/support/itplus-mock.ts):
 *
 * stored encrypted login → Test connection → authenticated session → logged-in trade price →
 * match the canonical product → supplier price (ex GST) + SKU + stock + timestamp → price history →
 * Chris approval → the Business Brain quotes the approved price; a later refresh never changes a
 * prepared quote and holds price changes for Chris. Also: rejected logins (credential-free reasons,
 * not retried), CAPTCHA / two-factor / Cloudflare stops, and nothing secret in anything stored.
 *
 * Every price and login here is a TEST VALUE.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { startItPlusMock, type MockState } from "../support/itplus-mock";

process.env.AI_PROVIDER = "rules";
process.env.SUPPLIER_SYNC_DELAY_MS = "0";

const { db } = await import("@/db");
const { drafts, installationPackages, leads, productPriceHistory, products, quotes, cctvKits, supplierConnectors, supplierCredentials, supplierProducts, supplierSyncRuns, suppliers, users } =
  await import("@/db/schema");
const { encryptSecret } = await import("@/lib/crypto");
const brain = await import("@/lib/brain/store");
const { applyReferenceCatalogue, resetReferenceMarker } = await import("@/lib/brain/reference/apply");
const { runSupplierConnector, mapSupplierListing } = await import("@/lib/brain/suppliers/connector");
const { GuardrailError } = await import("@/lib/guard/actor");
const { house } = await import("../unit/brain-fixtures");

const RUN = `ip${Date.now().toString(36)}`;
const USER = `trade-${RUN}@getsecure.test`;
const PASS = `Corr3ct-Horse-${RUN}`;
const state: MockState = {
  username: USER,
  password: PASS,
  mode: "normal",
  log: [],
  products: [
    { sku: "S455-2.8", slug: "tp-link-vigi-insight-s455-2-8mm", name: "TP-Link VIGI InSight S455 2.8MM", type: "bundle", trade: 151.3, publicPrice: 157.7, stock: "In stock" },
    { sku: "S455-4", slug: "tp-link-vigi-insight-s455-4mm", name: "TP-Link VIGI InSight S455 4MM", type: "bundle", trade: 140.7, publicPrice: 140.7, stock: "Available on back-order" },
    { sku: "NVR1004H-4P", slug: "tp-link-vigi-nvr1004h-4p", name: "TP-Link VIGI NVR1004H-4P", type: "bundle", trade: 165, publicPrice: 173.2, stock: "8 in stock" },
    { sku: "VJB-240", slug: "tp-link-vigi-vjb-240", name: "TP-Link VIGI VJB-240", type: "simple", trade: 25.8, publicPrice: 27.1, stock: "In stock" },
    { sku: "VJB-240-BLK", slug: "tp-link-vigi-vjb-240-blk", name: "TP-Link VIGI VJB-240-BLK", type: "simple", trade: 25.8, publicPrice: 27.1, stock: "Out of stock" },
    {
      sku: "WD43PURZ-SUP",
      slug: "western-digital-wd43purz-sup",
      name: "Western Digital WD43PURZ-SUP",
      type: "simple",
      trade: 189,
      publicPrice: 350,
      stock: "Out of stock",
      summary: "Western Digital WD43PURZ-SUP 3.5″ Purple Surveillance SATA Hard Drive – 4TB – Supply Only",
      description: "Key Features: 4TB. Notes* Supply -> test note.",
    },
    {
      sku: "WD43PURZ-Inst",
      slug: "western-digital-wd43purz-inst",
      name: "Western Digital WD43PURZ-Inst",
      type: "simple",
      trade: 205,
      publicPrice: 370,
      stock: "In stock",
      summary: "Western Digital WD43PURZ-Inst 3.5″ Purple Surveillance SATA Hard Drive – 4TB – Price Including Installation In a Recorder",
    },
  ],
};

let mock: Awaited<ReturnType<typeof startItPlusMock>>;
let itPlusId: string;
let chris: { kind: "human"; userId: string; name: string; canApprove: true };
let staff: { kind: "human"; userId: string; name: string; canApprove: false };
let leadId: string;
let kitId: string | undefined;
let savedCred: typeof supplierCredentials.$inferSelect | undefined;
let savedConn: typeof supplierConnectors.$inferSelect | undefined;
let pkgBefore: typeof installationPackages.$inferSelect;
const quoteIds: string[] = [];
const ids: Record<string, string> = {};

const pid = async (manufacturer: string, model: string) => (await db.query.products.findFirst({ where: and(eq(products.manufacturer, manufacturer), eq(products.model, model)) }))!.id;
const offer = (productId: string) => db.query.supplierProducts.findFirst({ where: and(eq(supplierProducts.productId, productId), eq(supplierProducts.supplierId, itPlusId)) });
const conn = async () => (await db.query.supplierConnectors.findFirst({ where: eq(supplierConnectors.supplierId, itPlusId) }))!;
const storeLogin = (username: string, password: string) =>
  db
    .insert(supplierCredentials)
    .values({ supplierId: itPlusId, username, secretEncrypted: encryptSecret(password) })
    .onConflictDoUpdate({ target: supplierCredentials.supplierId, set: { username, secretEncrypted: encryptSecret(password), updatedAt: new Date() } });
const trade = (sku: string) => state.products.find((p) => p.sku === sku)!;

beforeAll(async () => {
  mock = await startItPlusMock(state);
  process.env.ITPLUS_BASE_URL = mock.url;
  resetReferenceMarker();
  await applyReferenceCatalogue();
  itPlusId = (await db.query.suppliers.findFirst({ where: eq(suppliers.name, "IT Plus") }))!.id;
  savedCred = await db.query.supplierCredentials.findFirst({ where: eq(supplierCredentials.supplierId, itPlusId) });
  savedConn = await conn();
  await db.update(supplierConnectors).set({ status: "not_tested", lastLoginOkAt: null, lastLoginFailedAt: null, lastLoginFailure: null, lastLoginFailureCode: null, lastSyncOkAt: null, priceBasisSeen: null }).where(eq(supplierConnectors.supplierId, itPlusId));
  const [c] = await db.insert(users).values({ email: `chris-${RUN}@test.local`, name: "Chris", passwordHash: "x", role: "admin", canApprove: true }).returning();
  const [s] = await db.insert(users).values({ email: `staff-${RUN}@test.local`, name: "Office", passwordHash: "x", role: "member" }).returning();
  chris = { kind: "human", userId: c.id, name: c.name, canApprove: true };
  staff = { kind: "human", userId: s.id, name: s.name, canApprove: false };
  const [l] = await db.insert(leads).values({ name: `Mere Tane ${RUN}`, email: `mere+${RUN}@example.com`, site: "4 Kauri Rd, Henderson", service: "CCTV", status: "new", source: "website" }).returning();
  leadId = l.id;
  ids.camera = await pid("TP-Link", "VIGI InSight S455(2.8mm)");
  ids.nvr = await pid("TP-Link", "VIGI NVR1004H-4P");
  ids.hdd = await pid("Western Digital", "WD43PURZ");
  ids.jb = await pid("TP-Link", "VJB-240");
  // No earlier IT Plus listing for these four (another test may have left one).
  await db.delete(supplierProducts).where(and(eq(supplierProducts.supplierId, itPlusId), inArray(supplierProducts.productId, Object.values(ids))));
  pkgBefore = (await db.query.installationPackages.findFirst({ where: eq(installationPackages.key, "RES_CCTV_SINGLE_4") }))!;
});

afterAll(async () => {
  await mock?.close();
  delete process.env.ITPLUS_BASE_URL;
  if (quoteIds.length) await db.delete(quotes).where(inArray(quotes.id, quoteIds));
  await db.delete(drafts).where(eq(drafts.leadId, leadId));
  await db.delete(leads).where(eq(leads.id, leadId));
  await db.delete(supplierProducts).where(and(eq(supplierProducts.supplierId, itPlusId), inArray(supplierProducts.productId, Object.values(ids))));
  await db.delete(supplierSyncRuns).where(eq(supplierSyncRuns.supplierId, itPlusId));
  if (kitId) await db.delete(cctvKits).where(eq(cctvKits.id, kitId));
  if (pkgBefore) {
    const { id, ...rest } = pkgBefore;
    await db.update(installationPackages).set(rest).where(eq(installationPackages.id, id));
  }
  if (savedCred) await db.update(supplierCredentials).set(savedCred).where(eq(supplierCredentials.supplierId, itPlusId));
  else await db.delete(supplierCredentials).where(eq(supplierCredentials.supplierId, itPlusId));
  if (savedConn) await db.update(supplierConnectors).set(savedConn).where(eq(supplierConnectors.supplierId, itPlusId));
  await db.delete(users).where(inArray(users.id, [chris.userId, staff.userId]));
  resetReferenceMarker();
});

/** Nothing stored or returned may carry the login or a session cookie. */
async function expectNoSecrets(result: unknown) {
  const runs = await db.select().from(supplierSyncRuns).where(eq(supplierSyncRuns.supplierId, itPlusId));
  const text = JSON.stringify([result, runs, await conn()]);
  for (const secret of [USER, PASS, encodeURIComponent(USER), "wordpress_logged_in"]) expect(text).not.toContain(secret);
  expect(text).not.toMatch(/tok[0-9a-z]{6,}/); // the mock's session cookie values
}

describe("IT Plus connector", () => {
  it("is registered for IT Plus, which now prices from its authenticated web catalogue", async () => {
    const s = (await db.query.suppliers.findFirst({ where: eq(suppliers.id, itPlusId) }))!;
    expect(s.priceSourceType).toBe("authenticated_web");
    expect((await conn()).connector).toBe("itplus");
  });

  it("refuses to send the login anywhere but IT Plus (or a local test server)", async () => {
    await storeLogin(USER, PASS);
    process.env.ITPLUS_BASE_URL = "https://itplus.example.com";
    const r = await runSupplierConnector(itPlusId, { kind: "test" }, chris);
    process.env.ITPLUS_BASE_URL = mock.url;
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/may only point at www\.itplus\.co\.nz/);
  });

  it("cannot be run by an agent", async () => {
    await expect(runSupplierConnector(itPlusId, { kind: "test" }, { kind: "agent", agent: "hermes" })).rejects.toBeInstanceOf(GuardrailError);
  });

  it("reports a rejected password without the username or password, and does not retry it automatically", async () => {
    await storeLogin(USER, "wrong-password");
    const r = await runSupplierConnector(itPlusId, { kind: "test" }, chris);
    expect(r.status).toBe("failed");
    expect(r.error).toBe("IT Plus rejected the stored password.");
    const c = await conn();
    expect(c).toMatchObject({ status: "auth_failed", lastLoginFailure: "IT Plus rejected the stored password.", lastLoginFailureCode: "auth_failed" });
    expect(c.lastLoginFailedAt).toBeTruthy();
    expect(c.lastLoginOkAt).toBeNull();
    const before = state.log.filter((x) => x.method === "POST").length;
    await expect(runSupplierConnector(itPlusId, { kind: "catalogue" }, chris)).rejects.toThrow(/Not retried/);
    expect(state.log.filter((x) => x.method === "POST").length).toBe(before);
    await expectNoSecrets(r);
  });

  it("Test connection logs in with the stored encrypted login and records nothing", async () => {
    await storeLogin(USER, PASS);
    const r = await runSupplierConnector(itPlusId, { kind: "test" }, chris);
    expect(r.status).toBe("ok");
    expect(r.message).toMatch(/Connection OK: logged in/);
    const c = await conn();
    expect(c.status).toBe("connected");
    expect(c.lastLoginOkAt).toBeTruthy();
    expect(c.lastLoginFailedAt).toBeTruthy(); // the earlier failure is still shown
    expect(await offer(ids.camera)).toBeUndefined();
    await expectNoSecrets(r);
  });

  it("refreshes the four products of a real 4-camera VIGI system from logged-in pages", async () => {
    const r = await runSupplierConnector(itPlusId, { kind: "selected", productIds: [ids.camera, ids.nvr, ids.hdd, ids.jb] }, chris);
    const item = (productId: string) => r.items.find((i) => i.productId === productId)!;
    // Camera, NVR and junction box: exact matches, trade price from the logged-in page (not the public API price).
    expect(item(ids.camera)).toMatchObject({ outcome: "recorded", sku: "S455-2.8", costExGst: 151.3, shownAmount: 151.3, shownBasis: "ex", basisFrom: "price label", stock: "In stock" });
    expect(item(ids.nvr)).toMatchObject({ outcome: "recorded", sku: "NVR1004H-4P", costExGst: 165, stock: "8 in stock" });
    expect(item(ids.nvr).priceText).toMatch(/From: \$165\.00 \+ GST/);
    expect(item(ids.jb)).toMatchObject({ outcome: "recorded", sku: "VJB-240", costExGst: 25.8 });
    // The drive has two IT Plus listings (supply-only and installer): nothing is recorded until Chris picks one.
    expect(item(ids.hdd)).toMatchObject({ outcome: "ambiguous" });
    expect(item(ids.hdd).candidates!.map((c) => c.sku).sort()).toEqual(["WD43PURZ-Inst", "WD43PURZ-SUP"]);
    // Each choice says what the listing is, in IT Plus's words, with no price.
    const sup = item(ids.hdd).candidates!.find((c) => c.sku === "WD43PURZ-SUP")!;
    expect(sup).toMatchObject({ summary: expect.stringMatching(/Supply Only/), notes: expect.stringMatching(/^Notes\*/), stock: "Out of stock" });
    expect(item(ids.hdd).candidates!.find((c) => c.sku === "WD43PURZ-Inst")!.summary).toMatch(/Including Installation In a Recorder/);
    expect(JSON.stringify(item(ids.hdd).candidates)).not.toMatch(/350|370|189|205/);
    expect(await offer(ids.hdd)).toBeUndefined();
    expect(r.status).toBe("partial");

    const cam = (await offer(ids.camera))!;
    expect(cam).toMatchObject({ supplierSku: "S455-2.8", priceApproved: false, priceSource: "authenticated_web", stock: "In stock", pendingCostExGst: null });
    expect(Number(cam.costExGst)).toBe(151.3);
    expect(cam.sourceUrl).toBe(`${mock.url}/products/tp-link-vigi-insight-s455-2-8mm/`);
    expect(cam.lastCheckedAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
    const [h] = await db.select().from(productPriceHistory).where(eq(productPriceHistory.supplierProductId, cam.id));
    expect(h).toMatchObject({ newCostExGst: "151.30", oldCostExGst: null, priceSource: "authenticated_web", stock: "In stock", syncRunId: r.runId, reviewStatus: "not_reviewed", source: "IT Plus trade login sync" });
    const c = await conn();
    expect(c.lastSyncOkAt).toBeTruthy();
    expect(c.priceBasisSeen).toBe("ex");
    expect(state.log.some((x) => x.path.startsWith("/products/") && !x.loggedIn)).toBe(false);
    await expectNoSecrets(r);
  });

  it("records a logged-in price that happens to equal the public feed's figure", async () => {
    const id4 = await pid("TP-Link", "VIGI InSight S455(4mm)");
    await db.delete(supplierProducts).where(and(eq(supplierProducts.supplierId, itPlusId), eq(supplierProducts.productId, id4)));
    expect(trade("S455-4").publicPrice).toBe(trade("S455-4").trade);
    const r = await runSupplierConnector(itPlusId, { kind: "product", productId: id4 }, chris);
    expect(r.items[0]).toMatchObject({ outcome: "recorded", sku: "S455-4", costExGst: 140.7, stock: "Available on back-order" });
    await db.delete(supplierProducts).where(and(eq(supplierProducts.supplierId, itPlusId), eq(supplierProducts.productId, id4)));
  });

  it("Chris chooses the drive's listing, then Refresh one product prices it", async () => {
    await mapSupplierListing(itPlusId, ids.hdd, { sku: "WD43PURZ-SUP", url: `${mock.url}/products/western-digital-wd43purz-sup/` }, chris);
    await expect(mapSupplierListing(itPlusId, ids.hdd, { sku: "X", url: "https://evil.example/x" }, chris)).rejects.toThrow(/not on the supplier's website/);
    const r = await runSupplierConnector(itPlusId, { kind: "product", productId: ids.hdd }, chris);
    expect(r.items[0]).toMatchObject({ outcome: "recorded", sku: "WD43PURZ-SUP", costExGst: 189, stock: "Out of stock" });
  });

  it("a new price is unapproved, so the Business Brain does not quote it until Chris approves", async () => {
    const cat = await brain.loadCatalogue();
    const { priceCatalogue } = await import("@/lib/brain/pricing");
    const before = priceCatalogue(cat, "residential", await brain.loadPolicies(), new Date()).products.find((p) => p.id === ids.camera)!;
    expect(before.price?.approved ?? false).toBe(false);
    for (const id of Object.values(ids)) await brain.approveSupplierPrice((await offer(id))!.id, chris);
    const after = priceCatalogue(await brain.loadCatalogue(), "residential", await brain.loadPolicies(), new Date()).products.find((p) => p.id === ids.camera)!;
    expect(after.price).toMatchObject({ supplier: "IT Plus", costExGst: 151.3, approved: true, freshness: "current", supplierSku: "S455-2.8", stock: "In stock" });
    const [h] = await db.select().from(productPriceHistory).where(eq(productPriceHistory.supplierProductId, (await offer(ids.camera))!.id));
    expect(h.reviewStatus).toBe("approved");
    expect(h.reviewedById).toBe(chris.userId);
  });

  it("the 4-camera VIGI quote uses the approved IT Plus prices; a later refresh never changes it and holds changes for Chris", async () => {
    // TEST VALUES for the input Chris owns: the RES_CCTV_SINGLE_4 package.
    await db
      .update(installationPackages)
      .set({ estimatedHours: "6.00", labourRate: "95.00", materialCostExGst: "80.00", complexityAllowanceExGst: "0.00", allowanceExGst: "790.00", status: "getsecure_approved" })
      .where(eq(installationPackages.key, "RES_CCTV_SINGLE_4"));

    // No kit yet: 4 cameras fall back to a 2 TB drive, which has no IT Plus price here: not fully priced, and never swapped for the priced 4 TB.
    const d = await brain.runAssessment(leadId, house({ requestedTier: "good", customerName: "Mere Tane", mountingSurface: "brick" }), staff);
    expect(d.packet.recording.storage).toMatchObject({ selection: "fallback", installedTb: 2 });
    expect(d.packet.costing.complete).toBe(false);
    // Chris approves the kit: 4 x S455, the NVR1004H-4P and the 4 TB WD43PURZ as its default HDD.
    const [k] = await db
      .insert(cctvKits)
      .values({ key: `KIT_${RUN.toUpperCase()}`, name: "VIGI Good 4", propertyType: "residential", tier: "good", cameraCount: 4, cameraProductId: ids.camera, nvrProductId: ids.nvr, defaultHddProductId: ids.hdd, defaultHddTb: "4.00", status: "getsecure_approved", approvedById: chris.userId, source: "integration test" })
      .returning();
    kitId = k.id;
    const a = await brain.runAssessment(leadId, house({ requestedTier: "good", customerName: "Mere Tane", mountingSurface: "brick" }), staff);
    const pk = a.packet;
    expect(pk.cameras.every((c) => c.product?.id === ids.camera)).toBe(true);
    expect(pk.nvr.selected?.id).toBe(ids.nvr);
    expect(pk.kit?.id).toBe(kitId);
    expect(pk.recording.storage).toMatchObject({ selection: "kit", installedTb: 4 });
    expect(pk.recording.storage.drives?.product.id).toBe(ids.hdd);
    // Brick walls: the documented, IT Plus-priced junction box is recommended (not charged until Chris confirms).
    const jb = pk.installation.materials.find((m) => m.key === `junction_box:${ids.jb}`)!;
    expect(jb).toMatchObject({ quantity: 4, charged: false, approvalRequired: true });
    expect(jb.reason).toMatch(/Supplier cost \$25\.8 ex GST each \(IT Plus\)/);
    const { quoteId } = await brain.prepareFromAssessment(a.id, { quote: true }, staff);
    quoteIds.push(quoteId!);
    const q = (await db.query.quotes.findFirst({ where: eq(quotes.id, quoteId!) }))!;
    const lines = (q.internalCosting as { lines: { key: string; model: string | null; supplier: string | null; supplierSku: string | null; unitCostExGst: number | null; stock: string | null }[] }).lines;
    expect(lines.find((l) => l.model === "TP-Link VIGI InSight S455(2.8mm)")).toMatchObject({ supplier: "IT Plus", supplierSku: "S455-2.8", unitCostExGst: 151.3 });
    expect(lines.find((l) => l.model === "TP-Link VIGI NVR1004H-4P")).toMatchObject({ supplier: "IT Plus", unitCostExGst: 165 });
    expect(lines.find((l) => l.model === "Western Digital WD43PURZ")).toMatchObject({ supplier: "IT Plus", supplierSku: "WD43PURZ-SUP", unitCostExGst: 189 });

    // IT Plus changes two trade prices; the catalogue refresh confirms the rest and holds the changes.
    trade("S455-2.8").trade = 158.9;
    trade("VJB-240").trade = 25.81;
    const r = await runSupplierConnector(itPlusId, { kind: "catalogue" }, chris);
    const item = (productId: string) => r.items.find((i) => i.productId === productId)!;
    expect(item(ids.camera)).toMatchObject({ outcome: "held", costExGst: 158.9, previousCostExGst: 151.3 });
    expect(item(ids.jb)).toMatchObject({ outcome: "held" }); // even a 1c change waits for Chris
    expect(item(ids.nvr)).toMatchObject({ outcome: "confirmed", costExGst: 165 });
    expect(item(ids.hdd)).toMatchObject({ outcome: "confirmed" });
    const cam = (await offer(ids.camera))!;
    expect(Number(cam.costExGst)).toBe(151.3);
    expect(Number(cam.pendingCostExGst)).toBe(158.9);
    expect(cam.priceApproved).toBe(true);
    // The prepared quote is untouched.
    const still = (await db.query.quotes.findFirst({ where: eq(quotes.id, quoteId!) }))!;
    expect(still.internalCosting).toEqual(q.internalCosting);
    expect(still.status).toBe(q.status);
    // History keeps both prices; Chris approves the change; a reprice then uses it.
    expect((await db.select().from(productPriceHistory).where(eq(productPriceHistory.supplierProductId, cam.id))).map((h) => h.newCostExGst).sort()).toEqual(["151.30", "158.90"]);
    await brain.approveSupplierPrice(cam.id, chris);
    await brain.repriceQuote(quoteId!, staff);
    const repriced = (await db.query.quotes.findFirst({ where: eq(quotes.id, quoteId!) }))!;
    expect((repriced.internalCosting as { lines: { model: string | null; unitCostExGst: number | null }[] }).lines.find((l) => l.model === "TP-Link VIGI InSight S455(2.8mm)")?.unitCostExGst).toBe(158.9);
    await expectNoSecrets(r);
  });

  it("stops if IT Plus drops the session part-way, recording nothing more", async () => {
    state.dropSessionAfter = 1;
    const r = await runSupplierConnector(itPlusId, { kind: "catalogue" }, chris);
    state.dropSessionAfter = undefined;
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/stopped treating the session as logged in/);
  });

  for (const [mode, code, text] of [
    ["captcha", "blocked", /CAPTCHA/],
    ["mfa", "blocked", /two-factor/],
    ["cloudflare", "blocked", /security check/],
    ["pending_account", "auth_failed", /pending approval or disabled/],
  ] as const) {
    it(`stops and reports ${mode} without getting past it`, async () => {
      state.mode = mode;
      const posts = state.log.filter((x) => x.method === "POST").length;
      const r = await runSupplierConnector(itPlusId, { kind: "test" }, chris);
      state.mode = "normal";
      expect(r.status).toBe("failed");
      expect(r.error).toMatch(text);
      expect((await conn()).status).toBe(code);
      if (mode === "captcha" || mode === "cloudflare") expect(state.log.filter((x) => x.method === "POST").length).toBe(posts); // nothing submitted
      await expectNoSecrets(r);
    });
  }
});
