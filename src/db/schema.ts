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
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { LEAD_STATUSES, LEAD_SOURCES, QUOTE_STATUSES, JOB_STATUSES } from "@/lib/constants";

export { LEAD_STATUSES, LEAD_SOURCES, QUOTE_STATUSES, JOB_STATUSES };
export type { LeadStatus, LeadSource, QuoteStatus, JobStatus } from "@/lib/constants";

// ---------- Enums ----------

export const userRoleEnum = pgEnum("user_role", ["admin", "member"]);

export const leadStatusEnum = pgEnum("lead_status", LEAD_STATUSES);

export const leadSourceEnum = pgEnum("lead_source", LEAD_SOURCES);

export const quoteStatusEnum = pgEnum("quote_status", QUOTE_STATUSES);

export const jobStatusEnum = pgEnum("job_status", JOB_STATUSES);

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
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "cascade" }),
    assignedToId: uuid("assigned_to_id").references(() => users.id, { onDelete: "set null" }),
    createdById: uuid("created_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("events_starts_idx").on(t.startsAt), index("events_job_idx").on(t.jobId)],
);

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
  quotes: many(quotes),
  jobs: many(jobs),
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
}));

export const eventsRelations = relations(events, ({ one }) => ({
  job: one(jobs, { fields: [events.jobId], references: [jobs.id] }),
  assignedTo: one(users, { fields: [events.assignedToId], references: [users.id] }),
}));

// ---------- Types ----------

export type User = typeof users.$inferSelect;
export type Contact = typeof contacts.$inferSelect;
export type Lead = typeof leads.$inferSelect;
export type Quote = typeof quotes.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type Event = typeof events.$inferSelect;
export type Activity = typeof activityLog.$inferSelect;
