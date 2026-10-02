/**
 * Business Brain v0.2 on the real, verified reference catalogue (specifications from the
 * manufacturers' own pages and datasheets; see data/catalogue-research and
 * src/lib/brain/reference/catalogue.json).
 *
 * Scenarios A-E from the v0.2 brief, plus supplier routing, price freshness, kits, junction boxes,
 * installation packages and the standard materials package.
 *
 * Supplier costs used here are TEST VALUES, not real trade prices: the reference catalogue has
 * none, and prices only ever come from a supplier.
 */
import { describe, it, expect } from "vitest";
import { assessCctv } from "@/lib/brain/engine";
import { composeQuote } from "@/lib/brain/compose";
import { chooseOffer, priceFreshness } from "@/lib/brain/pricing";
import { DEFAULT_POLICIES } from "@/lib/brain/policy";
import { REFERENCE_CATALOGUE, referenceLinks, referenceProducts } from "@/lib/brain/reference/products";
import type { BrandRoute, CameraProduct, Catalogue, InstallationPackage, MaterialsPackage, Policies, Product, ProductOffer } from "@/lib/brain/types";
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

/** The eight residential packages as seeded: structure only, no hours, no price. */
function seededPackages(): InstallationPackage[] {
  const out: InstallationPackage[] = [];
  for (const storeys of [1, 2])
    for (const [min, max] of [
      [1, 2],
      [3, 4],
      [5, 6],
      [7, 8],
    ])
      out.push({
        id: `pkg-${min}-${max}-${storeys}`,
        name: `Residential ${min}–${max} cameras, ${storeys === 1 ? "single" : "double"} storey`,
        propertyType: "residential",
        minCameras: min,
        maxCameras: max,
        storeys,
        estimatedHours: null,
        labourRate: 95,
        allowanceExGst: null,
        materialsPackageId: "mat",
        conduitIncluded: storeys === 2,
        conduitAllowanceExGst: null,
        includedMaterials: [],
        assumptions: storeys === 2 ? ["Additional installation complexity for upper-storey cameras", "Cable routes to be confirmed (site/cable-route assumption)"] : [],
        exclusions: [],
        version: 1,
        status: "requires_review",
      });
  return out;
}

function realCatalogue(edit: (products: Product[]) => Product[] = (p) => p, over: Partial<Catalogue> = {}): Catalogue {
  return { products: edit(referenceProducts()), packages: seededPackages(), materialsPackages: [MATERIALS], compatibility: referenceLinks(), routes: ROUTES, ...over };
}

const policies = (over: Partial<Policies> = {}): Policies => ({ ...DEFAULT_POLICIES, ...over });
const run = (input = house(), cat = realCatalogue(), pol = policies()) => assessCctv(input, cat, pol, { now: NOW });
const REF_IDS = new Set(REFERENCE_CATALOGUE.products.map((p) => `${p.manufacturer}|${p.model}`));
const hardware = (p: ReturnType<typeof run>): Product[] => [...p.cameras.map((c) => c.product), p.nvr.selected, p.recording.storage.drives?.product].filter(Boolean) as Product[];
const withSpecs = (match: (p: Product) => boolean, specs: Record<string, unknown>) => (list: Product[]) => list.map((p) => (match(p) ? ({ ...p, ...specs } as Product) : p));

