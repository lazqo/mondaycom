/**
 * Storage: calculated from bitrate and retention, never from a camera-count table.
 *
 *   storage = total average bitrate x seconds recorded
 *   1 Mbps continuous = 10.8 GB/day, so GB = total Mbps x 10.8 x days, plus a safety allowance.
 *
 * Commercial: drives are chosen from the catalogue within the recorder's limits (bays, largest
 * drive, total) to meet the retention target. If it cannot be reached the shortfall is reported.
 *
 * Residential: the drive is Get Secure's default for the camera count (or Chris's choice on the
 * assessment), never resized to hit a retention target and never swapped for another capacity
 * because that one has a price. The bitrate gives an estimated retention, which is advice for
 * Chris, with a warning when it is below the normal target.
 */
import type { CameraDesign, CompatibilityLink, EnquiryInput, HddProduct, NvrProduct, Policies, Product, StorageResult } from "./types";
import { TRUSTED_STATUSES } from "./types";
import { documentedDrives } from "./compat";

export function dailyGb(totalMbps: number, policies: Policies): number {
  return totalMbps * policies.gbPerMbpsDay.value;
}

export function requiredStorageGb(totalMbps: number, days: number, policies: Policies): { rawGb: number; requiredGb: number } {
  const rawGb = dailyGb(totalMbps, policies) * days;
  return { rawGb, requiredGb: rawGb * (1 + policies.storageHeadroomPct.value / 100) };
}

export function usableGb(capacityTb: number, count: number, policies: Policies): number {
  return capacityTb * count * 1000 * policies.hddUsableFraction.value;
}

export function isHdd(p: Product): p is HddProduct {
  return p.category === "hdd";
}

type DriveOption = { product: HddProduct; count: number; usable: number };

/**
 * Every drive arrangement this recorder can take, from the surveillance-rated drives in the
 * catalogue (any approved manufacturer). If the recorder has a documented drive list, only those.
 */
export function driveOptions(nvr: NvrProduct, products: Product[], policies: Policies, links: CompatibilityLink[] = []): DriveOption[] {
  const out: DriveOption[] = [];
  const listed = documentedDrives(nvr.id, links);
  for (const d of products.filter(isHdd)) {
    if (d.status === "deprecated" || !d.surveillanceRated || d.capacityTb > nvr.maxHddTb) continue;
    if (listed.size && !listed.has(d.id)) continue;
    for (let n = 1; n <= nvr.hddBays; n++) {
      if (d.capacityTb * n > nvr.maxTotalTb) break;
      out.push({ product: d, count: n, usable: usableGb(d.capacityTb, n, policies) });
    }
  }
  return out;
}

const trusted = (d: HddProduct) => (TRUSTED_STATUSES.includes(d.status) && d.price?.approved ? 0 : 1);

/** The smallest arrangement that meets the requirement: fewest drives, then least capacity, then cost. */
export function chooseDrives(requiredGb: number, nvr: NvrProduct, products: Product[], policies: Policies, links: CompatibilityLink[] = []): DriveOption | null {
  const fits = driveOptions(nvr, products, policies, links).filter((o) => o.usable >= requiredGb);
  fits.sort(
    (a, b) =>
      trusted(a.product) - trusted(b.product) ||
      a.count - b.count ||
      a.product.capacityTb * a.count - b.product.capacityTb * b.count ||
      (a.product.price?.costExGst ?? Infinity) * a.count - (b.product.price?.costExGst ?? Infinity) * b.count ||
      a.product.model.localeCompare(b.product.model),
  );
  return fits[0] ?? null;
}

/** The most storage this recorder can hold with catalogue drives. */
export function largestDrives(nvr: NvrProduct, products: Product[], policies: Policies, links: CompatibilityLink[] = []): DriveOption | null {
  const all = driveOptions(nvr, products, policies, links).sort((a, b) => b.usable - a.usable || a.count - b.count || trusted(a.product) - trusted(b.product) || a.product.model.localeCompare(b.product.model));
  return all[0] ?? null;
}

