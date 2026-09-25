"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { contacts, leads } from "@/db/schema";
import { requireOffice } from "@/lib/auth";
import { logActivity } from "@/lib/activity";
import { dateInAppTz } from "@/lib/email/pipeline";
import { ok, fail, type ActionResult } from "@/lib/action-result";

const entryInput = z.object({
  target: z.enum(["lead", "contact"]),
  id: z.string().uuid(),
  type: z.enum(["note", "call"]),
  body: z.string().trim().max(5000, "That is too long for one entry"),
  direction: z.enum(["outgoing", "incoming"]).optional(),
  outcome: z.string().trim().max(200).optional(),
});
export type TimelineEntryInput = z.input<typeof entryInput>;

/** Add a note, or log a phone call, to a lead's or a customer's timeline. */
export async function addTimelineEntry(input: unknown): Promise<ActionResult<undefined>> {
  const user = await requireOffice();
  const parsed = entryInput.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");
  const d = parsed.data;
  if (d.type === "note" && !d.body) return fail("Write a note first");
  if (d.type === "call" && !d.body && !d.outcome) return fail("Say what the call was about");

  if (d.target === "lead") {
    const lead = await db.query.leads.findFirst({ where: eq(leads.id, d.id), columns: { id: true, contactId: true } });
    if (!lead) return fail("Lead not found");
    // A call is contact with the customer, so it counts for the "last contact" column.
    if (d.type === "call") await db.update(leads).set({ lastContactAt: dateInAppTz(new Date()), updatedAt: new Date() }).where(eq(leads.id, d.id));
    if (lead.contactId) revalidatePath(`/contacts/${lead.contactId}`);
  } else {
    const contact = await db.query.contacts.findFirst({ where: eq(contacts.id, d.id), columns: { id: true } });
    if (!contact) return fail("Customer not found");
  }

  await logActivity({
    entity: d.target,
    entityId: d.id,
    actorId: user.id,
    action: d.type,
    detail: d.type === "call" ? { body: d.body, direction: d.direction ?? "outgoing", outcome: d.outcome || null } : { body: d.body },
  });
  revalidatePath(d.target === "lead" ? `/leads/${d.id}` : `/contacts/${d.id}`);
  if (d.target === "lead") revalidatePath("/leads");
  return ok(undefined);
}
