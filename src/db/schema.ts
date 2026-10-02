import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  date,
  numeric,
  jsonb,
  boolean,
  integer,
  index,
  uniqueIndex,
  customType,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import {
  LEAD_STATUSES,
  LEAD_SOURCES,
  QUOTE_STATUSES,
  JOB_STATUSES,
  EMAIL_CLASSIFICATIONS,
  LEAD_URGENCIES,
  TASK_STATUSES,
  EVENT_KINDS,
  USER_ROLES,
  DRAFT_STATUSES,
} from "@/lib/constants";
import { KNOWLEDGE_STATUSES } from "@/lib/brain/types";

export { LEAD_STATUSES, LEAD_SOURCES, QUOTE_STATUSES, JOB_STATUSES, EMAIL_CLASSIFICATIONS, LEAD_URGENCIES, TASK_STATUSES, EVENT_KINDS };
export type { LeadStatus, LeadSource, QuoteStatus, JobStatus, EmailClassification, LeadUrgency, TaskStatus, EventKind } from "@/lib/constants";

// ---------- Enums ----------

export const userRoleEnum = pgEnum("user_role", USER_ROLES);

export const leadStatusEnum = pgEnum("lead_status", LEAD_STATUSES);

export const leadSourceEnum = pgEnum("lead_source", LEAD_SOURCES);

export const quoteStatusEnum = pgEnum("quote_status", QUOTE_STATUSES);

export const jobStatusEnum = pgEnum("job_status", JOB_STATUSES);
export const emailClassificationEnum = pgEnum("email_classification", EMAIL_CLASSIFICATIONS);
export const emailDirectionEnum = pgEnum("email_direction", ["inbound", "outbound"]);
export const leadUrgencyEnum = pgEnum("lead_urgency", LEAD_URGENCIES);
export const taskStatusEnum = pgEnum("task_status", TASK_STATUSES);
export const eventKindEnum = pgEnum("event_kind", EVENT_KINDS);
export const knowledgeStatusEnum = pgEnum("knowledge_status", KNOWLEDGE_STATUSES);
export const draftStatusEnum = pgEnum("draft_status", DRAFT_STATUSES);

// ---------- Tables ----------

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: userRoleEnum("role").notNull().default("member"),
  active: boolean("active").notNull().default(true),
  /** May approve customer-facing actions (emails, quotes, commitments) prepared by the system. */
  canApprove: boolean("can_approve").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    company: text("company"),
    email: text("email"),
    phone: text("phone"),
    address: text("address"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("contacts_email_idx").on(t.email), index("contacts_name_idx").on(t.name)],
);

export const leads = pgTable(
  "leads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Board columns
    name: text("name").notNull(), // "Lead" column: the person / enquiry name
    company: text("company"),
    phone: text("phone"),
    email: text("email"),
    service: text("service"),
    site: text("site"), // site address
    status: leadStatusEnum("status").notNull().default("new"),
    assignedToId: uuid("assigned_to_id").references(() => users.id, { onDelete: "set null" }),
    followUpAt: date("follow_up_at"),
    lastContactAt: date("last_contact_at"),
    source: leadSourceEnum("source").notNull().default("other"),
    // Extra
    notes: text("notes"),
    summary: text("summary"), // short enquiry summary (AI or manual)
    urgency: leadUrgencyEnum("urgency"),
    nextAction: text("next_action"),
    aiConfidence: numeric("ai_confidence", { precision: 4, scale: 3 }),
    emailThreadId: uuid("email_thread_id"), // FK added below via relations (no circular import)
    sourceEmailId: uuid("source_email_id"),
    position: integer("position").notNull().default(0),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    convertedAt: timestamp("converted_at", { withTimezone: true }),
    createdById: uuid("created_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    index("leads_status_idx").on(t.status),
    index("leads_assigned_idx").on(t.assignedToId),
    index("leads_contact_idx").on(t.contactId),
  ],
);

export type QuoteLineItem = {
  description: string;
  quantity: number;
  unitPrice: number;
};

export const quotes = pgTable(
  "quotes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    number: integer("number").notNull().unique(),
    title: text("title").notNull(),
    // A quote prepared for a lead that is not yet a customer has no contact until it converts.
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "restrict" }),
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
    status: quoteStatusEnum("status").notNull().default("draft"),
    /** "manual" when a person wrote it; "brain" when prepared from a CCTV assessment. */
    origin: text("origin").$type<"manual" | "brain">().notNull().default("manual"),
    assessmentId: uuid("assessment_id"),
    version: integer("version").notNull().default(1),
    revisionOfId: uuid("revision_of_id"),
    approvedById: uuid("approved_by_id").references(() => users.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    /** Fingerprint of what was approved; any change to it voids the approval. */
    approvalHash: text("approval_hash"),
    /** Internal costing (supplier cost, markup, margin). Never shown to the customer. */
    internalCosting: jsonb("internal_costing").$type<Record<string, unknown>>(),
    confidence: jsonb("confidence").$type<Record<string, unknown>>(),
    lineItems: jsonb("line_items").$type<QuoteLineItem[]>().notNull().default([]),
    taxRate: numeric("tax_rate", { precision: 5, scale: 2 }).notNull().default("15.00"),
    subtotal: numeric("subtotal", { precision: 12, scale: 2 }).notNull().default("0"),
    total: numeric("total", { precision: 12, scale: 2 }).notNull().default("0"),
    notes: text("notes"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("quotes_contact_idx").on(t.contactId)],
);

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    number: integer("number").notNull().unique(),
    title: text("title").notNull(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "restrict" }),
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
    quoteId: uuid("quote_id").references(() => quotes.id, { onDelete: "set null" }),
    service: text("service"),
    siteAddress: text("site_address"),
    status: jobStatusEnum("status").notNull().default("unscheduled"),
    assignedToId: uuid("assigned_to_id").references(() => users.id, { onDelete: "set null" }),
    notes: text("notes"),
    statusChangedAt: timestamp("status_changed_at", { withTimezone: true }),
    doneAt: timestamp("done_at", { withTimezone: true }),
    invoicedAt: timestamp("invoiced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("jobs_contact_idx").on(t.contactId), index("jobs_status_idx").on(t.status)],
);

