/**
 * Step 1: what the customer wants, what we still need to know, and one camera requirement per
 * camera with its purpose. Nothing missing is invented: it is listed with the question that would
 * answer it and how much it matters.
 */
import type { CameraPurpose, CameraRequirement, EnquiryInput, MissingItem, Policies } from "./types";

const AREA_PURPOSES: [RegExp, CameraPurpose][] = [
  [/counter|register|till|\bpos\b|checkout/i, "cash_register"],
  [/loading|dock|bay/i, "loading_area"],
  [/front door|entrance|entry|door|porch|reception/i, "entrance_identification"],
  [/drive ?way|\bdrive\b/i, "driveway"],
  [/garage|carport|vehicle|car park|parking|\bcars?\b/i, "vehicle"],
  [/side|lane|gate|path|walkway|alley/i, "side_access"],
  [/back ?yard|rear|garden|deck|pool|patio|back of/i, "backyard"],
  [/perimeter|fence|boundary/i, "perimeter"],
  [/front ?yard|street|overview|front of|yard|lawn|warehouse|floor|office/i, "overview"],
];

export function purposeForArea(area: string): CameraPurpose {
  for (const [re, purpose] of AREA_PURPOSES) if (re.test(area)) return purpose;
  return "general";
}

/** One requirement per camera: from an explicit plan, else from the areas asked for, padded to the count. */
export function cameraPlan(input: EnquiryInput, policies: Policies): { cameras: CameraRequirement[]; notes: string[] } {
  const notes: string[] = [];
  const detailFor = (purpose: CameraPurpose) => policies.purposeDetail.value[purpose];
  const night = true; // Residential and commercial CCTV both record at night unless the enquiry says otherwise.

  if (input.cameraPlan?.length) {
    return {
      cameras: input.cameraPlan.map((c, i) => ({
        id: `cam${i + 1}`,
        purpose: c.purpose,
        targetArea: c.targetArea,
        requiredDetail: c.requiredDetail ?? detailFor(c.purpose),
        distanceM: c.distanceM ?? null,
        sceneWidthM: c.sceneWidthM ?? null,
        lighting: c.lighting ?? "unknown",
        analyticsRequired: c.analyticsRequired ?? input.analytics,
        nightRequired: c.nightRequired ?? night,
        mounting: c.mounting ?? input.mountingSurface,
      })),
      notes,
    };
  }

  const areas = input.areas.map((a) => a.trim()).filter(Boolean);
  const count = input.cameraCount ?? areas.length;
  if (!count) return { cameras: [], notes: ["No camera count or areas given."] };
  if (input.cameraCount && areas.length > input.cameraCount) {
    notes.push(`${areas.length} areas were mentioned but ${input.cameraCount} cameras asked for; confirm which areas matter most.`);
  }

  const cameras: CameraRequirement[] = [];
  for (let i = 0; i < count; i++) {
    const area = areas[i] ?? (areas.length ? "Additional coverage (position to confirm)" : "Position to confirm");
    const purpose = areas[i] ? purposeForArea(area) : "general";
    cameras.push({
      id: `cam${i + 1}`,
      purpose,
      targetArea: area,
      requiredDetail: detailFor(purpose),
      distanceM: null,
      sceneWidthM: null,
      lighting: "unknown",
      analyticsRequired: input.analytics,
      nightRequired: night,
      mounting: input.mountingSurface,
    });
  }
  if (count > areas.length) notes.push(`${count - areas.length} camera position(s) not described; placed as general coverage to confirm.`);
  return { cameras, notes };
}

export function requirementsSummary(input: EnquiryInput, mode: string): string[] {
  const out: string[] = [];
  const kind = input.propertyType ? (input.propertyType === "residential" ? "Residential" : "Commercial") : "Property type unknown";
  out.push(`${kind}${input.jobType ? `, ${input.jobType === "new" ? "new system" : input.jobType}` : ""}`);
  if (input.cameraCount) out.push(`${input.cameraCount} camera${input.cameraCount === 1 ? "" : "s"}${input.areas.length ? `: ${input.areas.join(", ")}` : ""}`);
  else if (input.areas.length) out.push(`Areas: ${input.areas.join(", ")}`);
  if (input.storeys) out.push(input.storeys === 1 ? "Single-storey" : input.storeys === 2 ? "Double-storey" : `${input.storeys}-storey`);
  if (input.address) out.push(`Site: ${input.address}`);
  out.push(`Recording: ${mode === "continuous" ? "24/7 continuous" : "motion"}${input.retentionDays ? ` (customer asked for ${input.retentionDays} days: custom requirement)` : ""}`);
  if (input.remoteViewing !== null) out.push(input.remoteViewing ? "Remote viewing on phone/app" : "No remote viewing needed");
  if (input.requestedBrand) out.push(`Brand asked for: ${input.requestedBrand}`);
  if (input.budget) out.push(`Budget mentioned: $${input.budget.toLocaleString("en-NZ")}`);
  if (input.analytics.length) out.push(`Analytics: ${input.analytics.join(", ")}`);
  if (input.siteVisitRequested) out.push("Customer asked for a site visit");
  if (input.urgency && input.urgency !== "normal") out.push(`Urgency: ${input.urgency}`);
  return out;
}

export function missingInformation(input: EnquiryInput): MissingItem[] {
  const m: MissingItem[] = [];
  if (!input.propertyType) m.push({ field: "propertyType", question: "Is this for a home or a business?", importance: "blocks_quote" });
  if (!input.cameraCount && !input.areas.length) m.push({ field: "cameraCount", question: "Roughly how many cameras, or which areas would you like covered?", importance: "blocks_quote" });
  if (!input.address) m.push({ field: "address", question: "What is the property address?", importance: "blocks_quote" });
  if (input.propertyType !== "commercial" && !input.storeys) m.push({ field: "storeys", question: "Is the house single or double storey?", importance: "affects_price" });
  if (input.remoteViewing === null) m.push({ field: "remoteViewing", question: "Would you like to view the cameras on your phone?", importance: "affects_price" });
  if (input.remoteViewing && input.internet === "unknown") m.push({ field: "internet", question: "Is there internet at the property?", importance: "affects_price" });
  if (input.remoteViewing && input.internet === "yes" && input.recorderNearRouter === "unknown") {
    m.push({ field: "recorderNearRouter", question: "Where is your internet router, and is there somewhere near it for the recorder?", importance: "nice_to_have" });
  }
  if (input.mountingSurface === "unknown") m.push({ field: "mountingSurface", question: "What are the outside walls (weatherboard, brick, concrete)?", importance: "nice_to_have" });
  if (!input.jobType) m.push({ field: "jobType", question: "Is this a new system or replacing an existing one?", importance: "nice_to_have" });

  if (input.propertyType === "commercial") {
    const c = input.commercial ?? {};
    if (c.futureCameras == null) m.push({ field: "futureCameras", question: "How many more cameras might you add over the next few years?", importance: "affects_price" });
    if (!c.surveillancePurpose) m.push({ field: "surveillancePurpose", question: "What is the CCTV for (theft, safety, incident review)?", importance: "affects_price" });
    if (!c.footageAccess) m.push({ field: "footageAccess", question: "Who will need access to the footage?", importance: "nice_to_have" });
  }
  return m;
}
