"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { users } from "@/db/schema";
import { hashPassword, requireAdmin } from "@/lib/auth";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { USER_ROLES } from "@/lib/constants";

const userInput = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  email: z.string().trim().toLowerCase().email("Invalid email"),
  password: z.string().min(8, "Password must be at least 8 characters").max(200),
  role: z.enum(USER_ROLES).default("member"),
});

export async function setUserRole(id: string, role: string): Promise<ActionResult<undefined>> {
  const admin = await requireAdmin();
  const parsed = z.enum(USER_ROLES).safeParse(role);
  if (!parsed.success) return fail("Invalid role");
  if (admin.id === id && parsed.data !== "admin") return fail("You cannot remove your own admin access");
  await db.update(users).set({ role: parsed.data }).where(eq(users.id, id));
  revalidatePath("/settings/users");
  return ok(undefined);
}

export async function createUser(input: unknown): Promise<ActionResult<{ id: string }>> {
  await requireAdmin();
  const parsed = userInput.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");
  const exists = await db.query.users.findFirst({ where: eq(users.email, parsed.data.email) });
  if (exists) return fail("A user with that email already exists");
  const [row] = await db
    .insert(users)
    .values({
      name: parsed.data.name,
      email: parsed.data.email,
      role: parsed.data.role,
      passwordHash: await hashPassword(parsed.data.password),
    })
    .returning({ id: users.id });
  revalidatePath("/settings/users");
  return ok({ id: row.id });
}

export async function setUserActive(id: string, active: boolean): Promise<ActionResult<undefined>> {
  const admin = await requireAdmin();
  if (admin.id === id && !active) return fail("You cannot deactivate yourself");
  await db.update(users).set({ active }).where(eq(users.id, id));
  revalidatePath("/settings/users");
  return ok(undefined);
}

export async function resetUserPassword(id: string, password: string): Promise<ActionResult<undefined>> {
  await requireAdmin();
  if (password.length < 8) return fail("Password must be at least 8 characters");
  await db.update(users).set({ passwordHash: await hashPassword(password) }).where(eq(users.id, id));
  return ok(undefined);
}
