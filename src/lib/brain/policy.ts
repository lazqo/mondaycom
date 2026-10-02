/**
 * Business Brain policies and their provenance.
 *
 * Every number the engine relies on lives here with where it came from. Values Chris set out in the
 * Business Brain v0.1 brief are `getsecure_approved`; published standards are `industry_fact`; a
 * value that had to exist for the engine to run but has not been set by Get Secure is
 * `getsecure_provisional` or `requires_review`, and any packet that leans on it says so.
 *
 * These are defaults. The database copy (Settings → Business Brain) overrides them once edited.
 */
import type { KnowledgeStatus, Policies, PolicyValue } from "./types";

const BRIEF = "Get Secure CCTV Business Brain v0.1 (Chris)";
const BRIEF_DATE = "2026-10-02";

function p<T>(value: T, status: KnowledgeStatus, source: string, notes?: string, sourceUrl?: string): PolicyValue<T> {
  return { value, status, source, sourceUrl: sourceUrl ?? null, createdAt: BRIEF_DATE, reviewedAt: null, approvedBy: status === "getsecure_approved" ? "Chris" : null, confidence: null, notes: notes ?? null };
}

export const DEFAULT_POLICIES: Policies = {
  labourRateResidential: p(95, "getsecure_approved", BRIEF, "Internal reference rate, NZD/hour. Residential prices use installation packages, not hours x rate."),
  labourRateCommercial: p(110, "getsecure_approved", BRIEF, "Internal reference rate, NZD/hour."),
  labourCostRate: p(null, "requires_review", "Not set", "Internal cost of labour per hour. Until set, gross profit does not deduct labour."),
  retentionTargetDays: p(28, "getsecure_approved", BRIEF),
  retentionMinimumDays: p(14, "getsecure_approved", BRIEF),
  residentialDefaultRecording: p("continuous", "getsecure_approved", BRIEF, "24/7 continuous recording."),
  gbPerMbpsDay: p(10.8, "industry_fact", "1 Mbps x 86,400 s / 8 bits = 10.8 GB per day (decimal GB)."),
  storageHeadroomPct: p(10, "getsecure_provisional", "Placeholder", "Safety allowance on calculated storage. Brief says configurable; value not yet set by Get Secure."),
  hddUsableFraction: p(0.93, "getsecure_provisional", "Placeholder", "Usable share of a drive's marketed (decimal) capacity after formatting. Check against real recorders."),
  gstRate: p(0.15, "industry_fact", "NZ GST rate 15%", undefined, "https://www.ird.govt.nz/gst"),
  suggestedMarkupPct: p(25, "getsecure_provisional", BRIEF, "Brief: 20-30% product markup, lower % on higher-value hardware; exact thresholds not approved. Midpoint used as a suggestion only."),
  markupRangePct: p([20, 30], "getsecure_approved", BRIEF),
  residentialSmallRecorderChannels: p({ maxCameras: 4, channels: 4 }, "getsecure_approved", BRIEF, "2-4 cameras: 4-channel recorder when all technical checks pass. No automatic upsell to 8."),
  ppmThresholds: p(
    { detect: 25, observe: 62.5, recognise: 125, identify: 250 },
    "industry_fact",
    "IEC 62676-4 operational requirement pixel densities (pixels per metre)",
    "Used to validate a camera choice when the distance or scene width is known; not a rule that a megapixel count gives identification.",
  ),
  purposeDetail: p(
    {
      overview: "observe",
      driveway: "observe",
      entrance_identification: "identify",
      vehicle: "recognise",
      side_access: "observe",
      backyard: "observe",
      cash_register: "identify",
      loading_area: "observe",
      perimeter: "detect",
      general: "observe",
    },
    "getsecure_provisional",
    "Engine default",
    "Detail level assumed for each camera purpose when the enquiry does not say. Review.",
  ),
  wdrRequiredDb: p(120, "getsecure_provisional", "Engine default", "True WDR rating required for backlit scenes such as entrances facing daylight."),
  standardMaterials: p(
    { sellExGst: null, costExGst: null, contents: ["Normal Cat6 allowance", "Standard fixings", "Connectors", "Normal installation consumables"] },
    "requires_review",
    BRIEF,
    "Brief defines the contents; the dollar value has not been set. Until it is, residential quotes are incomplete.",
  ),
  junctionBoxSurfaces: p(["brick", "concrete"], "getsecure_provisional", BRIEF, "Junction box recommended on these surfaces; Chris confirms each one in v1 and it is not charged until approved."),
  doubleStoreyConduit: p(true, "getsecure_approved", BRIEF, "Double-storey: conduit/material allowance normally considered."),
  priceStaleDays: p(30, "getsecure_provisional", "Engine default", "A supplier price older than this lowers pricing confidence."),
  priceChangeReviewPct: p(5, "getsecure_provisional", BRIEF, "A supplier cost moving more than this is held for review instead of changing quote pricing. Threshold not yet set by Get Secure."),
  defaultResidentialTier: p(null, "requires_review", "Not set", "No default tier. The packet shows every tier and asks Chris to choose."),
  tiers: p(
    {
      good: { targetMp: 4, brands: ["TP-Link VIGI"] },
      better: { targetMp: 6, brands: ["HiLook", "Dahua"] },
      best: { targetMp: 8, brands: ["Hikvision"] },
      premium: { targetMp: null, brands: ["Ajax"] },
    },
    "getsecure_provisional",
    BRIEF,
    "Price/value tiers. HiLook catalogue naming, QVT and other brands to be verified before approval.",
  ),
  commercialSiteVisitMandatory: p(true, "getsecure_approved", BRIEF),
  audioDefault: p(
    false,
    "industry_fact",
    "NZ Privacy Commissioner CCTV guidance: collect only what is necessary; audio is more intrusive and generally avoided where video is enough.",
  ),
};

