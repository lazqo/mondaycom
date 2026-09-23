"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq, isNull, max, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { contacts, jobs, leads, quotes } from "@/db/schema";
import { requireOffice as requireUser } from "@/lib/auth";
import { logActivity } from "@/lib/activity";
import { LEAD_SOURCES, LEAD_STATUSES, LEAD_URGENCIES } from "@/lib/constants";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { nextNumber } from "@/lib/numbering";
import { isWebsiteLeadSender, WEBSITE_SENDER_MESSAGE } from "@/lib/email/website-lead";

const optionalText = z
  .string()
  .trim()
  .max(500)
  .transform((v) => (v === "" ? null : v))
  .nullable()
  .optional();
const optionalDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$|^$/, "Invalid date")
  .transform((v) => (v === "" ? null : v))
  .nullable()
  .optional();
const optionalUuid = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : v))
  .pipe(z.string().uuid().nullable())
  .nullable()
  .optional();

const leadInput = z.object({
  name: z.string().trim().min(1, "Lead name is required").max(200),
  company: optionalText,
  phone: optionalText,
  email: z
    .string()
    .trim()
    .transform((v) => (v === "" ? null : v))
    .pipe(z.string().email("Invalid email").nullable())
    .nullable()
    .optional()
    .refine((v) => !isWebsiteLeadSender(v), WEBSITE_SENDER_MESSAGE),
  service: optionalText,
  site: optionalText,
  status: z.enum(LEAD_STATUSES).optional(),
  assignedToId: optionalUuid,
  followUpAt: optionalDate,
  lastContactAt: optionalDate,
  source: z.enum(LEAD_SOURCES).optional(),
  notes: z.string().trim().max(10000).optional(),
  summary: z.string().trim().max(2000).optional(),
  urgency: z
    .string()
    .trim()
    .transform((v) => (v === "" ? null : v))
    .pipe(z.enum(LEAD_URGENCIES).nullable())
    .nullable()
    .optional(),
  nextAction: z.string().trim().max(500).optional(),
});
export type LeadInput = z.infer<typeof leadInput>;

function fieldErrors(err: z.ZodError) {
  const out: Record<string, string[]> = {};
  for (const issue of err.issues) {
    const key = issue.path.join(".") || "_";
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

export async function createLead(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  const parsed = leadInput.safeParse(input);
  if (!parsed.success) return fail("Please fix the highlighted fields", fieldErrors(parsed.error));
  const [{ maxPos }] = await db.select({ maxPos: max(leads.position) }).from(leads);
  const [row] = await db
    .insert(leads)
    .values({
      ...parsed.data,
      status: parsed.data.status ?? "new",
      source: parsed.data.source ?? "other",
      position: (maxPos ?? 0) + 1,
      createdById: user.id,
    })
    .returning({ id: leads.id });
  await logActivity({ entity: "lead", entityId: row.id, actorId: user.id, action: "created" });
  revalidatePath("/leads");
  return ok({ id: row.id });
}

export async function updateLead(id: string, input: unknown): Promise<ActionResult<undefined>> {
  const user = await requireUser();
  const parsed = leadInput.partial().safeParse(input);
  if (!parsed.success) return fail("Please fix the highlighted fields", fieldErrors(parsed.error));
  const existing = await db.query.leads.findFirst({ where: eq(leads.id, id) });
  if (!existing) return fail("Lead not found");

  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const [key, value] of Object.entries(parsed.data)) {
    const before = (existing as Record<string, unknown>)[key];
    if (value !== undefined && before !== value) changes[key] = { from: before, to: value };
  }
  if (Object.keys(changes).length === 0) return ok(undefined);

  await db
    .update(leads)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(leads.id, id));
  await logActivity({
    entity: "lead",
    entityId: id,
    actorId: user.id,
    action: changes.status ? "status_changed" : "updated",
    detail: { changes },
  });
  revalidatePath("/leads");
  revalidatePath(`/leads/${id}`);
  return ok(undefined);
}

export async function setLeadStatus(id: string, status: string) {
  return updateLead(id, { status });
}

export async function archiveLead(id: string): Promise<ActionResult<undefined>> {
  const user = await requireUser();
  await db.update(leads).set({ archivedAt: new Date(), updatedAt: new Date() }).where(eq(leads.id, id));
  await logActivity({ entity: "lead", entityId: id, actorId: user.id, action: "archived" });
  revalidatePath("/leads");
  return ok(undefined);
}

export async function deleteLead(id: string): Promise<ActionResult<undefined>> {
  await requireUser();
  await db.delete(leads).where(eq(leads.id, id));
  revalidatePath("/leads");
  return ok(undefined);
}

// ---------- Convert ----------

