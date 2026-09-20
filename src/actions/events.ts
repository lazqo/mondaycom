"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { events } from "@/db/schema";
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
  const [row] = await db
    .insert(events)
    .values({ ...d, startsAt, endsAt, createdById: user.id })
    .returning({ id: events.id });
  await logActivity({ entity: "event", entityId: row.id, actorId: user.id, action: "created" });
  revalidatePath("/calendar");
  return ok({ id: row.id });
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
