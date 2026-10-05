/**
 * The autonomy dial as set in the CRM (Settings → Hermes). The dial itself (classes, levels,
 * defaults, floors) is in dial.ts; this reads and saves the setting.
 */
import { getSetting, setSetting } from "@/lib/settings";
import { normaliseAutonomy, type AutonomySettings } from "./dial";

export * from "./dial";

const KEY = "hermes_autonomy";

/** The dial as set in the CRM (Settings → Hermes), with HERMES_MIN_CONFIDENCE as the old global floor. */
export async function hermesAutonomy(): Promise<AutonomySettings> {
  const raw = await getSetting<Partial<AutonomySettings>>(KEY).catch(() => null);
  const env = Number(process.env.HERMES_MIN_CONFIDENCE);
  return normaliseAutonomy(raw, env > 0 && env <= 1 ? env : undefined);
}

export async function saveHermesAutonomy(patch: Partial<AutonomySettings>): Promise<AutonomySettings> {
  const current = await hermesAutonomy();
  const next = normaliseAutonomy({ levels: { ...current.levels, ...(patch.levels ?? {}) }, thresholds: { ...current.thresholds, ...(patch.thresholds ?? {}) } });
  await setSetting(KEY, next);
  return next;
}