export function storagePlan(input: {
  /** Total design bitrate of the cameras (recording profile), Mbps. */
  totalMbps: number | null;
  customerRetentionDays?: number | null;
  retention?: { target: number; minimum: number; source: "customer" | "profile" | "policy" };
  nvr: NvrProduct | null;
  products: Product[];
  policies: Policies;
  links?: CompatibilityLink[];
  /** Why the total is unknown, when it is. */
  missingNote?: string;
}): StorageResult {
  const { policies } = input;
  const target = input.retention?.target ?? input.customerRetentionDays ?? policies.retentionTargetDays.value;
  const minimum = Math.min(target, input.retention?.minimum ?? policies.retentionMinimumDays.value);
  const base = {
    retentionTargetDays: target,
    retentionSource: input.retention?.source ?? ((input.customerRetentionDays ? "customer" : "policy") as "customer" | "policy"),
    headroomPct: policies.storageHeadroomPct.value,
  };
  if (input.totalMbps == null) {
    return {
      ...base,
      totalMbps: null,
      rawGb: null,
      requiredGb: null,
      drives: null,
      installedTb: null,
      expectedRetentionDays: null,
      status: "cannot_calculate",
      notes: [input.missingNote ?? "Design bitrates unknown: storage cannot be calculated."],
    };
  }
  const { rawGb, requiredGb } = requiredStorageGb(input.totalMbps, target, policies);
  const perDay = dailyGb(input.totalMbps, policies);
  const notes = [`${input.totalMbps.toFixed(1)} Mbps design bitrate x ${policies.gbPerMbpsDay.value} GB/day per Mbps x ${target} days = ${Math.round(rawGb)} GB, plus ${policies.storageHeadroomPct.value}% = ${Math.round(requiredGb)} GB.`];
  if (!input.nvr) return { ...base, totalMbps: input.totalMbps, rawGb, requiredGb, drives: null, installedTb: null, expectedRetentionDays: null, status: "cannot_calculate", notes: [...notes, "No recorder selected, so drives cannot be chosen."] };

  const pick = chooseDrives(requiredGb, input.nvr, input.products, input.policies, input.links);
  if (pick) {
    return {
      ...base,
      totalMbps: input.totalMbps,
      rawGb,
      requiredGb,
      drives: { product: pick.product, count: pick.count },
      installedTb: pick.product.capacityTb * pick.count,
      expectedRetentionDays: Math.floor(pick.usable / perDay),
      status: "meets_target",
      notes,
    };
  }
  const most = largestDrives(input.nvr, input.products, input.policies, input.links);
  if (!most) return { ...base, totalMbps: input.totalMbps, rawGb, requiredGb, drives: null, installedTb: null, expectedRetentionDays: null, status: "cannot_calculate", notes: [...notes, "No surveillance-rated drive in the catalogue fits this recorder."] };
  const days = Math.floor(most.usable / perDay);
  notes.push(
    days >= target
      ? `The most this recorder takes is ${most.count} x ${most.product.capacityTb} TB: about ${days} days, which reaches ${target} days but without the full ${policies.storageHeadroomPct.value}% safety allowance (${Math.round(requiredGb)} GB).`
      : `The most this recorder takes is ${most.count} x ${most.product.capacityTb} TB, about ${days} days. ${Math.round(requiredGb)} GB is needed for ${target} days: a recorder with more bays or larger drives, or lower bitrates, would be needed.`,
  );
  return {
    ...base,
    totalMbps: input.totalMbps,
    rawGb,
    requiredGb,
    drives: { product: most.product, count: most.count },
    installedTb: most.product.capacityTb * most.count,
    expectedRetentionDays: days,
    status: days >= minimum ? "below_target" : "below_minimum",
    notes,
  };
}

// ---------- residential ----------

export const RETENTION_LOW_WARNING = "Estimated retention is below the normal Get Secure target. Consider selecting a larger HDD.";

export type HddChoice = { capacityTb: number | null; productId: string | null; source: "default" | "override" | "manual_required"; note: string };

/** The residential drive: Chris's choice on the assessment, else the Get Secure default for the camera count. */
export function residentialHddChoice(input: { cameraCount: number; override?: EnquiryInput["hddOverride"]; products: Product[]; policies: Policies }): HddChoice {
  const o = input.override;
  if (o?.productId) {
    const d = input.products.find((p) => p.id === o.productId && isHdd(p)) as HddProduct | undefined;
    if (d) return { capacityTb: d.capacityTb, productId: d.id, source: "override", note: `HDD chosen by Chris: ${d.manufacturer} ${d.model} (${d.capacityTb} TB).` };
  }
  if (o?.capacityTb && o.capacityTb > 0) return { capacityTb: o.capacityTb, productId: null, source: "override", note: `HDD chosen by Chris: ${o.capacityTb} TB.` };
  const band = input.policies.residentialHddDefaults.value.find((b) => input.cameraCount >= b.minCameras && input.cameraCount <= b.maxCameras);
  if (band) return { capacityTb: band.capacityTb, productId: null, source: "default", note: `Default HDD for ${input.cameraCount} cameras: ${band.capacityTb} TB (Get Secure rule).` };
  return { capacityTb: null, productId: null, source: "manual_required", note: `No default HDD for ${input.cameraCount} camera(s): choose the HDD on the assessment.` };
}

/**
 * The drive model for a capacity: a surveillance-rated drive of exactly that capacity that the
 * recorder takes, preferring an approved price, then any supplier listing, then the model name.
 */
