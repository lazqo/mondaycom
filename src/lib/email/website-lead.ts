/**
 * Website landing-page enquiries.
 *
 * The Get Secure site emails a structured notification for every form submission. Those arrive
 * from a `noreply@` address, which every sensible heuristic treats as automated junk, and the
 * customer's real details are in the body rather than the headers. So they are parsed here,
 * exactly, before any classifier sees them — no guessing, no AI, every field correct.
 *
 * The HTML is flattened to text before we see it, which glues labels to their values
 * ("ServiceCCTV Installation", "Address7 solo place manurewa"), so parsing splits on the known
 * label set rather than on punctuation.
 */
import type { ExtractedLead } from "@/lib/ai/types";

/**
 * The Get Secure website's sending address. It is never a person: it only ever carries enquiries,
 * so it must never be saved as a customer's email or used to match one.
 */
export const DEFAULT_WEBSITE_SENDER = "noreply@updates.getsecure.co.nz";

/**
 * Addresses whose mail is always a website enquiry. Comma-separated, case-insensitive. Falls back
 * to the Get Secure website's address when LEAD_SENDER_ADDRESSES is not set, so a server whose
 * .env predates the setting still recognises it.
 */
export function websiteLeadSenders(): string[] {
  const configured = (process.env.LEAD_SENDER_ADDRESSES ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return configured.length ? configured : [DEFAULT_WEBSITE_SENDER];
}

export function isWebsiteLeadSender(address: string | null | undefined): boolean {
  if (!address) return false;
  return websiteLeadSenders().includes(address.trim().toLowerCase());
}

/** Shown when someone tries to save the robot's address against a person. */
export const WEBSITE_SENDER_MESSAGE =
  "That is the website's sending address, not the customer's. Use the email written in the enquiry.";

/** An email address fit to store against a person: null for the website robot's address. */
export function personalEmail(address: string | null | undefined): string | null {
  const a = address?.trim();
  if (!a || isWebsiteLeadSender(a)) return null;
  return a;
}

/**
 * Labels the forms use. Longest first, so "Current Setup" wins over "Setup" and the scan below
 * never splits a longer label in half. Different landing pages use different subsets: the CCTV
 * page asks for Storeys and Cameras and calls the site "Address", the home page calls it
 * "Location". Anything unknown is simply not extracted rather than mis-read.
 */
const SUMMARY_LABELS = [
  "Current Setup",
  "Property",
  "Storeys",
  "Cameras",
  "Timeline",
  "Location",
  "Address",
  "Service",
  "Phone",
  "Email",
] as const;

/** Labels that name where the work is. */
const SITE_LABELS = ["Address", "Location"] as const;

const NZ_PHONE = /(?:\+64|0)[2-9]\d[\d\s-]{5,11}\d/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Read "Label value" pairs out of the flattened text.
 *
 * Each label's value runs until the next label starts. A label word can also appear *inside* a
 * value — "PropertyCommercial Property" — which shows up as a label with nothing after it. Those
 * are put back into the value they came from, otherwise Property would read as "Commercial".
 */
function splitLabels(text: string): Map<string, string> {
  const t = text.replace(/\r\n/g, "\n");
  const pattern = new RegExp(SUMMARY_LABELS.join("|"), "g");
  const hits = [...t.matchAll(pattern)];
  const pairs: { label: string; value: string }[] = [];

  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i];
    const from = hit.index! + hit[0].length;
    const to = i + 1 < hits.length ? hits[i + 1].index! : t.length;
    const value = t.slice(from, to);

    if (!value.trim() && pairs.length) {
      // This label is part of the previous value, not a field of its own.
      pairs[pairs.length - 1].value += hit[0] + value;
      continue;
    }
    pairs.push({ label: hit[0], value });
  }

  const out = new Map<string, string>();
  for (const { label, value } of pairs) {
    // A field never runs past its own line: "Service cctv" is followed by the Call back line and
    // the REQUEST SUMMARY heading, none of which belong to the service. Several fields can share
    // one line though ("TimelinethisweekLocationPonsonby"), which the label scan already split.
    const v = value.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
    // Keep the first occurrence; later ones are the "Call back / Reply" repeat.
    if (v && !out.has(label)) out.set(label, v);
  }
  return out;
}

