/**
 * Business Brain v0.2/v0.3 on the real, verified reference catalogue (specifications from the
 * manufacturers' own pages and datasheets; see data/catalogue-research and
 * src/lib/brain/reference/catalogue.json).
 *
 * Scenarios A-E from the v0.2 brief, plus supplier routing, price freshness, kits, junction boxes,
 * installation packages and the standard materials package.
 *
 * Supplier costs, design bitrates and package values used here are TEST VALUES, not Get Secure's:
 * the reference catalogue has none of them, and they only ever come from Chris or a supplier.
 */
import { describe, it, expect } from "vitest";
import { assessCctv } from "@/lib/brain/engine";
import { composeEmail, composeQuote } from "@/lib/brain/compose";
import { chooseOffer, priceFreshness } from "@/lib/brain/pricing";
import { DEFAULT_POLICIES } from "@/lib/brain/policy";
import { REFERENCE_CATALOGUE, referenceLinks, referenceProducts } from "@/lib/brain/reference/products";
import type { BrandRoute, CameraProduct, Catalogue, InstallationPackage, MaterialsPackage, Policies, Product, ProductOffer, RecordingProfile, RecordingRule } from "@/lib/brain/types";
import { house } from "./brain-fixtures";

const NOW = new Date("2026-10-02T09:00:00+13:00");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

const SUPPLIERS = {
  itplus: { id: "s-itplus", name: "IT Plus", isDefault: true, priority: 1 },
  clear: { id: "s-clear", name: "Clear Digital", isDefault: false, priority: 2 },
  swl: { id: "s-swl", name: "SWL / Security Wholesale", isDefault: false, priority: 3 },
  atlas: { id: "s-atlas", name: "Atlas Gentech", isDefault: false, priority: 4 },
  iot: { id: "s-iot", name: "IOT Technologies", isDefault: false, priority: 5 },
} as const;

/** The v0.2 routing matrix, as the migration seeds it. */
const ROUTES: BrandRoute[] = (
  [
    ["TP-Link VIGI", "itplus", 1, "both"],
    ["HiLook", "itplus", 1, "both"],
    ["Hikvision", "itplus", 1, "both"],
    ["Hikvision", "atlas", 2, "commercial"],
    ["TVT", "itplus", 1, "both"],
    ["Tiandy", "iot", 1, "both"],
    ["Dahua", "clear", 1, "both"],
    ["Dahua", "iot", 2, "both"],
    ["Ajax", "clear", 1, "both"],
    ["Ajax", "iot", 2, "both"],
    ["Uniview", "itplus", 1, "both"],
    ["Uniview", "clear", 2, "both"],
    ["Uniview", "iot", 3, "both"],
    ["Axis", "atlas", 1, "both"],
    ["Hanwha", "atlas", 1, "both"],
  ] as const
).map(([brand, s, rank, market]) => ({ brand, supplierId: SUPPLIERS[s].id, supplier: SUPPLIERS[s].name, rank, market, status: "getsecure_approved" }));

function offer(s: keyof typeof SUPPLIERS, cost: number | null, over: Partial<ProductOffer> = {}): ProductOffer {
  const sup = SUPPLIERS[s];
  return {
    supplierId: sup.id,
    supplier: sup.name,
    supplierIsDefault: sup.isDefault,
    supplierPriority: sup.priority,
    supplierSku: null,
    costExGst: cost,
    approved: true,
    pendingCostExGst: null,
    priceOnApplication: false,
    stock: null,
    lastChecked: daysAgo(3),
    confidence: 1,
    ...over,
  };
}

const MATERIALS: MaterialsPackage = {
  id: "mat",
  name: "Standard residential CCTV materials",
  propertyType: "residential",
  customerDescription: "Cabling and standard installation materials",
  items: [{ description: "Normal Cat6 allowance" }, { description: "Connectors" }, { description: "Normal clips and fixings" }, { description: "Weatherproofing and entry consumables" }, { description: "Miscellaneous CCTV installation materials" }],
  costExGst: null,
  sellExGst: null,
  isDefault: true,
  version: 1,
  status: "requires_review",
};

/** The eight residential packages as seeded: exact camera counts, no hours, no costs, no price. */
function seededPackages(): InstallationPackage[] {
  const out: InstallationPackage[] = [];
  for (const st of ["single", "double"] as const)
    for (const n of [2, 4, 6, 8])
      out.push({
        id: `RES_CCTV_${st.toUpperCase()}_${n}`,
        key: `RES_CCTV_${st.toUpperCase()}_${n}`,
        name: `Residential CCTV, ${st} storey, ${n} cameras`,
        propertyType: "residential",
        cameraCount: n,
        storeyType: st,
        minCameras: n,
        maxCameras: n,
        storeys: st === "double" ? 2 : 1,
        estimatedHours: null,
        labourRate: 95,
        allowanceExGst: null,
        materialCostExGst: null,
        materialsPackageId: "mat",
        conduitIncluded: st === "double",
        conduitAllowanceExGst: null,
        complexityAllowanceExGst: null,
        includedMaterials: [],
        assumptions: st === "double" ? ["Additional installation complexity for upper-storey cameras", "Cable routes to be confirmed (site/cable-route assumption)"] : [],
        exclusions: [],
        version: 1,
        status: "requires_review",
      });
  return out;
}

