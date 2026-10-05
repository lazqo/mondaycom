"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { AUTONOMY_LEVELS, DIAL_CLASSES, saveHermesAutonomy, type AutonomySettings } from "@/lib/hermes/autonomy";

const input = z.object({
  levels: z.partialRecord(z.enum(DIAL_CLASSES), z.enum(AUTONOMY_LEVELS)).default({}),
  thresholds: z.partialRecord(z.enum(DIAL_CLASSES), z.coerce.number().min(0.3).max(1)).default({}),
});

/** Chris sets how far Hermes goes on its own, by class (the floor in code never moves). */
export async function saveHermesAutonomyAction(raw: unknown): Promise<ActionResult<AutonomySettings>> {
  await requireAdmin();
  const parsed = input.safeParse(raw);
  if (!parsed.success) return fail(`${parsed.error.issues[0]?.path.join(".")}: ${parsed.error.issues[0]?.message}`);
  try {
    const next = await saveHermesAutonomy(parsed.data as Partial<AutonomySettings>);
    revalidatePath("/settings/hermes");
    return ok(next);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
