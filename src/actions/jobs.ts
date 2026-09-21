"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { events, jobs, jobNotes, jobPhotos } from "@/db/schema";
import { notifyJobScheduled } from "@/lib/automations/runner";
import { logActivity as log } from "@/lib/activity";
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
  const before = await db.query.jobs.findFirst({ where: eq(jobs.id, id), columns: { status: true, doneAt: true, invoicedAt: true } });
  if (!before) return fail("Job not found");
  const statusChanged = parsed.data.status !== undefined && parsed.data.status !== before.status;
  await db
    .update(jobs)
    .set({
      ...parsed.data,
      updatedAt: new Date(),
      ...(statusChanged ? { statusChangedAt: new Date() } : {}),
      ...(statusChanged && parsed.data.status === "done" ? { doneAt: new Date() } : {}),
      ...(statusChanged && parsed.data.status === "invoiced" ? { invoicedAt: new Date(), doneAt: before.doneAt ?? new Date() } : {}),
    })
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
      kind: "job" as const,
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
  await notifyJobScheduled({ ...job, assignedToId }, startsAt, endsAt);
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

// ---------- Notes & photos ----------

export async function addJobNote(jobId: string, body: string): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  const text = body.trim();
  if (!text) return fail("Write a note first");
  if (text.length > 5000) return fail("Note is too long");
  const [row] = await db.insert(jobNotes).values({ jobId, authorId: user.id, body: text }).returning({ id: jobNotes.id });
  await log({ entity: "job", entityId: jobId, actorId: user.id, action: "note_added", detail: { noteId: row.id } });
  revalidatePath(`/jobs/${jobId}`);
  revalidatePath("/my-day");
  return ok({ id: row.id });
}

const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

export async function addJobPhoto(jobId: string, formData: FormData): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  const file = formData.get("photo");
  if (!(file instanceof File) || file.size === 0) return fail("Choose a photo first");
  if (!file.type.startsWith("image/")) return fail("Only images can be uploaded");
  if (file.size > MAX_PHOTO_BYTES) return fail("Photo is larger than 8 MB");
  const caption = String(formData.get("caption") ?? "").trim() || null;
  const content = Buffer.from(await file.arrayBuffer());
  const [row] = await db
    .insert(jobPhotos)
    .values({ jobId, uploadedById: user.id, filename: file.name || "photo.jpg", contentType: file.type, size: file.size, caption, content })
    .returning({ id: jobPhotos.id });
  await log({ entity: "job", entityId: jobId, actorId: user.id, action: "photo_added", detail: { photoId: row.id, filename: file.name } });
  revalidatePath(`/jobs/${jobId}`);
  revalidatePath("/my-day");
  return ok({ id: row.id });
}

export async function deleteJobPhoto(photoId: string): Promise<ActionResult<undefined>> {
  await requireUser();
  const [row] = await db.delete(jobPhotos).where(eq(jobPhotos.id, photoId)).returning({ jobId: jobPhotos.jobId });
  if (row) {
    revalidatePath(`/jobs/${row.jobId}`);
    revalidatePath("/my-day");
  }
  return ok(undefined);
}
