/**
 * The website enquiry form's structured fields as Business Brain inputs. Pure: the Brain's own
 * input builder (store.ts enquiryFromLead) and the Hermes invariants (src/lib/hermes/invariants.ts)
 * read a form the same way, so what the form supplies always reaches the Brain.
 */
import type { EnquiryInput } from "./types";

export function enquiryFromForm(fields: Record<string, string>): Pick<EnquiryInput, "propertyType" | "jobType" | "cameraCount" | "storeys" | "address"> {
  const f = fields;
  const property = (f["Property"] ?? "").toLowerCase();
  const storeys = (f["Storeys"] ?? "").toLowerCase();
  const setup = (f["Current Setup"] ?? "").toLowerCase();
  const cams = Number((f["Cameras"] ?? "").match(/\d+/)?.[0] ?? NaN);
  return {
    propertyType: /commercial|business|office|shop|warehouse|retail/.test(property) ? "commercial" : /residential|home|house/.test(property) ? "residential" : null,
    jobType: /upgrade|replace|existing/.test(setup) ? "upgrade" : /repair|fault|not working/.test(setup) ? "repair" : /new/.test(setup) ? "new" : null,
    cameraCount: Number.isFinite(cams) && cams > 0 ? cams : null,
    storeys: /double|two|2/.test(storeys) ? 2 : /single|one|1/.test(storeys) ? 1 : null,
    address: f["Address"] ?? f["Location"] ?? null,
  };
}

/** An enquiry with nothing known yet (every unknown left unknown: the Brain never guesses one). */
export function blankEnquiry(): EnquiryInput {
  return {
    propertyType: null,
    jobType: null,
    cameraCount: null,
    areas: [],
    storeys: null,
    address: null,
    recordingMode: null,
    retentionDays: null,
    remoteViewing: null,
    internet: "unknown",
    recorderNearRouter: "unknown",
    wiredRoutePossible: "unknown",
    requestedBrand: null,
    budget: null,
    siteVisitRequested: false,
    urgency: null,
    remoteAssessable: "unknown",
    construction: "unknown",
    accessUnclear: false,
    customSystem: false,
    mountingSurface: "unknown",
    analytics: [],
    audioRequested: false,
    message: null,
  };
}