export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    description: text("description"),
    location: text("location"),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    allDay: boolean("all_day").notNull().default(false),
    kind: eventKindEnum("kind").notNull().default("other"),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "cascade" }),
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "cascade" }), // site visits
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }), // customer appointments
    /** Created in the connected Titan calendar rather than in the CRM. */
    fromCalendar: boolean("from_calendar").notNull().default(false),
    /** An occurrence of a repeating calendar event: change it in the calendar, not here. */
    readOnly: boolean("read_only").notNull().default(false),
    assignedToId: uuid("assigned_to_id").references(() => users.id, { onDelete: "set null" }),
    createdById: uuid("created_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("events_starts_idx").on(t.startsAt),
    index("events_job_idx").on(t.jobId),
    index("events_lead_idx").on(t.leadId),
    index("events_contact_idx").on(t.contactId),
  ],
);

// ---------- Jobs: notes & photos ----------

export const jobNotes = pgTable(
  "job_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    authorId: uuid("author_id").references(() => users.id, { onDelete: "set null" }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("job_notes_job_idx").on(t.jobId)],
);

export const jobPhotos = pgTable(
  "job_photos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    uploadedById: uuid("uploaded_by_id").references(() => users.id, { onDelete: "set null" }),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull().default("image/jpeg"),
    size: integer("size").notNull().default(0),
    caption: text("caption"),
    content: customType<{ data: Buffer; driverData: Buffer }>({
      dataType() {
        return "bytea";
      },
    })("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("job_photos_job_idx").on(t.jobId)],
);

// ---------- Tasks, notifications, settings ----------

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    detail: text("detail"),
    status: taskStatusEnum("status").notNull().default("open"),
    dueAt: date("due_at"),
    assignedToId: uuid("assigned_to_id").references(() => users.id, { onDelete: "set null" }),
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "cascade" }),
    quoteId: uuid("quote_id").references(() => quotes.id, { onDelete: "cascade" }),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "cascade" }),
    // Automation-created tasks: one open task per (rule, entity). Manual tasks have ruleKey null.
    ruleKey: text("rule_key"),
    entityId: uuid("entity_id"),
    createdById: uuid("created_by_id").references(() => users.id, { onDelete: "set null" }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("tasks_status_due_idx").on(t.status, t.dueAt),
    index("tasks_assigned_idx").on(t.assignedToId),
    uniqueIndex("tasks_rule_entity_open_idx").on(t.ruleKey, t.entityId).where(sql`status = 'open' and rule_key is not null`),
  ],
);

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: text("body"),
    link: text("link"),
    kind: text("kind").notNull().default("info"),
    dedupeKey: text("dedupe_key"),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("notifications_user_idx").on(t.userId, t.readAt), uniqueIndex("notifications_dedupe_idx").on(t.userId, t.dedupeKey).where(sql`dedupe_key is not null`)],
);

/**
 * Voice recordings pulled from Plaud. Each one is stored once, keyed by its Plaud id, with the
 * transcript. If it can be matched to a customer or lead it is attached automatically; otherwise it
 * waits in review. Recordings are never turned into leads without a person deciding.
 */
export const recordingStatusEnum = pgEnum("recording_status", ["review", "attached", "dismissed"]);

export const recordings = pgTable(
  "recordings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Plaud's own id, e.g. of_71fa29… — what stops the same recording importing twice. */
    externalId: text("external_id").notNull(),
    source: text("source").notNull().default("plaud"),
    title: text("title").notNull(),
    transcript: text("transcript").notNull(),
    /** True once the transcript is Plaud's AI-cleaned version rather than the raw one. */
    transcriptPolished: boolean("transcript_polished").notNull().default(false),
    /** When Plaud was last asked for the cleaned version, so a missing one is not asked for every run. */
    polishCheckedAt: timestamp("polish_checked_at", { withTimezone: true }),
    recordedAt: timestamp("recorded_at", { withTimezone: true }),
    durationSeconds: integer("duration_seconds"),
    status: recordingStatusEnum("status").notNull().default("review"),
    /** Who it was filed against, once matched or chosen. */
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
    /** How the match was made, for the audit trail: "phone", "name", "chosen by Admin"… */
    matchedBy: text("matched_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("recordings_external_idx").on(t.source, t.externalId),
    index("recordings_status_idx").on(t.status, t.recordedAt),
    index("recordings_contact_idx").on(t.contactId),
  ],
);