describe("the reference catalogue", () => {
  const products = referenceProducts();
  it("holds real, sourced products for every residential family and the commercial catalogue", () => {
    const families = new Set(products.filter((p) => p.category === "camera").map((p) => p.family));
    for (const f of ["TP-Link VIGI", "HiLook", "Hikvision", "TVT", "Dahua", "Tiandy", "Uniview", "Ajax", "Axis", "Hanwha"]) expect(families).toContain(f);
    expect(REFERENCE_CATALOGUE.products.every((p) => /^https?:\/\//.test(p.sourceUrl) && p.verifiedAt)).toBe(true);
  });
  it("stores no prices and no Get Secure planning bitrate", () => {
    expect(JSON.stringify(REFERENCE_CATALOGUE)).not.toMatch(/costExGst|costIncGst|"price"/);
    expect(products.filter((p): p is CameraProduct => p.category === "camera").every((c) => c.expectedBitrateMbps == null)).toBe(true);
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
  const p = run(house({ requestedTier: "good" }));
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
    expect(e.checks.map((c) => c.name)).toEqual(expect.arrayContaining(["channels", "bandwidth", "poe", "storage", "recording", "decoding", "features", "compatibility"]));
    expect(e.pass).toBe(true);
  });
  it("sizes storage from the bitrate calculation, and says it used the maximum published bitrate", () => {
    expect(p.recording.storage.status).toBe("meets_target");
    expect(p.recording.storage.notes.join(" ")).toMatch(/maximum published bitrate/);
    expect(p.approvals.map((a) => a.key)).toContain("expected_bitrate");
  });
  it("is honest about what is not priced yet", () => {
    expect(p.costing.complete).toBe(false);
    expect(p.costing.unpriced.join(" ")).toMatch(/no approved price/);
    expect(p.costing.unpriced.join(" ")).toMatch(/hours and price not set/);
    expect(p.labour.package?.name).toBe("Residential 3–4 cameras, single storey");
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
  it("on the maximum published bitrate the 40 Mbps 4-channel recorder is shown failing bandwidth, and the 8-channel is used", () => {
    const p = run(house({ requestedTier: "better" }));
    const four = p.nvr.evaluated.find((e) => e.product.model === "NVR-104MH-K/4P(B)")!;
    expect(four.checks.find((c) => c.name === "bandwidth")).toMatchObject({ pass: false });
    expect(four.checks.find((c) => c.name === "channels")!.pass).toBe(true);
    expect(p.nvr.selected?.model).toBe("NVR-108MH-K/8P(B)");
    expect(p.approvals.map((a) => a.key)).toContain("expected_bitrate");
  });
  it("with Get Secure's expected bitrate entered, the 4-channel HiLook recorder passes each check on its own", () => {
    // What Chris would enter as the planning bitrate (test value).
    const p = run(house({ requestedTier: "better" }), realCatalogue(withSpecs((x) => x.family === "HiLook" && x.category === "camera", { expectedBitrateMbps: 6 })));
    expect(p.nvr.selected?.model).toBe("NVR-104MH-K/4P(B)");
    expect(check(p, "channels")).toMatchObject({ pass: true });
    expect(check(p, "channels").detail).toMatch(/4 camera\(s\), 4 channel\(s\) needed, recorder has 4/);
    expect(check(p, "bandwidth")).toMatchObject({ pass: true });
    expect(check(p, "bandwidth").detail).toMatch(/24\.0 Mbps from cameras, recorder accepts 40 Mbps/);
    expect(check(p, "poe")).toMatchObject({ pass: true }); // per-port limit not published; total within 50 W
    expect(check(p, "poe").detail).toMatch(/budget 50 W/);
    expect(check(p, "storage")).toMatchObject({ pass: true });
    expect(check(p, "recording")).toMatchObject({ pass: true });
    expect(check(p, "decoding")).toMatchObject({ pass: true, unverified: false });
    expect(check(p, "decoding").detail).toMatch(/at 8 MP/);
    expect(check(p, "features")).toMatchObject({ pass: true });
    expect(check(p, "compatibility")).toMatchObject({ pass: true, unverified: false });
    expect(check(p, "compatibility").detail).toMatch(/same family/);
    expect(p.recording.storage.status).toBe("meets_target");
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
  it("on the maximum published bitrate, the 4-channel recorder's bandwidth is exceeded and that is shown, not hidden", () => {
    const p = run(house({ requestedTier: "best" }));
    const four = p.nvr.evaluated.find((e) => e.product.model === "DS-7604NI-M1/4P")!;
    expect(four.checks.find((c) => c.name === "bandwidth")!.pass).toBe(false);
    expect(p.nvr.selected?.channels).toBe(8);
    expect(p.nvr.notes.join(" ")).toMatch(/No 4-channel recorder passed/);
  });
  it("with Get Secure's expected bitrate entered, the 4-channel recorder passes every check", () => {
    // What Chris would enter on the camera record as the planning bitrate (test value).
    const cat = realCatalogue(withSpecs((x) => x.family === "Hikvision" && x.category === "camera", { expectedBitrateMbps: 6 }));
    const p = run(house({ requestedTier: "best" }), cat);
    expect(p.nvr.selected?.model).toBe("DS-7604NI-M1/4P");
    expect(p.approvals.map((a) => a.key)).not.toContain("expected_bitrate");
  });
  it("is not chosen just because a camera is 8 MP", () => {
    // Only VIGI/Tiandy/TVT 8 MP alternatives would exist without Hikvision: best stays empty.
    const p = run(house({ requestedTier: "best" }), realCatalogue((list) => list.filter((x) => x.family !== "Hikvision")));
    expect(p.cameras.every((c) => c.product == null)).toBe(true);
  });
});

describe("Scenario D: 6-camera residential system", () => {
  const p = run(house({ requestedTier: "good", cameraCount: 6, areas: [] }));
  it("needs more than a 4-channel recorder, and the PoE budget decides which 8-channel", () => {
    expect(p.cameras).toHaveLength(6);
    expect(p.nvr.selected?.channels).toBeGreaterThan(4);
    const e = p.nvr.evaluated.find((x) => x.product.id === p.nvr.selected!.id)!;
    expect(e.checks.find((c) => c.name === "poe")!.pass).toBe(true);
    const lowBudget = p.nvr.evaluated.find((x) => x.product.model === "VIGI NVR1008H-8P");
    if (lowBudget) expect(lowBudget.checks.find((c) => c.name === "poe")!.pass).toBe(false);
    expect(hardware(p).every((x) => REF_IDS.has(x.id))).toBe(true);
  });
  it("uses the 5–6 camera package", () => {
    expect(p.labour.package?.name).toBe("Residential 5–6 cameras, single storey");
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
    realCatalogue((list) =>
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

describe("installation packages and materials", () => {
  it("leaves labour unpriced until hours or a package price are entered", () => {
    const p = run(house({ requestedTier: "good" }));
    expect(p.labour.basis).toBeNull();
    expect(p.costing.lines.some((l) => l.kind === "labour")).toBe(false);
  });
  it("uses entered hours x the $95 residential rate when no package price is set", () => {
    const pkgs = seededPackages().map((k) => (k.id === "pkg-3-4-1" ? { ...k, estimatedHours: 6 } : k));
    const p = run(house({ requestedTier: "good" }), realCatalogue(undefined, { packages: pkgs }));
    expect(p.labour.basis).toBe("hours_x_rate");
    expect(p.labour.allowanceExGst).toBe(6 * 95);
    expect(p.approvals.map((a) => a.key)).toContain("labour_basis");
  });
  it("uses the package price when one is set", () => {
    const pkgs = seededPackages().map((k) => (k.id === "pkg-3-4-1" ? { ...k, estimatedHours: 6, allowanceExGst: 690 } : k));
    const p = run(house({ requestedTier: "good" }), realCatalogue(undefined, { packages: pkgs }));
    expect(p.labour.basis).toBe("package_price");
    expect(p.costing.lines.find((l) => l.kind === "labour")?.unitSellExGst).toBe(690);
  });
  it("double storey: uses the double-storey package, considers conduit, keeps the cable-route assumption, no automatic site visit", () => {
    const p = run(house({ requestedTier: "good", storeys: 2 }));
    expect(p.labour.package?.name).toBe("Residential 3–4 cameras, double storey");
    expect(p.installation.conduitRequired).toBe(true);
    expect(p.costing.unpriced).toContain("Conduit allowance not set");
    expect(p.assumptions.join(" ")).toMatch(/cable-route assumption/);
    expect(p.siteVisit.required).toBe(false);
  });
  it("shows the customer one materials line and keeps its contents and cost internal", () => {
    const mat = { ...MATERIALS, costExGst: 60, sellExGst: 150, status: "getsecure_approved" as const };
    const cat = realCatalogue(
      (list) => list.map((x) => (x.family === "TP-Link VIGI" || x.category === "hdd" ? ({ ...x, offers: [offer("itplus", 100)] } as Product) : x)),
      { materialsPackages: [mat] },
    );
    const p = run(house({ requestedTier: "good" }), cat);
    const line = p.costing.lines.find((l) => l.key === "standard_materials")!;
    expect(line.customerDescription).toBe("Cabling and standard installation materials");
    expect(line.detail?.join(" ")).toMatch(/Cat6/);
    const q = composeQuote(p, { customerName: "Test", gstPct: 15 });
    const text = JSON.stringify(q);
    expect(text).toMatch(/Cabling and standard installation materials/);
    expect(text).not.toMatch(/Cat6|IT Plus|costExGst|unitCost|margin/i);
  });
});

describe("hard drives", () => {
  it("chooses capacity from the storage calculation, not the camera count", () => {
    const week = run(house({ requestedTier: "good", retentionDays: 7 }));
    const month = run(house({ requestedTier: "good", retentionDays: 30 }));
    expect(week.cameras.length).toBe(month.cameras.length);
    expect(week.recording.storage.drives!.product.capacityTb).toBeLessThan(month.recording.storage.drives!.product.capacityTb);
  });
});
