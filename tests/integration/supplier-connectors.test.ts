/**
 * The Clear Digital, SWL and Vesta Electrical trade-login connectors end to end, against the
 * database and a stand-in for each website (tests/support/cleardigital-mock.ts, webninja-mock.ts):
 *
 * stored encrypted login → Test connection → signed-in session → price on the signed-in product
 * page (and only that: the public Open Graph figure and the guest "POA" are never used) → match
 * the canonical product → supplier price (ex GST) + code + stock → history → Chris approval (or
 * auto-approval within his threshold). Also: rejected logins (credential-free reasons, not
 * retried), CAPTCHA / two-factor / challenge stops, a dropped session, and nothing secret in
 * anything stored or returned.
 *
 * Every price and login here is a TEST VALUE.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { startClearDigitalMock, type CdState } from "../support/cleardigital-mock";
import { startWebNinjaMock, type WnState } from "../support/webninja-mock";

process.env.SUPPLIER_SYNC_DELAY_MS = "0";

const { db } = await import("@/db");
const { productPriceHistory, products, supplierConnectors, supplierCredentials, supplierProducts, supplierSyncRuns, suppliers, users } = await import("@/db/schema");
const { encryptSecret } = await import("@/lib/crypto");
const { applyReferenceCatalogue, resetReferenceMarker } = await import("@/lib/brain/reference/apply");
const { runSupplierConnector, liveSupplierLookup, baseUrlFor } = await import("@/lib/brain/suppliers/connector");
const { SITES } = await import("@/lib/brain/suppliers/sites");
const { GuardrailError } = await import("@/lib/guard/actor");

const RUN = `sc${Date.now().toString(36)}`;
const EMAIL = `trade-${RUN}@getsecure.test`;
const PASS = `Corr3ct-Horse-${RUN}`;

let chris: { kind: "human"; userId: string; name: string; canApprove: true };
const ids: Record<string, string> = {};
const saved: { cred: Map<string, typeof supplierCredentials.$inferSelect | undefined>; conn: Map<string, typeof supplierConnectors.$inferSelect | undefined> } = { cred: new Map(), conn: new Map() };
const supplierIds: Record<string, string> = {};

const cd: CdState = {
  email: EMAIL,
  password: PASS,
  mode: "normal",
  log: [],
  products: [
    { id: 6651, code: "DH-PFA139", slug: "dahua-junction-box-pfa139", name: "Dahua Junction Box PFA139", priceHtml: "$18.40 + GST", publicPrice: 33.95, stock: "Auckland: 42 · Wellington: 6" },
    { id: 6652, code: "DHI-NVR4104HS-P-AI/ANZ", slug: "dahua-4ch-wizsense-nvr", name: "Dahua 4 Channel WizSense NVR with 4 PoE", priceHtml: "$189.00 + GST", publicPrice: 349, stock: "In stock" },
    { id: 6653, code: "DH-IPC-HDW3667EM-S-IL-ANZ(2.8mm)", slug: "dahua-6mp-smart-dual-light-eyeball-2-8", name: "Dahua 6MP Smart Dual Light Eyeball 2.8mm", priceHtml: "$102.00 + GST", publicPrice: 199, stock: "In stock" },
    { id: 6654, code: "DH-IPC-HDW3667EM-S-IL-ANZ(3.6mm)", slug: "dahua-6mp-smart-dual-light-eyeball-3-6", name: "Dahua 6MP Smart Dual Light Eyeball 3.6mm", priceHtml: "RRP $199.00", publicPrice: 199, stock: "In stock" },
    { id: 6655, code: "TR-JB03-G-IN", slug: "uniview-junction-box", name: "Uniview Junction Box", priceHtml: "$9.50", publicPrice: 14.9, stock: "In stock" },
  ],
};
const swl: WnState = {
  shop: "SWL",
  email: EMAIL,
  password: PASS,
  mode: "normal",
  log: [],
  products: [
    { id: 4360, code: "47970", slug: "tp-link-vigi-nvr1004h-4p-4-channel-poe-nvr", name: "TP-Link VIGI NVR1004H-4P: 4 Channel PoE+ Network Video Recorder", priceHtml: '$158.00 <span class="tax">ex GST</span>', stock: "Auckland 12" },
    { id: 4361, code: "47971", slug: "tp-link-vigi-nvr1008h-8p", name: "TP-Link VIGI NVR1008H-8P: 8 Channel PoE+ NVR", priceHtml: "POA" },
    { id: 4362, code: "47972", slug: "tp-link-vigi-nvr1104h-4p", name: "TP-Link VIGI NVR1104H-4P: 4 Channel PoE+ NVR", priceHtml: "$171.00" },
  ],
};
const vesta: WnState = {
  shop: "Vesta Electrical",
  email: EMAIL,
  password: PASS,
  mode: "normal",
  siteNote: false,
  log: [],
  products: [
    { id: 13999, code: "IPC-T361H-MU(2.8mm)", slug: "hilook-6mp-turret-2-8mm", name: "HILOOK 6MP ColorVu Turret Camera 2.8mm", priceHtml: "$149.50 inc GST", stock: "5" },
    { id: 13998, code: "NVR-104MH-K/4P(B)", slug: "hilook-4ch-nvr", name: "HILOOK 4 Channel NVR 4 PoE", priceHtml: "$207.00" },
  ],
};

let cdMock: Awaited<ReturnType<typeof startClearDigitalMock>>;
let swlMock: Awaited<ReturnType<typeof startWebNinjaMock>>;
let vestaMock: Awaited<ReturnType<typeof startWebNinjaMock>>;

const pid = async (manufacturer: string, model: string) => (await db.query.products.findFirst({ where: and(eq(products.manufacturer, manufacturer), eq(products.model, model)) }))!.id;
const offer = (supplierId: string, productId: string) => db.query.supplierProducts.findFirst({ where: and(eq(supplierProducts.productId, productId), eq(supplierProducts.supplierId, supplierId)) });
const conn = async (supplierId: string) => (await db.query.supplierConnectors.findFirst({ where: eq(supplierConnectors.supplierId, supplierId) }))!;
const storeLogin = (supplierId: string, username: string, password: string) =>
  db
    .insert(supplierCredentials)
    .values({ supplierId, username, secretEncrypted: encryptSecret(password) })
    .onConflictDoUpdate({ target: supplierCredentials.supplierId, set: { username, secretEncrypted: encryptSecret(password), updatedAt: new Date() } });

/** Nothing stored or returned may carry the login or a session cookie. */
async function expectNoSecrets(supplierId: string, result: unknown) {
  const runs = await db.select().from(supplierSyncRuns).where(eq(supplierSyncRuns.supplierId, supplierId));
  const text = JSON.stringify([result, runs, await conn(supplierId)]);
  for (const secret of [EMAIL, PASS, encodeURIComponent(EMAIL), "zulu_member", "wn_session"]) expect(text).not.toContain(secret);
  expect(text).not.toMatch(/tok[0-9a-z]{6,}/);
}

