/**
 * A made-up catalogue for engine tests. These are not real products: names, specifications and
 * prices are invented test values chosen to exercise the rules, and must never be used for quoting.
 */
import type { CameraProduct, Catalogue, EnquiryInput, HddProduct, InstallationPackage, NvrProduct, OtherProduct, Policies, SwitchProduct } from "@/lib/brain/types";
import { DEFAULT_POLICIES } from "@/lib/brain/policy";

const price = (costExGst: number) => ({ supplier: "Test Supplier", supplierSku: null, costExGst, lastChecked: "2026-10-01", confidence: 1, approved: true });

export function camera(over: Partial<CameraProduct> & Pick<CameraProduct, "id" | "model">): CameraProduct {
  return {
    category: "camera",
    manufacturer: "Fixture A",
    market: "residential",
    tier: "good",
    status: "getsecure_approved",
    price: price(100),
    resolutionMp: 4,
    horizontalPixels: 2560,
    hfovDeg: 100,
    irRangeM: 30,
    colourNight: false,
    wdrDb: 120,
    codecs: ["H.265", "H.264"],
    expectedBitrateMbps: 4,
    poeWatts: 5,
    analytics: ["human_vehicle"],
    onvifProfiles: ["S", "T"],
    ...over,
  };
}

export function nvr(over: Partial<NvrProduct> & Pick<NvrProduct, "id" | "model" | "channels">): NvrProduct {
  return {
    category: "nvr",
    manufacturer: "Fixture A",
    market: "residential",
    tier: "good",
    status: "getsecure_approved",
    price: price(200),
    incomingMbps: over.channels * 10,
    poePorts: over.channels,
    poePerPortW: 25,
    poeBudgetW: over.channels * 12.5,
    hddBays: 1,
    maxHddTb: 10,
    maxTotalTb: 10,
    features: ["human_vehicle", "smart_search"],
    onvifProfiles: ["S", "T"],
    ...over,
  };
}

export function hdd(tb: number, cost: number): HddProduct {
  return { id: `hdd${tb}`, category: "hdd", manufacturer: "Fixture Disk", model: `FD-${tb}TB`, market: "both", tier: null, status: "getsecure_approved", price: price(cost), capacityTb: tb, surveillanceRated: true };
}

const other = (id: string, category: OtherProduct["category"], cost: number): OtherProduct => ({ id, category, manufacturer: "Fixture Parts", model: id, market: "both", tier: null, status: "getsecure_approved", price: price(cost) });

export const SWITCH: SwitchProduct = { id: "sw8", category: "poe_switch", manufacturer: "Fixture Net", model: "FN-8P", market: "both", tier: null, status: "getsecure_approved", price: price(150), poePorts: 8, poePerPortW: 30, poeBudgetW: 120 };

export function packages(): InstallationPackage[] {
  const base = { propertyType: "residential" as const, includedMaterials: [], assumptions: [], exclusions: [], version: 1, status: "getsecure_approved" as const };
  return [
    { ...base, id: "p1", name: "1-4 cameras, single storey", minCameras: 1, maxCameras: 4, storeys: 1, estimatedHours: 6, allowanceExGst: 760 },
    { ...base, id: "p2", name: "1-4 cameras, double storey", minCameras: 1, maxCameras: 4, storeys: 2, estimatedHours: 8, allowanceExGst: 980 },
    { ...base, id: "p3", name: "5-8 cameras, single storey", minCameras: 5, maxCameras: 8, storeys: 1, estimatedHours: 10, allowanceExGst: 1250 },
    { ...base, id: "p4", name: "5-8 cameras, double storey", minCameras: 5, maxCameras: 8, storeys: 2, estimatedHours: 12, allowanceExGst: 1500 },
  ];
}

export function catalogue(): Catalogue {
  return {
    products: [
      camera({ id: "ca4", model: "FA-CAM-4" }),
      camera({ id: "cb6", model: "FB-CAM-6", manufacturer: "Fixture B", tier: "better", resolutionMp: 6, horizontalPixels: 3072, expectedBitrateMbps: 6, poeWatts: 6, price: price(160) }),
      camera({ id: "cc8", model: "FC-CAM-8", manufacturer: "Fixture C", tier: "best", resolutionMp: 8, horizontalPixels: 3840, expectedBitrateMbps: 8, poeWatts: 7, price: price(250) }),
      camera({ id: "cx8", model: "FX-COM-8", manufacturer: "Fixture X", market: "commercial", tier: null, resolutionMp: 8, horizontalPixels: 3840, expectedBitrateMbps: 8, poeWatts: 8, price: price(420) }),
      nvr({ id: "na4", model: "FA-NVR-4", channels: 4 }),
      nvr({ id: "na8", model: "FA-NVR-8", channels: 8, hddBays: 2, maxTotalTb: 20, price: price(350) }),
      nvr({ id: "nb4", model: "FB-NVR-4", manufacturer: "Fixture B", tier: "better", channels: 4, price: price(260) }),
      nvr({ id: "nb8", model: "FB-NVR-8", manufacturer: "Fixture B", tier: "better", channels: 8, hddBays: 2, maxTotalTb: 20, price: price(420) }),
      nvr({ id: "nc4", model: "FC-NVR-4", manufacturer: "Fixture C", tier: "best", channels: 4, price: price(380) }),
      nvr({ id: "nc8", model: "FC-NVR-8", manufacturer: "Fixture C", tier: "best", channels: 8, hddBays: 2, maxTotalTb: 20, price: price(560) }),
      nvr({ id: "nx16", model: "FX-NVR-16", manufacturer: "Fixture X", market: "commercial", tier: null, channels: 16, hddBays: 4, maxTotalTb: 40, price: price(1400) }),
      hdd(2, 90),
      hdd(4, 140),
      hdd(6, 200),
      hdd(8, 260),
      SWITCH,
      other("jb", "junction_box", 15),
      other("conduit", "conduit", 40),
      other("bridge", "network", 180),
      other("lte", "router_4g", 260),
    ],
    packages: packages(),
  };
}

/** Defaults, with the two values Get Secure has not set yet filled in for testing. */
export function testPolicies(over: Partial<Policies> = {}): Policies {
  return {
    ...DEFAULT_POLICIES,
    standardMaterials: { ...DEFAULT_POLICIES.standardMaterials, value: { ...DEFAULT_POLICIES.standardMaterials.value, sellExGst: 150, costExGst: 60 }, status: "getsecure_approved" },
    defaultResidentialTier: { ...DEFAULT_POLICIES.defaultResidentialTier, value: "good", status: "getsecure_approved" },
    ...over,
  };
}

/** A plain single-storey 4-camera house with everything known. */
export function house(over: Partial<EnquiryInput> = {}): EnquiryInput {
  return {
    propertyType: "residential",
    jobType: "new",
    cameraCount: 4,
    areas: ["Driveway", "Front door", "Side gate", "Backyard"],
    storeys: 1,
    address: "12 Test Street, Ponsonby",
    recordingMode: null,
    retentionDays: null,
    remoteViewing: true,
    internet: "yes",
    recorderNearRouter: "yes",
    wiredRoutePossible: "yes",
    requestedBrand: null,
    budget: null,
    siteVisitRequested: false,
    urgency: "normal",
    remoteAssessable: "yes",
    construction: "standard",
    accessUnclear: false,
    customSystem: false,
    mountingSurface: "weatherboard",
    analytics: [],
    audioRequested: false,
    message: "Hi, could I get a price for 4 cameras around the house? Thanks",
    leadStatus: "new",
    customerName: "Dave Lincoln",
    ...over,
  };
}
