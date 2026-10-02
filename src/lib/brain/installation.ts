/**
 * Installation: materials derived from the site conditions, and labour from the matching
 * installation package.
 *
 * Residential quotes carry the standard materials package as one line ("Cabling and standard
 * installation materials") instead of listing every fixing; approvers still see its contents and
 * cost. Items beyond it are added only when a condition calls for them. The exact compatible
 * junction box is identified from documented links and recommended, never charged, until Chris
 * confirms it (v1). A 4G router is an option for the customer, not a line in the base quote.
 */
import type {
  CameraChoice,
  CompatibilityKind,
  CompatibilityLink,
  EnquiryInput,
  InstallationPackage,
  LabourResult,
  Level,
  MaterialLine,
  MaterialsPackage,
  NetworkResult,
  NvrProduct,
  Policies,
  Product,
  SwitchProduct,
} from "./types";
import { TRUSTED_STATUSES } from "./types";
import { ACCESSORY_KINDS, relatedProducts } from "./compat";

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
  accessories: { camera: string; kind: CompatibilityKind; product: string; productId: string }[];
  materialsPackage: MaterialsPackage | null;
  notes: string[];
};

/** The materials package for this job: the one the installation package names, else the default. */
export function materialsPackageFor(pkg: InstallationPackage | null, all: MaterialsPackage[], residential: boolean): MaterialsPackage | null {
  const live = all.filter((m) => m.status !== "deprecated");
  return (
    (pkg?.materialsPackageId ? live.find((m) => m.id === pkg.materialsPackageId) : undefined) ??
    live.find((m) => m.isDefault && m.propertyType === (residential ? "residential" : "commercial")) ??
    null
  );
}