beforeAll(async () => {
  resetReferenceMarker();
  await applyReferenceCatalogue();
  cdMock = await startClearDigitalMock(cd);
  swlMock = await startWebNinjaMock(swl);
  vestaMock = await startWebNinjaMock(vesta);
  process.env.CLEARDIGITAL_BASE_URL = cdMock.url;
  process.env.SWL_BASE_URL = swlMock.url;
  process.env.VESTA_BASE_URL = vestaMock.url;
  for (const [key, name] of [
    ["cleardigital", "Clear Digital"],
    ["swl", "SWL / Security Wholesale"],
    ["vesta", "Vesta Electrical"],
  ] as const) {
    const s = (await db.query.suppliers.findFirst({ where: eq(suppliers.name, name) }))!;
    supplierIds[key] = s.id;
    saved.cred.set(s.id, await db.query.supplierCredentials.findFirst({ where: eq(supplierCredentials.supplierId, s.id) }));
    saved.conn.set(s.id, await db.query.supplierConnectors.findFirst({ where: eq(supplierConnectors.supplierId, s.id) }));
    await db.update(supplierConnectors).set({ status: "not_tested", lastLoginOkAt: null, lastLoginFailedAt: null, lastLoginFailure: null, lastLoginFailureCode: null, lastSyncOkAt: null, lastSyncFailedAt: null, lastSyncFailure: null, priceBasisSeen: null }).where(eq(supplierConnectors.supplierId, s.id));
  }
  const [c] = await db.insert(users).values({ email: `chris-${RUN}@test.local`, name: "Chris", passwordHash: "x", role: "admin", canApprove: true }).returning();
  chris = { kind: "human", userId: c.id, name: c.name, canApprove: true };
  ids.jb = await pid("Dahua Technology", "DH-PFA139");
  ids.dnvr = await pid("Dahua Technology", "DHI-NVR4104HS-P-AI/ANZ");
  ids.cam28 = await pid("Dahua Technology", "DH-IPC-HDW3667EM-S-IL-ANZ (2.8mm)");
  ids.cam36 = await pid("Dahua Technology", "DH-IPC-HDW3667EM-S-IL-ANZ (3.6mm)");
  ids.unvjb = await pid("Zhejiang Uniview Technologies Co., Ltd.", "TR-JB03-G-IN");
  ids.nvr1004 = await pid("TP-Link", "VIGI NVR1004H-4P");
  ids.nvr1008 = await pid("TP-Link", "VIGI NVR1008H-8P");
  ids.nvr1104 = await pid("TP-Link", "VIGI NVR1104H-4P");
  ids.hl28 = await pid("HiLook", "IPC-T361H-MU(2.8mm)");
  ids.hlnvr = await pid("HiLook", "NVR-104MH-K/4P(B)");
  await db.delete(supplierProducts).where(and(inArray(supplierProducts.supplierId, Object.values(supplierIds)), inArray(supplierProducts.productId, Object.values(ids))));
});

