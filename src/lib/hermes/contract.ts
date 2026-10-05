/**
 * What Hermes must return for each email or conversation it inspects. Hermes is the operational
 * judgement: what it is, whether it is a lead, which work it belongs to, whether it is resolved or
 * waiting, which commitments are kept, and the next step. The validator
 * (src/lib/inspector/validate.ts) only checks Hermes is authorised to do that safely; the Business
 * Brain stays the technical and commercial authority. Nothing here is trusted until it has been
 * parsed against this schema and validated. Plain module.
 */
import { z } from "zod";
import { COMMITMENT_KEYS, FACT_KEYS, INTENTS } from "@/lib/inspector/types";

/** Bump when the prompt or the contract changes: every run records it. */
export const HERMES_INSPECTOR_VERSION = "hermes-inspector-4";

/** The controlled next actions Hermes may recommend. Nothing outside this list is ever executed. */
export const HERMES_ACTIONS = [
  "RUN_BUSINESS_BRAIN",
  "PREPARE_QUOTE",
  "ASK_CUSTOMER",
  "PROPOSE_SITE_VISIT",
  "DRAFT_REPLY",
  "PROPOSE_BOOKING",
  "CREATE_INTERNAL_TASK",
  "FOLLOW_UP",
  "CALL_CUSTOMER",
  "REQUEST_RESEARCH",
  "WAITING_ON_CUSTOMER",
  "NEEDS_REVIEW",
  "NO_ACTION",
] as const;
export type HermesAction = (typeof HERMES_ACTIONS)[number];

/** Extra internal work Hermes may ask for beside its main recommendation (all audited; none reaches a customer). */
export const HERMES_INTERNAL_ACTIONS = ["CREATE_INTERNAL_TASK", "FOLLOW_UP", "CALL_CUSTOMER", "ADD_INTERNAL_NOTE", "RUN_BUSINESS_BRAIN", "PROPOSE_SITE_VISIT", "PROPOSE_BOOKING"] as const;

/**
 * Structured evidence Hermes can cite instead of (or as well as) quoting words: the CRM checks the
 * cited field exists in the source or the record and supports the value.
 *   form:<Field>       a website form field as shown in source.form.fields ("form:Cameras"), or
 *                      form:name / form:email / form:phone / form:address / form:service
 *   turn:<n>           transcript turn n (source.transcript.turns[].n)
 *   email:subject      the subject; email:body the message text; email:from the sender's name, address or phone
 *   crm:<fact key>     a value already on the CRM record (crm:site_address)
 */
export const EVIDENCE_REF_HINT = "form:<Field> | form:name|email|phone|address|service | turn:<n> | email:body | email:subject | email:from | crm:<fact key>";

/**
 * What kind of business relationship a message belongs to: Hermes's judgement, decided before (and
 * separately from) who the sender is. The CRM routes on it; only customer work can need a customer.
 */
export const BUSINESS_CONTEXTS = ["customer_prospect", "existing_work", "supplier_vendor", "service_provider", "accounting_payment", "internal_admin", "irrelevant", "unknown"] as const;
export type BusinessContext = (typeof BUSINESS_CONTEXTS)[number];
/** Contexts that are never about a customer: no lead, and no "Who is this?" for the sender. */
export const NON_CUSTOMER_CONTEXTS: BusinessContext[] = ["supplier_vendor", "service_provider", "internal_admin", "irrelevant"];

export const CONVERSATION_TYPES = ["new_enquiry", "existing_lead", "existing_customer", "existing_job", "quote_follow_up", "service_request", "supplier", "spam_or_marketing", "internal", "other"] as const;

const confidence = z.coerce.number().min(0).max(1);
const text = (max: number) => z.string().trim().max(max);
/** Models often send null for "nothing"; treat null like absent. */
const opt = <T extends z.ZodTypeAny>(s: T) => s.nullish().transform((v) => v ?? null);