export function installationPlan(input: {
  enquiry: EnquiryInput;
  cameras: CameraChoice[];
  nvr: NvrProduct | null;
  network: NetworkResult;
  products: Product[];
  policies: Policies;
  links?: CompatibilityLink[];
  installationPackage?: InstallationPackage | null;
  materialsPackages?: MaterialsPackage[];
}): InstallationResult {
  const { enquiry, cameras, nvr, network, products, policies } = input;
  const links = input.links ?? [];
  const pkg = input.installationPackage ?? null;
  const materials: MaterialLine[] = [];
  const notes: string[] = [];
  const count = cameras.length;
  const commercial = enquiry.propertyType === "commercial";
  const marketOk = (p: Product) => (commercial ? p.commercialAllowed : p.residentialAllowed);

  // Standard materials package (residential): one customer line, contents and cost internal.
  const mp = commercial ? null : materialsPackageFor(pkg, input.materialsPackages ?? [], true);
  if (!commercial) {
    const set = mp?.sellExGst != null;
    materials.push({
      key: "standard_materials",
      description: mp?.customerDescription ?? "Cabling and standard installation materials",
      quantity: 1,
      product: null,
      charged: set,
      approvalRequired: !set || !TRUSTED_STATUSES.includes(mp!.status),
      reason: !mp
        ? "No standard materials package (Settings → Business Brain)."
        : set
          ? `${mp.name}: ${mp.items.map((i) => i.description).join(", ")}.`
          : `${mp.name}: value not set (Settings → Business Brain).`,
    });
  }

  // Documented accessories for each chosen camera model.
  const accessories: InstallationResult["accessories"] = [];
  const models = [...new Map(cameras.filter((c) => c.product).map((c) => [c.product!.id, c.product!])).values()];
  for (const cam of models) {
    for (const kind of ACCESSORY_KINDS) {
      for (const r of relatedProducts(cam.id, kind, links, products)) accessories.push({ camera: cam.model, kind, product: `${r.product.manufacturer} ${r.product.model}`, productId: r.product.id });
    }
  }

  // Junction boxes: recommended on hard surfaces, never charged without Chris in v1.
  const surfaces = policies.junctionBoxSurfaces.value;
  const hard = cameras.filter((c) => surfaces.includes(c.requirement.mounting));
  const junctionBoxRecommended = hard.length > 0;
  const junctionBoxReason = junctionBoxRecommended
    ? `${hard.length} camera(s) on ${[...new Set(hard.map((c) => c.requirement.mounting))].join("/")} need a junction box or mounting accessory.`
    : null;
  if (junctionBoxRecommended) {
    // One line per exact box model, from the camera's documented junction boxes.
    const byBox = new Map<string, { product: Product | null; qty: number; cams: string[] }>();
    for (const c of hard) {
      const box = c.product ? (relatedProducts(c.product.id, "camera_junction_box", links, products)[0]?.product ?? null) : null;
      const k = box?.id ?? "unknown";
      const e = byBox.get(k) ?? { product: box, qty: 0, cams: [] };
      e.qty += 1;
      e.cams.push(c.product?.model ?? c.requirement.targetArea);
      byBox.set(k, e);
    }
    for (const [k, e] of byBox) {
      materials.push({
        key: k === "unknown" ? "junction_box" : `junction_box:${k}`,
        description: e.product ? `Junction box ${e.product.manufacturer} ${e.product.model}` : "Junction boxes / mounting accessories",
        quantity: e.qty,
        product: e.product,
        charged: false,
        approvalRequired: true,
        reason: `${junctionBoxReason} ${e.product ? `Compatible with ${[...new Set(e.cams)].join(", ")} (documented).` : "No documented junction box for this camera."} Chris to confirm before it is charged.`,
      });
    }
  }

  // Double storey: conduit and extra complexity.
  const doubleStorey = (enquiry.storeys ?? 1) >= 2;
  const conduitRequired = doubleStorey && policies.doubleStoreyConduit.value;
  if (conduitRequired) {
    const allowance = pkg?.conduitIncluded ? (pkg.conduitAllowanceExGst ?? null) : null;
    const conduit = allowance == null ? pickProduct(products, of("conduit"), marketOk) : null;
    materials.push({
      key: "conduit",
      description: "Conduit for exposed upper-storey cable runs",
      quantity: 1,
      product: conduit,
      charged: allowance != null || !!conduit?.price?.approved,
      approvalRequired: allowance == null && !conduit?.price?.approved,
      allowanceExGst: allowance,
      reason:
        allowance != null
          ? `Double-storey conduit allowance from "${pkg!.name}"; subject to accessible cable routes on site.`
          : `Double-storey: conduit allowance considered, value not set${pkg ? ` on "${pkg.name}"` : ""}; subject to accessible cable routes on site.`,
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
      (s) => marketOk(s) && s.poePorts >= extra && (need == null || (s.poeBudgetW ?? Infinity) >= need),
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

  return { storeys: enquiry.storeys, doubleStorey, junctionBoxRecommended, junctionBoxReason, conduitRequired, complexity, materials, accessories, materialsPackage: mp, notes };
}

/** The installation package for this job (residential only), most specific first. */
export function packageFor(enquiry: EnquiryInput, cameraCount: number, packages: InstallationPackage[]): InstallationPackage | null {
  if (enquiry.propertyType === "commercial") return null;
  const storeys = enquiry.storeys ?? 1;
  const matches = packages
    .filter((p) => p.status !== "deprecated" && p.propertyType === "residential" && cameraCount >= p.minCameras && cameraCount <= p.maxCameras)
    .filter((p) => p.storeys == null || p.storeys === Math.min(storeys, 2) || (storeys >= 2 && p.storeys >= 2))
    .sort((a, b) => (a.storeys == null ? 1 : 0) - (b.storeys == null ? 1 : 0) || b.version - a.version || a.name.localeCompare(b.name));
  return matches[0] ?? null;
}

/**
 * Labour: the package price when Get Secure has set one; otherwise the entered package hours x the
 * internal labour rate. With neither, labour is left unpriced rather than guessed.
 */
export function labourPlan(input: { enquiry: EnquiryInput; cameraCount: number; packages: InstallationPackage[]; policies: Policies }): LabourResult {
  const { enquiry, cameraCount, packages, policies } = input;
  const commercial = enquiry.propertyType === "commercial";
  const policyRate = commercial ? policies.labourRateCommercial.value : policies.labourRateResidential.value;
  const notes: string[] = [];
  const none = { package: null, estimatedHours: null, allowanceExGst: null, basis: null, internalRate: policyRate, internalReferenceExGst: null };
  if (commercial) {
    notes.push(`Commercial labour is estimated after the site visit; internal reference rate $${policyRate}/hour.`);
    return { ...none, notes };
  }
  const pkg = packageFor(enquiry, cameraCount, packages);
  if (!pkg) {
    notes.push(`No installation package for ${cameraCount} camera(s), ${enquiry.storeys ?? 1}-storey. Add one in Settings → Business Brain.`);
    return { ...none, notes };
  }
  const rate = pkg.labourRate ?? policyRate;
  if (!TRUSTED_STATUSES.includes(pkg.status)) notes.push(`Installation package "${pkg.name}" is ${pkg.status}: needs approval.`);
  const reference = pkg.estimatedHours != null ? Math.round(pkg.estimatedHours * rate * 100) / 100 : null;
  let allowance: number | null = null;
  let basis: LabourResult["basis"] = null;
  if (pkg.allowanceExGst != null) {
    allowance = pkg.allowanceExGst;
    basis = "package_price";
  } else if (reference != null) {
    allowance = reference;
    basis = "hours_x_rate";
    notes.push(`"${pkg.name}" has no package price: labour is ${pkg.estimatedHours} h x $${rate}/h.`);
  } else {
    notes.push(`Installation package "${pkg.name}": hours and price not set yet (Settings → Business Brain).`);
  }
  return { package: pkg, estimatedHours: pkg.estimatedHours, allowanceExGst: allowance, basis, internalRate: rate, internalReferenceExGst: reference, notes };
}