afterAll(async () => {
  await cdMock?.close();
  await swlMock?.close();
  await vestaMock?.close();
  delete process.env.CLEARDIGITAL_BASE_URL;
  delete process.env.SWL_BASE_URL;
  delete process.env.VESTA_BASE_URL;
  await db.delete(supplierProducts).where(and(inArray(supplierProducts.supplierId, Object.values(supplierIds)), inArray(supplierProducts.productId, Object.values(ids))));
  for (const id of Object.values(supplierIds)) {
    await db.delete(supplierSyncRuns).where(eq(supplierSyncRuns.supplierId, id));
    const cred = saved.cred.get(id);
    if (cred) await db.update(supplierCredentials).set(cred).where(eq(supplierCredentials.supplierId, id));
    else await db.delete(supplierCredentials).where(eq(supplierCredentials.supplierId, id));
    const c = saved.conn.get(id);
    if (c) await db.update(supplierConnectors).set(c).where(eq(supplierConnectors.supplierId, id));
  }
  await db.delete(users).where(eq(users.id, chris.userId));
  resetReferenceMarker();
});

describe("the three new connectors are registered", () => {
  it("each supplier prices from its authenticated website, through its own site module, and its login may only go to that site", async () => {
    for (const [key, name] of [
      ["cleardigital", "Clear Digital"],
      ["swl", "SWL"],
      ["vesta", "Vesta Electrical"],
    ] as const) {
      const s = (await db.query.suppliers.findFirst({ where: eq(suppliers.id, supplierIds[key]) }))!;
      expect(s.priceSourceType).toBe("authenticated_web");
      expect(s.website).toBe(SITES[key].baseUrl);
      expect((await conn(supplierIds[key])).connector).toBe(key);
      expect(SITES[key].name).toBe(name);
      const envVar = SITES[key].envVar;
      const before = process.env[envVar];
      process.env[envVar] = "https://evil.example.com";
      expect(() => baseUrlFor(key)).toThrow(/may only point at/);
      process.env[envVar] = before;
    }
    await expect(runSupplierConnector(supplierIds.cleardigital, { kind: "test" }, { kind: "agent", agent: "hermes" })).rejects.toBeInstanceOf(GuardrailError);
  });
});