export const hermesResultSchema = z.object({
  conversation_type: z.enum(CONVERSATION_TYPES),
  intent: z.enum(INTENTS),
  service: opt(z.enum(["cctv", "alarm", "access_control", "intercom", "networking", "other"])),
  property_type: opt(z.enum(["residential", "commercial"])),
  /** One short headline, e.g. "New residential CCTV enquiry: 2 cameras, two-storey, new install." */
  summary: text(300),
  facts: z
    .array(
      z.object({
        key: z.enum(FACT_KEYS),
        value: z.union([z.string().max(500), z.number(), z.boolean()]),
        /** The customer's own words the fact comes from, quoted from the source (optional when evidence_ref is given). */
        evidence: text(500).default(""),
        /** Structured provenance instead of a quote: see EVIDENCE_REF_HINT. */
        evidence_ref: opt(text(120)),
        confidence,
      }),
    )
    .max(40)
    .default([]),
  objections: z
    .array(z.object({ kind: z.enum(["price", "timing", "competitor", "undecided", "scope", "other"]), evidence: text(500) }))
    .max(10)
    .default([]),
  commitments: z
    .array(
      z.object({
        owner: z.enum(["get_secure", "customer"]),
        owner_name: opt(text(80)),
        action: text(200),
        action_key: z.enum(COMMITMENT_KEYS).catch("other"),
        /** The words used for the time ("tonight", "by Friday"). */
        due_text: opt(text(80)),
        /** ISO 8601, if Hermes worked out a time. The validator prefers its own reading of due_text. */
        due_at: opt(z.string().max(40)),
        evidence: text(500).default(""),
        evidence_ref: opt(text(120)),
      }),
    )
    .max(10)
    .default([]),
  urgency: z.enum(["low", "normal", "high", "urgent"]).catch("normal"),
  missing: z
    .array(
      z.object({
        field: text(40),
        label: text(120),
        /** True only if Get Secure cannot progress (quote, visit, booking) without it. */
        blocking: z.boolean(),
        for: text(40).default("quote"),
        reason: text(300).default(""),
        /** The question to ask the customer, in plain words. */
        question: opt(text(300)),
      }),
    )
    .max(15)
    .default([]),
  recommended_action: z.enum(HERMES_ACTIONS),
  run_business_brain: z.boolean().default(false),
  /** For CREATE_INTERNAL_TASK / FOLLOW_UP / CALL_CUSTOMER. */
  task: opt(z.object({ title: text(200), due: opt(text(40)), detail: opt(text(1000)) })),
  /** Further internal work beside the main recommendation (a second task, a follow-up, a Brain run…). */
  internal_actions: z
    .array(z.object({ action: z.enum(HERMES_INTERNAL_ACTIONS), title: opt(text(200)), due: opt(text(40)), detail: opt(text(1000)), reason: text(300).default("") }))
    .max(6)
    .default([]),
  /**
   * Questions for the research profile when the CRM and the Business Brain do not know the answer
   * (a model's specification, compatibility, a replacement for a discontinued product). Only the
   * question and product details go out, never the customer's message.
   */
  research: z
    .array(z.object({ question: text(600), kind: z.enum(["product", "compatibility", "manual", "firmware", "supplier", "availability", "standard", "other"]).catch("other"), product: opt(text(120)), why: text(300).default("") }))
    .max(3)
    .default([]),
  /** For NEEDS_REVIEW: the one judgement Chris has to make (not "please look"). */
  review_question: opt(text(300)),
  /** For DRAFT_REPLY: the reply Chris will review. It must not quote prices, dates or discounts. */
  reply_draft: opt(z.object({ subject: opt(text(200)), body: text(4000) })),
  /** Who Hermes thinks the sender is. Advisory only: a person's identity is decided by the CRM's guarded rules. */
  identity: z
    .object({
      suggestion: z.enum(["candidate", "new", "unknown"]),
      candidate_key: opt(text(80)),
      reason: text(300).default(""),
    })
    .default({ suggestion: "unknown", candidate_key: null, reason: "" }),
  /** The kind of business relationship (customer/prospect, existing work, supplier, provider, accounting, internal, irrelevant). */
  business_context: z.enum(BUSINESS_CONTEXTS).catch("unknown").default("unknown"),
  /** Who the other party is as an organisation or person, in Hermes's reading (not an identity link). */
  counterparty: z
    .object({ name: opt(text(120)), kind: z.enum(["customer", "prospect", "supplier", "service_provider", "internal", "unknown"]).catch("unknown") })
    .default({ name: null, kind: "unknown" }),
  /** For statements, invoices, remittances and receipts: what the document is and its reference. */
  accounting: opt(
    z.object({
      document: z.enum(["statement", "invoice", "remittance", "receipt", "credit_note", "reminder", "other"]).catch("other"),
      reference: opt(text(80)),
      amount: opt(z.coerce.number()),
      due: opt(text(40)),
    }),
  ),
  /** Hermes asks Chris to confirm who the sender is even though the work does not need it. */
  identity_review: z.object({ needed: z.boolean().default(false), reason: text(300).default("") }).default({ needed: false, reason: "" }),
  /** Hermes's decision on an email: a new lead, not a lead, or part of existing work. */
  lead_decision: z.enum(["lead", "not_lead", "existing", "undecided"]).catch("undecided").default("undecided"),
  /**
   * The work this is about, as a ref from the context pack ("lead:<id>", "job:<id>", "customer:<id>"),
   * even when the sender is someone new. Separate from who the sender is: that stays the CRM's call.
   */
  operational_context: z
    .object({ ref: opt(text(80)), reason: text(300).default("") })
    .default({ ref: null, reason: "" }),
  /** Where the matter stands, with the CRM records (refs from the pack) that show it. */
  resolution: z
    .object({
      status: z.enum(["open", "waiting_on_us", "waiting_on_customer", "resolved"]).catch("open"),
      evidence: z.array(z.object({ ref: text(80), note: text(300).default("") })).max(10).default([]),
    })
    .default({ status: "open", evidence: [] }),
  /** Outstanding commitments (by id from the pack) that the CRM record shows were kept or are void. */
  commitment_updates: z
    .array(z.object({ id: text(80), status: z.enum(["done", "cancelled"]), evidence_ref: text(80), note: text(300).default("") }))
    .max(10)
    .default([]),
  conflicts: z
    .array(z.object({ key: text(40), crm_value: opt(z.union([z.string(), z.number(), z.boolean()])), new_value: z.union([z.string(), z.number(), z.boolean()]), evidence: text(500) }))
    .max(10)
    .default([]),
  confidence,
  /** Concise decision rationale (not a transcript of reasoning). */
  reason: text(600),
  advisories: z.array(text(300)).max(10).default([]),
});
export type HermesResult = z.infer<typeof hermesResultSchema>;

export class HermesOutputError extends Error {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
    this.name = "HermesOutputError";
  }
}

/**
 * Hermes is an agent, not a JSON API: its reply may be wrapped in a code fence or a sentence. Take
 * the outermost JSON object and parse it strictly against the contract.
 */
export function parseHermesResult(raw: string): HermesResult {
  const s = raw.trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const body = fenced ?? s;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new HermesOutputError("Hermes did not return a JSON object.", raw);
  let json: unknown;
  try {
    json = JSON.parse(body.slice(start, end + 1));
  } catch (e) {
    throw new HermesOutputError(`Hermes returned invalid JSON: ${(e as Error).message}`, raw);
  }
  const parsed = hermesResultSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new HermesOutputError(`Hermes output did not match the Inspector contract: ${first}`, raw);
  }
  return parsed.data;
}

/** The contract as JSON Schema, given to Hermes in the prompt. */
export function hermesResultJsonSchema(): unknown {
  return z.toJSONSchema(hermesResultSchema, { io: "input" });
}
