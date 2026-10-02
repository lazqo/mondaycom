/**
 * Quote costing. Everything is ex GST internally:
 *
 *   hardware sell   = approved trade cost x (1 + markup)
 *   installation    = the exact package's customer sell allowance (covers labour, cabling and
 *                     standard installation materials, conduit and complexity)
 *   internal costs  = hardware + labour (hours x internal rate) + standard material cost +
 *                     conduit allowance + complexity allowance + approved exceptional items
 *   subtotal        = hardware sell + installation sell + exceptional items
 *   GST             = subtotal x 15%
 *
 * Only approved prices are used. A product without one is listed as unpriced and the costing is
 * marked incomplete rather than estimated. Each line keeps a snapshot of the supplier, SKU, cost
 * and price date it used, so a prepared quote does not move when supplier prices change later.
 * Supplier cost and margin never leave this object; the customer sees only the sell lines.
 */
import type { CameraChoice, CompatibilityLink, CostLine, Costing, LabourResult, MaterialLine, MaterialsPackage, NvrProduct, Policies, Product, StorageResult } from "./types";
import { relatedProducts } from "./compat";

const round2 = (n: number) => Math.round(n * 100) / 100;

export function markupFor(policies: Policies, override: number | null | undefined): { pct: number; source: "suggested" | "override"; logic: string; outOfRange: boolean } {
  const [lo, hi] = policies.markupRangePct.value;
  if (override != null) {
    const outOfRange = override < lo || override > hi;
    return { pct: override, source: "override", logic: `Chris override ${override}%${outOfRange ? ` (outside the ${lo}-${hi}% range)` : ""}.`, outOfRange };
  }
  const s = policies.suggestedMarkupPct;
  return {
    pct: s.value,
    source: "suggested",
    logic:
      s.status === "getsecure_approved"
        ? `Suggested ${s.value}% (approved); policy range ${lo}-${hi}%.`
        : `Provisional suggested markup ${s.value}% (not a Get Secure rule); policy range ${lo}-${hi}%, normally lower on higher-value hardware. Price bands not yet approved: Chris to confirm or override.`,
    outOfRange: false,
  };
}

function hardwareLine(key: string, description: string, qty: number, product: Product | null, markup: number): CostLine {
  const priced = !!product?.price?.approved;
  const cost = priced ? product!.price!.costExGst : null;
  return {
    key,
    customerDescription: description,
    quantity: qty,
    unitCostExGst: cost,
    unitSellExGst: cost != null ? round2(cost * (1 + markup / 100)) : null,
    markupPct: priced ? markup : null,
    kind: "hardware",
    priced,
    productId: product?.id ?? null,
    model: product ? `${product.manufacturer} ${product.model}` : null,
    supplier: product?.price?.supplier ?? null,
    supplierSku: product?.price?.supplierSku ?? null,
    lastChecked: product?.price?.lastChecked ?? null,
    freshness: product?.price ? (product.price.freshness ?? "unknown") : null,
    stock: product?.price?.stock ?? null,
    routeNote: product?.price?.routeNote ?? null,
    alternatives: product?.price?.alternatives ?? [],
  };
}

/**
 * Use a supplier kit for part of the hardware when every component it contains is already in the
 * system (at least that many) and the kit's approved cost is lower than the components bought
 * separately. Anything beyond the kit stays on its own line, so a kit is extended, never forced.
 */
