/**
 * Putting something in the calendar. The one path for a site visit, a job or any other appointment,
 * whether Chris books it on the calendar page or accepts a slot Hermes proposed. Only a person can
 * book: an agent actor is refused here, whatever asked for it.
 */
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { events, leads } from "@/db/schema";
import { logActivity } from "@/lib/activity";
import { queueCalendarSync } from "@/lib/calendar/sync";
import { type Actor, GuardrailError } from "@/lib/guard/actor";
import type { EventKind } from "@/lib/constants";

export type BookingInput = {
  kind: EventKind;
  title: string;
  description?: string | null;
  location?: string | null;
  startsAt: Date;
  endsAt: Date;
  allDay?: boolean;
  leadId?: string | null;
  contactId?: string | null;
  jobId?: string | null;
  assignedToId?: string | null;
  /** Where it came from, for the activity record ("calendar", "hermes_proposal"). */
  via?: string;
};

export async function bookEvent(input: BookingInput, actor: Actor): Promise<{ id: string }> {
  if (actor.kind !== "human") throw new GuardrailError("Only a person can put something in the calendar.");
  if (input.endsAt <= input.startsAt) throw new Error("End time must be after start time");
  const [row] = await db
    .insert(events)
    .values({
      title: input.title,
      description: input.description ?? null,
      location: input.location ?? null,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      allDay: input.allDay ?? false,
      kind: input.kind,
      leadId: input.leadId ?? null,
      contactId: input.contactId ?? null,
      jobId: input.jobId ?? null,
      assignedToId: input.assignedToId ?? null,
      createdById: actor.userId,
    })
    .returning({ id: events.id });
  if (input.leadId && input.kind === "site_visit") {
    // Booking a site visit moves a New/Contacted lead along.
    await db
      .update(leads)
      .set({ status: sql`case when ${leads.status} in ('new','contacted') then 'site_visit'::lead_status else ${leads.status} end`, updatedAt: new Date() })
      .where(eq(leads.id, input.leadId));
    await logActivity({ entity: "lead", entityId: input.leadId, actorId: actor.userId, action: "site_visit_scheduled", detail: { eventId: row.id, startsAt: input.startsAt.toISOString(), via: input.via ?? null } });
  } else if (input.kind !== "site_visit" && (input.leadId || input.contactId)) {
    await logActivity({ entity: input.leadId ? "lead" : "contact", entityId: (input.leadId ?? input.contactId)!, actorId: actor.userId, action: "booking_scheduled", detail: { eventId: row.id, title: input.title, startsAt: input.startsAt.toISOString(), via: input.via ?? null } });
  }
  await logActivity({ entity: "event", entityId: row.id, actorId: actor.userId, action: "created" });
  queueCalendarSync();
  return { id: row.id };
}
