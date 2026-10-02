/**
 * Storage: calculated from bitrate and retention, never from a camera-count table.
 *
 *   storage = total average bitrate x seconds recorded
 *   1 Mbps continuous = 10.8 GB/day, so GB = total Mbps x 10.8 x days, plus a safety allowance.
 *
 * Drives are then chosen from the catalogue within the recorder's limits (bays, largest drive,
 * total). If the target cannot be reached the shortfall is reported, never quietly accepted.
 */
import type { HddProduct, NvrProduct, Policies, Product, StorageResult } from "./types";
import { TRUSTED_STATUSES } from "./types";

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

/** Every drive arrangement this recorder can take, from the surveillance-rated drives in the catalogue. */
export function driveOptions(nvr: NvrProduct, products: Product[], policies: Policies): DriveOption[] {
  const out: DriveOption[] = [];
  for (const d of products.filter(isHdd)) {
    if (d.status === "deprecated" || !d.surveillanceRated || d.capacityTb > nvr.maxHddTb) continue;
    for (let n = 1; n <= nvr.hddBays; n++) {
      if (d.capacityTb * n > nvr.maxTotalTb) break;
      out.push({ product: d, count: n, usable: usableGb(d.capacityTb, n, policies) });
    }
  }
  return out;
}

const trusted = (d: HddProduct) => (TRUSTED_STATUSES.includes(d.status) && d.price?.approved ? 0 : 1);

/** The smallest arrangement that meets the requirement: fewest drives, then least capacity, then cost. */
export function chooseDrives(requiredGb: number, nvr: NvrProduct, products: Product[], policies: Policies): DriveOption | null {
  const fits = driveOptions(nvr, products, policies).filter((o) => o.usable >= requiredGb);
  fits.sort(
    (a, b) =>
      trusted(a.product) - trusted(b.product) ||
      a.count - b.count ||
      a.product.capacityTb * a.count - b.product.capacityTb * b.count ||
      (a.product.price?.costExGst ?? Infinity) * a.count - (b.product.price?.costExGst ?? Infinity) * b.count,
  );
  return fits[0] ?? null;
}

/** The most storage this recorder can hold with catalogue drives. */
export function largestDrives(nvr: NvrProduct, products: Product[], policies: Policies): DriveOption | null {
  const all = driveOptions(nvr, products, policies).sort((a, b) => b.usable - a.usable || a.count - b.count);
  return all[0] ?? null;
}

export function storagePlan(input: {
  totalMbps: number | null;
  customerRetentionDays: number | null;
  nvr: NvrProduct | null;
  products: Product[];
  policies: Policies;
}): StorageResult {
  const { policies } = input;
  const target = input.customerRetentionDays ?? policies.retentionTargetDays.value;
  const minimum = Math.min(target, policies.retentionMinimumDays.value);
  const base = {
    retentionTargetDays: target,
    retentionSource: (input.customerRetentionDays ? "customer" : "policy") as "customer" | "policy",
    headroomPct: policies.storageHeadroomPct.value,
  };
  if (input.totalMbps == null) {
    return { ...base, totalMbps: null, rawGb: null, requiredGb: null, drives: null, installedTb: null, expectedRetentionDays: null, status: "cannot_calculate", notes: ["Camera bitrates unknown: storage cannot be calculated."] };
  }
  const { rawGb, requiredGb } = requiredStorageGb(input.totalMbps, target, policies);
  const perDay = dailyGb(input.totalMbps, policies);
  const notes = [`${input.totalMbps.toFixed(1)} Mbps total x ${policies.gbPerMbpsDay.value} GB/day per Mbps x ${target} days = ${Math.round(rawGb)} GB, plus ${policies.storageHeadroomPct.value}% = ${Math.round(requiredGb)} GB.`];
  if (!input.nvr) return { ...base, totalMbps: input.totalMbps, rawGb, requiredGb, drives: null, installedTb: null, expectedRetentionDays: null, status: "cannot_calculate", notes: [...notes, "No recorder selected, so drives cannot be chosen."] };

  const pick = chooseDrives(requiredGb, input.nvr, input.products, input.policies);
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
  const most = largestDrives(input.nvr, input.products, input.policies);
  if (!most) return { ...base, totalMbps: input.totalMbps, rawGb, requiredGb, drives: null, installedTb: null, expectedRetentionDays: null, status: "cannot_calculate", notes: [...notes, "No surveillance-rated drive in the catalogue fits this recorder."] };
  const days = Math.floor(most.usable / perDay);
  notes.push(
    `The most this recorder takes is ${most.count} x ${most.product.capacityTb} TB, about ${days} days. ${Math.round(requiredGb)} GB is needed for ${target} days: a recorder with more bays or larger drives, or lower bitrates, would be needed.`,
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
