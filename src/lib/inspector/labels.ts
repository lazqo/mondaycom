/** How the Inspector's actions and facts are named on screen. Plain module (server and client). */
import type { ActionType, FactKey } from "./types";
import type { BusinessContext } from "@/lib/hermes/contract";

export const ACTION_LABELS: Record<ActionType, string> = {
  PREPARE_QUOTE: "Prepare quote",
  PREPARE_REVISED_QUOTE: "Revised quote",
  RUN_BUSINESS_BRAIN: "Run the Business Brain",
  PROPOSE_SITE_VISIT: "Site visit",
  PROPOSE_BOOKING: "Booking",
  CREATE_INTERNAL_TASK: "Task",
  ADD_INTERNAL_NOTE: "Note",
  PROPOSE_LEAD_FACT_UPDATE: "Lead facts",
  CREATE_SERVICE_CASE: "Service case",
  PREPARE_FOLLOW_UP: "Follow-up",
  DRAFT_EMAIL: "Draft email",
  CALL_CUSTOMER: "Call",
  LINK_RECORDING: "Link recording",
  NO_ACTION: "No action",
  NEEDS_REVIEW: "Needs review",
  OUTSTANDING: "Outstanding",
  RESOLVE_COMMITMENT: "Commitment kept",
  REQUEST_RESEARCH: "Research",
  PROPOSE_LINK_SENDER: "Link sender (optional)",
  ASK_CHRIS: "Question for you",
};

/** What accepting does, in Chris's words. Never "send" or "confirm". */
export const ACCEPT_LABELS: Partial<Record<ActionType, string>> = {
  PROPOSE_SITE_VISIT: "Pencil it in",
  PROPOSE_BOOKING: "Pencil it in",
  PREPARE_REVISED_QUOTE: "Prepare revised quote",
  PROPOSE_LINK_SENDER: "Link sender",
};

export const FACT_LABELS: Record<FactKey, string> = {
  contact_name: "Name",
  email: "Email",
  phone: "Phone",
  company: "Company",
  site_address: "Site address",
  service: "Service",
  property_type: "Property",
  job_type: "New or upgrade",
  camera_count: "Cameras",
  storeys: "Storeys",
  areas: "Areas",
  existing_system: "Existing system",
  existing_cabling: "Existing cabling",
  remote_viewing: "Phone viewing",
  budget: "Budget",
  timing: "Timing",
  brand: "Brand",
  site_visit_requested: "Site visit requested",
};

/** Hermes's recommended next actions, as Chris reads them. */
export const HERMES_ACTION_LABELS: Record<string, string> = {
  RUN_BUSINESS_BRAIN: "Run the Business Brain",
  PREPARE_QUOTE: "Prepare quote",
  ASK_CUSTOMER: "Ask the customer",
  PROPOSE_SITE_VISIT: "Propose a site visit",
  DRAFT_REPLY: "Draft a reply",
  CREATE_INTERNAL_TASK: "Create a task",
  FOLLOW_UP: "Follow up",
  PROPOSE_BOOKING: "Propose a booking",
  CALL_CUSTOMER: "Call the customer",
  REQUEST_RESEARCH: "Research",
  WAITING_ON_CUSTOMER: "Waiting on the customer",
  NEEDS_REVIEW: "Needs review",
  NO_ACTION: "No action",
};

/** Why an item waits for Chris. */
export const REVIEW_KIND_LABELS: Record<string, string> = {
  identity: "Who is this?",
  hermes_unavailable: "Hermes could not read it",
  hermes_low_confidence: "Hermes is unsure",
  hermes_flagged: "Hermes asks you to look",
  hermes_proposed_lead: "Hermes thinks this is a lead",
};

/** Hermes's business-context classification, as Chris reads it. */
export const BUSINESS_CONTEXT_LABELS: Record<BusinessContext, string> = {
  customer_prospect: "customer or prospect",
  existing_work: "existing site, job or service issue",
  supplier_vendor: "supplier / vendor",
  service_provider: "service or monitoring provider",
  accounting_payment: "accounting, payment or statement",
  internal_admin: "internal / admin",
  irrelevant: "irrelevant",
  unknown: "unknown",
};
