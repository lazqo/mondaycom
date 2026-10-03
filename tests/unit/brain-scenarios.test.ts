/**
 * The Business Brain v0.1 test scenarios that exercise the engine (1-11, 15, 16). Scenarios 12-14
 * (drafts, quote approval) need the database and live in tests/integration/brain-workflow.test.ts.
 * The catalogue is fictional; see brain-fixtures.ts.
 */
import { describe, it, expect } from "vitest";
import type { CctvKit } from "@/lib/brain/types";
import { assessCctv } from "@/lib/brain/engine";
import { composeEmail, composeQuote } from "@/lib/brain/compose";
import { validateNvr, onvifCompatible } from "@/lib/brain/nvr";

import { siteVisitDecision } from "@/lib/brain/site-visit";
import { camera, catalogue, house, nvr, testPolicies } from "./brain-fixtures";

const NOW = new Date("2026-10-02T00:00:00Z");
const run = (input = house(), cat = catalogue(), policies = testPolicies()) => assessCctv(input, cat, policies, { now: NOW });
const approvalKeys = (p: ReturnType<typeof run>) => p.approvals.map((a) => a.key);

describe("Test 1: normal 4-camera house", () => {
  const p = run();

  it("allows a remote quote", () => {
    expect(p.siteVisit.required).toBe(false);
    expect(p.siteVisit.remoteQuoteConfidence).toBe("high");
  });

  it("picks a 4-channel recorder that passes every check", () => {
    expect(p.nvr.selected?.channels).toBe(4);
    expect(p.nvr.evaluated.find((e) => e.product.id === p.nvr.selected!.id)!.checks.every((c) => c.pass)).toBe(true);
  });

  it("records 24/7 on the fallback 2 TB drive for 4 cameras (no kit), with no retention calculated", () => {
    expect(p.recording.mode).toBe("continuous");
    expect(p.recording.storage).toMatchObject({ selection: "fallback", installedTb: 2, customerRetentionDays: null });
    expect(p.recording.storage.notes.join(" ")).not.toMatch(/days/i);
    expect(Object.keys(p.recording.storage).sort()).toEqual(["capacityTb", "customerRetentionDays", "drives", "installedTb", "notes", "selection"]);
  });

  it("uses the exact 4-camera package, with standard materials inside it and labour at $95/hour", () => {
    expect(p.labour.package?.key).toBe("RES_CCTV_SINGLE_4");
    expect(p.installation.materials.find((m) => m.key === "standard_materials")?.charged).toBe(false);
    expect(p.costing.lines.find((l) => l.key === "standard_materials")).toMatchObject({ internalOnly: true, unitCostExGst: 60 });
    expect(p.labour.internalRate).toBe(95);
    expect(p.labour.internalReferenceExGst).toBe(6 * 95);
  });

  it("is priced: 15% GST on the ex-GST subtotal, margin shown internally", () => {
    expect(p.costing.complete).toBe(true);
    expect(p.costing.gst).toBeCloseTo(p.costing.sellExGst * 0.15, 1);
    expect(p.costing.totalIncGst).toBeCloseTo(p.costing.sellExGst * 1.15, 1);
    expect(p.costing.grossProfit).toBeGreaterThan(0);
  });

  it("produces drafts only, both needing Chris, with no cost or margin in them", () => {
    expect(approvalKeys(p)).toEqual(expect.arrayContaining(["customer_email", "quote"]));
    const email = composeEmail(p, { firstName: "Dave Lincoln", subject: "CCTV quote", address: "12 Test Street", areas: house().areas });
    const quote = composeQuote(p, { customerName: "Dave Lincoln", gstPct: 15 });
    expect(email.body).not.toMatch(/margin|cost price|markup|\$100\b/i);
    // Residential: no promised number of days, and the variability is stated.
    expect(email.body).not.toMatch(/\d+ days/);
    expect(email.body).toContain("Recording duration depends on camera settings, recording configuration and scene activity.");
    expect(quote.notes).not.toMatch(/28 days/);
    expect(quote.notes).toMatch(/recording duration depends on camera settings, recording configuration and scene activity/);
    expect(JSON.stringify(quote)).not.toMatch(/costExGst|margin|markup/i);
    expect(quote.lineItems.every((l) => l.unitPrice > 0)).toBe(true);
  });
});

