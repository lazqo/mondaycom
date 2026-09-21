"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { users } from "@/db/schema";
import { createSession, hashPassword, requireAdmin } from "@/lib/auth";
import { hasAnyUser, patchSetupState } from "@/lib/setup";
import { ok, type ActionResult } from "@/lib/action-result";

const firstAdmin = z
  .object({
    name: z.string().trim().min(1, "Your name is required").max(120),
    email: z.string().trim().toLowerCase().email("Enter a valid email"),
    password: z.string().min(10, "Use at least 10 characters").max(200),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, { message: "Passwords do not match", path: ["confirm"] });

export type FirstAdminState = { error?: string } | undefined;

/** Creates the very first admin. Only works while the users table is empty. */
export async function createFirstAdmin(_prev: FirstAdminState, formData: FormData): Promise<FirstAdminState> {
  if (await hasAnyUser()) return { error: "An account already exists. Sign in instead." };
  const parsed = firstAdmin.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const [row] = await db
    .insert(users)
    .values({ name: parsed.data.name, email: parsed.data.email, passwordHash: await hashPassword(parsed.data.password), role: "admin" })
    .returning({ id: users.id });
  await createSession(row.id);
  redirect("/setup");
}

export async function confirmSetupStep(step: "ai" | "hours"): Promise<ActionResult<undefined>> {
  await requireAdmin();
  await patchSetupState(step === "ai" ? { aiConfirmedAt: new Date().toISOString() } : { hoursConfirmedAt: new Date().toISOString() });
  revalidatePath("/setup");
  return ok(undefined);
}

export async function completeSetup(): Promise<ActionResult<undefined>> {
  await requireAdmin();
  await patchSetupState({ completedAt: new Date().toISOString() });
  revalidatePath("/setup");
  revalidatePath("/dashboard");
  return ok(undefined);
}

export async function reopenSetup(): Promise<ActionResult<undefined>> {
  await requireAdmin();
  await patchSetupState({ completedAt: undefined });
  revalidatePath("/setup");
  revalidatePath("/dashboard");
  return ok(undefined);
}

