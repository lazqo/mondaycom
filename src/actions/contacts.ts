"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { contacts } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { logActivity } from "@/lib/activity";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { isWebsiteLeadSender, WEBSITE_SENDER_MESSAGE } from "@/lib/email/website-lead";

const optionalText = z
  .string()
  .trim()
  .max(1000)
  .transform((v) => (v === "" ? null : v))
  .nullable()
  .optional();

const contactInput = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  company: optionalText,
  email: optionalText.refine((v) => !isWebsiteLeadSender(v), WEBSITE_SENDER_MESSAGE),
  phone: optionalText,
  address: optionalText,
  notes: z.string().trim().max(10000).optional(),
});

export async function createContact(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  const parsed = contactInput.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");
  const [row] = await db.insert(contacts).values(parsed.data).returning({ id: contacts.id });
  await logActivity({ entity: "contact", entityId: row.id, actorId: user.id, action: "created" });
  revalidatePath("/contacts");
  return ok({ id: row.id });
}

export async function updateContact(id: string, input: unknown): Promise<ActionResult<undefined>> {
  const user = await requireUser();
  const parsed = contactInput.partial().safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");
  await db
    .update(contacts)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(contacts.id, id));
  await logActivity({ entity: "contact", entityId: id, actorId: user.id, action: "updated", detail: parsed.data });
  revalidatePath("/contacts");
  revalidatePath(`/contacts/${id}`);
  return ok(undefined);
}

export async function addContactNote(id: string, body: string): Promise<ActionResult<undefined>> {
  const user = await requireUser();
  const text = body.trim();
  if (!text) return fail("Write a note first");
  if (text.length > 5000) return fail("Note is too long");
  await logActivity({ entity: "contact", entityId: id, actorId: user.id, action: "note", detail: { body: text } });
  revalidatePath(`/contacts/${id}`);
  return ok(undefined);
}
