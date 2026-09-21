export const LEAD_STATUSES = [
  "new",
  "contacted",
  "site_visit",
  "quote_required",
  "quote_sent",
  "won",
  "lost",
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const LEAD_STATUS_META: Record<LeadStatus, { label: string; color: string; bg: string; text: string }> = {
  new: { label: "New", color: "#579bfc", bg: "bg-[#579bfc]", text: "text-white" },
  contacted: { label: "Contacted", color: "#a25ddc", bg: "bg-[#a25ddc]", text: "text-white" },
  site_visit: { label: "Site Visit", color: "#ff9900", bg: "bg-[#ff9900]", text: "text-white" },
  quote_required: { label: "Quote Required", color: "#ffcb00", bg: "bg-[#ffcb00]", text: "text-gray-900" },
  quote_sent: { label: "Quote Sent", color: "#0086c0", bg: "bg-[#0086c0]", text: "text-white" },
  won: { label: "Won", color: "#00c875", bg: "bg-[#00c875]", text: "text-white" },
  lost: { label: "Lost", color: "#e2445c", bg: "bg-[#e2445c]", text: "text-white" },
};

export const LEAD_SOURCES = ["email", "phone", "website", "referral", "walk_in", "social", "other"] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];
export const LEAD_SOURCE_LABELS: Record<LeadSource, string> = {
  email: "Email",
  phone: "Phone",
  website: "Website",
  referral: "Referral",
  walk_in: "Walk-in",
  social: "Social",
  other: "Other",
};

export const QUOTE_STATUSES = ["draft", "sent", "accepted", "declined"] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];
export const QUOTE_STATUS_META: Record<QuoteStatus, { label: string; bg: string; text: string }> = {
  draft: { label: "Draft", bg: "bg-gray-400", text: "text-white" },
  sent: { label: "Sent", bg: "bg-[#0086c0]", text: "text-white" },
  accepted: { label: "Accepted", bg: "bg-[#00c875]", text: "text-white" },
  declined: { label: "Declined", bg: "bg-[#e2445c]", text: "text-white" },
};

export const JOB_STATUSES = ["unscheduled", "scheduled", "in_progress", "done", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const JOB_STATUS_META: Record<JobStatus, { label: string; bg: string; text: string }> = {
  unscheduled: { label: "Unscheduled", bg: "bg-gray-400", text: "text-white" },
  scheduled: { label: "Scheduled", bg: "bg-[#579bfc]", text: "text-white" },
  in_progress: { label: "In Progress", bg: "bg-[#ff9900]", text: "text-white" },
  done: { label: "Done", bg: "bg-[#00c875]", text: "text-white" },
  cancelled: { label: "Cancelled", bg: "bg-[#e2445c]", text: "text-white" },
};

export const SERVICE_SUGGESTIONS = [
  "CCTV install",
  "Alarm install",
  "Alarm monitoring",
  "Access control",
  "Intercom",
  "Service call",
  "Maintenance",
];

export const DEFAULT_TAX_RATE = 15; // NZ GST

export const EMAIL_CLASSIFICATIONS = [
  "pending", // stored, not yet classified
  "lead", // AI confident: lead created automatically
  "needs_review", // AI unsure or low confidence: waiting for a human
  "not_lead", // newsletter, invoice, supplier, spam, etc.
  "existing", // reply on a thread already linked to a lead/customer/job
  "outbound", // sent from the CRM
  "error", // classification failed; retry from the inbox
] as const;
export type EmailClassification = (typeof EMAIL_CLASSIFICATIONS)[number];
export const EMAIL_CLASSIFICATION_META: Record<EmailClassification, { label: string; bg: string; text: string }> = {
  pending: { label: "Pending", bg: "bg-gray-200", text: "text-gray-700" },
  lead: { label: "Lead", bg: "bg-[#00c875]", text: "text-white" },
  needs_review: { label: "Needs review", bg: "bg-[#ffcb00]", text: "text-gray-900" },
  not_lead: { label: "Not a lead", bg: "bg-gray-400", text: "text-white" },
  existing: { label: "Existing", bg: "bg-[#579bfc]", text: "text-white" },
  outbound: { label: "Sent", bg: "bg-[#a25ddc]", text: "text-white" },
  error: { label: "Error", bg: "bg-[#e2445c]", text: "text-white" },
};

export const LEAD_URGENCIES = ["low", "normal", "high", "urgent"] as const;
export type LeadUrgency = (typeof LEAD_URGENCIES)[number];
export const LEAD_URGENCY_META: Record<LeadUrgency, { label: string; bg: string; text: string }> = {
  low: { label: "Low", bg: "bg-gray-200", text: "text-gray-700" },
  normal: { label: "Normal", bg: "bg-[#579bfc]", text: "text-white" },
  high: { label: "High", bg: "bg-[#ff9900]", text: "text-white" },
  urgent: { label: "Urgent", bg: "bg-[#e2445c]", text: "text-white" },
};
