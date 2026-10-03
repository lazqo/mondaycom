/**
 * A made-up catalogue for engine tests. These are not real products: names, specifications and
 * prices are invented test values chosen to exercise the rules, and must never be used for quoting.
 */
import type {
  CameraProduct,
  Catalogue,
  EnquiryInput,
  HddProduct,
  InstallationPackage,
  MaterialsPackage,
  NvrProduct,
  OtherProduct,
  Policies,
  SwitchProduct,
} from "@/lib/brain/types";
import { DEFAULT_POLICIES } from "@/lib/brain/policy";

const price = (costExGst: number) => ({ supplier: "Test Supplier", supplierSku: null, costExGst, lastChecked: "2026-10-01", confidence: 1, approved: true });

/** `maxMbps`: the camera's published maximum bitrate (test value), checked against the recorder. */
export function camera({ maxMbps = 4, ...over }: Partial<CameraProduct> & Pick<CameraProduct, "id" | "model"> & { maxMbps?: number | null }): CameraProduct {
  return {
    maxBitrateMbps: maxMbps,
    category: "camera",
    manufacturer: "Fixture A",
    residentialAllowed: true,
    commercialAllowed: false,
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
    residentialAllowed: true,
    commercialAllowed: false,
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
  return { id: `hdd${tb}`, category: "hdd", manufacturer: "Fixture Disk", model: `FD-${tb}TB`, residentialAllowed: true, commercialAllowed: true, tier: null, status: "getsecure_approved", price: price(cost), capacityTb: tb, surveillanceRated: true };
}

const other = (id: string, category: OtherProduct["category"], cost: number): OtherProduct => ({ id, category, manufacturer: "Fixture Parts", model: id, residentialAllowed: true, commercialAllowed: true, tier: null, status: "getsecure_approved", price: price(cost) });

export const SWITCH: SwitchProduct = { id: "sw8", category: "poe_switch", manufacturer: "Fixture Net", model: "FN-8P", residentialAllowed: true, commercialAllowed: true, tier: null, status: "getsecure_approved", price: price(150), poePorts: 8, poePerPortW: 30, poeBudgetW: 120 };

/** Exact-count residential packages with every commercial input filled in (test values). */
export function packages(): InstallationPackage[] {
  const base = { propertyType: "residential" as const, includedMaterials: [], assumptions: [], exclusions: [], version: 1, status: "getsecure_approved" as const, labourRate: 95 };
  const out: InstallationPackage[] = [];
  for (const [st, storeys] of [
    ["single", 1],
    ["double", 2],
  ] as const)
    for (const n of [2, 4, 6, 8]) {
      const hours = n + (storeys === 2 ? 4 : 2);
      out.push({
        ...base,
        id: `p-${st}-${n}`,
        key: `RES_CCTV_${st.toUpperCase()}_${n}`,
        name: `Residential CCTV, ${st} storey, ${n} cameras`,
        cameraCount: n,
        storeyType: st,
        minCameras: n,
        maxCameras: n,
        storeys,
        estimatedHours: hours,
        allowanceExGst: hours * 130,
        materialCostExGst: 15 * n,
        conduitIncluded: storeys === 2,
        conduitAllowanceExGst: storeys === 2 ? 60 : null,
        complexityAllowanceExGst: 0,
      });
    }
  return out;
}

export function catalogue(): Catalogue {
  return {
    products: [
      camera({ id: "ca4", model: "FA-CAM-4" }),
      camera({ id: "cb6", model: "FB-CAM-6", manufacturer: "Fixture B", tier: "better", resolutionMp: 6, horizontalPixels: 3072, maxMbps: 6, poeWatts: 6, price: price(160) }),
      camera({ id: "cc8", model: "FC-CAM-8", manufacturer: "Fixture C", tier: "best", resolutionMp: 8, horizontalPixels: 3840, maxMbps: 8, poeWatts: 7, price: price(250) }),
      camera({ id: "cx8", model: "FX-COM-8", manufacturer: "Fixture X", residentialAllowed: false, commercialAllowed: true, tier: null, resolutionMp: 8, horizontalPixels: 3840, maxMbps: 8, poeWatts: 8, price: price(420) }),
      nvr({ id: "na4", model: "FA-NVR-4", channels: 4 }),
      nvr({ id: "na8", model: "FA-NVR-8", channels: 8, hddBays: 2, maxTotalTb: 20, price: price(350) }),
      nvr({ id: "nb4", model: "FB-NVR-4", manufacturer: "Fixture B", tier: "better", channels: 4, price: price(260) }),
      nvr({ id: "nb8", model: "FB-NVR-8", manufacturer: "Fixture B", tier: "better", channels: 8, hddBays: 2, maxTotalTb: 20, price: price(420) }),
      nvr({ id: "nc4", model: "FC-NVR-4", manufacturer: "Fixture C", tier: "best", channels: 4, price: price(380) }),
      nvr({ id: "nc8", model: "FC-NVR-8", manufacturer: "Fixture C", tier: "best", channels: 8, hddBays: 2, maxTotalTb: 20, price: price(560) }),
      nvr({ id: "nx16", model: "FX-NVR-16", manufacturer: "Fixture X", residentialAllowed: false, commercialAllowed: true, tier: null, channels: 16, hddBays: 4, maxTotalTb: 40, price: price(1400) }),
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
    materialsPackages: [MATERIALS],
  };
}

/** The standard residential materials package, with test values Get Secure has not set yet. */
export const MATERIALS: MaterialsPackage = {
  id: "mat",
  name: "Standard residential CCTV materials",
  propertyType: "residential",
  customerDescription: "Cabling and standard installation materials",
  items: [{ description: "Normal Cat6 allowance" }, { description: "Connectors" }, { description: "Normal clips and fixings" }],
  costExGst: 60,
  sellExGst: 150,
  isDefault: true,
  version: 1,
  status: "getsecure_approved",
};

/** Defaults, with a default tier (not yet set by Get Secure) filled in for testing. */
export function testPolicies(over: Partial<Policies> = {}): Policies {
  return {
    ...DEFAULT_POLICIES,
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
