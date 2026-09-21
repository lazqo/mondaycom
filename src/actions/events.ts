"use server";

import { revalidatePath } from "next/cache";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { events, jobs, leads } from "@/db/schema";
import { notifyJobScheduled } from "@/lib/automations/runner";
import { EVENT_KINDS } from "@/lib/constants";
import { requireUser } from "@/lib/auth";
import { logActivity } from "@/lib/activity";
import { ok, fail, type ActionResult } from "@/lib/action-result";

const optionalText = z
  .string()
  .trim()
  .max(2000)
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

const eventInput = z.object({
  title: z.string().trim().min(1, "Title is required").max(200),
  description: optionalText,
  location: optionalText,
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }),
  allDay: z.boolean().default(false),
  assignedToId: optionalUuid,
  kind: z.enum(EVENT_KINDS).optional(),
  leadId: optionalUuid,
});
export type EventInput = z.input<typeof eventInput>;

export async function createEvent(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  const parsed = eventInput.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");
  const d = parsed.data;
  const startsAt = new Date(d.startsAt);
  const endsAt = new Date(d.endsAt);
  if (endsAt <= startsAt) return fail("End time must be after start time");
  const kind = d.kind ?? (d.leadId ? "site_visit" : "other");
  const [row] = await db
    .insert(events)
    .values({ ...d, kind, startsAt, endsAt, createdById: user.id })
    .returning({ id: events.id });
  if (d.leadId && kind === "site_visit") {
    // Booking a site visit moves a New/Contacted lead along.
    await db
      .update(leads)
      .set({ status: sql`case when ${leads.status} in ('new','contacted') then 'site_visit'::lead_status else ${leads.status} end`, updatedAt: new Date() })
      .where(eq(leads.id, d.leadId));
    await logActivity({ entity: "lead", entityId: d.leadId, actorId: user.id, action: "site_visit_scheduled", detail: { eventId: row.id, startsAt: d.startsAt } });
    revalidatePath(`/leads/${d.leadId}`);
    revalidatePath("/leads");
  }
  await logActivity({ entity: "event", entityId: row.id, actorId: user.id, action: "created" });
  revalidatePath("/calendar");
  revalidatePath("/dashboard");
  return ok({ id: row.id });
}

/** Drag-and-drop: move an event (job or otherwise) to a new time and optionally a new technician. */
export async function moveEvent(id: string, input: { startsAt: string; endsAt: string; assignedToId?: string | null }): Promise<ActionResult<undefined>> {
  const user = await requireUser();
  const startsAt = new Date(input.startsAt);
  const endsAt = new Date(input.endsAt);
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) return fail("Invalid time range");
  const ev = await db.query.events.findFirst({ where: eq(events.id, id), with: { job: true } });
  if (!ev) return fail("Event not found");
  const assignedToId = input.assignedToId === undefined ? ev.assignedToId : input.assignedToId;
  await db.transaction(async (tx) => {
    await tx.update(events).set({ startsAt, endsAt, assignedToId, updatedAt: new Date() }).where(eq(events.id, id));
    if (ev.jobId) {
      await tx.update(jobs).set({ assignedToId, updatedAt: new Date() }).where(eq(jobs.id, ev.jobId));
      await logActivity({ entity: "job", entityId: ev.jobId, actorId: user.id, action: "rescheduled", detail: { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), assignedToId } });
    }
  });
  if (ev.job) await notifyJobScheduled({ ...ev.job, assignedToId }, startsAt, endsAt);
  revalidatePath("/calendar");
  revalidatePath("/dashboard");
  revalidatePath("/my-day");
  if (ev.jobId) revalidatePath(`/jobs/${ev.jobId}`);
  return ok(undefined);
}

export async function updateEvent(id: string, input: unknown): Promise<ActionResult<undefined>> {
  const user = await requireUser();
  const parsed = eventInput.partial().safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");
  const d = parsed.data;
  const patch: Partial<typeof events.$inferInsert> = { ...d, startsAt: undefined, endsAt: undefined, updatedAt: new Date() };
  if (d.startsAt) patch.startsAt = new Date(d.startsAt);
  if (d.endsAt) patch.endsAt = new Date(d.endsAt);
  if (patch.startsAt && patch.endsAt && patch.endsAt <= patch.startsAt) return fail("End time must be after start time");
  await db.update(events).set(patch).where(eq(events.id, id));
  await logActivity({ entity: "event", entityId: id, actorId: user.id, action: "updated" });
  revalidatePath("/calendar");
  return ok(undefined);
}

export async function deleteEvent(id: string): Promise<ActionResult<undefined>> {
  const user = await requireUser();
  const ev = await db.query.events.findFirst({ where: eq(events.id, id) });
  if (!ev) return fail("Event not found");
  if (ev.jobId) return fail("This event belongs to a job. Unschedule the job instead.");
  await db.delete(events).where(eq(events.id, id));
  await logActivity({ entity: "event", entityId: id, actorId: user.id, action: "deleted" });
  revalidatePath("/calendar");
  return ok(undefined);
}
