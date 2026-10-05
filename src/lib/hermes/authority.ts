/**
 * Hermes's authority, by capability class: what it may do on its own, what it may only prepare or
 * propose, and the hard limits. The validator (src/lib/inspector/validate.ts), the router
 * (src/lib/inspector/router.ts), the MCP tools and the tests all read this one table, so the
 * limits live in one place. Plain module.
 *
 * The model: Hermes is the employee. It understands, decides, investigates, organises and does
 * internal work. The guardrails are its employment limits: it cannot bind Get Secure externally,
 * alter protected commercial truth, expose secrets, or make destructive identity or financial
 * changes without authority.
 */
import type { ActionType } from "@/lib/inspector/types";

export type CapabilityClass =
  | "internal_record" // notes, the audit trail
  | "internal_work" // tasks, follow-ups, call reminders, service cases
  | "operational_state" // commitments kept or void, lead / not-lead, filing into existing work
  | "record_data" // facts on a customer record
  | "business_brain" // running the Brain (it designs and prices; Hermes never does)
  | "prepare_customer_facing" // a quote or reply prepared for Chris, never sent
  | "proposal" // site visit, booking, revised quote, linking the sender: Chris accepts
  | "research" // the separate research profile, through the CRM's broker
  | "review" // Chris's judgement genuinely needed
  | "none";

export type Authority = {
  class: CapabilityClass;
  /** Carried out without Chris (internal, audited). Otherwise it waits for him. */
  autonomous: boolean;
  /**
   * The action needs a CRM record to work on: "lead" (the Brain and quotes work on a lead), "work" (a
   * lead, job or customer: a verified sender, the evidenced work Hermes placed it in, or the lead it
   * created), or nothing (it can be done without knowing who the sender is).
   */
  needs: "lead" | "work" | null;
  /** Can be undone by Chris in the CRM (reopen, dismiss, mark lost, delete a task). */
  reversible: boolean;
};

export const AUTHORITY: Record<ActionType, Authority> = {
  ADD_INTERNAL_NOTE: { class: "internal_record", autonomous: true, needs: null, reversible: true },
  CREATE_INTERNAL_TASK: { class: "internal_work", autonomous: true, needs: null, reversible: true },
  CREATE_SERVICE_CASE: { class: "internal_work", autonomous: true, needs: null, reversible: true },
  CALL_CUSTOMER: { class: "internal_work", autonomous: true, needs: null, reversible: true },
  PREPARE_FOLLOW_UP: { class: "internal_work", autonomous: true, needs: null, reversible: true },
  REQUEST_RESEARCH: { class: "research", autonomous: true, needs: null, reversible: true },
  RESOLVE_COMMITMENT: { class: "operational_state", autonomous: true, needs: "work", reversible: true },
  OUTSTANDING: { class: "operational_state", autonomous: true, needs: null, reversible: true },
  PROPOSE_LEAD_FACT_UPDATE: { class: "record_data", autonomous: true, needs: "work", reversible: true },
  LINK_RECORDING: { class: "record_data", autonomous: true, needs: "work", reversible: true },
  RUN_BUSINESS_BRAIN: { class: "business_brain", autonomous: true, needs: "lead", reversible: true },
  PREPARE_QUOTE: { class: "prepare_customer_facing", autonomous: true, needs: "lead", reversible: true },
  DRAFT_EMAIL: { class: "prepare_customer_facing", autonomous: true, needs: null, reversible: true },
  PROPOSE_SITE_VISIT: { class: "proposal", autonomous: false, needs: "work", reversible: true },
  PROPOSE_BOOKING: { class: "proposal", autonomous: false, needs: "work", reversible: true },
  PREPARE_REVISED_QUOTE: { class: "proposal", autonomous: false, needs: "lead", reversible: true },
  PROPOSE_LINK_SENDER: { class: "proposal", autonomous: false, needs: "work", reversible: true },
  NEEDS_REVIEW: { class: "review", autonomous: false, needs: null, reversible: true },
  NO_ACTION: { class: "none", autonomous: true, needs: null, reversible: true },
};

/**
 * What Hermes may do autonomously, in Chris's words (the authority matrix shown in the docs).
 * Internal planning of Business Brain packages is autonomous too: Hermes may create a CANDIDATE
 * package, never an approved one.
 */
export const HERMES_MAY = [
  "classify lead / not lead, and create a lead when confident (never a permanent customer for an enquiry)",
  "link an existing customer only on strong identity evidence (exact email, phone, thread), never a name",
  "continue work under an existing site, job or lead when the source evidences it, with the sender unverified",
  "decide the next action, no action, waiting on us or the customer, resolved, outstanding, urgency",
  "mark an outstanding commitment kept or void when a cited CRM record shows it (reversible)",
  "add internal notes; create, deduplicate and follow up internal tasks",
  "run the Business Brain; prepare a quote, reply, follow-up, site-visit or booking proposal for Chris",
  "ask the research profile a question (only the question leaves; findings are graded by source)",
  "propose Business Brain updates and candidate packages/kits (they start as candidates for Chris)",
  "propose linking the sender (Chris decides); ask Chris only when his judgement is genuinely needed",
] as const;

/** The hard guardrails, by class. Enforced in code (actor guard, validator, router), not by the prompt. */
export const HARD_GUARDRAILS = {
  customer_facing: [
    "send a customer email, quote or follow-up",
    "confirm an appointment, site visit or installation date",
    "accept or decline commercial terms, or discount",
    "make an externally binding promise (price, product, date)",
  ],
  commercial: [
    "invent a price or trade cost (an unknown cost is never $0)",
    "override approved labour rules, products, kits or packages",
    "change markup or discount policy",
    "promote research into approved Business Brain knowledge, or approve a candidate package",
  ],
  identity: [
    "link or merge people on a name alone",
    "silently overwrite a conflicting fact (it is flagged for Chris)",
    "treat an unknown person as a verified customer without evidence",
  ],
  destructive: ["delete anything", "merge records", "approve anything financial", "make an irreversible state change"],
  secrets: ["see a password, cookie, token or supplier login; bypass a CAPTCHA or MFA"],
} as const;

/** Does this planned action need a record to work on that is not there? */
export function lacksRecord(type: ActionType, has: { lead: boolean; work: boolean }): boolean {
  const n = AUTHORITY[type]?.needs;
  return n === "lead" ? !has.lead : n === "work" ? !has.work : false;
}
