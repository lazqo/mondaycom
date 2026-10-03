/**
 * The Inspector's bridge to the Business Brain. The Brain is unchanged: it still designs and
 * prices from an EnquiryInput by its own rules. This only fills that input with the facts Chris
 * (or the Inspector, into blank fields) has applied for the lead, each traceable to its source.
 */
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { facts } from "@/db/schema";
import { enquiryFromLead } from "@/lib/brain/store";
import type { EnquiryInput } from "@/lib/brain/types";

export async function enquiryWithFacts(leadId: string): Promise<EnquiryInput | null> {
  const base = await enquiryFromLead(leadId);
  if (!base) return null;
  const rows = await db.query.facts.findMany({ where: and(eq(facts.leadId, leadId), eq(facts.state, "applied")), orderBy: [desc(facts.createdAt)] });
  const v = new Map<string, string | number | boolean>();
  for (const f of rows) if (!v.has(f.key)) v.set(f.key, f.value);
  const out: EnquiryInput = { ...base };
  const pt = v.get("property_type");
  if (pt === "residential" || pt === "commercial") out.propertyType = pt;
  const jt = v.get("job_type");
  if (jt === "new" || jt === "upgrade" || jt === "repair") out.jobType = jt;
  if (typeof v.get("camera_count") === "number") out.cameraCount = v.get("camera_count") as number;
  if (typeof v.get("storeys") === "number") out.storeys = v.get("storeys") as number;
  if (typeof v.get("areas") === "string" && !out.areas.length) out.areas = String(v.get("areas")).split(/,\s*/).map((a) => a[0].toUpperCase() + a.slice(1));
  if (typeof v.get("site_address") === "string" && !out.address) out.address = String(v.get("site_address"));
  if (v.get("remote_viewing") === true) out.remoteViewing = true;
  if (v.get("site_visit_requested") === true) out.siteVisitRequested = true;
  // Existing cabling is only ever what the customer said; condition stays unknown until checked,
  // so the Brain will not assume reusable cable (and cheaper upgrade labour).
  const cab = v.get("existing_cabling");
  if (out.jobType === "upgrade" && (cab === "cat5e" || cab === "cat6" || cab === "coax")) {
    out.existing = { systemType: cab === "coax" ? "analogue_coax" : "ip_poe", recorder: null, cameraCount: null, cableType: cab, cableCondition: "unknown", locationsSuitable: "unknown", power: null, ...(out.existing ?? {}) };
  }
  return out;
}
