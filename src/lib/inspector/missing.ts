/**
 * What is still missing, and whether it actually matters yet. A blank field is not a reason to ask
 * the customer anything: only information without which we cannot safely decide, price or proceed
 * is blocking. Pure.
 */
import type { FactKey, MissingInfo, Understanding } from "./types";

export type Known = Partial<Record<FactKey, string | number | boolean>>;

const has = (k: Known, key: FactKey) => k[key] !== undefined && k[key] !== null && k[key] !== "";

/**
 * Merge what this source says with what the CRM already knows (the CRM's applied facts and the
 * lead's own fields). The source wins only where the CRM has nothing.
 */
export function knownFrom(u: Understanding, crm: Known): Known {
  const out: Known = { ...crm };
  for (const f of u.facts) if (!has(out, f.key)) out[f.key] = f.value;
  if (u.service && !has(out, "service")) out.service = u.service;
  if (u.propertyType && !has(out, "property_type")) out.property_type = u.propertyType;
  return out;
}

/** The route the evidence points to, by Get Secure's fixed rules (not AI). */
export function sitePath(u: Understanding, known: Known): { siteVisit: boolean; rule: string | null; reason: string | null } {
  if (known.service === "cctv" && known.property_type === "commercial") return { siteVisit: true, rule: "commercial_cctv_site_visit", reason: "Commercial CCTV is always designed from a site visit." };
  if (known.site_visit_requested === true || u.intents.includes("site_visit_request")) return { siteVisit: true, rule: "explicit_site_visit_request", reason: "The customer asked for a site visit." };
  return { siteVisit: false, rule: null, reason: null };
}

export function computeMissing(u: Understanding, known: Known): MissingInfo[] {
  const out: MissingInfo[] = [];
  const quoteish = u.intents.some((i) => ["new_enquiry", "quote_request", "quote_change"].includes(i));
  const svc = known.service ?? u.service;
  if (!svc && quoteish) out.push({ field: "service", label: "What they want (CCTV, alarm, access…)", blocking: true, for: "quote", reason: "Without the service the enquiry cannot be routed." });

  const path = sitePath(u, known);
  if (svc === "cctv" && quoteish && !path.siteVisit) {
    if (!has(known, "property_type")) out.push({ field: "property_type", label: "Home or business", blocking: true, for: "quote", reason: "Residential or commercial decides the design, and commercial needs a site visit." });
    if (!has(known, "camera_count") && !has(known, "areas")) out.push({ field: "camera_count", label: "How many cameras, or which areas to cover", blocking: true, for: "quote", reason: "The system cannot be sized without it." });
    if (known.property_type !== "commercial" && !has(known, "storeys")) out.push({ field: "storeys", label: "Single or double storey", blocking: true, for: "quote", reason: "The installation package (labour) depends on it." });
    if (known.job_type === "upgrade" && !has(known, "existing_cabling")) out.push({ field: "existing_cabling", label: "Existing cable type and condition", blocking: true, for: "quote", reason: "Existing cabling must be confirmed before upgrade labour savings can be applied." });
    if (!has(known, "site_address")) out.push({ field: "site_address", label: "Site address", blocking: false, for: "quote", reason: "Useful, but the quote does not depend on it." });
    if (!has(known, "remote_viewing")) out.push({ field: "remote_viewing", label: "Viewing on the phone", blocking: false, for: "quote", reason: "Assumed; every system includes app viewing." });
  }
  if (path.siteVisit && !has(known, "site_address")) out.push({ field: "site_address", label: "Site address", blocking: true, for: "site visit", reason: "A visit cannot be arranged without the address." });
  if (u.intents.includes("booking_request") && !has(known, "site_address")) out.push({ field: "site_address", label: "Site address", blocking: true, for: "booking", reason: "A booking needs the address." });
  if (!has(known, "phone") && has(known, "email")) out.push({ field: "phone", label: "Phone number", blocking: false, for: "contact", reason: "Email is enough to reply." });
  if (!has(known, "budget") && quoteish) out.push({ field: "budget", label: "Budget", blocking: false, for: "quote", reason: "Not needed: tiers cover the range." });
  // de-duplicate by field, keeping blocking
  const seen = new Map<string, MissingInfo>();
  for (const m of out) {
    const prev = seen.get(m.field);
    if (!prev || (m.blocking && !prev.blocking)) seen.set(m.field, m);
  }
  return [...seen.values()];
}

const INTENT_LABEL: Record<string, string> = {
  new_enquiry: "new enquiry",
  quote_request: "wants a quote",
  site_visit_request: "asked for a site visit",
  booking_request: "wants to book a time",
  question: "asked a question",
  quote_change: "wants the quote changed",
  acceptance: "accepted",
  objection: "raised an objection",
  service_issue: "has a problem with an existing system",
  follow_up: "is following up",
  information: "sent information",
  not_relevant: "nothing to act on",
};

/** One plain line for the timeline. */
export function summarise(u: Understanding, who: string | null): string {
  const svc = u.service ? { cctv: "CCTV", alarm: "alarm", access_control: "access control", intercom: "intercom", networking: "networking", other: "" }[u.service] : null;
  const head = [who, svc ? `${u.propertyType ? `${u.propertyType} ` : ""}${svc}` : null, INTENT_LABEL[u.primaryIntent]].filter(Boolean).join(" · ");
  const bits: string[] = [];
  const f = (k: string) => u.facts.find((x) => x.key === k)?.display;
  for (const k of ["camera_count", "areas", "storeys", "job_type", "site_address", "timing", "budget"]) if (f(k)) bits.push(f(k)!);
  if (u.objections.length) bits.push(`objection: ${u.objections.map((o) => o.kind).join(", ")}`);
  if (u.commitments.length) bits.push(`${u.commitments.length} commitment${u.commitments.length > 1 ? "s" : ""}`);
  const blocking = u.missing.filter((m) => m.blocking);
  if (blocking.length) bits.push(`blocking: ${blocking.map((m) => m.label.toLowerCase()).join("; ")}`);
  return `${head}${bits.length ? `. ${bits.join("; ")}` : ""}`;
}