export const POLICY_KEYS = Object.keys(DEFAULT_POLICIES) as (keyof Policies)[];

export const POLICY_DESCRIPTIONS: Record<keyof Policies, string> = {
  labourRateResidential: "Residential labour reference rate (NZD/hour)",
  labourRateCommercial: "Commercial labour reference rate (NZD/hour)",
  labourCostRate: "Internal labour cost per hour (for gross profit)",
  retentionTargetDays: "Recording retention target (days)",
  retentionMinimumDays: "Recording retention minimum (days)",
  residentialDefaultRecording: "Residential default recording mode",
  gbPerMbpsDay: "Storage per Mbps per day (GB)",
  storageHeadroomPct: "Storage safety allowance (%)",
  hddUsableFraction: "Usable share of drive capacity",
  gstRate: "GST rate",
  suggestedMarkupPct: "Suggested product markup (%)",
  markupRangePct: "Product markup range (%)",
  residentialSmallRecorderChannels: "Small residential system recorder size",
  ppmThresholds: "Pixel density per detail level (px/m)",
  purposeDetail: "Detail level assumed per camera purpose",
  wdrRequiredDb: "WDR needed for backlit scenes (dB)",
  standardMaterials: "Residential standard materials allowance",
  junctionBoxSurfaces: "Surfaces that call for a junction box",
  doubleStoreyConduit: "Double-storey conduit allowance",
  priceStaleDays: "Days before a supplier price is stale",
  priceChangeReviewPct: "Supplier price change that needs review (%)",
  defaultResidentialTier: "Default residential tier",
  tiers: "Residential tiers and brand families",
  commercialSiteVisitMandatory: "Commercial CCTV needs a site visit",
  audioDefault: "Audio recording on by default",
};

/** Merge stored policies over the defaults. Unknown keys are ignored. */
export function mergePolicies(stored: Partial<Record<keyof Policies, PolicyValue<unknown>>>): Policies {
  const out = { ...DEFAULT_POLICIES } as Record<string, PolicyValue<unknown>>;
  for (const key of POLICY_KEYS) {
    const s = stored[key];
    if (s) out[key] = s;
  }
  return out as unknown as Policies;
}
