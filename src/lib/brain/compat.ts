/**
 * Compatibility between products, from documented relationships first.
 *
 * A camera works with a recorder when the relationship is documented, when the recorder is the
 * same family (or its manufacturer lists the camera's family), or, failing those, when both claim
 * a common ONVIF profile, which covers streaming and basic events but not every proprietary
 * analytic. Accessories (junction boxes, brackets) and kit contents come only from documented links.
 */
import type { CameraProduct, CompatibilityKind, CompatibilityLink, NvrProduct, Product } from "./types";
import { familyOf } from "./pricing";

export type NvrBasis = "documented" | "family" | "onvif";

const lower = (s: string) => s.trim().toLowerCase();

/** Do these two products share an ONVIF profile both claim (S for streaming, T for H.265/advanced)? */
export function onvifCompatible(a: { onvifProfiles?: string[] }, b: { onvifProfiles?: string[] }): string[] {
  const x = new Set((a.onvifProfiles ?? []).map((p) => p.toUpperCase()));
  return (b.onvifProfiles ?? []).map((p) => p.toUpperCase()).filter((p) => x.has(p) && (p === "S" || p === "T"));
}

export function linked(links: CompatibilityLink[], kind: CompatibilityKind, a: string, b: string): boolean {
  return links.some((l) => l.kind === kind && l.status !== "deprecated" && ((l.fromId === a && l.toId === b) || (l.fromId === b && l.toId === a)));
}

export function cameraNvrBasis(camera: CameraProduct, nvr: NvrProduct, links: CompatibilityLink[]): { basis: NvrBasis | null; profiles: string[] } {
  if (linked(links, "camera_nvr", camera.id, nvr.id)) return { basis: "documented", profiles: [] };
  const fam = lower(familyOf(camera));
  if (lower(familyOf(nvr)) === fam || (nvr.compatibleFamilies ?? []).some((f) => lower(f) === fam)) return { basis: "family", profiles: [] };
  const profiles = onvifCompatible(camera, nvr);
  return { basis: profiles.length ? "onvif" : null, profiles };
}

/** Products documented as going with this one, for a kind of link (e.g. its junction boxes). */
export function relatedProducts(id: string, kind: CompatibilityKind, links: CompatibilityLink[], products: Product[]): { product: Product; quantity: number }[] {
  const byId = new Map(products.map((p) => [p.id, p]));
  return links
    .filter((l) => l.kind === kind && l.fromId === id && l.status !== "deprecated")
    .map((l) => ({ product: byId.get(l.toId), quantity: l.quantity }))
    .filter((x): x is { product: Product; quantity: number } => !!x.product && x.product.status !== "deprecated");
}

/** Drives a recorder is documented to take. Empty means no list was published: any suitable drive. */
export function documentedDrives(nvrId: string, links: CompatibilityLink[]): Set<string> {
  return new Set(links.filter((l) => l.kind === "nvr_hdd" && l.fromId === nvrId && l.status !== "deprecated").map((l) => l.toId));
}

export const ACCESSORY_KINDS: CompatibilityKind[] = ["camera_junction_box", "camera_wall_bracket", "camera_pole_bracket"];