export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const activityLog = pgTable(
  "activity_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entity: text("entity").notNull(), // lead | contact | quote | job | event
    entityId: uuid("entity_id").notNull(),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("activity_entity_idx").on(t.entity, t.entityId)],
);

// ---------- Email ingestion ----------

export const mailboxes = pgTable("mailboxes", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  emailAddress: text("email_address").notNull(),
  provider: text("provider").notNull().default("titan"),
  imapHost: text("imap_host").notNull(),
  imapPort: integer("imap_port").notNull().default(993),
  imapSecure: boolean("imap_secure").notNull().default(true),
  smtpHost: text("smtp_host").notNull(),
  smtpPort: integer("smtp_port").notNull().default(465),
  smtpSecure: boolean("smtp_secure").notNull().default(true),
  username: text("username").notNull(),
  passwordEncrypted: text("password_encrypted").notNull(),
  folder: text("folder").notNull().default("INBOX"),
  active: boolean("active").notNull().default(true),
  // IMAP cursor: only UIDs above lastUid within the same uidValidity are fetched.
  uidValidity: text("uid_validity"),
  lastUid: integer("last_uid").notNull().default(0),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  lastError: text("last_error"),
  // Sent folder: mail sent from webmail, a phone or any other client, so the CRM sees both sides.
  syncSent: boolean("sync_sent").notNull().default(true),
  sentFolder: text("sent_folder"), // detected from the server's \Sent special-use flag when null
  sentUidValidity: text("sent_uid_validity"),
  sentLastUid: integer("sent_last_uid").notNull().default(0),
  sentLastSyncAt: timestamp("sent_last_sync_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const emailThreads = pgTable(
  "email_threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    mailboxId: uuid("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    subject: text("subject").notNull().default(""),
    normalizedSubject: text("normalized_subject").notNull().default(""),
    counterpartAddress: text("counterpart_address"), // the customer's address on this thread
    firstMessageAt: timestamp("first_message_at", { withTimezone: true }).notNull(),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull(),
    messageCount: integer("message_count").notNull().default(0),
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("email_threads_mailbox_idx").on(t.mailboxId, t.lastMessageAt),
    index("email_threads_lead_idx").on(t.leadId),
    index("email_threads_contact_idx").on(t.contactId),
    index("email_threads_subject_idx").on(t.mailboxId, t.normalizedSubject, t.counterpartAddress),
  ],
);

export type EmailAddress = { name: string | null; address: string };