const convertInput = z.object({
  contactMode: z.enum(["new", "existing"]),
  existingContactId: optionalUuid,
  contact: z
    .object({
      name: z.string().trim().min(1, "Contact name is required"),
      company: optionalText,
      email: optionalText.refine((v) => !isWebsiteLeadSender(v), WEBSITE_SENDER_MESSAGE),
      phone: optionalText,
      address: optionalText,
    })
    .optional(),
  createJob: z.boolean().default(true),
  job: z
    .object({
      title: z.string().trim().min(1, "Job title is required"),
      service: optionalText,
      siteAddress: optionalText,
      assignedToId: optionalUuid,
    })
    .optional(),
  createQuote: z.boolean().default(false),
  quoteTitle: optionalText,
  markWon: z.boolean().default(false),
});
export type ConvertInput = z.input<typeof convertInput>;

export async function convertLead(
  id: string,
  input: unknown,
): Promise<ActionResult<{ contactId: string; jobId: string | null; quoteId: string | null }>> {
  const user = await requireUser();
  const parsed = convertInput.safeParse(input);
  if (!parsed.success) return fail("Please fix the highlighted fields", fieldErrors(parsed.error));
  const data = parsed.data;
  const lead = await db.query.leads.findFirst({ where: eq(leads.id, id) });
  if (!lead) return fail("Lead not found");

  const result = await db.transaction(async (tx) => {
    let contactId: string;
    if (data.contactMode === "existing") {
      if (!data.existingContactId) throw new Error("Choose an existing customer");
      const c = await tx.query.contacts.findFirst({ where: eq(contacts.id, data.existingContactId) });
      if (!c) throw new Error("Customer not found");
      contactId = c.id;
    } else {
      const c = data.contact;
      if (!c) throw new Error("Contact details are required");
      const [row] = await tx
        .insert(contacts)
        .values({
          name: c.name,
          company: c.company ?? null,
          email: c.email ?? null,
          phone: c.phone ?? null,
          address: c.address ?? null,
        })
        .returning({ id: contacts.id });
      contactId = row.id;
      await logActivity({
        entity: "contact",
        entityId: contactId,
        actorId: user.id,
        action: "created",
        detail: { fromLeadId: id },
      });
    }

    let jobId: string | null = null;
    if (data.createJob && data.job) {
      const number = await nextNumber(tx, "jobs");
      const [row] = await tx
        .insert(jobs)
        .values({
          number,
          title: data.job.title,
          service: data.job.service ?? lead.service,
          siteAddress: data.job.siteAddress ?? lead.site,
          assignedToId: data.job.assignedToId ?? lead.assignedToId,
          contactId,
          leadId: id,
        })
        .returning({ id: jobs.id });
      jobId = row.id;
      await logActivity({ entity: "job", entityId: jobId, actorId: user.id, action: "created", detail: { fromLeadId: id } });
    }

    let quoteId: string | null = null;
    if (data.createQuote) {
      const number = await nextNumber(tx, "quotes");
      const [row] = await tx
        .insert(quotes)
        .values({
          number,
          title: data.quoteTitle ?? `${lead.service ?? "Quote"} for ${lead.name}`,
          contactId,
          leadId: id,
        })
        .returning({ id: quotes.id });
      quoteId = row.id;
      if (jobId) await tx.update(jobs).set({ quoteId }).where(eq(jobs.id, jobId));
      await logActivity({ entity: "quote", entityId: quoteId, actorId: user.id, action: "created", detail: { fromLeadId: id } });
    }

    await tx
      .update(leads)
      .set({
        contactId,
        convertedAt: new Date(),
        status: data.markWon ? "won" : lead.status,
        updatedAt: new Date(),
      })
      .where(eq(leads.id, id));
    await logActivity({
      entity: "lead",
      entityId: id,
      actorId: user.id,
      action: "converted",
      detail: { contactId, jobId, quoteId },
    });
    return { contactId, jobId, quoteId };
  });

  revalidatePath("/leads");
  revalidatePath(`/leads/${id}`);
  revalidatePath("/contacts");
  revalidatePath("/jobs");
  revalidatePath("/quotes");
  return ok(result);
}

export async function searchContacts(q: string) {
  await requireUser();
  const term = `%${q.trim()}%`;
  if (!q.trim()) {
    return db.query.contacts.findMany({ limit: 10, orderBy: (c, { desc }) => [desc(c.updatedAt)] });
  }
  return db
    .select()
    .from(contacts)
    .where(
      or(
        sql`${contacts.name} ilike ${term}`,
        sql`${contacts.company} ilike ${term}`,
        sql`${contacts.email} ilike ${term}`,
        sql`${contacts.phone} ilike ${term}`,
      ),
    )
    .limit(10);
}

/** Server-action wrapper used by forms that redirect after create. */
export async function createLeadAndGo(formData: FormData) {
  const res = await createLead(Object.fromEntries(formData));
  if (!res.ok) throw new Error(res.error);
  redirect(`/leads/${res.data.id}`);
}

export async function activeLeadCount() {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(leads)
    .where(and(isNull(leads.archivedAt), sql`${leads.status} not in ('won','lost')`));
  return n;
}
