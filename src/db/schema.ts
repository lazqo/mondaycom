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
} from "@/lib/constants";

export { LEAD_STATUSES, LEAD_SOURCES, QUOTE_STATUSES, JOB_STATUSES, EMAIL_CLASSIFICATIONS, LEAD_URGENCIES, TASK_STATUSES, EVENT_KINDS };
export type { LeadStatus, LeadSource, QuoteStatus, JobStatus, EmailClassification, LeadUrgency, TaskStatus, EventKind } from "@/lib/constants";

// ---------- Enums ----------

export const userRoleEnum = pgEnum("user_role", ["admin", "member"]);

export const leadStatusEnum = pgEnum("lead_status", LEAD_STATUSES);

export const leadSourceEnum = pgEnum("lead_source", LEAD_SOURCES);

export const quoteStatusEnum = pgEnum("quote_status", QUOTE_STATUSES);

export const jobStatusEnum = pgEnum("job_status", JOB_STATUSES);
export const emailClassificationEnum = pgEnum("email_classification", EMAIL_CLASSIFICATIONS);
export const emailDirectionEnum = pgEnum("email_direction", ["inbound", "outbound"]);
export const leadUrgencyEnum = pgEnum("lead_urgency", LEAD_URGENCIES);
export const taskStatusEnum = pgEnum("task_status", TASK_STATUSES);
export const eventKindEnum = pgEnum("event_kind", EVENT_KINDS);

// ---------- Tables ----------

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: userRoleEnum("role").notNull().default("member"),
  active: boolean("active").notNull().default(true),
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
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "restrict" }),
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
    status: quoteStatusEnum("status").notNull().default("draft"),
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
    assignedToId: uuid("assigned_to_id").references(() => users.id, { onDelete: "set null" }),
    createdById: uuid("created_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("events_starts_idx").on(t.startsAt), index("events_job_idx").on(t.jobId), index("events_lead_idx").on(t.leadId)],
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
  assignedTo: one(users, { fields: [events.assignedToId], references: [users.id] }),
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
export type Task = typeof tasks.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
