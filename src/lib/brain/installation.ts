/**
 * Installation: materials derived from the site conditions, and the labour allowance from an
 * approved installation package.
 *
 * Residential quotes carry a standard materials allowance instead of listing every fixing. Items
 * beyond it are added only when a condition calls for them. A junction box is recommended, never
 * charged, until Chris confirms it (v1). A 4G router is an option for the customer, not a line
 * in the base quote.
 */
import type {
  CameraChoice,
  EnquiryInput,
  InstallationPackage,
  LabourResult,
  Level,
  MaterialLine,
  NetworkResult,
  NvrProduct,
  Policies,
  Product,
  SwitchProduct,
} from "./types";
import { TRUSTED_STATUSES } from "./types";

function pickProduct<T extends Product>(products: Product[], test: (p: Product) => p is T, ok: (p: T) => boolean = () => true): T | null {
  const list = products.filter(test).filter((p) => p.status !== "deprecated" && ok(p));
  list.sort(
    (a, b) =>
      (TRUSTED_STATUSES.includes(a.status) && a.price?.approved ? 0 : 1) - (TRUSTED_STATUSES.includes(b.status) && b.price?.approved ? 0 : 1) ||
      (a.price?.costExGst ?? Infinity) - (b.price?.costExGst ?? Infinity) ||
      a.model.localeCompare(b.model),
  );
  return list[0] ?? null;
}

const of = (cat: Product["category"]) => (p: Product): p is Product => p.category === cat;

export type InstallationResult = {
  storeys: number | null;
  doubleStorey: boolean;
  junctionBoxRecommended: boolean;
  junctionBoxReason: string | null;
  conduitRequired: boolean;
  complexity: Level;
  materials: MaterialLine[];
  notes: string[];
};

export function installationPlan(input: {
  enquiry: EnquiryInput;
  cameras: CameraChoice[];
  nvr: NvrProduct | null;
  network: NetworkResult;
  products: Product[];
  policies: Policies;
}): InstallationResult {
  const { enquiry, cameras, nvr, network, products, policies } = input;
  const materials: MaterialLine[] = [];
  const notes: string[] = [];
  const count = cameras.length;
  const commercial = enquiry.propertyType === "commercial";

  // Standard allowance (residential): one line, contents internal.
  if (!commercial) {
    const sm = policies.standardMaterials.value;
    materials.push({
      key: "standard_materials",
      description: "Standard cabling and installation materials",
      quantity: 1,
      product: null,
      charged: sm.sellExGst != null,
      approvalRequired: sm.sellExGst == null,
      reason: sm.sellExGst != null ? `Includes: ${sm.contents.join(", ")}.` : "Standard materials allowance value not set (Settings → Business Brain).",
    });
  }

  // Junction boxes: recommended on hard surfaces, never charged without Chris in v1.
  const surfaces = policies.junctionBoxSurfaces.value;
  const hard = cameras.filter((c) => surfaces.includes(c.requirement.mounting));
  const junctionBoxRecommended = hard.length > 0;
  const junctionBoxReason = junctionBoxRecommended
    ? `${hard.length} camera(s) on ${[...new Set(hard.map((c) => c.requirement.mounting))].join("/")} need a junction box or mounting accessory.`
    : null;
  if (junctionBoxRecommended) {
    materials.push({
      key: "junction_box",
      description: "Junction boxes / mounting accessories",
      quantity: hard.length,
      product: pickProduct(products, of("junction_box")),
      charged: false,
      approvalRequired: true,
      reason: `${junctionBoxReason} Chris to confirm before it is charged.`,
    });
  }

  // Double storey: conduit and extra complexity.
  const doubleStorey = (enquiry.storeys ?? 1) >= 2;
  const conduitRequired = doubleStorey && policies.doubleStoreyConduit.value;
  if (conduitRequired) {
    const conduit = pickProduct(products, of("conduit"));
    materials.push({
      key: "conduit",
      description: "Conduit for exposed upper-storey cable runs",
      quantity: 1,
      product: conduit,
      charged: !!conduit?.price,
      approvalRequired: !conduit?.price,
      reason: "Double-storey: conduit allowance considered; subject to accessible cable routes on site.",
    });
  }

  // PoE: switch when the recorder cannot power every camera.
  const poePorts = nvr?.poePorts ?? 0;
  if (nvr && count > poePorts) {
    const extra = count - poePorts;
    const watts = cameras.slice(poePorts).map((c) => c.product?.poeWatts ?? null);
    const need = watts.every((w) => w != null) ? (watts as number[]).reduce((s, w) => s + w, 0) : null;
    const sw = pickProduct<SwitchProduct>(
      products,
      (p): p is SwitchProduct => p.category === "poe_switch",
      (s) => s.poePorts >= extra && (need == null || (s.poeBudgetW ?? Infinity) >= need),
    );
    materials.push({
      key: "poe_switch",
      description: `PoE switch for ${extra} camera(s)`,
      quantity: 1,
      product: sw,
      charged: !!sw?.price,
      approvalRequired: !sw,
      reason: sw ? `Recorder powers ${poePorts}; ${extra} more need PoE.` : "No PoE switch in the catalogue with enough ports and budget.",
    });
  }

  // Network.
  if (network.method === "wired_extension") {
    materials.push({ key: "lan_extension", description: "Cat6 run from recorder to router", quantity: 1, product: null, charged: false, approvalRequired: false, reason: "Covered by the cabling allowance unless the run is unusually long." });
  }
  if (network.method === "approved_bridge") {
    const bridge = pickProduct(products, of("network"));
    materials.push({ key: "bridge", description: "Wireless bridge / network extension", quantity: 1, product: bridge, charged: !!bridge?.price, approvalRequired: !bridge?.price, reason: "Wired run to the router impractical." });
  }
  if (network.method === "cellular_option") {
    const router = pickProduct(products, of("router_4g"));
    materials.push({
      key: "router_4g",
      description: "4G/5G router for remote viewing (optional)",
      quantity: 1,
      product: router,
      charged: false,
      approvalRequired: true,
      reason: "Customer decision: offered separately, with the ongoing SIM/data cost disclosed.",
    });
  }

  // Commercial: power protection and cabinet are considered, finalised on site.
  if (commercial) {
    materials.push({ key: "ups", description: "UPS for recorder and network", quantity: 1, product: pickProduct(products, of("ups")), charged: false, approvalRequired: true, reason: "Commercial: consider power protection; confirm on site." });
    materials.push({ key: "rack", description: "Rack / cabinet", quantity: 1, product: null, charged: false, approvalRequired: true, reason: "Commercial: confirm equipment location on site." });
  }

  let complexity: Level = "low";
  if (doubleStorey || junctionBoxRecommended || network.method === "approved_bridge") complexity = "medium";
  if (commercial || enquiry.accessUnclear || (doubleStorey && count > 6)) complexity = "high";
  if (doubleStorey) notes.push("Double-storey: extra installation complexity; cable routes assumed accessible.");

  return { storeys: enquiry.storeys, doubleStorey, junctionBoxRecommended, junctionBoxReason, conduitRequired, complexity, materials, notes };
}