describe("Test 2: 6 cameras, double storey", () => {
  const p = run(house({ cameraCount: 6, storeys: 2, areas: ["Driveway", "Front door", "Side gate", "Backyard", "Garage", "Deck"] }));

  it("uses a recorder with more than 4 channels and the default 4 TB drive for 6 cameras", () => {
    expect(p.nvr.selected!.channels).toBeGreaterThan(4);
    expect(p.recording.storage).toMatchObject({ selection: "fallback", installedTb: 4 });
  });

  it("allows for double-storey complexity and conduit, with the assumption stated", () => {
    expect(p.installation.doubleStorey).toBe(true);
    expect(p.installation.conduitRequired).toBe(true);
    expect(p.installation.materials.some((m) => m.key === "conduit")).toBe(true);
    expect(p.installation.complexity).not.toBe("low");
    expect(p.assumptions.join(" ")).toMatch(/upper-storey cable runs/i);
    expect(p.labour.package?.storeys).toBe(2);
  });

  it("can stay a remote, indicative quote, at lower site confidence, and still needs Chris", () => {
    expect(p.siteVisit.required).toBe(false);
    expect(p.confidence.site).toBe("medium");
    expect(approvalKeys(p)).toContain("quote");
  });
});

describe("Test 3: concrete wall mounting", () => {
  const p = run(house({ mountingSurface: "concrete" }));
  it("recommends junction boxes but does not charge them until Chris confirms", () => {
    expect(p.installation.junctionBoxRecommended).toBe(true);
    const jb = p.installation.materials.find((m) => m.key === "junction_box")!;
    expect(jb.charged).toBe(false);
    expect(jb.approvalRequired).toBe(true);
    expect(p.costing.lines.some((l) => l.key === "junction_box")).toBe(false);
    expect(approvalKeys(p)).toContain("junction_box");
  });
});

describe("Test 4: router elsewhere in the house", () => {
  const p = run(house({ recorderNearRouter: "no", wiredRoutePossible: "unknown" }));
  it("extends the wired LAN first and does not add 4G", () => {
    expect(p.network.method).toBe("wired_extension");
    expect(p.installation.materials.some((m) => m.key === "router_4g")).toBe(false);
  });
  it("proposes a bridge only when a wired run is impractical", () => {
    const q = run(house({ recorderNearRouter: "no", wiredRoutePossible: "no" }));
    expect(q.network.method).toBe("approved_bridge");
    expect(q.installation.materials.some((m) => m.key === "router_4g")).toBe(false);
  });
});

describe("Test 5: property has no internet, remote viewing wanted", () => {
  const p = run(house({ internet: "no" }));
  it("keeps the local recording system valid", () => {
    expect(p.nvr.selected).not.toBeNull();
    expect(p.recording.storage.drives?.product.capacityTb).toBe(2);
  });
  it("names the blocker and offers 4G separately, with the ongoing cost as a customer decision", () => {
    expect(p.network.method).toBe("cellular_option");
    expect(p.network.customerDecisions.join(" ")).toMatch(/ongoing SIM\/data cost/);
    const lte = p.installation.materials.find((m) => m.key === "router_4g")!;
    expect(lte.charged).toBe(false);
    expect(p.exclusions.join(" ")).toMatch(/4G\/5G router and data plan/);
    expect(approvalKeys(p)).toContain("connectivity");
  });
});

describe("Test 6: commercial warehouse", () => {
  const p = run(
    house({
      propertyType: "commercial",
      cameraCount: 6,
      areas: ["Loading dock", "Warehouse floor", "Office entrance", "Car park", "Perimeter fence", "Reception"],
      storeys: null,
      message: "We need CCTV for our warehouse",
      commercial: { futureCameras: 4 },
    }),
  );
  it("requires a site visit", () => {
    expect(p.siteVisit.required).toBe(true);
    expect(p.siteVisit.reasons.join(" ")).toMatch(/Commercial/);
  });
  it("does not apply the residential good/better/best ladder", () => {
    expect(p.recommendedTier).toBeNull();
    expect(p.tierOptions).toEqual([]);
    expect(p.cameras.every((c) => c.product?.commercialAllowed)).toBe(true);
  });
  it("uses the $110/hour reference and plans for expansion", () => {
    expect(p.labour.internalRate).toBe(110);
    expect(p.nvr.channelsNeeded).toBe(10);
    expect(p.nvr.expansionChannels).toBe(4);
    expect(p.nvr.selected!.channels).toBeGreaterThanOrEqual(10);
  });
  it("captures the privacy checklist and gives no firm price before discovery", () => {
    expect(p.privacy?.checklist.map((c) => c.item)).toEqual(expect.arrayContaining(["Surveillance purpose", "Areas monitored", "Retention requirement", "Who can access footage", "Signage responsibility", "Audio requirement"]));
    expect(p.costing.complete).toBe(false);
    expect(approvalKeys(p)).toContain("commercial_site_visit");
  });
});

