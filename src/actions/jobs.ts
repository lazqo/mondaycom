"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { events, jobs } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { logActivity } from "@/lib/activity";
import { JOB_STATUSES } from "@/lib/constants";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { nextNumber } from "@/lib/numbering";

const optionalText = z
  .string()
  .trim()
  .max(1000)
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

const jobInput = z.object({
  title: z.string().trim().min(1, "Title is required").max(200),
  contactId: z.string().uuid("Choose a customer"),
  leadId: optionalUuid,
  quoteId: optionalUuid,
  service: optionalText,
  siteAddress: optionalText,
  assignedToId: optionalUuid,
  status: z.enum(JOB_STATUSES).optional(),
  notes: z.string().trim().max(10000).optional(),
});

export async function createJob(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  const parsed = jobInput.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");
  const id = await db.transaction(async (tx) => {
    const number = await nextNumber(tx, "jobs");
    const [row] = await tx
      .insert(jobs)
      .values({ ...parsed.data, number })
      .returning({ id: jobs.id });
    return row.id;
  });
  await logActivity({ entity: "job", entityId: id, actorId: user.id, action: "created" });
  revalidatePath("/jobs");
  return ok({ id });
}

export async function updateJob(id: string, input: unknown): Promise<ActionResult<undefined>> {
  const user = await requireUser();
  const parsed = jobInput.partial().safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");
  await db
    .update(jobs)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(jobs.id, id));
  // Keep the linked calendar event's assignee/location in sync.
  if (parsed.data.assignedToId !== undefined || parsed.data.siteAddress !== undefined || parsed.data.title) {
    const patch: Partial<typeof events.$inferInsert> = { updatedAt: new Date() };
    if (parsed.data.assignedToId !== undefined) patch.assignedToId = parsed.data.assignedToId;
    if (parsed.data.siteAddress !== undefined) patch.location = parsed.data.siteAddress;
    if (parsed.data.title) patch.title = parsed.data.title;
    await db.update(events).set(patch).where(eq(events.jobId, id));
  }
  await logActivity({
    entity: "job",
    entityId: id,
    actorId: user.id,
    action: parsed.data.status ? "status_changed" : "updated",
    detail: parsed.data,
  });
  revalidatePath("/jobs");
  revalidatePath(`/jobs/${id}`);
  revalidatePath("/calendar");
  return ok(undefined);
}

const scheduleInput = z.object({
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }),
  assignedToId: optionalUuid,
});

/** Create or replace the calendar event for a job and mark it scheduled. */
export async function scheduleJob(id: string, input: unknown): Promise<ActionResult<{ eventId: string }>> {
  const user = await requireUser();
  const parsed = scheduleInput.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");
  const startsAt = new Date(parsed.data.startsAt);
  const endsAt = new Date(parsed.data.endsAt);
  if (endsAt <= startsAt) return fail("End time must be after start time");

  const job = await db.query.jobs.findFirst({ where: eq(jobs.id, id), with: { contact: true, events: true } });
  if (!job) return fail("Job not found");
  const assignedToId = parsed.data.assignedToId === undefined ? job.assignedToId : parsed.data.assignedToId;

  const eventId = await db.transaction(async (tx) => {
    const existing = job.events[0];
    const values = {
      title: `#${job.number} ${job.title} — ${job.contact.name}`,
      location: job.siteAddress,
      startsAt,
      endsAt,
      allDay: false,
      jobId: job.id,
      assignedToId,
      updatedAt: new Date(),
    };
    let evId: string;
    if (existing) {
      await tx.update(events).set(values).where(eq(events.id, existing.id));
      evId = existing.id;
    } else {
      const [row] = await tx
        .insert(events)
        .values({ ...values, createdById: user.id })
        .returning({ id: events.id });
      evId = row.id;
    }
    await tx
      .update(jobs)
      .set({
        status: job.status === "unscheduled" ? "scheduled" : job.status,
        assignedToId,
        updatedAt: new Date(),
      })
      .where(eq(jobs.id, id));
    return evId;
  });

  await logActivity({
    entity: "job",
    entityId: id,
    actorId: user.id,
    action: "scheduled",
    detail: { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), assignedToId },
  });
  revalidatePath("/jobs");
  revalidatePath(`/jobs/${id}`);
  revalidatePath("/calendar");
  return ok({ eventId });
}

export async function unscheduleJob(id: string): Promise<ActionResult<undefined>> {
  const user = await requireUser();
  await db.transaction(async (tx) => {
    await tx.delete(events).where(eq(events.jobId, id));
    await tx.update(jobs).set({ status: "unscheduled", updatedAt: new Date() }).where(eq(jobs.id, id));
  });
  await logActivity({ entity: "job", entityId: id, actorId: user.id, action: "unscheduled" });
  revalidatePath("/jobs");
  revalidatePath(`/jobs/${id}`);
  revalidatePath("/calendar");
  return ok(undefined);
}

export async function setJobStatus(id: string, status: string) {
  return updateJob(id, { status });
}