describe("Clear Digital (custom shop, members sign-in)", () => {
  const sid = () => supplierIds.cleardigital;

  it("reports a rejected password with a fixed reason, never the email, and does not retry it", async () => {
    await storeLogin(sid(), EMAIL, "wrong-password");
    const r = await runSupplierConnector(sid(), { kind: "test" }, chris);
    expect(r.status).toBe("failed");
    expect(r.error).toBe("Clear Digital rejected the stored password.");
    expect(await conn(sid())).toMatchObject({ status: "auth_failed", lastLoginFailureCode: "auth_failed" });
    const posts = cd.log.filter((x) => x.method === "POST").length;
    await expect(runSupplierConnector(sid(), { kind: "catalogue" }, chris)).rejects.toThrow(/Not retried/);
    expect(cd.log.filter((x) => x.method === "POST").length).toBe(posts);
    await expectNoSecrets(sid(), r);
  });

  it("says when the site wants the password reset first, and stops at a CAPTCHA or a verification code", async () => {
    await storeLogin(sid(), EMAIL, PASS);
    cd.mode = "reset_required";
    expect((await runSupplierConnector(sid(), { kind: "test" }, chris)).error).toMatch(/password must be reset/);
    cd.mode = "captcha";
    const c = await runSupplierConnector(sid(), { kind: "test" }, chris);
    expect(c.error).toMatch(/CAPTCHA/);
    expect(cd.log.filter((x) => x.method === "POST" && x.path.startsWith("/members/login")).map((x) => x.body)).not.toContain(expect.stringContaining(PASS));
    expect((await conn(sid())).status).toBe("blocked");
    cd.mode = "mfa";
    expect((await runSupplierConnector(sid(), { kind: "test" }, chris)).error).toMatch(/two-factor/);
    cd.mode = "normal";
  });

  it("Test connection signs in with the stored encrypted login and records nothing; the public og:product figure is never used", async () => {
    const r = await runSupplierConnector(sid(), { kind: "test" }, chris);
    expect(r.status).toBe("ok");
    expect(r.message).toMatch(/Connection OK: logged in to the Clear Digital trade account/);
    expect((await conn(sid())).status).toBe("connected");
    expect(await offer(sid(), ids.jb)).toBeUndefined();
    expect(JSON.stringify(r)).not.toMatch(/33\.95|349/);
    await expectNoSecrets(sid(), r);
  });

  it("refreshes Dahua products from signed-in pages: exact code matches, '+ GST' label, stock; RRP and no-basis prices are reported, not recorded", async () => {
    const r = await runSupplierConnector(sid(), { kind: "selected", productIds: [ids.jb, ids.dnvr, ids.cam28, ids.cam36, ids.unvjb] }, chris);
    const item = (productId: string) => r.items.find((i) => i.productId === productId)!;
    expect(item(ids.jb)).toMatchObject({ outcome: "recorded", sku: "DH-PFA139", costExGst: 18.4, shownBasis: "ex", basisFrom: "price label", stock: "Auckland: 42 · Wellington: 6" });
    expect(item(ids.dnvr)).toMatchObject({ outcome: "recorded", sku: "DHI-NVR4104HS-P-AI/ANZ", costExGst: 189 });
    expect(item(ids.cam28)).toMatchObject({ outcome: "recorded", sku: "DH-IPC-HDW3667EM-S-IL-ANZ(2.8mm)", costExGst: 102 });
    expect(item(ids.cam36)).toMatchObject({ outcome: "not_read" });
    expect(item(ids.cam36).reason).toMatch(/RRP/);
    // No "+ GST" on the Uniview box, but the page's "All prices exclude GST" note settles it.
    expect(item(ids.unvjb)).toMatchObject({ outcome: "recorded", sku: "TR-JB03-G-IN", costExGst: 9.5, basisFrom: "shop tax setting" });
    const jb = (await offer(sid(), ids.jb))!;
    expect(jb).toMatchObject({ supplierSku: "DH-PFA139", priceApproved: false, priceSource: "authenticated_web" });
    expect(Number(jb.costExGst)).toBe(18.4);
    expect(jb.sourceUrl).toBe(`${cdMock.url}/product/6651/dahua-junction-box-pfa139/`);
    const [h] = await db.select().from(productPriceHistory).where(eq(productPriceHistory.supplierProductId, jb.id));
    expect(h).toMatchObject({ newCostExGst: "18.40", source: "Clear Digital trade login sync", priceSource: "authenticated_web", syncRunId: r.runId });
    expect(await offer(sid(), ids.cam36)).toBeUndefined();
    // The public og:product figures never appear anywhere (the RRP line is quoted only as the reason it was refused).
    expect(JSON.stringify(r)).not.toMatch(/33\.95|\b349\b|14\.9/);
    expect(cd.log.some((x) => x.path.startsWith("/product/") && !x.loggedIn)).toBe(false);
    expect((await conn(sid())).priceBasisSeen).toBe("ex");
    await expectNoSecrets(sid(), r);
  });

  it("without the site-wide GST note, a price with no label is not recorded", async () => {
    cd.siteNote = false;
    const r = await runSupplierConnector(sid(), { kind: "product", productId: ids.unvjb }, chris);
    cd.siteNote = true;
    expect(r.items[0]).toMatchObject({ outcome: "confirmed" }); // the basis seen earlier in this connector's run history still applies
    await db.update(supplierConnectors).set({ priceBasisSeen: null }).where(eq(supplierConnectors.supplierId, sid()));
    cd.siteNote = false;
    const r2 = await runSupplierConnector(sid(), { kind: "product", productId: ids.unvjb }, chris);
    cd.siteNote = true;
    expect(r2.items[0]).toMatchObject({ outcome: "not_read" });
    expect(r2.items[0].reason).toMatch(/ex or inc GST/);
  });

  it("stops if the site drops the session part-way, recording nothing more", async () => {
    cd.dropSessionAfter = 1;
    const r = await runSupplierConnector(sid(), { kind: "selected", productIds: [ids.jb, ids.dnvr] }, chris);
    cd.dropSessionAfter = undefined;
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/stopped treating the session as logged in/);
  });

  it("Hermes's research lookup sees the signed-in price as evidence only; nothing is recorded, nothing secret returned", async () => {
    await db.delete(supplierProducts).where(and(eq(supplierProducts.supplierId, sid()), eq(supplierProducts.productId, ids.dnvr)));
    const r = await liveSupplierLookup(sid(), { sku: "DHI-NVR4104HS-P-AI/ANZ" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.page).toMatchObject({ sku: "DHI-NVR4104HS-P-AI/ANZ", amount: 189, basis: "ex" });
    expect(r.note).toMatch(/not recorded as a cost/);
    expect(await offer(sid(), ids.dnvr)).toBeUndefined();
    await expectNoSecrets(sid(), r);
  });
});

