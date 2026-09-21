import { sql } from "drizzle-orm";
import { db } from "@/db";
import { notifications } from "@/db/schema";

export type NotifyInput = {
  userId: string;
  title: string;
  body?: string | null;
  link?: string | null;
  kind?: string;
  /** Same (user, dedupeKey) is inserted once. */
  dedupeKey?: string | null;
};

/** In-app notification. Returns true when a new row was inserted. */
export async function notify(input: NotifyInput): Promise<boolean> {
  const rows = await db
    .insert(notifications)
    .values({
      userId: input.userId,
      title: input.title,
      body: input.body ?? null,
      link: input.link ?? null,
      kind: input.kind ?? "info",
      dedupeKey: input.dedupeKey ?? null,
    })
    .onConflictDoNothing({ target: [notifications.userId, notifications.dedupeKey], where: sql`dedupe_key is not null` })
    .returning({ id: notifications.id });
  return rows.length > 0;
}
