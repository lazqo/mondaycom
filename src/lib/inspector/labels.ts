/** How the Inspector's actions and facts are named on screen. Plain module (server and client). */
import type { ActionType, FactKey } from "./types";

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
};

/** What accepting does, in Chris's words. Never "send" or "confirm". */
export const ACCEPT_LABELS: Partial<Record<ActionType, string>> = {
  PROPOSE_SITE_VISIT: "Add task to arrange",
  PROPOSE_BOOKING: "Add task to arrange",
  PREPARE_REVISED_QUOTE: "Prepare revised quote",
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
