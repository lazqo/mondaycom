import { z } from "zod";

/** What the classifier sees. Kept provider-neutral and free of DB types. */
export type ClassificationInput = {
  from: { name: string | null; address: string };
  to: string[];
  subject: string;
  receivedAt: string; // ISO
  text: string; // plain-text body (HTML already converted), trimmed to a sane length
  attachments: { filename: string; contentType: string; size: number }[];
  /** Earlier messages on the same thread, oldest first, for context. */
  priorMessages?: { from: string; date: string; text: string }[];
  /** Known CRM context to help linking. */
  knownContact?: { name: string; company: string | null } | null;
};

export const extractedLeadSchema = z.object({
  is_lead: z.boolean().describe("True if this email is a genuine enquiry for security work Get Secure could quote or do"),
  confidence: z.number().min(0).max(1).describe("How confident you are in is_lead and the extracted fields, 0-1"),
  contact_name: z.string().nullable().describe("Person's full name if identifiable"),
  company: z.string().nullable().describe("Company or organisation, if any"),
  email: z.string().nullable().describe("Best contact email address for the enquirer"),
  phone: z.string().nullable().describe("Phone number as written, NZ format if present"),
  service: z.string().nullable().describe("Service requested, e.g. CCTV install, Ajax alarm, access control, intercom, service call, maintenance"),
  site_address: z.string().nullable().describe("Site / property address if mentioned"),
  summary: z.string().describe("One or two sentence summary of the enquiry"),
  urgency: z.enum(["low", "normal", "high", "urgent"]).describe("Urgency implied by the email"),
  next_action: z.string().describe("Suggested next action for the Get Secure team"),
  reason: z.string().describe("One sentence on why this is or is not a lead"),
});
export type ExtractedLead = z.infer<typeof extractedLeadSchema>;

export type ClassificationResult = {
  provider: string;
  model: string | null;
  result: ExtractedLead;
  raw?: unknown;
  usage?: { inputTokens?: number; outputTokens?: number };
  durationMs: number;
};

export interface LeadClassifier {
  readonly name: string;
  classify(input: ClassificationInput): Promise<ClassificationResult>;
}

/** Truncate long bodies (quoted replies, signatures) before sending to a model. */
export function trimBody(text: string, max = 6000): string {
  const t = text.replace(/\r\n/g, "\n").trim();
  return t.length > max ? t.slice(0, max) + "\n…[truncated]" : t;
}