describe("Test 7: not enough PoE on the recorder", () => {
  it("rejects the recorder even though the channel count fits", () => {
    const cat = catalogue();
    cat.products = cat.products.map((p) => (p.id === "na4" ? { ...p, poeBudgetW: 15 } : p));
    const p = run(house(), cat);
    const e = p.nvr.evaluated.find((x) => x.product.id === "na4")!;
    expect(e.pass).toBe(false);
    expect(e.checks.find((c) => c.name === "channels")!.pass).toBe(true);
    expect(e.checks.find((c) => c.name === "poe")!.pass).toBe(false);
    expect(p.nvr.selected?.id).not.toBe("na4");
  });

  it("also rejects a camera that draws more than one port allows", () => {
    const e = validateNvr(nvr({ id: "x", model: "X", channels: 4, poePerPortW: 6, poeBudgetW: 100 }), {
      cameras: [camera({ id: "c", model: "C", poeWatts: 12 })],
      channelsNeeded: 4,
      requiredFeatures: [],
      audio: false,
      alarmIo: false,
      products: catalogue().products,
      policies: testPolicies(),
    });
    expect(e.checks.find((c) => c.name === "poe")).toMatchObject({ pass: false });
  });
});

describe("Test 8: incoming bandwidth from published specifications", () => {
  it("warns when the cameras' published maximum exceeds the recorder's incoming bandwidth", () => {
    const cat = catalogue();
    cat.products = cat.products.map((p) => (p.id === "na4" ? { ...p, incomingMbps: 12 } : p));
    const p = run(house(), cat);
    const e = p.nvr.evaluated.find((x) => x.product.id === "na4")!;
    expect(e.checks.find((c) => c.name === "channels")!.pass).toBe(true);
    expect(e.checks.find((c) => c.name === "bandwidth")).toMatchObject({ pass: true, warning: true });
    expect(e.checks.find((c) => c.name === "bandwidth")!.detail).toMatch(/published maximum 16\.0 Mbps exceeds the recorder's 12 Mbps/);
  });
  it("reports bandwidth as not verifiable when a camera publishes no maximum", () => {
    const cat = catalogue();
    cat.products = cat.products.map((p) => (p.category === "camera" ? { ...p, maxBitrateMbps: null } : p));
    const p = run(house(), cat);
    const e = p.nvr.evaluated.find((x) => x.product.id === p.nvr.selected!.id)!;
    expect(e.checks.find((c) => c.name === "bandwidth")).toMatchObject({ pass: true, unverified: true });
  });
});

describe("Test 9: HDD (no recording profiles, no retention calculation)", () => {
  const withKit = (over: Partial<CctvKit> = {}) => {
    const cat = catalogue();
    cat.kits = [{ id: "k4", key: "FA_GOOD_4", name: "Fixture Good 4", propertyType: "residential", tier: "good", cameraCount: 4, cameraProductId: "ca4", nvrProductId: "na4", defaultHddTb: 4, defaultHddProductId: null, accessories: [], status: "getsecure_approved", version: 1, ...over }];
    return cat;
  };

  it("an approved kit fixes the cameras, recorder and default HDD", () => {
    const p = run(house(), withKit());
    expect(p.kit).toMatchObject({ id: "k4", name: "Fixture Good 4" });
    expect(p.cameras.every((c) => c.product?.id === "ca4")).toBe(true);
    expect(p.nvr.selected?.id).toBe("na4");
    expect(p.recording.storage).toMatchObject({ selection: "kit", installedTb: 4 });
    expect(p.costing.complete).toBe(true);
  });

  it("the kit HDD is never resized or replaced by the camera-count fallback", () => {
    const p = run(house({ retentionDays: 90 }), withKit({ defaultHddTb: 2 }));
    expect(p.recording.storage).toMatchObject({ selection: "kit", installedTb: 2, customerRetentionDays: 90 });
    expect(approvalKeys(p)).toContain("custom_retention");
    expect(p.costing.complete).toBe(true); // a retention request is an exception for Chris, not a blocker
  });

  it("Chris's override beats the kit, by capacity or exact drive", () => {
    expect(run(house({ hddOverride: { capacityTb: 8 } }), withKit()).recording.storage).toMatchObject({ selection: "override", installedTb: 8 });
    const byModel = run(house({ hddOverride: { productId: "hdd6" } }), withKit());
    expect(byModel.recording.storage).toMatchObject({ selection: "override", installedTb: 6 });
    expect(byModel.costing.lines.find((l) => l.key.startsWith("hdd:"))?.unitCostExGst).toBe(200);
  });

  it("a kit without a default HDD uses the residential fallback; an unapproved kit is not used", () => {
    expect(run(house(), withKit({ defaultHddTb: null })).recording.storage).toMatchObject({ selection: "fallback", installedTb: 2 });
    const draft = run(house(), withKit({ status: "requires_review" }));
    expect(draft.kit).toBeNull();
    expect(draft.recording.storage.selection).toBe("fallback");
  });

  it("kit accessories are charged with the kit", () => {
    const p = run(house({ mountingSurface: "brick" }), withKit({ accessories: [{ productId: "jb", quantity: 1, perCamera: true }] }));
    expect(p.costing.lines.find((l) => l.key === "accessory:jb")).toMatchObject({ quantity: 4, unitCostExGst: 15, priced: true });
    expect(p.installation.materials.some((m) => m.product?.id === "jb")).toBe(false); // not recommended a second time
  });

  it("no kit and no fallback (11+ cameras): the HDD must be chosen", () => {
    const areas = Array.from({ length: 11 }, (_, i) => `Area ${i + 1}`);
    const p = run(house({ cameraCount: 11, areas }));
    expect(p.recording.storage).toMatchObject({ selection: "required", drives: null });
    expect(approvalKeys(p)).toContain("hdd");
    expect(p.costing.unpriced).toContain("Hard drive: none selected");
    expect(p.readiness.items.find((i) => i.key === "storage")?.ok).toBe(false);
    expect(run(house({ cameraCount: 11, areas, hddOverride: { capacityTb: 8 } })).recording.storage.installedTb).toBe(8);
  });

  it("never substitutes another capacity because it has a price", () => {
    const cat = withKit();
    cat.products = cat.products.map((p) => (p.category === "hdd" && p.capacityTb === 4 ? { ...p, price: null } : p));
    const p = run(house(), cat);
    expect(p.recording.storage.drives?.product.capacityTb).toBe(4);
    expect(p.costing.complete).toBe(false);
    expect(p.costing.unpriced.join(" ")).toMatch(/FD-4TB: no approved price/);
  });

  it("commercial: same principle, no fallback by camera count", () => {
    const p = run(house({ propertyType: "commercial" }));
    expect(p.recording.storage.selection).toBe("required");
    const kit = catalogue();
    kit.kits = [{ id: "kc", key: null, name: "Fixture commercial 4", propertyType: "commercial", tier: null, cameraCount: 4, cameraProductId: "cx8", nvrProductId: "nx16", defaultHddTb: 8, defaultHddProductId: null, accessories: [], status: "getsecure_approved", version: 1 }];
    expect(run(house({ propertyType: "commercial" }), kit).recording.storage).toMatchObject({ selection: "kit", installedTb: 8 });
  });
});

describe("Test 10: mixed-brand camera and recorder", () => {
  const base = { channelsNeeded: 4, requiredFeatures: [], audio: false, alarmIo: false, products: catalogue().products, policies: testPolicies() };
  it("checks ONVIF and notes that proprietary analytics still need verifying", () => {
    const cam = camera({ id: "b", model: "B", manufacturer: "Other Brand", onvifProfiles: ["S"] });
    const e = validateNvr(nvr({ id: "n", model: "N", channels: 4, onvifProfiles: ["S", "T"] }), { ...base, cameras: [cam] });
    const check = e.checks.find((c) => c.name === "compatibility")!;
    expect(check.pass).toBe(true);
    expect(check.unverified).toBe(true);
    expect(check.detail).toMatch(/proprietary analytics still to be verified/);
  });
  it("rejects a pairing with no shared ONVIF profile", () => {
    const cam = camera({ id: "b", model: "B", manufacturer: "Other Brand", onvifProfiles: [] });
    const e = validateNvr(nvr({ id: "n", model: "N", channels: 4 }), { ...base, cameras: [cam] });
    expect(e.checks.find((c) => c.name === "compatibility")!.pass).toBe(false);
    expect(onvifCompatible(cam, nvr({ id: "n", model: "N", channels: 4 }))).toEqual([]);
  });
  it("flags analytics across brands for verification in the packet", () => {
    const cat = catalogue();
    // Only a Fixture B camera in the good tier, and only Fixture A recorders.
    cat.products = cat.products.filter((p) => !(p.category === "nvr" && p.manufacturer === "Fixture B")).map((p) => (p.id === "ca4" ? { ...p, manufacturer: "Fixture B" } : p));
    const p = run(house({ analytics: ["human_vehicle"] }), cat);
    expect(p.interoperability.join(" ")).toMatch(/not every proprietary analytic/);
    expect(approvalKeys(p)).toContain("interoperability");
  });
});

describe("Test 11: customer asks for a site visit", () => {
  it("requires one regardless of how quotable the property is", () => {
    const p = run(house({ siteVisitRequested: true }));
    expect(p.siteVisit.required).toBe(true);
    expect(p.sales.recommendedAction).toBe("arrange_site_visit");
    expect(siteVisitDecision(house({ siteVisitRequested: true }), testPolicies()).reasons[0]).toMatch(/asked for a site visit/);
  });
});

describe("Test 15: customer says a competitor is cheaper", () => {
  const p = run(house({ message: "Thanks but another company quoted me cheaper", competitorQuote: { price: 1800 }, leadStatus: "quote_sent" }));
  it("does not discount; compares scope; drafts a factual reply for Chris", () => {
    expect(p.sales.recommendedAction).toBe("explain_value_difference");
    expect(p.sales.stage).toBe("objection");
    expect(p.costing.markupPct).toBe(testPolicies().suggestedMarkupPct.value);
    expect(p.costing.lines.every((l) => (l.unitSellExGst ?? 0) >= 0)).toBe(true);
    expect(p.sales.objectionChecklist!.map((r) => r.item)).toEqual(
      expect.arrayContaining(["Camera specification", "Recorder", "Storage / retention", "Installation", "Cabling", "Accessories (junction boxes, conduit)", "Commissioning", "Warranty", "App setup", "Support", "GST"]),
    );
    expect(p.sales.notes.join(" ")).toMatch(/any discount needs Chris/);
    const email = composeEmail(p, { firstName: "Dave", subject: "Quote", address: null, areas: [] });
    expect(email.body).toMatch(/cover the same things/);
    expect(email.body).not.toMatch(/discount/i);
    expect(approvalKeys(p)).toContain("customer_email");
  });
});

describe("Test 16: commercial audio request", () => {
  const commercial = (justification: string | null) =>
    run(house({ propertyType: "commercial", storeys: null, audioRequested: true, commercial: { futureCameras: 2, audioJustification: justification } }));
  it("flags the privacy issue and leaves audio off without a purpose", () => {
    const p = commercial(null);
    expect(p.privacy!.audioRecording).toBe(false);
    expect(p.privacy!.flags.join(" ")).toMatch(/more intrusive/);
    expect(p.privacy!.flags.join(" ")).toMatch(/No business purpose given/);
    expect(approvalKeys(p)).toContain("audio");
  });
  it("keeps audio off even with a stated purpose until Chris approves", () => {
    const p = commercial("Staff safety at the counter");
    expect(p.privacy!.audioRecording).toBe(false);
    expect(p.privacy!.flags.join(" ")).toMatch(/Chris to review/);
  });
});

describe("guards that hold everywhere", () => {
  it("never chooses a camera without approved data: an empty catalogue gives an incomplete, unpriced packet", () => {
    const p = run(house(), { products: [], packages: [] });
    expect(p.cameras.every((c) => c.product === null)).toBe(true);
    expect(p.costing.complete).toBe(false);
    expect(p.costing.lines.filter((l) => l.kind === "hardware" && l.priced)).toEqual([]);
    expect(p.costing.unpriced.join(" ")).toMatch(/no suitable product/);
    expect(p.confidence.overall).toBe("low");
  });

  it("does not invent missing details; it asks for them", () => {
    const p = run(house({ address: null, storeys: null, remoteViewing: null }));
    expect(p.missing.map((m) => m.field)).toEqual(expect.arrayContaining(["address", "storeys", "remoteViewing"]));
    expect(p.siteVisit.required).toBe(true);
  });

  it("flags provisional policies it relied on", () => {
    const p = run();
    expect(p.provisionalPolicies.map((x) => x.key)).toEqual(expect.arrayContaining(["suggestedMarkupPct", "priceAgingDays"]));
    expect(p.provisionalPolicies.map((x) => x.key)).not.toContain("storageHeadroomPct");
    expect(approvalKeys(p)).toContain("markup");
  });

  it("is deterministic", () => {
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });
});
