import { db } from "@/db";
import { activityLog } from "@/db/schema";

export async function logActivity(input: {
  entity: "lead" | "contact" | "quote" | "job" | "event" | "user";
  entityId: string;
  actorId: string | null;
  action: string;
  detail?: Record<string, unknown>;
}) {
  await db.insert(activityLog).values({
    entity: input.entity,
    entityId: input.entityId,
    actorId: input.actorId,
    action: input.action,
    detail: input.detail ?? null,
  });
}
