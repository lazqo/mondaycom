/**
 * CCTV upgrades: the existing cabling decides the installation package. The cheaper IP upgrade
 * package only with confirmed reusable Cat5e/Cat6 and reused positions; coax never assumed
 * reusable; unknown cabling leaves installation unresolved (or the approved conservative
 * assumption); mixed positions need Chris. Package values are TEST VALUES.
 */
import { describe, it, expect } from "vitest";
import { assessCctv } from "@/lib/brain/engine";
import { CABLING_UNCONFIRMED } from "@/lib/brain/upgrade";
import type { ExistingSystem, InstallationPackage } from "@/lib/brain/types";
import { catalogue, house, packages, testPolicies } from "./brain-fixtures";

const NOW = new Date("2026-10-03T00:00:00Z");
const upgradePackages: InstallationPackage[] = [2, 4, 6, 8].map((n) => ({
  id: `up-${n}`,
  key: `RES_CCTV_UPGRADE_IP_${n}`,
  name: `Residential CCTV IP upgrade, ${n} cameras`,
  propertyType: "residential",
  installType: "upgrade_ip",
  cameraCount: n,
  storeyType: null,
  minCameras: n,
  maxCameras: n,
  storeys: null,
  estimatedHours: n,
  labourRate: 95,
  allowanceExGst: n * 100,
  materialCostExGst: 5 * n,
  complexityAllowanceExGst: 0,
  includedMaterials: [],
  assumptions: [],
  exclusions: [],
  version: 1,
  status: "getsecure_approved",
}));
const cat = () => ({ ...catalogue(), packages: [...packages(), ...upgradePackages] });
const existing = (over: Partial<ExistingSystem>): ExistingSystem => ({
  systemType: "ip_poe",
  recorder: null,
  cameraCount: 4,
  cableType: "cat6",
  cableCondition: "reusable",
  locationsSuitable: "yes",
  power: null,
  ...over,
});
const run = (ex: Partial<ExistingSystem> | null, policies = testPolicies(), extra = {}) =>
  assessCctv(house({ jobType: "upgrade", existing: ex ? existing(ex) : null, ...extra }), cat(), policies, { now: NOW });
const item = (p: ReturnType<typeof run>, key: string) => p.readiness.items.find((i) => i.key === key);

