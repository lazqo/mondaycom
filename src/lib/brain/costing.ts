/**
 * Quote costing. Everything is ex GST internally:
 *
 *   hardware sell = approved cost x (1 + markup)
 *   labour        = installation package price, or entered hours x internal rate
 *   materials     = standard materials package + approved exceptional items
 *   subtotal      = hardware + labour + materials + other
 *   GST           = subtotal x 15%
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
    logic: `Suggested ${s.value}% (${s.status}); policy range ${lo}-${hi}%, lower on higher-value hardware. Exact thresholds not yet approved.`,
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

  for (const m of input.materials) {
    if (!m.charged) continue;
    if (m.key === "standard_materials") {
      const mp = input.materialsPackage;
      other.push({
        key: m.key,
        customerDescription: m.description,
        quantity: 1,
        unitCostExGst: mp?.costExGst ?? null,
        unitSellExGst: mp?.sellExGst ?? null,
        markupPct: null,
        kind: "materials",
        priced: mp?.sellExGst != null,
        detail: mp?.items.map((i) => `${i.description}${i.costExGst != null ? `: $${i.costExGst}` : ""}`),
      });
      continue;
    }
    if (m.allowanceExGst != null) {
      other.push({ key: m.key, customerDescription: m.description, quantity: 1, unitCostExGst: null, unitSellExGst: m.allowanceExGst, markupPct: null, kind: "materials", priced: true });
      continue;
    }
    const line = { ...hardwareLine(m.key, m.description, m.quantity, m.product, mk.pct), kind: "materials" as const };
    if (!line.priced) unpriced.push(`${m.description}: no approved price`);
    other.push(line);
  }
  if (input.residential && !input.materials.some((m) => m.key === "standard_materials" && m.charged)) unpriced.push("Standard materials package value not set");
  for (const m of input.materials) if (m.key === "conduit" && !m.charged) unpriced.push("Conduit allowance not set");

  if (input.labour.allowanceExGst != null) {
    const labourCostRate = policies.labourCostRate.value;
    const cost = labourCostRate != null && input.labour.estimatedHours != null ? labourCostRate * input.labour.estimatedHours : null;
    other.push({
      key: "labour",
      customerDescription: "Installation and commissioning",
      quantity: 1,
      unitCostExGst: cost,
      unitSellExGst: input.labour.allowanceExGst,
      markupPct: null,
      kind: "labour",
      priced: true,
      detail: [
        input.labour.basis === "package_price" ? `Package price (${input.labour.package?.name})` : `${input.labour.estimatedHours} h x $${input.labour.internalRate}/h (${input.labour.package?.name})`,
      ],
    });
  } else {
    unpriced.push(input.residential ? (input.labour.package ? `Installation: "${input.labour.package.name}" hours and price not set` : "Installation allowance: no package") : "Installation: estimated after the site visit");
  }

  const lines = [...hardware, ...other];
  const sum = (kind: CostLine["kind"], f: (l: CostLine) => number) => round2(lines.filter((l) => l.kind === kind && l.priced).reduce((s, l) => s + f(l), 0));
  const cost = (l: CostLine) => (l.unitCostExGst ?? 0) * l.quantity;
  const sell = (l: CostLine) => (l.unitSellExGst ?? 0) * l.quantity;
  const equipmentCost = sum("hardware", cost);
  const materialsCost = sum("materials", cost);
  const labourCost = sum("labour", cost);
  const otherCost = sum("other", cost);
  const sellExGst = round2(lines.filter((l) => l.priced).reduce((s, l) => s + sell(l), 0));
  const gst = round2(sellExGst * policies.gstRate.value);
  const grossProfit = round2(sellExGst - equipmentCost - materialsCost - labourCost - otherCost);
  const refreshRequired = lines
    .filter((l) => l.priced && l.productId && (l.freshness === "stale" || l.freshness === "unknown"))
    .map((l) => ({ model: l.model ?? l.customerDescription, supplier: l.supplier ?? null, freshness: l.freshness! }));

  return {
    lines,
    equipmentCost,
    labourCost,
    materialsCost,
    otherCost,
    sellExGst,
    gst,
    totalIncGst: round2(sellExGst + gst),
    grossProfit,
    grossMarginPct: sellExGst > 0 ? round2((grossProfit / sellExGst) * 100) : null,
    markupPct: mk.pct,
    markupSource: mk.source,
    markupLogic:
      mk.logic +
      (policies.labourCostRate.value == null ? " Labour cost not set, so gross profit does not deduct labour." : "") +
      (input.materialsPackage && input.materialsPackage.costExGst == null && input.materialsPackage.sellExGst != null ? " Materials cost not set, so gross profit does not deduct it." : ""),
    complete: unpriced.length === 0,
    unpriced,
    refreshRequired,
    kit: kitResult.kit,
    kitNotes: kitResult.notes,
  };
}
