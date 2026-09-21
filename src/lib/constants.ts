export const USER_ROLES = ["admin", "member", "field"] as const;
export type UserRole = (typeof USER_ROLES)[number];
export const USER_ROLE_META: Record<UserRole, { label: string; description: string }> = {
  admin: { label: "Admin", description: "Everything, including staff, email accounts, AI and reminder settings." },
  member: { label: "Office", description: "Leads, inbox, customers, quotes, jobs and calendar. No settings." },
  field: { label: "Technician", description: "My Day, calendar, jobs and customer contact details only." },
};
/** Roles allowed to see leads, inbox and quotes. */
export const OFFICE_ROLES: UserRole[] = ["admin", "member"];

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

export const JOB_STATUSES = ["unscheduled", "scheduled", "en_route", "on_site", "done", "invoiced", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const JOB_STATUS_META: Record<JobStatus, { label: string; color: string; bg: string; text: string }> = {
  unscheduled: { label: "Unscheduled", color: "#9ca3af", bg: "bg-gray-400", text: "text-white" },
  scheduled: { label: "Scheduled", color: "#579bfc", bg: "bg-[#579bfc]", text: "text-white" },
  en_route: { label: "En Route", color: "#a25ddc", bg: "bg-[#a25ddc]", text: "text-white" },
  on_site: { label: "On Site", color: "#ff9900", bg: "bg-[#ff9900]", text: "text-white" },
  done: { label: "Done", color: "#00c875", bg: "bg-[#00c875]", text: "text-white" },
  invoiced: { label: "Invoiced", color: "#037f4c", bg: "bg-[#037f4c]", text: "text-white" },
  cancelled: { label: "Cancelled", color: "#e2445c", bg: "bg-[#e2445c]", text: "text-white" },
};
/** Statuses a job can still be worked on (used by dispatch and automations). */
export const OPEN_JOB_STATUSES: JobStatus[] = ["unscheduled", "scheduled", "en_route", "on_site"];

export const TASK_STATUSES = ["open", "done", "dismissed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const EVENT_KINDS = ["job", "site_visit", "other"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
export const EVENT_KIND_LABELS: Record<EventKind, string> = { job: "Job", site_visit: "Site visit", other: "Appointment" };

/** Default thresholds for follow-up automations (editable in Settings → Automations). */
export const AUTOMATION_DEFAULTS = {
  new_lead_contact_hours: 24,
  site_visit_quote_days: 2,
  quote_followup_days: 5,
  job_invoice_days: 3,
  notify_assignee_by_email: false,
  business_hours_start: 7, // calendar grid starts here (24h)
  business_hours_end: 18, // and ends here
} as const;
export type AutomationSettings = { [K in keyof typeof AUTOMATION_DEFAULTS]: (typeof AUTOMATION_DEFAULTS)[K] extends boolean ? boolean : number };


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
  pending: { label: "Waiting", bg: "bg-gray-200", text: "text-gray-700" },
  lead: { label: "New lead", bg: "bg-[#00c875]", text: "text-white" },
  needs_review: { label: "Needs review", bg: "bg-[#ffcb00]", text: "text-gray-900" },
  not_lead: { label: "Not a lead", bg: "bg-gray-400", text: "text-white" },
  existing: { label: "Known customer", bg: "bg-[#579bfc]", text: "text-white" },
  outbound: { label: "Sent by us", bg: "bg-[#a25ddc]", text: "text-white" },
  error: { label: "Couldn't classify", bg: "bg-[#e2445c]", text: "text-white" },
};

export const LEAD_URGENCIES = ["low", "normal", "high", "urgent"] as const;
export type LeadUrgency = (typeof LEAD_URGENCIES)[number];
export const LEAD_URGENCY_META: Record<LeadUrgency, { label: string; bg: string; text: string }> = {
  low: { label: "Low", bg: "bg-gray-200", text: "text-gray-700" },
  normal: { label: "Normal", bg: "bg-[#579bfc]", text: "text-white" },
  high: { label: "High", bg: "bg-[#ff9900]", text: "text-white" },
  urgent: { label: "Urgent", bg: "bg-[#e2445c]", text: "text-white" },
};