export function labourPlan(input: { enquiry: EnquiryInput; cameraCount: number; packages: InstallationPackage[]; policies: Policies }): LabourResult {
  const { enquiry, cameraCount, packages, policies } = input;
  const commercial = enquiry.propertyType === "commercial";
  const rate = commercial ? policies.labourRateCommercial.value : policies.labourRateResidential.value;
  const notes: string[] = [];
  if (commercial) {
    notes.push(`Commercial labour is estimated after the site visit; internal reference rate $${rate}/hour.`);
    return { package: null, estimatedHours: null, allowanceExGst: null, internalRate: rate, internalReferenceExGst: null, notes };
  }
  const storeys = enquiry.storeys ?? 1;
  const matches = packages
    .filter((p) => p.status !== "deprecated" && p.propertyType === "residential" && cameraCount >= p.minCameras && cameraCount <= p.maxCameras)
    .filter((p) => p.storeys == null || p.storeys === Math.min(storeys, 2) || (storeys >= 2 && p.storeys >= 2))
    .sort((a, b) => (a.storeys == null ? 1 : 0) - (b.storeys == null ? 1 : 0) || b.version - a.version);
  const pkg = matches[0] ?? null;
  if (!pkg) {
    notes.push(`No installation package for ${cameraCount} camera(s), ${storeys}-storey. Add one in Settings → Business Brain.`);
    return { package: null, estimatedHours: null, allowanceExGst: null, internalRate: rate, internalReferenceExGst: null, notes };
  }
  if (!TRUSTED_STATUSES.includes(pkg.status)) notes.push(`Installation package "${pkg.name}" is ${pkg.status}: needs approval.`);
  return {
    package: pkg,
    estimatedHours: pkg.estimatedHours,
    allowanceExGst: pkg.allowanceExGst,
    internalRate: rate,
    internalReferenceExGst: pkg.estimatedHours * rate,
    notes,
  };
}
