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

/** Addresses whose mail is always a website enquiry. Comma-separated, case-insensitive. */
export function websiteLeadSenders(): string[] {
  return (process.env.LEAD_SENDER_ADDRESSES ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isWebsiteLeadSender(address: string): boolean {
  return websiteLeadSenders().includes(address.trim().toLowerCase());
}

/** Labels used in the REQUEST SUMMARY block, longest first so "Current Setup" wins over "Setup". */
const SUMMARY_LABELS = [
  "Current Setup",
  "Property",
  "Storeys",
  "Cameras",
  "Timeline",
  "Address",
  "Service",
  "Phone",
  "Email",
] as const;

const NZ_PHONE = /(?:\+64|0)[2-9]\d[\d\s-]{5,11}\d/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Put each known label on its own line so "Label value" pairs can be read off. */
function splitLabels(text: string): Map<string, string> {
  let t = text.replace(/\r\n/g, "\n");
  for (const label of SUMMARY_LABELS) {
    t = t.replace(new RegExp(label, "g"), `\n${label}\u0000`);
  }
  const out = new Map<string, string>();
  for (const line of t.split("\n")) {
    const m = line.match(/^(.+?)\u0000(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    const value = m[2].trim();
    // Keep the first occurrence; later ones are usually the "Call back / Reply" repeat.
    if (value && !out.has(key)) out.set(key, value);
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
  const looksRight =
    /new lead/i.test(input.subject) ||
    /new lead/i.test(text) ||
    /request summary/i.test(text) ||
    /sent from the get secure website/i.test(text);
  if (!looksRight) return null;

  const labelled = splitLabels(text);

  // The enquirer's address is any address in the body that is not the sending robot.
  const sender = input.fromAddress.toLowerCase();
  const bodyEmails = [...new Set((text.match(EMAIL) ?? []).map((e) => e.trim()))].filter(
    (e) => e.toLowerCase() !== sender && !/^(noreply|no-reply|postmaster|mailer-daemon)@/i.test(e),
  );
  const email = clean(labelled.get("Email")) ?? bodyEmails[0] ?? null;

  const phoneField = clean(labelled.get("Phone"));
  const phone = phoneField?.match(NZ_PHONE)?.[0]?.trim() ?? phoneField ?? text.match(NZ_PHONE)?.[0]?.trim() ?? null;
  const service = clean(labelled.get("Service"));
  const address = clean(labelled.get("Address"));
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

  const timeline = (fields["Timeline"] ?? "").toLowerCase();
  const urgency: ExtractedLead["urgency"] = /asap|as soon as possible|urgent|immediately|emergency/.test(timeline)
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
