"use server";

import { revalidatePath } from "next/cache";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { notifications } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { ok, type ActionResult } from "@/lib/action-result";

export async function markNotificationRead(id: string): Promise<ActionResult<undefined>> {
  const user = await requireUser();
  await db.update(notifications).set({ readAt: new Date() }).where(and(eq(notifications.id, id), eq(notifications.userId, user.id)));
  revalidatePath("/", "layout");
  return ok(undefined);
}

export async function markAllNotificationsRead(): Promise<ActionResult<undefined>> {
  const user = await requireUser();
  await db.update(notifications).set({ readAt: new Date() }).where(and(eq(notifications.userId, user.id), isNull(notifications.readAt)));
  revalidatePath("/", "layout");
  return ok(undefined);
}