/** "ISAPELA" on its own line near the top, or "...respond directly to Isapela." at the foot. */
function findName(text: string): string | null {
  const foot = text.match(/respond directly to\s+([A-Za-z][\w'’-]*(?:\s+[A-Za-z][\w'’-]*){0,2})\s*\.?/i);
  if (foot) return titleCase(foot[1].trim());
  for (const raw of text.split(/\n/).slice(0, 12)) {
    const line = raw.trim();
    if (!line || line.length > 60) continue;
    if (/^(new lead|request summary|call back|reply)\b/i.test(line)) continue;
    if (/[@:]|\d/.test(line)) continue;
    if (/^[A-Z][A-Za-z'’\- ]+$/.test(line) && line.split(/\s+/).length <= 4) return titleCase(line);
  }
  return null;
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** Tidy a label's value: drop the tel:/mailto: link text the HTML flattening leaves behind. */
function clean(value: string | undefined): string | null {
  if (!value) return null;
  const v = value
    .replace(/\b(?:tel|mailto|sms):\S*/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.,;]+$/, "");
  return v || null;
}

export type WebsiteLead = { extraction: ExtractedLead; fields: Record<string, string> };

/**
 * Parse a website enquiry. Returns null when the body does not look like one, so the caller can
 * fall back to the normal classifier.
 */
export function parseWebsiteLead(input: { subject: string; text: string; fromAddress: string }): WebsiteLead | null {
  const text = (input.text ?? "").replace(/\r\n/g, "\n");
  // Subjects vary by landing page: "New Lead · CCTV Landing" and
  // "[CCTV Landing] New Contact Form Submission from Anubhav Sharma" are both real.
  const looksRight =
    isWebsiteLeadSender(input.fromAddress) ||
    /new lead|contact form submission/i.test(input.subject) ||
    /new lead|request summary|sent from the get secure website/i.test(text);
  if (!looksRight) return null;

  const labelled = splitLabels(text);
  // A form always carries several labelled fields. Requiring that stops an ordinary email which
  // happens to say "new lead" from being read as a submission and given perfect confidence.
  if (labelled.size < 2) return null;

  // The enquirer's address is any address in the body that is not the sending robot.
  const sender = input.fromAddress.toLowerCase();
  const bodyEmails = [...new Set((text.match(EMAIL) ?? []).map((e) => e.trim()))].filter(
    (e) => e.toLowerCase() !== sender && !/^(noreply|no-reply|postmaster|mailer-daemon)@/i.test(e),
  );
  const email = clean(labelled.get("Email")) ?? bodyEmails[0] ?? null;

  const phoneField = clean(labelled.get("Phone"));
  const phone = phoneField?.match(NZ_PHONE)?.[0]?.trim() ?? phoneField ?? text.match(NZ_PHONE)?.[0]?.trim() ?? null;
  const service = clean(labelled.get("Service"));
  const address = SITE_LABELS.map((l) => clean(labelled.get(l))).find(Boolean) ?? null;
  const name = findName(text);

  // Everything the form collected, for the summary and the lead notes.
  const fields: Record<string, string> = {};
  for (const label of SUMMARY_LABELS) {
    const v = clean(labelled.get(label));
    if (v) fields[label] = v;
  }

  const detailOrder = ["Property", "Storeys", "Cameras", "Current Setup", "Timeline"] as const;
  const details = detailOrder.filter((k) => fields[k]).map((k) => `${k}: ${fields[k]}`);
  const summary = [
    `Website enquiry${service ? ` for ${service}` : ""}${address ? ` at ${address}` : ""}.`,
    details.join(" · "),
  ]
    .filter(Boolean)
    .join(" ")
    .trim();

  // Forms send either words ("As Soon As Possible") or slugs ("this-week"); treat them alike.
  const timeline = (fields["Timeline"] ?? "").toLowerCase().replace(/[-_]+/g, " ");
  const urgency: ExtractedLead["urgency"] = /asap|as soon as possible|urgent|immediately|emergency|today/.test(timeline)
    ? "urgent"
    : /week|soon|priority/.test(timeline)
      ? "high"
      : "normal";

  const extraction: ExtractedLead = {
    is_lead: true,
    confidence: 1,
    contact_name: name,
    company: null,
    email,
    phone,
    service,
    site_address: address,
    summary,
    urgency,
    next_action: phone ? `Call ${phone} to confirm details and book a site visit.` : "Reply to confirm details and book a site visit.",
    reason: "Submitted through the Get Secure website enquiry form.",
  };
  return { extraction, fields };
}