describe("CCTV upgrades", () => {
  it("a new installation never uses an upgrade package", () => {
    const p = assessCctv(house({ jobType: "new" }), cat(), testPolicies(), { now: NOW });
    expect(p.labour.package?.key).toBe("RES_CCTV_SINGLE_4");
    expect(p.installation.upgrade ?? null).toBeNull();
  });

  it("reusable Cat5e/Cat6 in the existing positions: the IP upgrade package", () => {
    for (const cableType of ["cat5e", "cat6"] as const) {
      const p = run({ cableType });
      expect(p.labour.package?.key).toBe("RES_CCTV_UPGRADE_IP_4");
      expect(p.labour.labourCostExGst).toBe(4 * 95);
      expect(p.installation.upgrade).toMatchObject({ path: "ip_reuse", packageKind: "upgrade_ip", unresolved: null });
      expect(p.costing.complete).toBe(true);
      expect(item(p, "existing_system")?.ok).toBe(true);
    }
  });

  it("unknown cabling: no upgrade saving; hardware still prepared, installation unresolved", () => {
    for (const ex of [null, { cableType: "unknown" as const }, { cableCondition: "needs_testing" as const }, { cableCondition: "unknown" as const }]) {
      const p = run(ex);
      expect(p.labour.package).toBeNull();
      expect(p.labour.missing).toEqual([CABLING_UNCONFIRMED]);
      expect(CABLING_UNCONFIRMED).toBe("Existing cabling must be confirmed before upgrade labour savings can be applied.");
      expect(p.costing.complete).toBe(false);
      expect(p.costing.unpriced).toContain(CABLING_UNCONFIRMED);
      expect(p.costing.lines.filter((l) => l.kind === "hardware").every((l) => l.priced)).toBe(true);
      expect(item(p, "existing_system")?.ok).toBe(false);
    }
  });

  it("unknown cabling with Chris's approved conservative assumption: the new-install package, never the upgrade one", () => {
    const policies = testPolicies({ upgradeUnconfirmedCabling: { value: "new_install", status: "getsecure_approved", source: "test", notes: null } as never });
    const p = run({ cableType: "unknown" }, policies);
    expect(p.labour.package?.key).toBe("RES_CCTV_SINGLE_4");
    expect(p.installation.upgrade?.summary).toMatch(/must be confirmed.*new-install package, as approved/);
    // An unapproved value is not used.
    const q = run({ cableType: "unknown" }, testPolicies({ upgradeUnconfirmedCabling: { value: "new_install", status: "getsecure_provisional", source: "test", notes: null } as never }));
    expect(q.labour.package).toBeNull();
  });

  it("coax is never assumed reusable: Chris decides; replacing with Cat6 is a new installation", () => {
    const undecided = run({ systemType: "analogue_coax", cableType: "coax" });
    expect(undecided.labour.package?.key).toBe("RES_CCTV_SINGLE_4");
    expect(undecided.approvals.find((a) => a.key === "upgrade_decision")?.description).toMatch(/replace it with Cat6.*or keep it with coax-compatible technology/);
    expect(item(undecided, "existing_system")?.ok).toBe(false);

    const replace = run({ systemType: "analogue_coax", cableType: "coax", coaxDecision: "replace_with_cat6" });
    expect(replace.labour.package?.key).toBe("RES_CCTV_SINGLE_4");
    expect(item(replace, "existing_system")?.ok).toBe(true);

    const keep = run({ systemType: "analogue_coax", cableType: "coax", coaxDecision: "retain_coax" });
    expect(keep.labour.package).toBeNull();
    expect(keep.costing.complete).toBe(false);
    expect(keep.labour.missing[0]).toMatch(/coax-compatible/);
  });

  it("damaged or unsuitable cabling: the normal new-install package (double storey too)", () => {
    expect(run({ cableCondition: "not_reusable" }).labour.package?.key).toBe("RES_CCTV_SINGLE_4");
    expect(run({ cableType: "other" }).labour.package?.key).toBe("RES_CCTV_SINGLE_4");
    expect(run({ cableCondition: "not_reusable" }, testPolicies(), { storeys: 2 }).labour.package?.key).toBe("RES_CCTV_DOUBLE_4");
  });

  it("camera positions: reused, new, to confirm, or mixed", () => {
    const allNew = run({ locationsSuitable: "no" });
    expect(allNew.labour.package?.key).toBe("RES_CCTV_SINGLE_4");
    const unknownPositions = run({ locationsSuitable: "unknown" });
    expect(unknownPositions.labour.package).toBeNull();
    expect(unknownPositions.labour.missing[0]).toMatch(/Camera positions to confirm \(4 of 4\)/);
    const mixed = run({ positions: { reuse: 2, new: 2, confirm: 0 } });
    expect(mixed.installation.upgrade).toMatchObject({ path: "mixed", positions: { reuse: 2, new: 2, confirm: 0 } });
    expect(mixed.labour.package).toBeNull();
    expect(mixed.labour.customInstallation).toBe(true);
    expect(mixed.labour.missing[0]).toMatch(/Mixed upgrade \(2 reused run\(s\), 2 new run\(s\)\)/);
    expect(run({ positions: { reuse: 4, new: 0, confirm: 0 }, locationsSuitable: "unknown" }).labour.package?.key).toBe("RES_CCTV_UPGRADE_IP_4");
  });

  it("other camera counts have no upgrade package: custom installation", () => {
    const p = run({}, testPolicies(), { cameraCount: 5, areas: ["A", "B", "C", "D", "E"] });
    expect(p.labour.package).toBeNull();
    expect(p.labour.customInstallation).toBe(true);
  });
});