function applyKit(lines: CostLine[], products: Product[], links: CompatibilityLink[], markup: number): { lines: CostLine[]; kit: Costing["kit"]; notes: string[] } {
  const notes: string[] = [];
  const kits = products.filter((p) => p.category === "kit" && p.status !== "deprecated" && p.price?.approved);
  let best: { kit: Product; comps: { product: Product; quantity: number }[]; saving: number } | null = null;
  for (const kit of kits) {
    const comps = relatedProducts(kit.id, "kit_component", links, products);
    if (!comps.length) continue;
    const fits = comps.every((c) => {
      const l = lines.find((x) => x.productId === c.product.id && x.priced);
      return l && l.quantity >= c.quantity;
    });
    if (!fits) {
      const missing = comps.filter((c) => !lines.some((x) => x.productId === c.product.id && x.quantity >= c.quantity)).map((c) => c.product.model);
      if (comps.some((c) => lines.some((x) => x.productId === c.product.id))) notes.push(`Kit ${kit.model} not used: this system does not include ${missing.join(", ")}.`);
      continue;
    }
    const separate = comps.reduce((s, c) => s + (lines.find((x) => x.productId === c.product.id)!.unitCostExGst ?? 0) * c.quantity, 0);
    const saving = round2(separate - kit.price!.costExGst);
    if (saving <= 0) {
      notes.push(`Kit ${kit.model} not used: no cheaper than its components.`);
      continue;
    }
    if (!best || saving > best.saving) best = { kit, comps, saving };
  }
  if (!best) return { lines, kit: null, notes };
  const out = lines.map((l) => {
    const c = best!.comps.find((x) => x.product.id === l.productId);
    return c ? { ...l, quantity: l.quantity - c.quantity } : l;
  });
  const kitLine: CostLine = {
    ...hardwareLine(`kit:${best.kit.id}`, `${best.kit.manufacturer} ${best.kit.model} kit`, 1, best.kit, markup),
    detail: best.comps.map((c) => `${c.quantity} x ${c.product.manufacturer} ${c.product.model}`),
  };
  return {
    lines: [kitLine, ...out.filter((l) => l.quantity > 0)],
    kit: { productId: best.kit.id, model: `${best.kit.manufacturer} ${best.kit.model}`, components: kitLine.detail!, savingExGst: best.saving },
    notes,
  };
}