/** A package with every commercial input entered (TEST VALUES). */
const filled = (key: string, over: Partial<InstallationPackage> = {}) => (pkgs: InstallationPackage[]) =>
  pkgs.map((k) => (k.key === key ? { ...k, estimatedHours: 6, materialCostExGst: 80, conduitAllowanceExGst: k.conduitIncluded ? 60 : null, complexityAllowanceExGst: 0, allowanceExGst: 790, ...over } : k));

const profile = (over: Partial<RecordingProfile> = {}): RecordingProfile => ({
  id: "RES_STANDARD",
  key: "RES_STANDARD",
  name: "Residential standard",
  propertyType: "residential",
  isDefault: true,
  codec: null,
  frameRate: null,
  bitrateControl: null,
  recordingMode: "continuous",
  retentionTargetDays: 28,
  retentionMinimumDays: 14,
  rules: [],
  version: 1,
  status: "requires_review",
  ...over,
});
/** Design bitrates by resolution band (TEST VALUES, not Get Secure's). */
const BANDS: RecordingRule[] = [
  { id: "b4", scope: "resolution", minMp: 0, maxMp: 4.5, designBitrateMbps: 4 },
  { id: "b6", scope: "resolution", minMp: 4.5, maxMp: 6.5, designBitrateMbps: 6 },
  { id: "b8", scope: "resolution", minMp: 6.5, maxMp: null, designBitrateMbps: 8 },
];
const designedProfile = (rules: RecordingRule[] = BANDS) => profile({ codec: "H.265", frameRate: 15, bitrateControl: "VBR", rules, status: "getsecure_approved" });

/** The real catalogue as seeded: products, routes, unpriced packages and a profile with no design bitrates. */
function realCatalogue(edit: (products: Product[]) => Product[] = (p) => p, over: Partial<Catalogue> = {}): Catalogue {
  return { products: edit(referenceProducts()), packages: seededPackages(), materialsPackages: [MATERIALS], compatibility: referenceLinks(), routes: ROUTES, recordingProfiles: [profile()], ...over };
}
/** The same with a designed (test) recording profile. */
const designed = (edit?: (products: Product[]) => Product[], over: Partial<Catalogue> = {}) => realCatalogue(edit, { recordingProfiles: [designedProfile()], ...over });

const policies = (over: Partial<Policies> = {}): Policies => ({ ...DEFAULT_POLICIES, ...over });
const run = (input = house(), cat = realCatalogue(), pol = policies()) => assessCctv(input, cat, pol, { now: NOW });
const REF_IDS = new Set(REFERENCE_CATALOGUE.products.map((p) => `${p.manufacturer}|${p.model}`));
const hardware = (p: ReturnType<typeof run>): Product[] => [...p.cameras.map((c) => c.product), p.nvr.selected, p.recording.storage.drives?.product].filter(Boolean) as Product[];

