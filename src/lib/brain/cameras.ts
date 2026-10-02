/**
 * Choosing a camera for each requirement from the catalogue.
 *
 * Resolution alone does not decide suitability. A candidate must meet the requirement's night,
 * backlight and analytics needs, and, when the distance or scene width is known, deliver the pixel
 * density its purpose calls for (IEC 62676-4). Among the cameras that pass, approved products with
 * an approved price come first, then the tier's brand order (e.g. VIGI first for Good), then
 * cameras whose bitrate and power are published, then the lowest cost, then the model name, so
 * the choice is repeatable.
 */
import type { CameraChoice, CameraProduct, CameraRequirement, Policies, Product, PropertyType, Tier } from "./types";
import { TRUSTED_STATUSES } from "./types";
import { familyOf } from "./pricing";

export function isCamera(p: Product): p is CameraProduct {
  return p.category === "camera";
}

/**
 * The bitrate to plan bandwidth and storage on: Get Secure's expected bitrate when set, otherwise
 * the manufacturer's maximum main-stream bitrate (conservative).
 */
export function planningBitrate(c: Pick<CameraProduct, "expectedBitrateMbps" | "maxBitrateMbps">): { mbps: number | null; basis: "expected" | "max_published" | null } {
  if (c.expectedBitrateMbps != null) return { mbps: c.expectedBitrateMbps, basis: "expected" };
  if (c.maxBitrateMbps != null) return { mbps: c.maxBitrateMbps, basis: "max_published" };
  return { mbps: null, basis: null };
}

/** Pixels per metre across the scene, if the scene width can be known. */
export function pixelDensity(camera: Pick<CameraProduct, "horizontalPixels" | "hfovDeg">, req: Pick<CameraRequirement, "distanceM" | "sceneWidthM">): number | null {
  const width = req.sceneWidthM ?? (req.distanceM != null ? 2 * req.distanceM * Math.tan(((camera.hfovDeg / 2) * Math.PI) / 180) : null);
  if (!width || width <= 0) return null;
  return camera.horizontalPixels / width;
}

export function cameraMeets(camera: CameraProduct, req: CameraRequirement, policies: Policies): { ok: boolean; reasons: string[]; ppm: number | null } {
  const reasons: string[] = [];
  let ok = true;
  if (req.nightRequired && !(camera.irRangeM && camera.irRangeM > 0) && !(camera.whiteLightRangeM && camera.whiteLightRangeM > 0) && !camera.colourNight) {
    ok = false;
    reasons.push("no night vision");
  }
  if (req.nightRequired && req.distanceM != null && camera.irRangeM != null && !camera.colourNight && camera.irRangeM < req.distanceM) {
    ok = false;
    reasons.push(`IR range ${camera.irRangeM} m is short of ${req.distanceM} m`);
  }
  if (req.lighting === "backlit" && !((camera.wdrDb ?? 0) >= policies.wdrRequiredDb.value)) {
    ok = false;
    reasons.push(`backlit scene needs ${policies.wdrRequiredDb.value} dB WDR`);
  }
  const missingAnalytics = req.analyticsRequired.filter((a) => !camera.analytics.includes(a));
  if (missingAnalytics.length) {
    ok = false;
    reasons.push(`lacks ${missingAnalytics.join(", ")}`);
  }
  const ppm = pixelDensity(camera, req);
  if (ppm != null) {
    const needed = policies.ppmThresholds.value[req.requiredDetail];
    if (ppm < needed) {
      ok = false;
      reasons.push(`${Math.round(ppm)} px/m is below the ${needed} px/m needed to ${req.requiredDetail}`);
    }
  }
  return { ok, reasons, ppm };
}

function ranker(brandOrder: string[]) {
  const order = brandOrder.map((b) => b.toLowerCase());
  const brandIdx = (p: CameraProduct) => {
    const i = order.indexOf(familyOf(p).toLowerCase());
    return i < 0 ? order.length : i;
  };
  const trusted = (p: CameraProduct) => (TRUSTED_STATUSES.includes(p.status) && p.price?.approved ? 0 : 1);
  // A camera whose bitrate and power are known can be validated end to end; prefer it.
  const gaps = (p: CameraProduct) => (planningBitrate(p).mbps == null ? 1 : 0) + (p.poeWatts == null ? 1 : 0);
  return (a: CameraProduct, b: CameraProduct) =>
    trusted(a) - trusted(b) ||
    brandIdx(a) - brandIdx(b) ||
    gaps(a) - gaps(b) ||
    (a.price?.costExGst ?? Infinity) - (b.price?.costExGst ?? Infinity) ||
    a.model.localeCompare(b.model);
}

/**
 * Cameras eligible for this job: allowed for this market and not deprecated. Residential cameras
 * must carry the tier being built; commercial jobs ignore the residential ladder entirely.
 */
export function candidateCameras(products: Product[], propertyType: PropertyType | null, tier: Tier | null): CameraProduct[] {
  return products.filter(isCamera).filter((c) => {
    if (c.status === "deprecated") return false;
    if (propertyType === "commercial") return c.commercialAllowed;
    if (!c.residentialAllowed) return false;
    return tier ? c.tier === tier : true;
  });
}

export function chooseCameras(requirements: CameraRequirement[], candidates: CameraProduct[], policies: Policies, brandOrder: string[] = []): CameraChoice[] {
  const rank = ranker(brandOrder);
  return requirements.map((req) => {
    const passing: { c: CameraProduct; ppm: number | null }[] = [];
    const rejected: string[] = [];
    for (const c of candidates) {
      const r = cameraMeets(c, req, policies);
      if (r.ok) passing.push({ c, ppm: r.ppm });
      else rejected.push(`${c.manufacturer} ${c.model}: ${r.reasons.join("; ")}`);
    }
    passing.sort((x, y) => rank(x.c, y.c));
    const best = passing[0];
    if (!best) {
      return {
        requirement: req,
        product: null,
        pixelDensity: null,
        reasons: candidates.length ? [`No catalogue camera meets this requirement.`, ...rejected] : ["No eligible camera in the catalogue for this tier."],
      };
    }
    const reasons: string[] = [];
    if (best.ppm != null) reasons.push(`${Math.round(best.ppm)} px/m at the stated distance (needs ${policies.ppmThresholds.value[req.requiredDetail]} to ${req.requiredDetail}).`);
    else reasons.push(`Distance not known: pixel density for "${req.requiredDetail}" not validated.`);
    if (!TRUSTED_STATUSES.includes(best.c.status)) reasons.push(`Product status is "${best.c.status}": needs approval before quoting.`);
    if (!best.c.price) reasons.push("No approved supplier price recorded.");
    else if (!best.c.price.approved) reasons.push("Supplier price not yet approved.");
    else if (best.c.price.freshness === "stale" || best.c.price.freshness === "unknown") reasons.push("Refresh supplier price before final quote approval.");
    return { requirement: req, product: best.c, pixelDensity: best.ppm, reasons };
  });
}
