/**
 * Regression: internal cost totals. Labour was left out of the labour cost and the total internal
 * cost whenever the customer sell allowance was blank (the installation line counted as "unpriced",
 * and cost sums only added priced lines). Every known cost must count, whether or not the sell side
 * is entered yet; the quote still stays Not fully priced. Values are TEST VALUES.
 */
import { describe, it, expect } from "vitest";
import { assessCctv } from "@/lib/brain/engine";
import { catalogue, house, packages, testPolicies } from "./brain-fixtures";

const NOW = new Date("2026-10-03T00:00:00Z");

function withPackage(key: string, over: Record<string, unknown>) {
  const cat = catalogue();
  return { ...cat, packages: packages().map((p) => (p.key === key ? { ...p, ...over } : p)) };
}

function totals(p: ReturnType<typeof assessCctv>) {
  const c = p.costing;
  const lineCost = (pred: (l: (typeof c.lines)[number]) => boolean) => c.lines.filter(pred).reduce((s, l) => s + (l.unitCostExGst ?? 0) * l.quantity, 0);
  return {
    hardware: lineCost((l) => l.kind === "hardware"),
    labour: lineCost((l) => l.kind === "labour"),
    materials: lineCost((l) => l.kind === "materials"),
    conduit: lineCost((l) => l.key === "conduit"),
    complexity: lineCost((l) => l.key === "complexity"),
    other: lineCost((l) => l.kind === "other" && l.key !== "conduit" && l.key !== "complexity"),
  };
}
const r2 = (n: number) => Math.round(n * 100) / 100;

describe("internal cost totals", () => {
  it("counts the package labour when the customer sell allowance is still blank, and stays Not fully priced", () => {
    const cat = withPackage("RES_CCTV_SINGLE_4", { estimatedHours: 8, labourRate: 95, materialCostExGst: 150, complexityAllowanceExGst: 100, allowanceExGst: null });
    const p = assessCctv(house(), cat, testPolicies(), { now: NOW });
    const c = p.costing;
    // The displayed labour cost is the package calculation: 8 h x $95 = $760.
    expect(p.labour.labourCostExGst).toBe(760);
    expect(c.labourCost).toBe(760);
    expect(c.labourCost).toBe(p.labour.labourCostExGst);
    expect(c.materialsCost).toBe(150);
    expect(c.allowancesCost).toBe(100);
    // totalInternalCost = hardware + labour + materials + conduit + complexity + other
    const t = totals(p);
    expect(c.equipmentCost).toBe(r2(t.hardware));
    expect(c.totalInternalCost).toBe(r2(t.hardware + t.labour + t.materials + t.conduit + t.complexity + t.other));
    expect(c.totalInternalCost).toBe(r2(c.equipmentCost + c.labourCost + c.materialsCost + c.allowancesCost + c.otherCost));
    expect(c.totalInternalCost).toBe(r2(c.equipmentCost + 760 + 150 + 100));
    // The sell allowance is blank, so the quote is not fully priced and says why.
    expect(c.complete).toBe(false);
    expect(c.unpriced).toContain("RES_CCTV_SINGLE_4: customer sell allowance not set");
  });

  it("includes the conduit allowance on a double-storey job", () => {
    const cat = withPackage("RES_CCTV_DOUBLE_4", { estimatedHours: 10, labourRate: 95, materialCostExGst: 180, conduitAllowanceExGst: 60, complexityAllowanceExGst: 40, allowanceExGst: 1500 });
    const p = assessCctv(house({ storeys: 2 }), cat, testPolicies(), { now: NOW });
    const c = p.costing;
    const t = totals(p);
    expect(c.labourCost).toBe(950);
    expect(t.conduit).toBe(60);
    expect(t.complexity).toBe(40);
    expect(c.allowancesCost).toBe(100);
    expect(c.totalInternalCost).toBe(r2(t.hardware + t.labour + t.materials + t.conduit + t.complexity + t.other));
    expect(c.complete).toBe(true);
    expect(c.grossProfit).toBe(r2(c.sellExGst - c.totalInternalCost));
  });
});
