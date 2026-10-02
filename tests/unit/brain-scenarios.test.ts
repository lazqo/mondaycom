/**
 * The Business Brain v0.1 test scenarios that exercise the engine (1-11, 15, 16). Scenarios 12-14
 * (drafts, quote approval) need the database and live in tests/integration/brain-workflow.test.ts.
 * The catalogue is fictional; see brain-fixtures.ts.
 */
import { describe, it, expect } from "vitest";
import { assessCctv } from "@/lib/brain/engine";
import { composeEmail, composeQuote } from "@/lib/brain/compose";
import { validateNvr, onvifCompatible } from "@/lib/brain/nvr";
import { requiredStorageGb } from "@/lib/brain/storage";
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

  it("records 24/7 for 28 days, with the drive calculated", () => {
    expect(p.recording.mode).toBe("continuous");
    expect(p.recording.storage.retentionTargetDays).toBe(28);
    expect(p.recording.storage.status).toBe("meets_target");
    expect(p.recording.storage.rawGb).toBeCloseTo(4 * 4 * 10.8 * 28, 5);
    expect(p.recording.storage.installedTb).toBe(6);
  });

  it("includes the standard materials allowance and the $95/hour reference", () => {
    expect(p.installation.materials.find((m) => m.key === "standard_materials")?.charged).toBe(true);
    expect(p.labour.internalRate).toBe(95);
    expect(p.labour.internalReferenceExGst).toBe(6 * 95);
  });

  it("is priced: 15% GST on the ex-GST subtotal, margin shown internally", () => {
    expect(p.costing.complete).toBe(true);
    expect(p.costing.gst).toBeCloseTo(p.costing.sellExGst * 0.15, 2);
    expect(p.costing.totalIncGst).toBeCloseTo(p.costing.sellExGst * 1.15, 2);
    expect(p.costing.grossProfit).toBeGreaterThan(0);
  });

  it("produces drafts only, both needing Chris, with no cost or margin in them", () => {
    expect(approvalKeys(p)).toEqual(expect.arrayContaining(["customer_email", "quote"]));
    const email = composeEmail(p, { firstName: "Dave Lincoln", subject: "CCTV quote", address: "12 Test Street", areas: house().areas });
    const quote = composeQuote(p, { customerName: "Dave Lincoln", gstPct: 15 });
    expect(email.body).not.toMatch(/margin|cost price|markup|\$100\b/i);
    expect(JSON.stringify(quote)).not.toMatch(/costExGst|margin|markup/i);
    expect(quote.lineItems.every((l) => l.unitPrice > 0)).toBe(true);
  });
});

describe("Test 2: 6 cameras, double storey", () => {
  const p = run(house({ cameraCount: 6, storeys: 2, areas: ["Driveway", "Front door", "Side gate", "Backyard", "Garage", "Deck"] }));

  it("uses a recorder with more than 4 channels and calculates 28 days of storage", () => {
    expect(p.nvr.selected!.channels).toBeGreaterThan(4);
    expect(p.recording.storage.rawGb).toBeCloseTo(6 * 4 * 10.8 * 28, 5);
    expect(p.recording.storage.status).toBe("meets_target");
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
    expect(p.recording.storage.status).toBe("meets_target");
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
    expect(p.cameras.every((c) => c.product?.market !== "residential")).toBe(true);
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
      requiredGb: 100,
      requiredFeatures: [],
      audio: false,
      alarmIo: false,
      products: catalogue().products,
      policies: testPolicies(),
    });
    expect(e.checks.find((c) => c.name === "poe")).toMatchObject({ pass: false });
  });
});

describe("Test 8: not enough incoming bandwidth", () => {
  it("rejects the recorder even though the channel count fits", () => {
    const cat = catalogue();
    cat.products = cat.products.map((p) => (p.id === "na4" ? { ...p, incomingMbps: 12 } : p));
    const p = run(house(), cat);
    const e = p.nvr.evaluated.find((x) => x.product.id === "na4")!;
    expect(e.pass).toBe(false);
    expect(e.checks.find((c) => c.name === "channels")!.pass).toBe(true);
    expect(e.checks.find((c) => c.name === "bandwidth")).toMatchObject({ pass: false });
  });
});