export function driveForCapacity(capacityTb: number, nvr: NvrProduct | null, products: Product[], links: CompatibilityLink[] = []): HddProduct | null {
  const listed = nvr ? documentedDrives(nvr.id, links) : new Set<string>();
  const fits = products
    .filter(isHdd)
    .filter((d) => d.status !== "deprecated" && d.surveillanceRated && d.capacityTb === capacityTb)
    .filter((d) => !nvr || (d.capacityTb <= nvr.maxHddTb && (!listed.size || listed.has(d.id))));
  const rank = (d: HddProduct) => (TRUSTED_STATUSES.includes(d.status) && d.price?.approved ? 0 : d.price || d.offers?.length ? 1 : 2);
  fits.sort((a, b) => rank(a) - rank(b) || (a.price?.costExGst ?? Infinity) - (b.price?.costExGst ?? Infinity) || a.model.localeCompare(b.model));
  return fits[0] ?? null;
}

/** "6 × 5MP cameras at 3 Mbps design bitrate" from the per-camera designs. */
export function bitrateBasis(designs: CameraDesign[]): string | null {
  if (!designs.length || designs.some((d) => d.designBitrateMbps == null)) return null;
  const groups = new Map<string, number>();
  for (const d of designs) {
    const k = `${d.resolutionMp}MP|${d.designBitrateMbps}`;
    groups.set(k, (groups.get(k) ?? 0) + 1);
  }
  return [...groups].map(([k, n]) => {
    const [mp, mbps] = k.split("|");
    return `${n} × ${mp} camera${n === 1 ? "" : "s"} at ${mbps} Mbps design bitrate`;
  }).join(" + ");
}

export function residentialStoragePlan(input: {
  choice: HddChoice;
  totalMbps: number | null;
  designs: CameraDesign[];
  retention: { target: number; minimum: number; source: "customer" | "profile" | "policy" };
  nvr: NvrProduct | null;
  products: Product[];
  policies: Policies;
  links?: CompatibilityLink[];
  missingNote?: string;
}): StorageResult {
  const { policies, choice } = input;
  const target = input.retention.target;
  const minimum = Math.min(target, input.retention.minimum);
  const base = { retentionTargetDays: target, retentionSource: input.retention.source, headroomPct: policies.storageHeadroomPct.value, advisory: true, selection: choice.source, basis: bitrateBasis(input.designs) };
  const notes = [choice.note];
  const empty = { totalMbps: input.totalMbps, rawGb: null, requiredGb: null, drives: null, installedTb: null, expectedRetentionDays: null, usableTb: null, warning: null };
  if (choice.capacityTb == null) return { ...base, ...empty, status: "cannot_calculate", notes };

  let drive: HddProduct | null = null;
  if (choice.productId) {
    const d = input.products.find((p) => p.id === choice.productId && isHdd(p)) as HddProduct | undefined;
    if (d && input.nvr && d.capacityTb > input.nvr.maxHddTb) notes.push(`${d.model} is larger than ${input.nvr.model} takes (${input.nvr.maxHddTb} TB per drive): choose another.`);
    else drive = d ?? null;
  } else {
    drive = driveForCapacity(choice.capacityTb, input.nvr, input.products, input.links);
    if (!drive) notes.push(input.nvr && choice.capacityTb > input.nvr.maxHddTb ? `${input.nvr.model} takes drives up to ${input.nvr.maxHddTb} TB: choose a smaller HDD.` : `No ${choice.capacityTb} TB surveillance drive in the catalogue for this recorder: add one or choose another HDD.`);
  }
  if (!drive) return { ...base, ...empty, status: "cannot_calculate", notes };

  const usable = usableGb(drive.capacityTb, 1, policies);
  const out = { ...base, drives: { product: drive, count: 1 }, installedTb: drive.capacityTb, usableTb: Math.round(usable / 10) / 100 };
  if (input.totalMbps == null) {
    return { ...out, totalMbps: null, rawGb: null, requiredGb: null, expectedRetentionDays: null, warning: null, status: "cannot_calculate", notes: [...notes, input.missingNote ?? "Design bitrates unknown: retention cannot be estimated."] };
  }
  const { rawGb, requiredGb } = requiredStorageGb(input.totalMbps, target, policies);
  const days = Math.floor(usable / dailyGb(input.totalMbps, policies));
  notes.push(`Estimated retention: ${input.totalMbps.toFixed(1)} Mbps x ${policies.gbPerMbpsDay.value} GB/day per Mbps against ${Math.round(usable)} GB usable = about ${days} days (reference target ${target} days).`);
  const status = days >= target ? "meets_target" : days >= minimum ? "below_target" : "below_minimum";
  return { ...out, totalMbps: input.totalMbps, rawGb, requiredGb, expectedRetentionDays: days, warning: status === "meets_target" ? null : RETENTION_LOW_WARNING, status, notes };
}