export const emails = pgTable(
  "emails",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    mailboxId: uuid("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => emailThreads.id, { onDelete: "cascade" }),
    direction: emailDirectionEnum("direction").notNull().default("inbound"),
    messageId: text("message_id").notNull(),
    inReplyTo: text("in_reply_to"),
    references: jsonb("references").$type<string[]>().notNull().default([]),
    imapUid: integer("imap_uid"),
    fromName: text("from_name"),
    fromAddress: text("from_address").notNull().default(""),
    to: jsonb("to").$type<EmailAddress[]>().notNull().default([]),
    cc: jsonb("cc").$type<EmailAddress[]>().notNull().default([]),
    subject: text("subject").notNull().default(""),
    textBody: text("text_body"),
    htmlBody: text("html_body"),
    snippet: text("snippet"),
    rawMime: text("raw_mime"), // full original message, preserved verbatim
    headers: jsonb("headers").$type<Record<string, string>>().notNull().default({}),
    hasAttachments: boolean("has_attachments").notNull().default(false),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    classification: emailClassificationEnum("classification").notNull().default("pending"),
    classificationError: text("classification_error"),
    classifiedAt: timestamp("classified_at", { withTimezone: true }),
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    sentById: uuid("sent_by_id").references(() => users.id, { onDelete: "set null" }),
    /** Where the CRM got it: the inbox, the mailbox's Sent folder, or sent by the CRM itself. */
    origin: text("origin").$type<"inbox" | "sent_folder" | "crm">().notNull().default("inbox"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("emails_mailbox_message_id_idx").on(t.mailboxId, t.messageId),
    index("emails_thread_idx").on(t.threadId, t.receivedAt),
    index("emails_received_idx").on(t.receivedAt),
    index("emails_classification_idx").on(t.classification),
    index("emails_from_idx").on(t.fromAddress),
  ],
);

export const emailAttachments = pgTable(
  "email_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    emailId: uuid("email_id")
      .notNull()
      .references(() => emails.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull().default("application/octet-stream"),
    size: integer("size").notNull().default(0),
    contentId: text("content_id"),
    content: customType<{ data: Buffer; driverData: Buffer }>({
      dataType() {
        return "bytea";
      },
    })("content"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("email_attachments_email_idx").on(t.emailId)],
);

export type ExtractedLead = {
  is_lead: boolean;
  confidence: number;
  contact_name: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  service: string | null;
  site_address: string | null;
  summary: string;
  urgency: "low" | "normal" | "high" | "urgent";
  next_action: string;
  reason: string;
};

export const emailClassifications = pgTable(
  "email_classifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    emailId: uuid("email_id")
      .notNull()
      .references(() => emails.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    model: text("model"),
    isLead: boolean("is_lead").notNull(),
    confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull(),
    result: jsonb("result").$type<ExtractedLead>().notNull(),
    rawResponse: jsonb("raw_response"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    durationMs: integer("duration_ms"),
    reviewedById: uuid("reviewed_by_id").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewOutcome: text("review_outcome"), // accepted | rejected | edited
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("email_classifications_email_idx").on(t.emailId)],
);

// ---------- Calendar sync (CalDAV, e.g. Titan) ----------

export const calendarConnections = pgTable("calendar_connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  serverUrl: text("server_url").notNull(),
  username: text("username").notNull(),
  passwordEncrypted: text("password_encrypted").notNull(),
  calendarUrl: text("calendar_url").notNull(),
  calendarName: text("calendar_name"),
  /** Which CRM event kinds are copied to the calendar. */
  pushKinds: jsonb("push_kinds").$type<string[]>().notNull().default(["site_visit", "job", "other"]),
  active: boolean("active").notNull().default(true),
  /** The collection's change tag at the last pull; unchanged means nothing to download. */
  ctag: text("ctag"),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One calendar object (or one occurrence of a repeating one) and the CRM event it is paired with.
 * The UID is stable, so the same event is updated in place rather than created again.
 */
export const calendarItems = pgTable(
  "calendar_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => calendarConnections.id, { onDelete: "cascade" }),
    /** Null once the CRM event is deleted: the next sync deletes it from the calendar too. */
    eventId: uuid("event_id").references(() => events.id, { onDelete: "set null" }),
    uid: text("uid").notNull(),
    /** "" for a single event; the occurrence start for one occurrence of a repeating event. */
    recurrenceId: text("recurrence_id").notNull().default(""),
    href: text("href").notNull(),
    etag: text("etag"),
    origin: text("origin").$type<"crm" | "calendar">().notNull(),
    /** The calendar's own copy, so an update keeps alarms, attendees and anything else it holds. */
    ics: text("ics"),
    /** The CRM event's updatedAt when the two were last in step. */
    syncedVersion: timestamp("synced_version", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("calendar_items_uid_idx").on(t.connectionId, t.uid, t.recurrenceId),
    index("calendar_items_event_idx").on(t.eventId),
  ],
);

// ---------- Business Brain ----------

/** Where a piece of knowledge came from, and whether Get Secure has approved it. */
const provenance = () => ({
  status: knowledgeStatusEnum("status").notNull().default("requires_review"),
  source: text("source"),
  sourceUrl: text("source_url"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  approvedById: uuid("approved_by_id").references(() => users.id, { onDelete: "set null" }),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  confidence: numeric("confidence", { precision: 3, scale: 2 }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Rules and settings the CCTV engine uses (labour rates, retention, markup…), each with provenance. */
export const brainPolicies = pgTable("brain_policies", {
  key: text("key").primaryKey(),
  /** Null when Get Secure has not set the value yet (e.g. labour cost rate). */
  value: jsonb("value"),
  ...provenance(),
});

export const suppliers = pgTable("suppliers", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  website: text("website"),
  accountStatus: text("account_status"),
  /** How trade prices arrive: manual | csv | authenticated_web | public_plus_trade | api | poa. */
  priceSourceType: text("price_source_type").notNull().default("manual"),
  /** The supplier used when no brand route says otherwise. */
  isDefault: boolean("is_default").notNull().default(false),
  integrationMethod: text("integration_method"),
  lastPriceSyncAt: timestamp("last_price_sync_at", { withTimezone: true }),
  priority: integer("priority").notNull().default(100),
  brands: jsonb("brands").$type<string[]>().notNull().default([]),
  ...provenance(),
});

/** Supplier logins, encrypted, in their own table so nothing that reads suppliers can see them. */
export const supplierCredentials = pgTable("supplier_credentials", {
  supplierId: uuid("supplier_id")
    .primaryKey()
    .references(() => suppliers.id, { onDelete: "cascade" }),
  username: text("username"),
  secretEncrypted: text("secret_encrypted").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Get Secure's supplier preference per brand: which supplier to buy a brand from, in order. Editable
 * preference data, not a fixed rule; a brand with no route falls back to the default supplier.
 */
export const supplierBrandRoutes = pgTable(
  "supplier_brand_routes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Brand/family as on the product record, e.g. "Hikvision", "TP-Link VIGI". */
    brand: text("brand").notNull(),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "cascade" }),
    /** 1 = preferred. */
    rank: integer("rank").notNull().default(1),
    /** residential | commercial | both */
    market: text("market").notNull().default("both"),
    ...provenance(),
  },
  (t) => [uniqueIndex("supplier_brand_routes_idx").on(t.brand, t.supplierId, t.market)],
);

export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    manufacturer: text("manufacturer").notNull(),
    /** Brand/family used for routing and tiers, e.g. "TP-Link VIGI", "HiLook", "WD Purple". */
    family: text("family"),
    model: text("model").notNull(),
    category: text("category").notNull(),
    formFactor: text("form_factor"),
    /** residential | commercial | both. Kept in step with the two flags below. */
    market: text("market").notNull().default("both"),
    residentialAllowed: boolean("residential_allowed").notNull().default(true),
    commercialAllowed: boolean("commercial_allowed").notNull().default(true),
    /** Get Secure residential tier: a commercial/value position, not a megapixel rule. */
    tier: text("tier"),
    tierStatus: knowledgeStatusEnum("tier_status").notNull().default("requires_review"),
    /** Apps / platforms the product works in, e.g. ["Hik-Connect"], ["VIGI app"], ["Ajax app"]. */
    ecosystem: jsonb("ecosystem").$type<string[]>().notNull().default([]),
    /** Specification fields looked for in the source but not published there. */
    unverifiedFields: jsonb("unverified_fields").$type<string[]>().notNull().default([]),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    /** Category-specific specification (resolution, bitrate, PoE, channels, capacity…). */
    specs: jsonb("specs").$type<Record<string, unknown>>().notNull().default({}),
    warranty: text("warranty"),
    alternatives: jsonb("alternatives").$type<string[]>().notNull().default([]),
    ...provenance(),
  },
  (t) => [uniqueIndex("products_model_idx").on(t.manufacturer, t.model), index("products_category_idx").on(t.category)],
);

/** One supplier's offer for a product. Cost changes go through price history and review. */
export const supplierProducts = pgTable(
  "supplier_products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "cascade" }),
    supplierSku: text("supplier_sku"),
    /** The cost quotes use: approved, ex GST. */
    costExGst: numeric("cost_ex_gst", { precision: 12, scale: 2 }),
    costIncGst: numeric("cost_inc_gst", { precision: 12, scale: 2 }),
    priceApproved: boolean("price_approved").notNull().default(false),
    /** A new cost waiting for review because it moved too much. Not used for quoting. */
    pendingCostExGst: numeric("pending_cost_ex_gst", { precision: 12, scale: 2 }),
    stock: text("stock"),
    sourceUrl: text("source_url"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    priceConfidence: numeric("price_confidence", { precision: 3, scale: 2 }),
    /** Price on application: the supplier quotes on request, so there is no list cost to use. */
    priceOnApplication: boolean("price_on_application").notNull().default(false),
    /** manual | csv | authenticated_web | public_plus_trade | api — how the current cost arrived. */
    priceSource: text("price_source"),
    /** Only trade (Get Secure account) pricing is a cost. Retail/RRP is never stored as cost. */
    priceBasis: text("price_basis").notNull().default("trade"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("supplier_products_idx").on(t.productId, t.supplierId)],
);

/**
 * Documented relationships between products: which recorder, junction box or bracket goes with a
 * camera, which drives a recorder takes, what a kit contains.
 */
export const productCompatibility = pgTable(
  "product_compatibility",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** camera_nvr | camera_junction_box | camera_wall_bracket | camera_pole_bracket | nvr_hdd | kit_component */
    kind: text("kind").notNull(),
    fromProductId: uuid("from_product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    toProductId: uuid("to_product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    quantity: integer("quantity").notNull().default(1),
    ...provenance(),
  },
  (t) => [uniqueIndex("product_compatibility_idx").on(t.kind, t.fromProductId, t.toProductId), index("product_compatibility_to_idx").on(t.toProductId)],
);

/**
 * Standard materials: what a residential install uses beyond the hardware (Cat6, connectors,
 * fixings, weatherproofing, consumables). Customers see one line; approvers see the contents and cost.
 */
export const materialsPackages = pgTable("materials_packages", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  propertyType: text("property_type").notNull().default("residential"),
  customerDescription: text("customer_description").notNull().default("Cabling and standard installation materials"),
  items: jsonb("items").$type<{ description: string; quantity?: string | null; costExGst?: number | null }[]>().notNull().default([]),
  /** Internal cost of the whole package, ex GST. Null until Get Secure sets it. */
  costExGst: numeric("cost_ex_gst", { precision: 12, scale: 2 }),
  /** What the customer is charged, ex GST. Null until Get Secure sets it. */
  sellExGst: numeric("sell_ex_gst", { precision: 12, scale: 2 }),
  isDefault: boolean("is_default").notNull().default(false),
  version: integer("version").notNull().default(1),
  ...provenance(),
});

export const productPriceHistory = pgTable(
  "product_price_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    supplierProductId: uuid("supplier_product_id")
      .notNull()
      .references(() => supplierProducts.id, { onDelete: "cascade" }),
    oldCostExGst: numeric("old_cost_ex_gst", { precision: 12, scale: 2 }),
    newCostExGst: numeric("new_cost_ex_gst", { precision: 12, scale: 2 }).notNull(),
    changedPct: numeric("changed_pct", { precision: 8, scale: 2 }),
    source: text("source").notNull(),
    /** approved | not_reviewed | rejected */
    reviewStatus: text("review_status").notNull().default("not_reviewed"),
    reviewedById: uuid("reviewed_by_id").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("price_history_offer_idx").on(t.supplierProductId, t.recordedAt)],
);

/**
 * Installation packages. Residential packages are keyed by an exact camera count and storey type
 * (RES_CCTV_SINGLE_4 …); a job with any other count is a custom installation, never mapped to the
 * nearest package. Every value is Get Secure's to enter; nothing is derived.
 */
export const installationPackages = pgTable("installation_packages", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Exact package key, e.g. RES_CCTV_SINGLE_4. */
  key: text("key").unique(),
  name: text("name").notNull(),
  propertyType: text("property_type").notNull().default("residential"),
  /** Exact camera count the package is for. */
  cameraCount: integer("camera_count"),
  /** single | double */
  storeyType: text("storey_type"),
  // Legacy range columns, kept equal to cameraCount on exact packages.
  minCameras: integer("min_cameras").notNull(),
  maxCameras: integer("max_cameras").notNull(),
  storeys: integer("storeys"),
  /** Expected labour hours. Null until Get Secure enters it. */
  estimatedHours: numeric("estimated_hours", { precision: 6, scale: 2 }),
  /** Internal labour rate, NZD/hour ex GST. Null uses the policy rate. */
  labourRate: numeric("labour_rate", { precision: 8, scale: 2 }),
  /** Customer sell allowance for the installation, ex GST. Null until Get Secure sets it. */
  allowanceExGst: numeric("allowance_ex_gst", { precision: 12, scale: 2 }),
  /** Internal cost of the standard materials for this package, ex GST. */
  materialCostExGst: numeric("material_cost_ex_gst", { precision: 12, scale: 2 }),
  materialsPackageId: uuid("materials_package_id").references(() => materialsPackages.id, { onDelete: "set null" }),
  conduitIncluded: boolean("conduit_included").notNull().default(false),
  /** Internal conduit allowance, ex GST, when conduit applies. Null until set. */
  conduitAllowanceExGst: numeric("conduit_allowance_ex_gst", { precision: 12, scale: 2 }),
  /** Internal installation-complexity allowance, ex GST. Null until set. */
  complexityAllowanceExGst: numeric("complexity_allowance_ex_gst", { precision: 12, scale: 2 }),
  includedMaterials: jsonb("included_materials").$type<string[]>().notNull().default([]),
  assumptions: jsonb("assumptions").$type<string[]>().notNull().default([]),
  exclusions: jsonb("exclusions").$type<string[]>().notNull().default([]),
  version: integer("version").notNull().default(1),
  ...provenance(),
});

/**
 * How cameras are configured to record, which sets the design bitrate used for recorder bandwidth,
 * storage and retention. Rules resolve most specific first: product, then manufacturer/family,
 * then resolution band. Values are Get Secure's; none are derived from datasheets.
 */
export const recordingProfiles = pgTable("recording_profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  /** residential | commercial | any */
  propertyType: text("property_type").notNull().default("residential"),
  isDefault: boolean("is_default").notNull().default(false),
  codec: text("codec"),
  frameRate: integer("frame_rate"),
  /** CBR | VBR */
  bitrateControl: text("bitrate_control"),
  /** continuous | event */
  recordingMode: text("recording_mode"),
  retentionTargetDays: integer("retention_target_days"),
  retentionMinimumDays: integer("retention_minimum_days"),
  rules: jsonb("rules")
    .$type<
      {
        id: string;
        scope: "product" | "family" | "resolution";
        productId?: string | null;
        family?: string | null;
        minMp?: number | null;
        maxMp?: number | null;
        designBitrateMbps: number | null;
        codec?: string | null;
        frameRate?: number | null;
        note?: string | null;
      }[]
    >()
    .notNull()
    .default([]),
  version: integer("version").notNull().default(1),
  ...provenance(),
});

/** A stored run of the CCTV engine for a lead: what went in and the decision packet that came out. */
export const cctvAssessments = pgTable(
  "cctv_assessments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    input: jsonb("input").$type<Record<string, unknown>>().notNull(),
    packet: jsonb("packet").$type<Record<string, unknown>>().notNull(),
    engineVersion: text("engine_version").notNull(),
    markupOverride: numeric("markup_override", { precision: 5, scale: 2 }),
    /** "user", "agent:<name>" or "system". */
    actor: text("actor").notNull(),
    createdById: uuid("created_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("cctv_assessments_lead_idx").on(t.leadId, t.createdAt)],
);

/**
 * Prepared customer communication waiting for Chris: email replies, follow-ups, proposed bookings.
 * Creating one is not contact with the customer and changes nothing on the lead.
 */
export const drafts = pgTable(
  "drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** email | follow_up | booking */
    kind: text("kind").notNull().default("email"),
    status: draftStatusEnum("status").notNull().default("draft"),
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    threadId: uuid("thread_id").references(() => emailThreads.id, { onDelete: "set null" }),
    assessmentId: uuid("assessment_id").references(() => cctvAssessments.id, { onDelete: "set null" }),
    toAddresses: jsonb("to_addresses").$type<string[]>().notNull().default([]),
    ccAddresses: jsonb("cc_addresses").$type<string[]>().notNull().default([]),
    subject: text("subject").notNull().default(""),
    body: text("body").notNull().default(""),
    /** "user", "agent:<name>" or "system". */
    createdByActor: text("created_by_actor").notNull(),
    createdById: uuid("created_by_id").references(() => users.id, { onDelete: "set null" }),
    reviewNote: text("review_note"),
    approvedById: uuid("approved_by_id").references(() => users.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvalHash: text("approval_hash"),
    /** Message-ID of the copy placed in the mailbox's Drafts folder, if any. */
    mailboxDraftMessageId: text("mailbox_draft_message_id"),
    sentEmailId: uuid("sent_email_id").references(() => emails.id, { onDelete: "set null" }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("drafts_status_idx").on(t.status, t.createdAt), index("drafts_lead_idx").on(t.leadId)],
);

// ---------- Relations ----------

export const usersRelations = relations(users, ({ many }) => ({
  leads: many(leads),
  jobs: many(jobs),
}));

export const contactsRelations = relations(contacts, ({ many }) => ({
  leads: many(leads),
  quotes: many(quotes),
  jobs: many(jobs),
}));

export const leadsRelations = relations(leads, ({ one, many }) => ({
  assignedTo: one(users, { fields: [leads.assignedToId], references: [users.id] }),
  contact: one(contacts, { fields: [leads.contactId], references: [contacts.id] }),
  emailThread: one(emailThreads, { fields: [leads.emailThreadId], references: [emailThreads.id] }),
  sourceEmail: one(emails, { fields: [leads.sourceEmailId], references: [emails.id] }),
  quotes: many(quotes),
  jobs: many(jobs),
  events: many(events),
  tasks: many(tasks),
}));

export const mailboxesRelations = relations(mailboxes, ({ many }) => ({
  threads: many(emailThreads),
  emails: many(emails),
}));

export const emailThreadsRelations = relations(emailThreads, ({ one, many }) => ({
  mailbox: one(mailboxes, { fields: [emailThreads.mailboxId], references: [mailboxes.id] }),
  lead: one(leads, { fields: [emailThreads.leadId], references: [leads.id] }),
  contact: one(contacts, { fields: [emailThreads.contactId], references: [contacts.id] }),
  job: one(jobs, { fields: [emailThreads.jobId], references: [jobs.id] }),
  emails: many(emails),
}));

export const emailsRelations = relations(emails, ({ one, many }) => ({
  mailbox: one(mailboxes, { fields: [emails.mailboxId], references: [mailboxes.id] }),
  thread: one(emailThreads, { fields: [emails.threadId], references: [emailThreads.id] }),
  lead: one(leads, { fields: [emails.leadId], references: [leads.id] }),
  contact: one(contacts, { fields: [emails.contactId], references: [contacts.id] }),
  sentBy: one(users, { fields: [emails.sentById], references: [users.id] }),
  attachments: many(emailAttachments),
  classifications: many(emailClassifications),
}));

export const emailAttachmentsRelations = relations(emailAttachments, ({ one }) => ({
  email: one(emails, { fields: [emailAttachments.emailId], references: [emails.id] }),
}));

export const emailClassificationsRelations = relations(emailClassifications, ({ one }) => ({
  email: one(emails, { fields: [emailClassifications.emailId], references: [emails.id] }),
  reviewedBy: one(users, { fields: [emailClassifications.reviewedById], references: [users.id] }),
}));

export const quotesRelations = relations(quotes, ({ one, many }) => ({
  contact: one(contacts, { fields: [quotes.contactId], references: [contacts.id] }),
  lead: one(leads, { fields: [quotes.leadId], references: [leads.id] }),
  approvedBy: one(users, { fields: [quotes.approvedById], references: [users.id] }),
  jobs: many(jobs),
}));

export const jobsRelations = relations(jobs, ({ one, many }) => ({
  contact: one(contacts, { fields: [jobs.contactId], references: [contacts.id] }),
  lead: one(leads, { fields: [jobs.leadId], references: [leads.id] }),
  quote: one(quotes, { fields: [jobs.quoteId], references: [quotes.id] }),
  assignedTo: one(users, { fields: [jobs.assignedToId], references: [users.id] }),
  events: many(events),
  noteEntries: many(jobNotes),
  photos: many(jobPhotos),
  tasks: many(tasks),
}));

export const eventsRelations = relations(events, ({ one }) => ({
  job: one(jobs, { fields: [events.jobId], references: [jobs.id] }),
  lead: one(leads, { fields: [events.leadId], references: [leads.id] }),
  contact: one(contacts, { fields: [events.contactId], references: [contacts.id] }),
  assignedTo: one(users, { fields: [events.assignedToId], references: [users.id] }),
}));

export const productsRelations = relations(products, ({ many }) => ({ offers: many(supplierProducts) }));
export const supplierProductsRelations = relations(supplierProducts, ({ one, many }) => ({
  product: one(products, { fields: [supplierProducts.productId], references: [products.id] }),
  supplier: one(suppliers, { fields: [supplierProducts.supplierId], references: [suppliers.id] }),
  history: many(productPriceHistory),
}));
export const suppliersRelations = relations(suppliers, ({ many }) => ({ offers: many(supplierProducts) }));
export const productPriceHistoryRelations = relations(productPriceHistory, ({ one }) => ({
  offer: one(supplierProducts, { fields: [productPriceHistory.supplierProductId], references: [supplierProducts.id] }),
}));
export const cctvAssessmentsRelations = relations(cctvAssessments, ({ one }) => ({
  lead: one(leads, { fields: [cctvAssessments.leadId], references: [leads.id] }),
  createdBy: one(users, { fields: [cctvAssessments.createdById], references: [users.id] }),
}));
export const supplierBrandRoutesRelations = relations(supplierBrandRoutes, ({ one }) => ({
  supplier: one(suppliers, { fields: [supplierBrandRoutes.supplierId], references: [suppliers.id] }),
}));

export const productCompatibilityRelations = relations(productCompatibility, ({ one }) => ({
  from: one(products, { fields: [productCompatibility.fromProductId], references: [products.id], relationName: "compat_from" }),
  to: one(products, { fields: [productCompatibility.toProductId], references: [products.id], relationName: "compat_to" }),
}));

export const draftsRelations = relations(drafts, ({ one }) => ({
  lead: one(leads, { fields: [drafts.leadId], references: [leads.id] }),
  contact: one(contacts, { fields: [drafts.contactId], references: [contacts.id] }),
  thread: one(emailThreads, { fields: [drafts.threadId], references: [emailThreads.id] }),
  assessment: one(cctvAssessments, { fields: [drafts.assessmentId], references: [cctvAssessments.id] }),
  approvedBy: one(users, { fields: [drafts.approvedById], references: [users.id] }),
  sentEmail: one(emails, { fields: [drafts.sentEmailId], references: [emails.id] }),
}));

export const calendarItemsRelations = relations(calendarItems, ({ one }) => ({
  connection: one(calendarConnections, { fields: [calendarItems.connectionId], references: [calendarConnections.id] }),
  event: one(events, { fields: [calendarItems.eventId], references: [events.id] }),
}));

export const recordingsRelations = relations(recordings, ({ one }) => ({
  contact: one(contacts, { fields: [recordings.contactId], references: [contacts.id] }),
  lead: one(leads, { fields: [recordings.leadId], references: [leads.id] }),
}));

export const jobNotesRelations = relations(jobNotes, ({ one }) => ({
  job: one(jobs, { fields: [jobNotes.jobId], references: [jobs.id] }),
  author: one(users, { fields: [jobNotes.authorId], references: [users.id] }),
}));

export const jobPhotosRelations = relations(jobPhotos, ({ one }) => ({
  job: one(jobs, { fields: [jobPhotos.jobId], references: [jobs.id] }),
  uploadedBy: one(users, { fields: [jobPhotos.uploadedById], references: [users.id] }),
}));

export const tasksRelations = relations(tasks, ({ one }) => ({
  assignedTo: one(users, { fields: [tasks.assignedToId], references: [users.id] }),
  lead: one(leads, { fields: [tasks.leadId], references: [leads.id] }),
  contact: one(contacts, { fields: [tasks.contactId], references: [contacts.id] }),
  quote: one(quotes, { fields: [tasks.quoteId], references: [quotes.id] }),
  job: one(jobs, { fields: [tasks.jobId], references: [jobs.id] }),
}));

export const notificationsRelations = relations(notifications, ({ one }) => ({
  user: one(users, { fields: [notifications.userId], references: [users.id] }),
}));

// ---------- Types ----------

export type User = typeof users.$inferSelect;
export type Contact = typeof contacts.$inferSelect;
export type Lead = typeof leads.$inferSelect;
export type Quote = typeof quotes.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type Event = typeof events.$inferSelect;
export type Activity = typeof activityLog.$inferSelect;
export type Mailbox = typeof mailboxes.$inferSelect;
export type EmailThread = typeof emailThreads.$inferSelect;
export type Email = typeof emails.$inferSelect;
export type EmailAttachment = typeof emailAttachments.$inferSelect;
export type EmailClassificationRow = typeof emailClassifications.$inferSelect;
export type JobNote = typeof jobNotes.$inferSelect;
export type JobPhoto = typeof jobPhotos.$inferSelect;
export type Recording = typeof recordings.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type CalendarConnection = typeof calendarConnections.$inferSelect;
export type CalendarItem = typeof calendarItems.$inferSelect;
export type Draft = typeof drafts.$inferSelect;
export type CctvAssessment = typeof cctvAssessments.$inferSelect;
export type ProductRow = typeof products.$inferSelect;
export type Supplier = typeof suppliers.$inferSelect;
export type SupplierBrandRoute = typeof supplierBrandRoutes.$inferSelect;
export type ProductCompatibilityRow = typeof productCompatibility.$inferSelect;
export type MaterialsPackage = typeof materialsPackages.$inferSelect;
export type RecordingProfileRow = typeof recordingProfiles.$inferSelect;
