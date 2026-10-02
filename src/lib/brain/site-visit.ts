/**
 * Remote quote or site visit. Hard rules first: any one of them makes a visit required. Without
 * one, a remote quote is allowed, with a confidence that reflects what could not be seen.
 */
import type { EnquiryInput, Level, Policies } from "./types";

export function siteVisitDecision(input: EnquiryInput, policies: Policies): { required: boolean; reasons: string[]; remoteQuoteConfidence: Level } {
  const reasons: string[] = [];
  if (input.siteVisitRequested) reasons.push("The customer asked for a site visit.");
  if (input.propertyType === "commercial" && policies.commercialSiteVisitMandatory.value) reasons.push("Commercial CCTV always needs a site visit.");
  if (!input.address) reasons.push("No address, so the property cannot be assessed remotely.");
  if (input.remoteAssessable === "no") reasons.push("The property cannot be assessed from aerial or street imagery.");
  if (input.accessUnclear) reasons.push("Construction or cable access is unclear enough to change the scope.");
  if (input.customSystem) reasons.push("Unusual or custom system; a remote estimate would not be reliable.");

  if (reasons.length) return { required: true, reasons, remoteQuoteConfidence: "low" };

  // Remote quote allowed. Lower confidence for anything that had to be assumed.
  let level: Level = "high";
  const softer: string[] = [];
  if (input.remoteAssessable === "unknown") softer.push("Remote imagery not yet checked.");
  if ((input.storeys ?? 1) >= 2) softer.push("Double-storey: cable routes assumed.");
  if (input.construction !== "standard") softer.push("Construction not confirmed as standard.");
  if (input.mountingSurface === "unknown") softer.push("Wall surfaces not known.");
  if (softer.length >= 2) level = "medium";
  if (softer.length >= 1 && level === "high") level = "medium";
  if (input.remoteAssessable === "unknown" && softer.length >= 3) level = "low";
  return { required: false, reasons: softer.length ? softer : ["Residential, address known, standard scope: remote quote possible."], remoteQuoteConfidence: level };
}