describe("Test 9: storage", () => {
  it("calculates from bitrate x 28 days, adds the safety allowance, and picks the nearest approved size", () => {
    const policies = testPolicies();
    const { rawGb, requiredGb } = requiredStorageGb(16, 28, policies);
    expect(rawGb).toBeCloseTo(4838.4, 5);
    expect(requiredGb).toBeCloseTo(4838.4 * 1.1, 5);
    const p = run();
    // 4 TB holds 3,720 GB usable (too small); 6 TB holds 5,580 GB (enough); 8 TB would be oversized.
    expect(p.recording.storage.drives).toMatchObject({ count: 1, product: { capacityTb: 6 } });
    expect(p.recording.storage.expectedRetentionDays).toBe(Math.floor(5580 / 172.8));
  });

  it("reports a shortfall instead of quietly cutting retention", () => {
    // Only drives up to 4 TB, and only the single-bay 4-channel recorder in this tier.
    const cat = catalogue();
    cat.products = cat.products.filter((p) => !(p.category === "hdd" && p.capacityTb > 4) && p.id !== "na8");
    const p = run(house(), cat);
    expect(p.nvr.selected?.id).toBe("na4");
    expect(p.recording.storage.expectedRetentionDays).toBe(Math.floor(3720 / 172.8));
    expect(p.recording.storage.retentionTargetDays).toBe(28);
    expect(p.recording.storage.status).toBe("below_target");
    expect(p.risks.join(" ")).toMatch(/days of recording achievable against a 28-day target/);
    expect(approvalKeys(p)).toContain("retention");
  });

  it("honours a retention the customer asks for", () => {
    const p = run(house({ retentionDays: 60 }));
    expect(p.recording.storage.retentionTargetDays).toBe(60);
    expect(p.recording.storage.retentionSource).toBe("customer");
  });
});

describe("Test 10: mixed-brand camera and recorder", () => {
  const base = { channelsNeeded: 4, requiredGb: 100, requiredFeatures: [], audio: false, alarmIo: false, products: catalogue().products, policies: testPolicies() };
  it("checks ONVIF and notes that proprietary analytics still need verifying", () => {
    const cam = camera({ id: "b", model: "B", manufacturer: "Other Brand", onvifProfiles: ["S"] });
    const e = validateNvr(nvr({ id: "n", model: "N", channels: 4, onvifProfiles: ["S", "T"] }), { ...base, cameras: [cam] });
    const check = e.checks.find((c) => c.name === "interoperability")!;
    expect(check.pass).toBe(true);
    expect(check.detail).toMatch(/proprietary analytics still to be verified/);
  });
  it("rejects a pairing with no shared ONVIF profile", () => {
    const cam = camera({ id: "b", model: "B", manufacturer: "Other Brand", onvifProfiles: [] });
    const e = validateNvr(nvr({ id: "n", model: "N", channels: 4 }), { ...base, cameras: [cam] });
    expect(e.checks.find((c) => c.name === "interoperability")!.pass).toBe(false);
    expect(onvifCompatible(cam, nvr({ id: "n", model: "N", channels: 4 }))).toEqual([]);
  });
  it("flags analytics across brands for verification in the packet", () => {
    const cat = catalogue();
    // Only a Fixture B camera in the good tier, alongside Fixture A recorders.
    cat.products = cat.products.map((p) => (p.id === "ca4" ? { ...p, manufacturer: "Fixture B" } : p));
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
    expect(p.provisionalPolicies.map((x) => x.key)).toEqual(expect.arrayContaining(["suggestedMarkupPct", "storageHeadroomPct"]));
    expect(approvalKeys(p)).toContain("markup");
  });

  it("is deterministic", () => {
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });
});
