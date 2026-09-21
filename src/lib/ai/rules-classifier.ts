import type { ClassificationInput, ClassificationResult, ExtractedLead, LeadClassifier } from "./types";

/**
 * Offline heuristic classifier. Used when no AI provider is configured, in CI, and as a
 * deterministic baseline. Deliberately conservative: unsure cases get a mid confidence so
 * they land in Needs Review rather than on the board.
 */
const SERVICE_PATTERNS: [RegExp, string][] = [
  [/\b(cctv|camera|cameras|nvr|dvr|surveillance)\b/i, "CCTV"],
  [/\bajax\b/i, "Ajax alarm"],
  [/\b(alarm|monitoring|monitored|sensor|pir)\b/i, "Alarm"],
  [/\b(access control|keypad|fob|fobs|swipe|maglock|door controller|card reader)\b/i, "Access control"],
  [/\b(intercom|video doorbell|gate entry)\b/i, "Intercom"],
  [/\b(service call|servicing|maintenance|not working|fault|faulty|repair|beeping|broken)\b/i, "Service / maintenance"],
  [/\b(gate automation|automatic gate|electric gate)\b/i, "Gate automation"],
];
const INTENT = /\b(quote|quotation|price|pricing|cost|install|installation|upgrade|replace|book|site visit|come out|how much|interested in|looking for|need|would like|can you)\b/i;
const NOT_LEAD =
  /\b(unsubscribe|newsletter|invoice\b[^\n]{0,40}\battached|please find (the |your )?invoice|payment is (now )?due|remittance|statement of account|your order|order confirmation|password reset|verify your email|out of office|automatic reply|auto-reply|delivery status notification|undeliverable|webinar|special offer|promo code|payslip|job application|cv attached)\b/i;
const PHONE = /(?:\+64|0)[2-9][\d\s-]{6,11}\d/;
const ADDRESS = /\b\d{1,5}[a-z]?\s+[A-Z][\w'’]+(?:\s+[A-Z][\w'’]+)*\s+(?:Street|St|Road|Rd|Avenue|Ave|Drive|Dr|Lane|Ln|Place|Pl|Crescent|Cres|Way|Terrace|Tce|Highway|Hwy|Parade|Pde|Grove|Close|Court|Ct|Rise|Heights|Esplanade|Quay|Mall|Square|Loop)\b[^\n,]*/;

function cleanName(name: string | null, address: string): string | null {
  if (name && name.trim() && !name.includes("@")) return name.trim().replace(/^"|"$/g, "");
  const local = address.split("@")[0] ?? "";
  if (/^(info|sales|admin|hello|noreply|no-reply|accounts|support)$/i.test(local)) return null;
  const guess = local.replace(/[._-]+/g, " ").replace(/\d+/g, "").trim();
  return guess ? guess.replace(/\b\w/g, (c) => c.toUpperCase()) : null;
}

export class RulesClassifier implements LeadClassifier {
  readonly name = "rules";

  async classify(input: ClassificationInput): Promise<ClassificationResult> {
    const started = Date.now();
    const text = `${input.subject}\n${input.text}`;
    const matched = SERVICE_PATTERNS.filter(([re]) => re.test(text)).map(([, label]) => label);
    const isService = matched.includes("Service / maintenance");
    const systems = matched.filter((m) => m !== "Service / maintenance");
    // "Alarm service" reads better than "Alarm" for a fault call; plain "Service / maintenance" when no system is named.
    const services = isService ? [systems.length ? `${systems[0]} service` : "Service / maintenance", ...systems.slice(1)] : systems;
    const hasIntent = INTENT.test(text);
    const notLead = NOT_LEAD.test(text) || /^(noreply|no-reply|mailer-daemon|postmaster)@/i.test(input.from.address);
    const phone = text.match(PHONE)?.[0]?.trim() ?? null;
    const address = text.match(ADDRESS)?.[0]?.trim() ?? null;
    const domain = input.from.address.split("@")[1] ?? "";
    const freeMail = /^(gmail|hotmail|outlook|yahoo|icloud|xtra|live|me)\./i.test(domain);
    // A company name is a whole signature line (optionally after "Title, "), never mid-sentence.
    const signatureCompany =
      text.match(/^(?:[^\n,]{0,40}, )?([A-Z][\w&'’ ]{1,40}(?: Ltd| Limited| Builders| Group| Trust| Apartments| Property| Properties| Retail| School))\s*$/m)?.[1]?.trim() ?? null;
    const company = signatureCompany ?? (!freeMail && domain ? domain.split(".")[0].replace(/\b\w/g, (c) => c.toUpperCase()) : null);

    let isLead = false;
    let confidence = 0.3;
    let reason = "No security service or enquiry intent detected.";
    if (notLead) {
      isLead = false;
      confidence = 0.9;
      reason = "Looks like an automated, marketing, or administrative email.";
    } else if (services.length > 0 && hasIntent) {
      isLead = true;
      confidence = phone || address ? 0.92 : 0.82;
      reason = `Mentions ${services.join(", ")} with enquiry intent.`;
    } else if (services.length > 0 || hasIntent) {
      isLead = true;
      confidence = 0.55;
      reason = services.length ? `Mentions ${services.join(", ")} but intent is unclear.` : "Enquiry intent without a clear service.";
    }

    const urgency: ExtractedLead["urgency"] = /\b(urgent|asap|immediately|today|emergency|break[- ]?in|burgl)/i.test(text)
      ? "urgent"
      : /\b(this week|soon|quickly)\b/i.test(text)
        ? "high"
        : "normal";

    const summary = isLead
      ? `${services[0] ?? "Security"} enquiry${address ? ` at ${address}` : ""}: ${input.subject || "no subject"}.`
      : `Not a lead: ${input.subject || "no subject"}.`;

    const result: ExtractedLead = {
      is_lead: isLead,
      confidence,
      contact_name: cleanName(input.from.name, input.from.address),
      company,
      email: input.from.address,
      phone,
      service: services[0] ?? null,
      site_address: address,
      summary,
      urgency,
      next_action: isLead
        ? isService
          ? "Call to confirm the fault and book a service visit."
          : "Call to qualify and arrange a site visit for a quote."
        : "No action needed.",
      reason,
    };
    return { provider: this.name, model: null, result, durationMs: Date.now() - started };
  }
}