export function costQuote(input: {
  cameras: CameraChoice[];
  nvr: NvrProduct | null;
  storage: StorageResult;
  materials: MaterialLine[];
  materialsPackage?: MaterialsPackage | null;
  labour: LabourResult;
  residential: boolean;
  policies: Policies;
  markupOverride?: number | null;
  products?: Product[];
  links?: CompatibilityLink[];
}): Costing & { kitNotes: string[] } {
  const { policies } = input;
  const mk = markupFor(policies, input.markupOverride);
  let hardware: CostLine[] = [];
  const other: CostLine[] = [];
  const unpriced: string[] = [];

  // Cameras, grouped by model.
  const groups = new Map<string, CameraChoice[]>();
  for (const c of input.cameras) {
    const k = c.product ? c.product.id : `missing:${c.requirement.id}`;
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  for (const [k, list] of groups) {
    const p = list[0].product;
    if (!p) {
      unpriced.push(`Camera for ${list.map((c) => c.requirement.targetArea).join(", ")}: no suitable product`);
      hardware.push({ key: k, customerDescription: "Camera (to be selected)", quantity: list.length, unitCostExGst: null, unitSellExGst: null, markupPct: null, kind: "hardware", priced: false });
      continue;
    }
    hardware.push(hardwareLine(`camera:${p.id}`, `${p.resolutionMp} MP ${p.manufacturer} ${p.model} camera`, list.length, p, mk.pct));
  }

  if (input.nvr) hardware.push(hardwareLine(`nvr:${input.nvr.id}`, `${input.nvr.channels}-channel ${input.nvr.manufacturer} recorder (${input.nvr.model})`, 1, input.nvr, mk.pct));
  else unpriced.push("Recorder: none selected");

  const drives = input.storage.drives;
  if (drives) hardware.push(hardwareLine(`hdd:${drives.product.id}`, `${drives.product.capacityTb} TB surveillance hard drive`, drives.count, drives.product, mk.pct));
  else unpriced.push("Hard drive: none selected");

  const kitResult = input.products ? applyKit(hardware, input.products, input.links ?? [], mk.pct) : { lines: hardware, kit: null, notes: [] };
  hardware = kitResult.lines;
  for (const l of hardware) if (!l.priced && l.productId) unpriced.push(`${l.model}: no approved price`);

  // Exceptional items a condition called for and Chris has approved charging (none are automatic).
  for (const m of input.materials) {
    if (!m.charged || m.key === "standard_materials" || m.key === "conduit") continue;
    const line = { ...hardwareLine(m.key, m.description, m.quantity, m.product, mk.pct), kind: "materials" as const };
    if (!line.priced) unpriced.push(`${m.description}: no approved price`);
    other.push(line);
  }

  // Installation: one customer line from the package sell allowance; its costs stay internal.
  const L = input.labour;
  for (const m of L.missing) unpriced.push(m);
  if (L.package) {
    const pkgName = L.package.key ?? L.package.name;
    other.push({
      key: "installation",
      customerDescription: "Installation, commissioning, cabling and standard installation materials",
      quantity: 1,
      unitCostExGst: L.labourCostExGst,
      unitSellExGst: L.allowanceExGst,
      markupPct: null,
      kind: "labour",
      priced: L.allowanceExGst != null && L.labourCostExGst != null,
      detail: [`${pkgName}: ${L.estimatedHours ?? "?"} h x $${L.internalRate}/h labour${L.allowanceExGst != null ? `, sell allowance $${L.allowanceExGst}` : ""}`],
    });
    const mp = input.materialsPackage;
    const internal = (key: string, label: string, value: number | null, kind: CostLine["kind"], detail?: string[]) =>
      other.push({ key, customerDescription: label, quantity: 1, unitCostExGst: value, unitSellExGst: 0, markupPct: null, kind, priced: value != null, internalOnly: true, detail });
    internal("standard_materials", "Standard installation materials (internal)", L.materialCostExGst, "materials", mp?.items.map((i) => i.description));
    if (L.conduitCostExGst) internal("conduit", "Conduit allowance (internal)", L.conduitCostExGst, "other");
    else if (L.conduitCostExGst == null) internal("conduit", "Conduit allowance (internal)", null, "other");
    internal("complexity", "Installation complexity allowance (internal)", L.complexityCostExGst, "other");
  }

  const lines = [...hardware, ...other];
  const sum = (kind: CostLine["kind"], f: (l: CostLine) => number, keys?: string[]) =>
    round2(lines.filter((l) => l.kind === kind && l.priced && (!keys || keys.includes(l.key))).reduce((s, l) => s + f(l), 0));
  const cost = (l: CostLine) => (l.unitCostExGst ?? 0) * l.quantity;
  const sell = (l: CostLine) => (l.unitSellExGst ?? 0) * l.quantity;
  const equipmentCost = sum("hardware", cost);
  const materialsCost = sum("materials", cost);
  const labourCost = sum("labour", cost);
  const allowancesCost = sum("other", cost, ["conduit", "complexity"]);
  const otherCost = round2(sum("other", cost) - allowancesCost);
  const sellExGst = round2(lines.filter((l) => l.priced && !l.internalOnly).reduce((s, l) => s + sell(l), 0));
  const gst = round2(sellExGst * policies.gstRate.value);
  const grossProfit = round2(sellExGst - equipmentCost - materialsCost - labourCost - allowancesCost - otherCost);
  const refreshRequired = lines
    .filter((l) => l.priced && l.productId && (l.freshness === "stale" || l.freshness === "unknown"))
    .map((l) => ({ model: l.model ?? l.customerDescription, supplier: l.supplier ?? null, freshness: l.freshness! }));

  return {
    lines,
    equipmentCost,
    labourCost,
    materialsCost,
    allowancesCost,
    otherCost,
    sellExGst,
    gst,
    totalIncGst: round2(sellExGst + gst),
    grossProfit,
    grossMarginPct: sellExGst > 0 ? round2((grossProfit / sellExGst) * 100) : null,
    markupPct: mk.pct,
    markupSource: mk.source,
    markupLogic: mk.logic,
    complete: unpriced.length === 0,
    unpriced,
    refreshRequired,
    kit: kitResult.kit,
    kitNotes: kitResult.notes,
  };
}
