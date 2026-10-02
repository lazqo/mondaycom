/**
 * Quote costing. Everything is ex GST internally:
 *
 *   hardware sell = approved cost x (1 + markup)
 *   labour        = installation package allowance
 *   materials     = standard allowance + approved exceptional items
 *   subtotal      = hardware + labour + materials + other
 *   GST           = subtotal x 15%
 *
 * Only approved prices are used. A product without one is listed as unpriced and the costing is
 * marked incomplete rather than estimated. Supplier cost and margin never leave this object; the
 * customer sees only the sell lines.
 */
import type { CameraChoice, CostLine, Costing, LabourResult, MaterialLine, NvrProduct, Policies, StorageResult } from "./types";

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

function hardwareLine(key: string, description: string, qty: number, product: { price: { costExGst: number; approved: boolean } | null } | null, markup: number): CostLine {
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
  };
}

export function costQuote(input: {
  cameras: CameraChoice[];
  nvr: NvrProduct | null;
  storage: StorageResult;
  materials: MaterialLine[];
  labour: LabourResult;
  residential: boolean;
  policies: Policies;
  markupOverride?: number | null;
}): Costing {
  const { policies } = input;
  const mk = markupFor(policies, input.markupOverride);
  const lines: CostLine[] = [];
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
      lines.push({ key: k, customerDescription: "Camera (to be selected)", quantity: list.length, unitCostExGst: null, unitSellExGst: null, markupPct: null, kind: "hardware", priced: false });
      continue;
    }
    const line = hardwareLine(`camera:${p.id}`, `${p.resolutionMp} MP ${p.manufacturer} ${p.model} camera`, list.length, p, mk.pct);
    if (!line.priced) unpriced.push(`${p.manufacturer} ${p.model}: no approved price`);
    lines.push(line);
  }

  if (input.nvr) {
    const line = hardwareLine(`nvr:${input.nvr.id}`, `${input.nvr.channels}-channel ${input.nvr.manufacturer} recorder (${input.nvr.model})`, 1, input.nvr, mk.pct);
    if (!line.priced) unpriced.push(`${input.nvr.manufacturer} ${input.nvr.model}: no approved price`);
    lines.push(line);
  } else {
    unpriced.push("Recorder: none selected");
  }

  const drives = input.storage.drives;
  if (drives) {
    const line = hardwareLine(`hdd:${drives.product.id}`, `${drives.product.capacityTb} TB surveillance hard drive`, drives.count, drives.product, mk.pct);
    if (!line.priced) unpriced.push(`${drives.product.manufacturer} ${drives.product.model}: no approved price`);
    lines.push(line);
  } else {
    unpriced.push("Hard drive: none selected");
  }

  for (const m of input.materials) {
    if (!m.charged) continue;
    if (m.key === "standard_materials") {
      const sm = policies.standardMaterials.value;
      lines.push({ key: m.key, customerDescription: m.description, quantity: 1, unitCostExGst: sm.costExGst ?? 0, unitSellExGst: sm.sellExGst, markupPct: null, kind: "materials", priced: sm.sellExGst != null });
      continue;
    }
    const line = { ...hardwareLine(m.key, m.description, m.quantity, m.product, mk.pct), kind: "materials" as const };
    if (!line.priced) unpriced.push(`${m.description}: no approved price`);
    lines.push(line);
  }
  if (input.residential && !input.materials.some((m) => m.key === "standard_materials" && m.charged)) unpriced.push("Standard materials allowance not set");

  if (input.labour.allowanceExGst != null) {
    const labourCostRate = policies.labourCostRate.value;
    const cost = labourCostRate != null && input.labour.estimatedHours != null ? labourCostRate * input.labour.estimatedHours : 0;
    lines.push({
      key: "labour",
      customerDescription: `Installation and commissioning`,
      quantity: 1,
      unitCostExGst: cost,
      unitSellExGst: input.labour.allowanceExGst,
      markupPct: null,
      kind: "labour",
      priced: true,
    });
  } else {
    unpriced.push(input.residential ? "Installation allowance: no package" : "Installation: estimated after the site visit");
  }

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
    markupLogic: mk.logic + (policies.labourCostRate.value == null ? " Labour cost not set, so gross profit does not deduct labour." : ""),
    complete: unpriced.length === 0,
    unpriced,
  };
}
