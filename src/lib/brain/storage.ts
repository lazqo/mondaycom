/**
 * Storage is the HDD in the system, chosen, not calculated. In order:
 *
 *   1. Chris's HDD override on the assessment (a capacity or an exact drive),
 *   2. the approved kit's default HDD,
 *   3. residential only: the fallback by camera count (Get Secure rule), when no kit applies,
 *   4. otherwise the HDD has to be chosen.
 *
 * No retention is calculated or promised, and the drive is never resized or swapped for another
 * capacity because that one happens to have a price. A customer who needs a number of days is a
 * custom requirement: Chris picks a larger HDD or designs it.
 */
import type { CctvKit, CompatibilityLink, EnquiryInput, HddProduct, NvrProduct, Policies, Product, StorageResult } from "./types";
import { TRUSTED_STATUSES } from "./types";
import { documentedDrives } from "./compat";

export function isHdd(p: Product): p is HddProduct {
  return p.category === "hdd";
}

export type HddChoice = { capacityTb: number | null; productId: string | null; source: StorageResult["selection"]; note: string };

export function hddChoice(input: { cameraCount: number; residential: boolean; override?: EnquiryInput["hddOverride"]; kit: CctvKit | null; products: Product[]; policies: Policies }): HddChoice {
  const o = input.override;
  if (o?.productId) {
    const d = input.products.find((p) => p.id === o.productId && isHdd(p)) as HddProduct | undefined;
    if (d) return { capacityTb: d.capacityTb, productId: d.id, source: "override", note: `HDD chosen by Chris: ${d.manufacturer} ${d.model} (${d.capacityTb} TB).` };
  }
  if (o?.capacityTb && o.capacityTb > 0) return { capacityTb: o.capacityTb, productId: null, source: "override", note: `HDD chosen by Chris: ${o.capacityTb} TB.` };
  const k = input.kit;
  if (k && (k.defaultHddProductId || k.defaultHddTb)) {
    const d = k.defaultHddProductId ? (input.products.find((p) => p.id === k.defaultHddProductId && isHdd(p)) as HddProduct | undefined) : undefined;
    if (d) return { capacityTb: d.capacityTb, productId: d.id, source: "kit", note: `Kit HDD (${k.name}): ${d.manufacturer} ${d.model} (${d.capacityTb} TB).` };
    if (k.defaultHddTb) return { capacityTb: k.defaultHddTb, productId: null, source: "kit", note: `Kit HDD (${k.name}): ${k.defaultHddTb} TB.` };
  }
  if (input.residential) {
    const band = input.policies.residentialHddDefaults.value.find((b) => input.cameraCount >= b.minCameras && input.cameraCount <= b.maxCameras);
    if (band) return { capacityTb: band.capacityTb, productId: null, source: "fallback", note: `${k ? `Kit ${k.name} has no default HDD; ` : "No approved kit; "}fallback for ${input.cameraCount} cameras: ${band.capacityTb} TB.` };
  }
  return { capacityTb: null, productId: null, source: "required", note: `HDD selection required: ${k ? `kit ${k.name} has no default HDD` : "no approved kit"}${input.residential ? ` and no fallback for ${input.cameraCount} camera(s)` : ""}.` };
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

export function storagePlan(input: { choice: HddChoice; nvr: NvrProduct | null; products: Product[]; links?: CompatibilityLink[]; customerRetentionDays: number | null }): StorageResult {
  const { choice, nvr } = input;
  const notes = [choice.note];
  const base = { selection: choice.source, capacityTb: choice.capacityTb, customerRetentionDays: input.customerRetentionDays };
  if (input.customerRetentionDays)
    notes.push(`The customer asked for ${input.customerRetentionDays} days of recording: a custom requirement. Choose an HDD to suit (no retention is calculated).`);
  if (choice.capacityTb == null) return { ...base, drives: null, installedTb: null, notes };
  let drive: HddProduct | null = null;
  if (choice.productId) {
    const d = input.products.find((p) => p.id === choice.productId && isHdd(p)) as HddProduct | undefined;
    if (d && nvr && d.capacityTb > nvr.maxHddTb) notes.push(`${d.model} is larger than ${nvr.model} takes (${nvr.maxHddTb} TB per drive): choose another.`);
    else drive = d ?? null;
  } else {
    drive = driveForCapacity(choice.capacityTb, nvr, input.products, input.links);
    if (!drive)
      notes.push(
        nvr && choice.capacityTb > nvr.maxHddTb
          ? `${nvr.model} takes drives up to ${nvr.maxHddTb} TB: choose a smaller HDD.`
          : `No ${choice.capacityTb} TB surveillance drive in the catalogue for this recorder: add one, or choose another HDD.`,
      );
  }
  return { ...base, drives: drive ? { product: drive, count: 1 } : null, installedTb: drive ? drive.capacityTb : null, notes };
}
