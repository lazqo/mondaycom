"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { tasks } from "@/db/schema";
import { requireUser, requireAdmin } from "@/lib/auth";
import { runAutomations } from "@/lib/automations/runner";
import { saveAutomationSettings } from "@/lib/settings";
import { ok, fail, type ActionResult } from "@/lib/action-result";

function revalidateAll() {
  revalidatePath("/");
  revalidatePath("/dashboard");
  revalidatePath("/settings/automations");
}

const optionalUuid = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : v))
  .pipe(z.string().uuid().nullable())
  .nullable()
  .optional();

const taskInput = z.object({
  title: z.string().trim().min(1, "Title is required").max(300),
  detail: z.string().trim().max(2000).optional(),
  dueAt: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$|^$/)
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional(),
  assignedToId: optionalUuid,
  leadId: optionalUuid,
  contactId: optionalUuid,
  quoteId: optionalUuid,
  jobId: optionalUuid,
});

export async function createTask(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  const parsed = taskInput.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");
  const [row] = await db
    .insert(tasks)
    .values({ ...parsed.data, createdById: user.id })
    .returning({ id: tasks.id });
  revalidateAll();
  return ok({ id: row.id });
}

export async function setTaskStatus(id: string, status: "open" | "done" | "dismissed"): Promise<ActionResult<undefined>> {
  await requireUser();
  await db
    .update(tasks)
    .set({ status, completedAt: status === "open" ? null : new Date(), updatedAt: new Date() })
    .where(eq(tasks.id, id));
  revalidateAll();
  return ok(undefined);
}

export async function runAutomationsNow(): Promise<ActionResult<{ created: number; resolved: number; open: number }>> {
  await requireUser();
  const s = await runAutomations();
  revalidateAll();
  return ok({ created: s.created, resolved: s.resolved, open: s.open });
}

const settingsInput = z.object({
  new_lead_contact_hours: z.coerce.number().int().min(1).max(720),
  site_visit_quote_days: z.coerce.number().int().min(0).max(90),
  quote_followup_days: z.coerce.number().int().min(1).max(90),
  job_invoice_days: z.coerce.number().int().min(0).max(90),
  notify_assignee_by_email: z.coerce.boolean(),
  business_hours_start: z.coerce.number().int().min(0).max(22),
  business_hours_end: z.coerce.number().int().min(2).max(24),
}).refine((v) => v.business_hours_end > v.business_hours_start, { message: "Work day must end after it starts", path: ["business_hours_end"] });

export async function updateAutomationSettings(formData: FormData): Promise<ActionResult<undefined>> {
  await requireAdmin();
  const o = Object.fromEntries(formData) as Record<string, unknown>;
  o.notify_assignee_by_email = o.notify_assignee_by_email === "on" || o.notify_assignee_by_email === "true";
  const parsed = settingsInput.safeParse(o);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");
  await saveAutomationSettings(parsed.data);
  await runAutomations();
  revalidateAll();
  return ok(undefined);
}