describe("the reference catalogue", () => {
  const products = referenceProducts();
  it("holds real, sourced products for every residential family and the commercial catalogue", () => {
    const families = new Set(products.filter((p) => p.category === "camera").map((p) => p.family));
    for (const f of ["TP-Link VIGI", "HiLook", "Hikvision", "TVT", "Dahua", "Tiandy", "Uniview", "Ajax", "Axis", "Hanwha"]) expect(families).toContain(f);
    expect(REFERENCE_CATALOGUE.products.every((p) => /^https?:\/\//.test(p.sourceUrl) && p.verifiedAt)).toBe(true);
  });
  it("stores no prices and no design bitrates (those are Get Secure's)", () => {
    expect(JSON.stringify(REFERENCE_CATALOGUE)).not.toMatch(/costExGst|costIncGst|"price"|designBitrate|expectedBitrate/);
    expect(products.filter((p): p is CameraProduct => p.category === "camera").some((c) => c.maxBitrateMbps != null)).toBe(true);
  });
  it("has surveillance drives from more than one manufacturer at 2-12 TB", () => {
    const hdds = products.filter((p) => p.category === "hdd") as Extract<Product, { category: "hdd" }>[];
    for (const tb of [2, 4, 6, 8, 10, 12]) {
      const at = hdds.filter((h) => h.capacityTb === tb);
      expect(new Set(at.map((h) => h.manufacturer)).size, `${tb} TB`).toBeGreaterThanOrEqual(2);
    }
  });
  it("keeps commercial products off the residential ladder", () => {
    for (const p of products.filter((x) => x.family === "Axis" || x.family === "Hanwha")) {
      expect(p.residentialAllowed).toBe(false);
      expect(p.tier).toBeNull();
    }
  });
  it("assigns tiers by family policy, not by megapixels", () => {
    const cams = products.filter((p): p is CameraProduct => p.category === "camera");
    // 8 MP cameras exist in good-value and better families too, and they are not "best" for being 8 MP.
    const eightMp = cams.filter((c) => c.resolutionMp >= 8);
    expect(new Set(eightMp.map((c) => c.tier))).not.toEqual(new Set(["best"]));
    expect(cams.filter((c) => c.family === "TP-Link VIGI").every((c) => c.tier === "good")).toBe(true);
    expect(cams.filter((c) => c.family === "Hikvision").every((c) => c.tier === "best")).toBe(true);
    expect(cams.filter((c) => c.family === "Ajax").every((c) => c.tier === "premium")).toBe(true);
  });
  it("decomposes supplier kits into their components", () => {
    const kit = REFERENCE_CATALOGUE.links.filter((l) => l.kind === "kit_component" && l.from === "TP-Link|VIGI NK4P-T4425-2T");
    expect(kit.map((l) => [l.to, l.quantity])).toEqual(
      expect.arrayContaining([
        ["TP-Link|VIGI C445(2.8mm)", 4],
        ["TP-Link|VIGI NVR1004H-4P", 1],
      ]),
    );
  });
});

describe("Scenario A: 4-camera VIGI good/value residential system", () => {
  const p = run(house({ requestedTier: "good" }), designed());
  it("selects real VIGI cameras, a 4-channel VIGI recorder and a surveillance drive", () => {
    expect(p.recommendedTier).toBe("good");
    expect(p.cameras).toHaveLength(4);
    expect(p.cameras.every((c) => c.product?.family === "TP-Link VIGI")).toBe(true);
    expect(p.nvr.selected?.family).toBe("TP-Link VIGI");
    expect(p.nvr.selected?.channels).toBe(4);
    expect(p.recording.storage.drives?.product.category).toBe("hdd");
    expect(hardware(p).every((x) => REF_IDS.has(x.id))).toBe(true);
  });
  it("runs every recorder check separately", () => {
    const e = p.nvr.evaluated.find((x) => x.product.id === p.nvr.selected!.id)!;
    expect(e.checks.map((c) => c.name)).toEqual(expect.arrayContaining(["channels", "bandwidth", "max_bandwidth", "poe", "storage", "recording", "decoding", "features", "compatibility"]));
    expect(e.pass).toBe(true);
  });
  it("estimates retention from the design bitrate on the default drive (advisory)", () => {
    expect(p.recording.profile?.key).toBe("RES_STANDARD");
    expect(p.recording.designs.every((d) => d.designBitrateMbps != null && d.bitrateApproved)).toBe(true);
    expect(p.recording.storage).toMatchObject({ advisory: true, selection: "default", installedTb: 2 });
    expect(p.recording.storage.totalMbps).toBe(p.recording.designBandwidthMbps);
    expect(p.recording.storage.expectedRetentionDays).toBeGreaterThan(0);
    expect(p.recording.storage.basis).toMatch(/design bitrate/);
  });
  it("without design bitrates it still picks the system, but says an approved recording profile is required", () => {
    const q = run(house({ requestedTier: "good" }));
    expect(q.nvr.selected?.family).toBe("TP-Link VIGI");
    expect(q.recording.storage.status).toBe("cannot_calculate");
    expect(q.recording.storage.installedTb).toBe(2); // the default drive does not depend on the bitrate
    expect(q.recording.storage.expectedRetentionDays).toBeNull();
    expect(q.recording.storage.notes.join(" ")).toMatch(/approved recording profile required/);
    expect(q.approvals.find((a) => a.key === "recording_profile")?.description).toMatch(/Approved recording profile required/);
    expect(q.readiness.items.find((i) => i.key === "recording_profile")?.ok).toBe(false);
  });
  it("is honest about what is not priced yet", () => {
    expect(p.costing.complete).toBe(false);
    expect(p.costing.unpriced.join(" ")).toMatch(/no approved price/);
    expect(p.costing.unpriced.join(" ")).toMatch(/RES_CCTV_SINGLE_4: labour hours not set/);
    expect(p.labour.package?.key).toBe("RES_CCTV_SINGLE_4");
  });
});

describe("Scenario B: 4-camera HiLook better residential system", () => {
  const checks = (p: ReturnType<typeof run>) => p.nvr.evaluated.find((x) => x.product.id === p.nvr.selected!.id)!.checks;
  const check = (p: ReturnType<typeof run>, name: string) => checks(p).find((c) => c.name === name)!;
  it("selects real HiLook 6 MP cameras and a HiLook recorder (HiLook is first in the better tier)", () => {
    const p = run(house({ requestedTier: "better" }));
    expect(p.recommendedTier).toBe("better");
    expect(p.cameras).toHaveLength(4);
    expect(p.cameras.every((c) => c.product?.family === "HiLook" && c.product.resolutionMp === 6)).toBe(true);
    expect(p.nvr.selected?.family).toBe("HiLook");
    expect(hardware(p).every((x) => REF_IDS.has(x.id))).toBe(true);
  });
  it("passes design bandwidth on the 4-channel recorder and warns about maximum possible bandwidth, without rejecting it", () => {
    const p = run(house({ requestedTier: "better" }), designed());
    expect(p.nvr.selected?.model).toBe("NVR-104MH-K/4P(B)");
    expect(check(p, "bandwidth")).toMatchObject({ pass: true });
    expect(check(p, "bandwidth").detail).toMatch(/Design bandwidth 24\.0 Mbps, recorder accepts 40 Mbps/);
    expect(check(p, "max_bandwidth")).toMatchObject({ pass: true, warning: true });
    expect(check(p, "max_bandwidth").detail).toMatch(/Maximum possible configured bandwidth 64\.0 Mbps exceeds the recorder's 40 Mbps/);
    expect(p.risks.join(" ")).toMatch(/keep the cameras at the approved recording profile/);
    expect(p.recording.maxPossibleBandwidthMbps).toBe(64);
  });
  it("checks channels, bandwidth, PoE, storage, recording, decoding, features and compatibility each on its own", () => {
    const p = run(house({ requestedTier: "better" }), designed());
    expect(check(p, "channels")).toMatchObject({ pass: true });
    expect(check(p, "channels").detail).toMatch(/4 camera\(s\), 4 channel\(s\) needed, recorder has 4/);
    expect(check(p, "poe")).toMatchObject({ pass: true }); // per-port limit not published; total within 50 W
    expect(check(p, "poe").detail).toMatch(/budget 50 W/);
    expect(check(p, "storage")).toMatchObject({ pass: true });
    expect(check(p, "recording")).toMatchObject({ pass: true });
    expect(check(p, "decoding")).toMatchObject({ pass: true, unverified: false });
    expect(check(p, "decoding").detail).toMatch(/at 8 MP/);
    expect(check(p, "features")).toMatchObject({ pass: true });
    expect(check(p, "compatibility")).toMatchObject({ pass: true, unverified: false });
    expect(check(p, "compatibility").detail).toMatch(/same family/);
    expect(check(p, "storage").detail).toMatch(/takes the default 2 TB drive/);
    expect(p.recording.storage.installedTb).toBe(2);
  });
  it("a product-specific design bitrate beats the family rule, which beats the resolution band", () => {
    const cam = referenceProducts().find((x) => x.model === "IPC-T361H-MU(2.8mm)")!;
    const rules: RecordingRule[] = [...BANDS, { id: "fam", scope: "family", family: "HiLook", designBitrateMbps: 5 }, { id: "prod", scope: "product", productId: cam.id, designBitrateMbps: 3 }];
    const p = run(house({ requestedTier: "better" }), realCatalogue(undefined, { recordingProfiles: [designedProfile(rules)] }));
    const byModel = new Map(p.recording.designs.map((d) => [d.model, d]));
    expect(byModel.get("HiLook IPC-T361H-MU(2.8mm)")?.designBitrateMbps ?? 3).toBe(3);
    const other = p.recording.designs.find((d) => d.model !== "HiLook IPC-T361H-MU(2.8mm)");
    if (other) expect(other.designBitrateMbps).toBe(5);
    expect(p.recording.designs.every((d) => d.bitrateSource)).toBe(true);
  });
  it("names the documented junction box for the HiLook cameras without charging it", () => {
    const p = run(house({ requestedTier: "better", mountingSurface: "brick" }));
    const jb = p.installation.materials.find((m) => m.key.startsWith("junction_box"))!;
    expect(jb.product?.model).toBe("DS-1280ZJ-DM8");
    expect(jb.charged).toBe(false);
  });
  it("marks what HiLook does not publish as unverified rather than guessing", () => {
    const nvr = REFERENCE_CATALOGUE.products.find((x) => x.model === "NVR-104MH-K/4P(B)")!;
    expect(nvr.unverifiedFields).toEqual(expect.arrayContaining(["poePerPortW", "onvifProfiles"]));
    expect(nvr.specs.poePerPortW).toBeUndefined();
  });
});

describe("Scenario C: 4-camera Hikvision best residential system", () => {
  it("selects Hikvision 8 MP cameras and a Hikvision recorder", () => {
    const p = run(house({ requestedTier: "best" }));
    expect(p.cameras.every((c) => c.product?.family === "Hikvision" && c.product.resolutionMp === 8)).toBe(true);
    expect(p.nvr.selected?.family).toBe("Hikvision");
    expect(hardware(p).every((x) => REF_IDS.has(x.id))).toBe(true);
  });
  it("keeps the 4-channel Hikvision recorder on design bandwidth and warns about the 64 Mbps maximum", () => {
    const p = run(house({ requestedTier: "best" }), designed());
    expect(p.nvr.selected?.model).toBe("DS-7604NI-M1/4P");
    const e = p.nvr.evaluated.find((x) => x.product.model === "DS-7604NI-M1/4P")!;
    expect(e.checks.find((c) => c.name === "bandwidth")).toMatchObject({ pass: true });
    expect(e.checks.find((c) => c.name === "max_bandwidth")).toMatchObject({ pass: true, warning: true });
  });
  it("still rejects a recorder whose design bandwidth is exceeded", () => {
    const heavy = designedProfile([{ id: "hk", scope: "family", family: "Hikvision", designBitrateMbps: 12 }, ...BANDS]);
    const p = run(house({ requestedTier: "best" }), realCatalogue(undefined, { recordingProfiles: [heavy] }));
    const four = p.nvr.evaluated.find((x) => x.product.model === "DS-7604NI-M1/4P")!;
    expect(four.checks.find((c) => c.name === "bandwidth")!.pass).toBe(false);
    expect(p.nvr.selected?.channels).toBe(8);
  });
  it("is not chosen just because a camera is 8 MP", () => {
    // Only VIGI/Tiandy/TVT 8 MP alternatives would exist without Hikvision: best stays empty.
    const p = run(house({ requestedTier: "best" }), realCatalogue((list) => list.filter((x) => x.family !== "Hikvision")));
    expect(p.cameras.every((c) => c.product == null)).toBe(true);
  });
});

describe("Scenario D: 6-camera residential system", () => {
  const p = run(house({ requestedTier: "good", cameraCount: 6, areas: [] }), designed());
  it("needs more than a 4-channel recorder, and the PoE budget decides which 8-channel", () => {
    expect(p.cameras).toHaveLength(6);
    expect(p.nvr.selected?.channels).toBeGreaterThan(4);
    const e = p.nvr.evaluated.find((x) => x.product.id === p.nvr.selected!.id)!;
    expect(e.checks.find((c) => c.name === "poe")!.pass).toBe(true);
    const lowBudget = p.nvr.evaluated.find((x) => x.product.model === "VIGI NVR1008H-8P");
    if (lowBudget) expect(lowBudget.checks.find((c) => c.name === "poe")!.pass).toBe(false);
    expect(hardware(p).every((x) => REF_IDS.has(x.id))).toBe(true);
  });
  it("uses the exact 6-camera package", () => {
    expect(p.labour.package?.key).toBe("RES_CCTV_SINGLE_6");
  });
});

describe("Scenario E: commercial system", () => {
  const p = run(house({ propertyType: "commercial", requestedTier: "best", cameraCount: 6, areas: [], commercial: { futureCameras: 2 } }));
  it("rejects the residential tier and requires a site visit", () => {
    expect(p.recommendedTier).toBeNull();
    expect(p.tierReason).toMatch(/Residential tier "best" not applied/);
    expect(p.tierOptions).toEqual([]);
    expect(p.siteVisit.required).toBe(true);
    expect(p.approvals.map((a) => a.key)).toContain("commercial_site_visit");
  });
  it("only considers products allowed for commercial work, all real", () => {
    expect(p.cameras.every((c) => !c.product || c.product.commercialAllowed)).toBe(true);
    expect(p.cameras.some((c) => c.product)).toBe(true);
    expect(hardware(p).every((x) => REF_IDS.has(x.id) && x.commercialAllowed)).toBe(true);
    expect(p.nvr.evaluated.every((e) => e.product.commercialAllowed)).toBe(true);
  });
});

describe("supplier routing", () => {
  const cam = referenceProducts().find((p) => p.model === "DS-2CD2386G2-IU (2.8mm)")!;
  it("prefers the brand's route over a cheaper supplier", () => {
    const pr = chooseOffer(cam, [offer("atlas", 280), offer("itplus", 300)], ROUTES, "residential", DEFAULT_POLICIES, NOW)!;
    expect(pr.supplier).toBe("IT Plus");
    expect(pr.routeRank).toBe(1);
  });
  it("falls back to the next route when the preferred supplier has no approved price", () => {
    const pr = chooseOffer(cam, [offer("atlas", 280), offer("itplus", 300, { approved: false })], ROUTES, "commercial", DEFAULT_POLICIES, NOW)!;
    expect(pr.supplier).toBe("Atlas Gentech");
    expect(pr.routeNote).toMatch(/preferred IT Plus has no approved price/);
  });
  it("routes each brand to its own supplier", () => {
    const dahua = referenceProducts().find((p) => p.family === "Dahua")!;
    expect(chooseOffer(dahua, [offer("itplus", 100), offer("iot", 110), offer("clear", 120)], ROUTES, "residential", DEFAULT_POLICIES, NOW)!.supplier).toBe("Clear Digital");
    const hdd = referenceProducts().find((p) => p.category === "hdd")!;
    expect(chooseOffer(hdd, [offer("clear", 100), offer("itplus", 110)], ROUTES, "residential", DEFAULT_POLICIES, NOW)!.supplier).toBe("IT Plus"); // default supplier, no route
  });
  it("never quotes from a price-on-application or held listing", () => {
    expect(chooseOffer(cam, [offer("itplus", null, { priceOnApplication: true })], ROUTES, "residential", DEFAULT_POLICIES, NOW)).toBeNull();
    const pr = chooseOffer(cam, [offer("itplus", 300, { pendingCostExGst: 400 })], ROUTES, "residential", DEFAULT_POLICIES, NOW)!;
    expect(pr.costExGst).toBe(300);
  });
});

describe("price freshness", () => {
  it("is current, aging, stale or unknown by the price date", () => {
    expect(priceFreshness(daysAgo(5), DEFAULT_POLICIES, NOW).freshness).toBe("current");
    expect(priceFreshness(daysAgo(20), DEFAULT_POLICIES, NOW).freshness).toBe("aging");
    expect(priceFreshness(daysAgo(45), DEFAULT_POLICIES, NOW).freshness).toBe("stale");
    expect(priceFreshness(null, DEFAULT_POLICIES, NOW).freshness).toBe("unknown");
  });
  it("flags a stale price for refresh before final quote approval, and still prepares the assessment", () => {
    const cat = realCatalogue((list) =>
      list.map((x) => (x.family === "TP-Link VIGI" || x.category === "hdd" ? ({ ...x, offers: [offer("itplus", 100, { lastChecked: x.category === "nvr" ? daysAgo(45) : daysAgo(2) })] } as Product) : x)),
    );
    const p = run(house({ requestedTier: "good" }), cat);
    expect(p.costing.refreshRequired.map((r) => r.model)).toEqual([expect.stringMatching(/NVR/)]);
    expect(p.approvals.find((a) => a.key === "price_refresh")!.description).toMatch(/^Refresh supplier price before final quote approval/);
    expect(p.costing.lines.find((l) => l.kind === "hardware" && l.model?.includes("NVR"))).toMatchObject({ supplier: "IT Plus", freshness: "stale" });
  });
});

describe("kits", () => {
  // Test prices: the kit is cheaper than 4 cameras + the recorder bought separately.
  const priced = (kitCost: number) =>
    designed((list) =>
      list.map((x) => {
        if (x.model === "VIGI C445(2.8mm)") return { ...x, offers: [offer("itplus", 90)] } as Product;
        if (x.family === "TP-Link VIGI" && x.category === "camera") return { ...x, offers: [offer("itplus", 150)] } as Product;
        if (x.model === "VIGI NVR1004H-4P") return { ...x, offers: [offer("itplus", 200)] } as Product;
        if (x.model === "VIGI NVR1104H-4P") return { ...x, offers: [offer("itplus", 260)] } as Product;
        if (x.model === "VIGI NK4P-T4425-2T") return { ...x, offers: [offer("itplus", kitCost)] } as Product;
        if (x.category === "hdd") return { ...x, offers: [offer("itplus", 100 + (x as { capacityTb: number }).capacityTb * 20)] } as Product;
        return x;
      }),
    );
  it("uses the kit for its components when cheaper, and prices anything extra separately", () => {
    const p = run(house({ requestedTier: "good" }), priced(500));
    expect(p.costing.kit?.model).toBe("TP-Link VIGI NK4P-T4425-2T");
    expect(p.costing.kit?.savingExGst).toBe(4 * 90 + 200 - 500);
    expect(p.costing.lines.some((l) => l.productId === "TP-Link|VIGI C445(2.8mm)")).toBe(false);
    expect(p.costing.lines.some((l) => l.kind === "hardware" && l.model?.includes("TB") === false && /PURZ|PURP|VX|VE/.test(l.model ?? ""))).toBe(true); // the drive stays its own line
  });
  it("does not use a kit that is not cheaper", () => {
    const p = run(house({ requestedTier: "good" }), priced(9999));
    expect(p.costing.kit).toBeNull();
  });
});

describe("junction boxes", () => {
  it("names the exact documented box for the chosen camera, recommends it, and does not charge it", () => {
    const p = run(house({ requestedTier: "best", mountingSurface: "brick" }));
    const jb = p.installation.materials.filter((m) => m.key.startsWith("junction_box"));
    expect(jb.length).toBeGreaterThan(0);
    for (const m of jb) {
      expect(m.product?.category).toBe("junction_box");
      expect(m.charged).toBe(false);
      expect(m.approvalRequired).toBe(true);
    }
    expect(p.installation.accessories?.some((a) => a.kind === "camera_junction_box")).toBe(true);
    expect(p.costing.lines.some((l) => l.key.startsWith("junction_box"))).toBe(false);
  });
  it("lists accessories without adding them when no box is called for", () => {
    const p = run(house({ requestedTier: "good", mountingSurface: "weatherboard" }));
    expect(p.installation.materials.some((m) => m.key.startsWith("junction_box"))).toBe(false);
    expect(p.installation.accessories?.length).toBeGreaterThan(0);
  });
});

describe("installation packages (exact camera counts) and materials", () => {
  it("matches only the exact package: 4 cameras single storey is RES_CCTV_SINGLE_4", () => {
    const p = run(house({ requestedTier: "good" }), designed());
    expect(p.labour.package?.key).toBe("RES_CCTV_SINGLE_4");
    expect(p.labour.customInstallation).toBe(false);
  });
  it("never maps 3, 5 or 7 cameras to a range: it is a custom installation", () => {
    for (const n of [3, 5, 7]) {
      const p = run(house({ requestedTier: "good", cameraCount: n, areas: [] }), designed());
      expect(p.labour.package, `${n} cameras`).toBeNull();
      expect(p.labour.customInstallation).toBe(true);
      expect(p.approvals.map((a) => a.key)).toContain("custom_installation");
      expect(p.costing.unpriced.join(" ")).toMatch(new RegExp(`Custom installation for ${n} camera`));
      expect(p.costing.complete).toBe(false);
    }
  });
  it("leaves installation unpriced, listing each missing input, until Get Secure enters them", () => {
    const p = run(house({ requestedTier: "good" }), designed());
    expect(p.labour.basis).toBeNull();
    expect(p.labour.missing).toEqual([
      "RES_CCTV_SINGLE_4: labour hours not set",
      "RES_CCTV_SINGLE_4: standard material cost not set",
      "RES_CCTV_SINGLE_4: installation complexity allowance not set (enter 0 if none)",
      "RES_CCTV_SINGLE_4: customer sell allowance not set",
    ]);
  });
  it("prices labour cost at hours x $95 and charges the package sell allowance", () => {
    const p = run(house({ requestedTier: "good" }), designed(undefined, { packages: filled("RES_CCTV_SINGLE_4")(seededPackages()) }));
    expect(p.labour.missing).toEqual([]);
    expect(p.labour.labourCostExGst).toBe(6 * 95);
    const inst = p.costing.lines.find((l) => l.key === "installation")!;
    expect(inst).toMatchObject({ unitCostExGst: 570, unitSellExGst: 790, priced: true });
    expect(p.costing.lines.find((l) => l.key === "standard_materials")).toMatchObject({ unitCostExGst: 80, internalOnly: true });
  });
  it("double storey: uses the exact double-storey package, needs its conduit allowance, keeps the cable-route assumption, no automatic site visit", () => {
    const p = run(house({ requestedTier: "good", storeys: 2 }), designed());
    expect(p.labour.package?.key).toBe("RES_CCTV_DOUBLE_4");
    expect(p.installation.conduitRequired).toBe(true);
    expect(p.labour.missing).toContain("RES_CCTV_DOUBLE_4: conduit allowance not set");
    expect(p.assumptions.join(" ")).toMatch(/cable-route assumption/);
    expect(p.siteVisit.required).toBe(false);
  });
  it("shows the customer one installation line that includes cabling and standard materials, and keeps the costs internal", () => {
    const cat = designed(
      (list) => list.map((x) => (x.family === "TP-Link VIGI" || x.category === "hdd" ? ({ ...x, offers: [offer("itplus", 100)] } as Product) : x)),
      { packages: filled("RES_CCTV_SINGLE_4")(seededPackages()) },
    );
    const p = run(house({ requestedTier: "good" }), cat);
    expect(p.costing.lines.find((l) => l.key === "standard_materials")!.detail?.join(" ")).toMatch(/Cat6/);
    const q = composeQuote(p, { customerName: "Test", gstPct: 15 });
    const text = JSON.stringify(q);
    expect(q.lineItems.map((l) => l.description)).toContain("Installation, commissioning, cabling and standard installation materials");
    expect(text).not.toMatch(/Cat6|IT Plus|internal|costExGst|unitCost|margin|complexity|conduit allowance/i);
  });
});

describe("hard drives", () => {
  it("residential: the default capacity comes from the camera count, not the retention asked for", () => {
    const week = run(house({ requestedTier: "good", retentionDays: 7 }), designed());
    const month = run(house({ requestedTier: "good", retentionDays: 30 }), designed());
    expect(week.cameras.length).toBe(month.cameras.length);
    expect(week.recording.storage.drives!.product.capacityTb).toBe(2);
    expect(month.recording.storage.drives!.product.capacityTb).toBe(2);
    expect(week.recording.storage.expectedRetentionDays).toBe(month.recording.storage.expectedRetentionDays);
  });
});

describe("first genuinely priced 4-camera residential quote (all inputs are TEST VALUES)", () => {
  // Trade costs for every product a VIGI system could use, current and approved.
  const tradePrices = (list: Product[]) =>
    list.map((x) => {
      if (x.family === "TP-Link VIGI" && x.category === "camera") return { ...x, offers: [offer("itplus", 120, { stock: "In stock" }), offer("clear", 110, { stock: "2" })] } as Product;
      if (x.family === "TP-Link VIGI" && x.category === "nvr") return { ...x, offers: [offer("itplus", 210, { stock: "In stock" })] } as Product;
      if (x.category === "hdd") return { ...x, offers: [offer("itplus", 60 + 25 * (x as { capacityTb: number }).capacityTb)] } as Product;
      if (x.category === "junction_box") return { ...x, offers: [offer("itplus", 18)] } as Product;
      return x;
    });
  const complete = (over: Partial<Catalogue> = {}) => designed(tradePrices, { packages: filled("RES_CCTV_SINGLE_4")(seededPackages()), ...over });
  const p = run(house({ requestedTier: "good", mountingSurface: "brick" }), complete());

  it("selects the real camera, recorder and calculated drive, with accessories and network", () => {
    expect(p.cameras.every((c) => c.product?.family === "TP-Link VIGI")).toBe(true);
    expect(p.nvr.selected?.family).toBe("TP-Link VIGI");
    expect(p.recording.storage.drives?.product.capacityTb).toBe(2);
    expect(p.installation.accessories?.length).toBeGreaterThan(0);
    expect(p.network.method).toBe("direct_lan");
    expect(p.labour.package?.key).toBe("RES_CCTV_SINGLE_4");
  });
  it("is fully priced from current supplier costs, using the preferred supplier, not the cheapest", () => {
    expect(p.costing.complete).toBe(true);
    expect(p.costing.unpriced).toEqual([]);
    const cam = p.costing.lines.find((l) => l.key.startsWith("camera:"))!;
    expect(cam).toMatchObject({ supplier: "IT Plus", unitCostExGst: 120, freshness: "current", stock: "In stock" });
    expect(cam.alternatives?.map((a) => a.supplier)).toEqual(["Clear Digital"]);
    expect(p.costing.refreshRequired).toEqual([]);
  });
  it("shows the junction box's real supplier cost but does not charge it without Chris", () => {
    const jb = p.installation.materials.find((m) => m.key.startsWith("junction_box"))!;
    expect(jb.reason).toMatch(/Supplier cost \$18 ex GST each \(IT Plus\)/);
    expect(jb.charged).toBe(false);
    expect(p.costing.lines.some((l) => l.key.startsWith("junction_box"))).toBe(false);
  });
  it("proposes a sell price with a provisional markup, and works out gross profit and margin", () => {
    const c = p.costing;
    expect(c.markupSource).toBe("suggested");
    expect(c.markupLogic).toMatch(/Provisional suggested markup 25%/);
    const hardwareCost = c.lines.filter((l) => l.kind === "hardware" && l.priced).reduce((s, l) => s + l.unitCostExGst! * l.quantity, 0);
    expect(c.equipmentCost).toBeCloseTo(hardwareCost, 2);
    expect(c.labourCost).toBe(570);
    expect(c.materialsCost).toBe(80);
    expect(c.allowancesCost).toBe(0);
    const hardwareSell = c.lines.filter((l) => l.kind === "hardware" && l.priced).reduce((s, l) => s + l.unitSellExGst! * l.quantity, 0);
    expect(c.sellExGst).toBeCloseTo(hardwareSell + 790, 2);
    expect(c.gst).toBeCloseTo(c.sellExGst * 0.15, 2);
    expect(c.grossProfit).toBeCloseTo(c.sellExGst - c.equipmentCost - 570 - 80, 2);
    expect(c.grossMarginPct).toBeCloseTo((c.grossProfit / c.sellExGst) * 100, 1);
  });
  it("lets Chris override the markup", () => {
    const q = assessCctv(house({ requestedTier: "good" }), complete(), DEFAULT_POLICIES, { now: NOW, markupOverride: 20 });
    expect(q.costing.markupPct).toBe(20);
    expect(q.costing.markupSource).toBe("override");
  });
  it("produces a customer quote and email draft with no cost, supplier or margin, both needing Chris", () => {
    const quote = composeQuote(p, { customerName: "Dave Lincoln", gstPct: 15 });
    const email = composeEmail(p, { firstName: "Dave", subject: "CCTV quote", address: "12 Test Street", areas: house().areas });
    expect(quote.complete).toBe(true);
    expect(quote.lineItems.length).toBeGreaterThan(2);
    const text = JSON.stringify(quote) + email.body;
    const hit = text.match(/.{0,60}(IT Plus|Clear Digital|cost price|supplier cost|trade|unit cost|margin|markup|\binternal\b).{0,60}/i);
    expect(hit?.[0] ?? null).toBeNull();
    expect(p.approvals.map((a) => a.key)).toEqual(expect.arrayContaining(["customer_email", "quote"]));
  });
  const missing: [string, () => Catalogue, RegExp][] = [
    ["a camera price", () => designed((l) => tradePrices(l).map((x) => (x.family === "TP-Link VIGI" && x.category === "camera" ? ({ ...x, offers: [] } as Product) : x)), { packages: filled("RES_CCTV_SINGLE_4")(seededPackages()) }), /no approved price/],
    ["the labour hours", () => complete({ packages: filled("RES_CCTV_SINGLE_4", { estimatedHours: null })(seededPackages()) }), /labour hours not set/],
    ["the material cost", () => complete({ packages: filled("RES_CCTV_SINGLE_4", { materialCostExGst: null })(seededPackages()) }), /standard material cost not set/],
    ["the sell allowance", () => complete({ packages: filled("RES_CCTV_SINGLE_4", { allowanceExGst: null })(seededPackages()) }), /customer sell allowance not set/],
  ];
  it("without the design bitrate it is priced but not ready: bandwidth and retention cannot be checked", () => {
    const q = run(house({ requestedTier: "good" }), complete({ recordingProfiles: [profile()] }));
    expect(q.recording.storage.installedTb).toBe(2);
    expect(q.readiness.ready).toBe(false);
    expect(q.readiness.items.find((i) => i.key === "recording_profile")?.ok).toBe(false);
  });
  for (const [what, cat, msg] of missing) {
    it(`is Not fully priced, and says why, without ${what}`, () => {
      const q = run(house({ requestedTier: "good" }), cat());
      expect(q.costing.complete).toBe(false);
      expect(q.costing.unpriced.join(" ")).toMatch(msg);
    });
  }
});
