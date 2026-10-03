/**
 * CCTV upgrades: which installation package an upgrade may use, from what is already on site.
 *
 * - Existing Cat5e/Cat6, confirmed reusable, cameras in the existing positions → IP upgrade package
 *   (RES_CCTV_UPGRADE_IP_n): the runs stay, subject to testing and re-termination.
 * - Coax → never assumed reusable for PoE/IP. Chris decides: replace with Cat6 (the IP system,
 *   costed as a new installation) or keep the coax (needs a coax-compatible design, not quoted here).
 * - Cabling damaged / unsuitable / other → the normal new-install package.
 * - Cable type or reusability not confirmed → the cheaper upgrade package is never applied. The
 *   installation stays unresolved, or uses the new-install package only if Chris has approved that
 *   as the conservative assumption (policy upgradeUnconfirmedCabling).
 * - Some cameras in existing positions and some new → a mixed upgrade, which has no package yet:
 *   the reused and new runs are listed and the installation needs Chris's calculation.
 * The hardware side of the quote is designed the same way in every case.
 */
import { TRUSTED_STATUSES, type EnquiryInput, type ExistingSystem, type Policies } from "./types";

export const CABLING_UNCONFIRMED = "Existing cabling must be confirmed before upgrade labour savings can be applied.";

export type UpgradePlan = {
  /** Which installation package family to price with; null = installation unresolved. */
  packageKind: "new" | "upgrade_ip" | null;
  path: "ip_reuse" | "new_install" | "coax_replace" | "coax_retain" | "coax_undecided" | "cabling_unconfirmed" | "mixed" | "positions_unconfirmed";
  existing: ExistingSystem;
  positions: { reuse: number; new: number; confirm: number };
  summary: string;
  /** Why installation cannot be priced yet (shown as missing, keeps the quote Not fully priced). */
  unresolved: string | null;
  /** Decisions Chris must make. */
  decisions: string[];
  notes: string[];
};

const UNKNOWN: ExistingSystem = { systemType: "unknown", recorder: null, cameraCount: null, cableType: "unknown", cableCondition: "unknown", locationsSuitable: "unknown", power: null, positions: null, coaxDecision: null };

const CABLE: Record<ExistingSystem["cableType"], string> = { cat5e: "Cat5e", cat6: "Cat6", coax: "coax", other: "other cable", unknown: "unknown cable" };

/** How many of the new cameras use existing positions, new positions, or are still to confirm. */
export function positionsFor(existing: ExistingSystem, cameraCount: number): { reuse: number; new: number; confirm: number } {
  const p = existing.positions;
  if (p && p.reuse + p.new + p.confirm > 0) {
    const reuse = Math.max(0, Math.min(p.reuse, cameraCount));
    const nw = Math.max(0, Math.min(p.new, cameraCount - reuse));
    return { reuse, new: nw, confirm: cameraCount - reuse - nw };
  }
  if (existing.locationsSuitable === "yes") return { reuse: cameraCount, new: 0, confirm: 0 };
  if (existing.locationsSuitable === "no") return { reuse: 0, new: cameraCount, confirm: 0 };
  return { reuse: 0, new: 0, confirm: cameraCount };
}

export function upgradePlan(enquiry: EnquiryInput, cameraCount: number, policies: Policies): UpgradePlan | null {
  if (enquiry.jobType !== "upgrade" || enquiry.propertyType === "commercial") return null;
  const e: ExistingSystem = { ...UNKNOWN, ...(enquiry.existing ?? {}) };
  const positions = positionsFor(e, cameraCount);
  const notes: string[] = [];
  const decisions: string[] = [];
  if (e.power) notes.push(`Existing power/PoE/baluns: ${e.power}.`);
  if (e.recorder) notes.push(`Existing recorder: ${e.recorder}.`);
  const conservative = policies.upgradeUnconfirmedCabling.value === "new_install" && TRUSTED_STATUSES.includes(policies.upgradeUnconfirmedCabling.status);
  const base = { existing: e, positions, decisions, notes };

  // Cabling that cannot be reused, or isn't Cat5e/Cat6/coax: a new installation.
  if (e.cableCondition === "not_reusable" || e.cableType === "other") {
    return { ...base, packageKind: "new", path: "new_install", summary: `Existing ${CABLE[e.cableType]} cannot be reused: priced as a new installation.`, unresolved: null };
  }

  // Coax is never assumed reusable for PoE/IP.
  if (e.cableType === "coax") {
    if (e.coaxDecision === "replace_with_cat6")
      return { ...base, packageKind: "new", path: "coax_replace", summary: "Existing coax replaced with Cat6 for the IP system: priced as a new installation.", unresolved: null };
    if (e.coaxDecision === "retain_coax")
      return {
        ...base,
        packageKind: null,
        path: "coax_retain",
        summary: "Keep the existing coax with a coax-compatible system.",
        unresolved: "Keeping the existing coax needs a coax-compatible (HD-over-coax) design, which this quote does not cover: the IP hardware and its installation need Chris's design.",
      };
    decisions.push("Existing coax: replace it with Cat6 for the IP system (priced here as a new installation), or keep it with coax-compatible technology (a different design).");
    return {
      ...base,
      packageKind: "new",
      path: "coax_undecided",
      summary: "Existing coax is not reused for the IP system: priced as a new installation with Cat6, until Chris decides.",
      unresolved: null,
    };
  }

  // Cable type or reusability not confirmed: never the cheaper upgrade package.
  const copper = e.cableType === "cat5e" || e.cableType === "cat6";
  if (!copper || e.cableCondition !== "reusable") {
    const why = !copper ? "cable type unknown" : e.cableCondition === "needs_testing" ? `${CABLE[e.cableType]} needs testing` : `${CABLE[e.cableType]} condition unknown`;
    if (conservative)
      return { ...base, packageKind: "new", path: "cabling_unconfirmed", summary: `${CABLING_UNCONFIRMED} (${why}). Priced with the new-install package, as approved.`, unresolved: null };
    return { ...base, packageKind: null, path: "cabling_unconfirmed", summary: `${CABLING_UNCONFIRMED} (${why}).`, unresolved: CABLING_UNCONFIRMED };
  }

  // Reusable Cat5e/Cat6: depends on whether the cameras stay in the existing positions.
  if (positions.confirm > 0)
    return {
      ...base,
      packageKind: null,
      path: "positions_unconfirmed",
      summary: `Existing ${CABLE[e.cableType]} is reusable; ${positions.confirm} camera position(s) still to confirm.`,
      unresolved: `Camera positions to confirm (${positions.confirm} of ${cameraCount}): the upgrade package applies only where cameras reuse existing positions and runs.`,
    };
  if (positions.new === 0)
    return { ...base, packageKind: "upgrade_ip", path: "ip_reuse", summary: `IP upgrade: existing ${CABLE[e.cableType]} runs and camera positions reused, subject to testing and re-termination.`, unresolved: null };
  if (positions.reuse === 0)
    return { ...base, packageKind: "new", path: "new_install", summary: "Every camera goes in a new position with new cable: priced as a new installation.", unresolved: null };
  return {
    ...base,
    packageKind: null,
    path: "mixed",
    summary: `Mixed upgrade: ${positions.reuse} camera(s) reuse existing ${CABLE[e.cableType]} runs, ${positions.new} need new positions and new cable.`,
    unresolved: `Mixed upgrade (${positions.reuse} reused run(s), ${positions.new} new run(s)) has no installation package yet: labour needs Chris's calculation.`,
  };
}