describe("SWL (WebNinja, CSRF login, POA for guests)", () => {
  const sid = () => supplierIds.swl;

  it("logs in with the CSRF token, searches by posting keywords, and matches a listing by the model written in its name (SWL's own code is a stock number)", async () => {
    await storeLogin(sid(), EMAIL, PASS);
    const t = await runSupplierConnector(sid(), { kind: "test" }, chris);
    expect(t.status).toBe("ok");
    expect(swl.log.find((x) => x.method === "POST" && x.path === "/login")?.body).toMatch(/_csrf_token=tok-csrf/);
    const r = await runSupplierConnector(sid(), { kind: "selected", productIds: [ids.nvr1004, ids.nvr1008, ids.nvr1104] }, chris);
    const item = (productId: string) => r.items.find((i) => i.productId === productId)!;
    expect(item(ids.nvr1004)).toMatchObject({ outcome: "recorded", sku: "47970", costExGst: 158, shownBasis: "ex", basisFrom: "price label", stock: "Auckland 12" });
    // POA for a signed-in account: nothing to record, said plainly.
    expect(item(ids.nvr1008)).toMatchObject({ outcome: "not_read", sku: "47971" });
    expect(item(ids.nvr1008).reason).toMatch(/on application/);
    // No label on this one; the page's "All prices are shown ex GST" note settles it.
    expect(item(ids.nvr1104)).toMatchObject({ outcome: "recorded", sku: "47972", costExGst: 171, basisFrom: "shop tax setting" });
    expect(swl.log.filter((x) => x.method === "POST" && x.path === "/search").length).toBeGreaterThan(0);
    expect(swl.log.some((x) => x.path.startsWith("/product/") && !x.loggedIn)).toBe(false);
    const o = (await offer(sid(), ids.nvr1004))!;
    expect(o.sourceUrl).toBe(`${swlMock.url}/product/4360-tp-link-vigi-nvr1004h-4p-4-channel-poe-nvr`);
    await expectNoSecrets(sid(), r);
  });

  it("a wrong login is reported without the email; a challenge page stops the run", async () => {
    await storeLogin(sid(), EMAIL, "nope");
    const r = await runSupplierConnector(sid(), { kind: "test" }, chris);
    expect(r.error).toBe("SWL rejected the stored password.");
    await expectNoSecrets(sid(), r);
    await storeLogin(sid(), EMAIL, PASS);
    swl.mode = "cloudflare";
    const b = await runSupplierConnector(sid(), { kind: "test" }, chris);
    swl.mode = "normal";
    expect(b.error).toMatch(/security check/);
    expect((await conn(sid())).status).toBe("blocked");
  });
});

