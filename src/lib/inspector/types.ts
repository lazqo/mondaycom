/**
 * Lead + Conversation Inspector: the shared shapes. An email and a Plaud conversation become the
 * same InspectorInput, are understood the same way, and feed the same action pipeline.
 */

export const INSPECTOR_VERSION = "inspector-2.0.0-hermes";

export type SourceType = "email" | "recording";
/** inbound email, outbound email (ours), or a recorded conversation. */
export type SourceDirection = "inbound" | "outbound" | "conversation";

export type Utterance = { speaker: string | null; text: string; at: string | null };

export type InspectorInput = {
  sourceType: SourceType;
  sourceId: string;
  direction: SourceDirection;
  at: Date;
  title: string;
  /** Email body (quoted history stripped) or the cleaned transcript. */
  text: string;
  /** Transcript turns, when the source is a conversation. */
  utterances: Utterance[];
  from: { name: string | null; email: string | null; phone: string | null };
  /** Earlier messages in the same thread, newest first (context only). */
  context: { from: string; at: string; text: string }[];
  /** Labelled fields from a website enquiry form (Property, Cameras, Storeys…), when it is one. */
  form?: { fields: Record<string, string>; name: string | null; email: string | null; phone: string | null; service: string | null; address: string | null } | null;
  /** What the rules classifier said about an email (comparison and evidence only, never the final word). */
  rulesClassification?: string | null;
  /** Links the source already has (thread linked to a lead, recording filed by Chris). */
  linked: { leadId: string | null; contactId: string | null; jobId: string | null; how: string | null };
};

// ---------------- understanding ----------------

export type ServiceType = "cctv" | "alarm" | "access_control" | "intercom" | "networking" | "other";
export type PropertyType = "residential" | "commercial";
export type Intent = (typeof INTENTS)[number];
export type Urgency = "low" | "normal" | "high" | "urgent";

/** A fact the Inspector read, with the words it read it from. */
export type ExtractedFact = {
  key: FactKey;
  value: string | number | boolean;
  display: string;
  evidence: string;
  confidence: number;
};

export const FACT_KEYS = [
  "contact_name",
  "email",
  "phone",
  "company",
  "site_address",
  "service",
  "property_type",
  "job_type",
  "camera_count",
  "storeys",
  "areas",
  "existing_system",
  "existing_cabling",
  "remote_viewing",
  "budget",
  "timing",
  "brand",
  "site_visit_requested",
] as const;
export type FactKey = (typeof FACT_KEYS)[number];

export const INTENTS = ["new_enquiry", "quote_request", "site_visit_request", "booking_request", "question", "quote_change", "acceptance", "objection", "service_issue", "follow_up", "information", "not_relevant"] as const;
export const COMMITMENT_KEYS = ["send_quote", "send_photos", "call", "visit", "send_info", "confirm", "pay", "check", "other"] as const;

export type Commitment = {
  owner: "get_secure" | "customer" | "unknown";
  ownerName: string | null;
  action: string;
  actionKey: (typeof COMMITMENT_KEYS)[number];
  /** Resolved due time, if the words give one. */
  dueAt: string | null;
  /** The words used for the time ("tonight", "by Friday"). */
  dueText: string | null;
  evidence: string;
  confidence: number;
};

export type MissingInfo = {
  field: FactKey | "service";
  label: string;
  /** Blocking: we cannot safely decide, price or proceed without it. */
  blocking: boolean;
  /** For what: "quote", "site visit", "booking". */
  for: string;
  reason: string;
};

export type Understanding = {
  service: ServiceType | null;
  propertyType: PropertyType | null;
  intents: Intent[];
  primaryIntent: Intent;
  urgency: Urgency;
  facts: ExtractedFact[];
  requested: { item: string; quantity: number | null; evidence: string }[];
  timing: { text: string; evidence: string }[];
  budget: { text: string; amount: number | null; evidence: string }[];
  objections: { kind: "price" | "timing" | "competitor" | "undecided" | "scope" | "other"; evidence: string }[];
  decisions: { text: string; evidence: string }[];
  commitments: Commitment[];
  missing: MissingInfo[];
  /** Mentions of a quote number (Q-123), to tie the conversation to a quote. */
  quoteRefs: number[];
  summary: string;
};

// ---------------- identity ----------------

export type IdentitySignal = { kind: "thread" | "linked" | "email" | "phone" | "calendar" | "quote_ref" | "address" | "company" | "name"; detail: string; weight: number };

export type IdentityCandidate = {
  leadId: string | null;
  contactId: string | null;
  jobId: string | null;
  label: string;
  score: number;
  signals: IdentitySignal[];
};

export type IdentityResult = {
  status: "matched" | "new" | "needs_review" | "not_applicable";
  chosen: IdentityCandidate | null;
  candidates: IdentityCandidate[];
  confidence: number;
  reason: string;
};

// ---------------- actions ----------------

export const ACTION_TYPES = [
  "PREPARE_QUOTE",
  "PREPARE_REVISED_QUOTE",
  "RUN_BUSINESS_BRAIN",
  "PROPOSE_SITE_VISIT",
  "PROPOSE_BOOKING",
  "CREATE_INTERNAL_TASK",
  "ADD_INTERNAL_NOTE",
  "PROPOSE_LEAD_FACT_UPDATE",
  "CREATE_SERVICE_CASE",
  "PREPARE_FOLLOW_UP",
  "DRAFT_EMAIL",
  "CALL_CUSTOMER",
  "LINK_RECORDING",
  "NO_ACTION",
  "NEEDS_REVIEW",
  /** Something already open (a commitment we or the customer made, an open task) is what needs doing. Kept for earlier records. */
  "OUTSTANDING",
  /** Hermes: the CRM record shows an outstanding commitment was kept (or is void). Reversible. */
  "RESOLVE_COMMITMENT",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

/**
 * How an action is carried out:
 * - auto: internal only (note, task, link, analysis, preparing a draft that waits for approval)
 * - approval: Chris must accept it before anything happens (bookings, revised quotes, conflicts)
 */
export type ActionMode = "auto" | "approval";

export type PlannedAction = {
  type: ActionType;
  mode: ActionMode;
  /** The deterministic rule that produced it. */
  rule: string;
  reason: string;
  payload: Record<string, unknown>;
};

/** Customer-facing actions the Inspector may never take on its own. Enforced in the router. */
export const NEVER_AUTONOMOUS = ["send_email", "send_quote", "confirm_booking", "confirm_site_visit", "promise_price", "promise_date", "discount", "accept_terms"] as const;
