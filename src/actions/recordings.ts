"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { recordings, contacts, leads } from "@/db/schema";
import { requireOffice as requireUser } from "@/lib/auth";
import { logActivity } from "@/lib/activity";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { importRecentRecordings } from "@/lib/recordings/import";
import { plaudConfigured } from "@/lib/recordings/plaud";

const id = z.string().uuid();

/** File a recording against a customer. */
export async function attachRecordingToContact(recordingId: string, contactId: string): Promise<ActionResult> {
  const user = await requireUser();
  const ids = z.object({ recordingId: id, contactId: id }).safeParse({ recordingId, contactId });
  if (!ids.success) return fail("Invalid selection");

  const contact = await db.query.contacts.findFirst({ where: eq(contacts.id, contactId), columns: { id: true, name: true } });
  if (!contact) return fail("That customer no longer exists");

  const [row] = await db
    .update(recordings)
    .set({ contactId, status: "attached", matchedBy: `chosen by ${user.name}`, updatedAt: new Date() })
    .where(eq(recordings.id, recordingId))
    .returning({ id: recordings.id, title: recordings.title });
  if (!row) return fail("That recording no longer exists");

  await logActivity({
    entity: "contact",
    entityId: contactId,
    actorId: user.id,
    action: "recording_attached",
    detail: { recordingId: row.id, title: row.title },
  });
  revalidatePath("/recordings");
  revalidatePath(`/contacts/${contactId}`);
  return ok(undefined);
}

/** File a recording against an existing lead. */
export async function attachRecordingToLead(recordingId: string, leadId: string): Promise<ActionResult> {
  const user = await requireUser();
  const ids = z.object({ recordingId: id, leadId: id }).safeParse({ recordingId, leadId });
  if (!ids.success) return fail("Invalid selection");

  const lead = await db.query.leads.findFirst({ where: eq(leads.id, leadId), columns: { id: true, contactId: true } });
  if (!lead) return fail("That lead no longer exists");

  const [row] = await db
    .update(recordings)
    .set({ leadId, contactId: lead.contactId, status: "attached", matchedBy: `chosen by ${user.name}`, updatedAt: new Date() })
    .where(eq(recordings.id, recordingId))
    .returning({ id: recordings.id, title: recordings.title });
  if (!row) return fail("That recording no longer exists");

  await logActivity({ entity: "lead", entityId: leadId, actorId: user.id, action: "recording_attached", detail: { recordingId: row.id, title: row.title } });
  revalidatePath("/recordings");
  revalidatePath(`/leads/${leadId}`);
  return ok(undefined);
}

/** Not about a customer: a note to self, a mis-fire. Keeps the transcript, clears the queue. */
export async function dismissRecording(recordingId: string): Promise<ActionResult> {
  await requireUser();
  if (!id.safeParse(recordingId).success) return fail("Invalid recording");
  await db.update(recordings).set({ status: "dismissed", updatedAt: new Date() }).where(eq(recordings.id, recordingId));
  revalidatePath("/recordings");
  return ok(undefined);
}

/** Put a dismissed recording back in the queue. */
export async function restoreRecording(recordingId: string): Promise<ActionResult> {
  await requireUser();
  if (!id.safeParse(recordingId).success) return fail("Invalid recording");
  await db.update(recordings).set({ status: "review", updatedAt: new Date() }).where(eq(recordings.id, recordingId));
  revalidatePath("/recordings");
  return ok(undefined);
}

/** Pull anything new from Plaud now, rather than waiting for the next scheduled run. */
export async function syncRecordingsNow(): Promise<ActionResult<{ imported: number; attached: number; review: number }>> {
  await requireUser();
  if (!plaudConfigured()) return fail("Plaud is not switched on. Set PLAUD_ENABLED=true on the server.");
  try {
    const s = await importRecentRecordings({});
    if (s.errors.length && s.imported === 0) return fail(s.errors[0]);
    revalidatePath("/recordings");
    return ok({ imported: s.imported, attached: s.attached, review: s.review });
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Could not reach Plaud");
  }
}