describe("Vesta Electrical (WebNinja, maker's model as the stock code)", () => {
  const sid = () => supplierIds.vesta;

  it("matches on the stock code, converts an 'inc GST' price to ex GST, and refuses a price with no GST basis at all", async () => {
    await storeLogin(sid(), EMAIL, PASS);
    const r = await runSupplierConnector(sid(), { kind: "selected", productIds: [ids.hl28, ids.hlnvr] }, chris);
    const item = (productId: string) => r.items.find((i) => i.productId === productId)!;
    expect(item(ids.hl28)).toMatchObject({ outcome: "recorded", sku: "IPC-T361H-MU(2.8mm)", shownAmount: 149.5, shownBasis: "inc", costExGst: 130, stock: "5" });
    // No label, no site-wide note, and no basis seen yet on this connector: not recorded.
    expect(item(ids.hlnvr)).toMatchObject({ outcome: "not_read", sku: "NVR-104MH-K/4P(B)" });
    expect(item(ids.hlnvr).reason).toMatch(/ex or inc GST/);
    expect(await offer(sid(), ids.hlnvr)).toBeUndefined();
    const o = (await offer(sid(), ids.hl28))!;
    expect(Number(o.costExGst)).toBe(130);
    expect(o.priceApproved).toBe(false);
    await expectNoSecrets(sid(), r);
  });

  it("a guest page (POA) is never read as a price even if the session is lost", async () => {
    vesta.dropSessionAfter = 0;
    const r = await runSupplierConnector(sid(), { kind: "product", productId: ids.hl28 }, chris);
    vesta.dropSessionAfter = undefined;
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/stopped treating the session as logged in/);
    expect(Number((await offer(sid(), ids.hl28))!.costExGst)).toBe(130);
  });
});
