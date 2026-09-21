import { eq } from "drizzle-orm";
import { db } from "@/db";
import { appSettings } from "@/db/schema";
import { AUTOMATION_DEFAULTS, type AutomationSettings } from "@/lib/constants";

const KEY = "automations";

export async function getAutomationSettings(): Promise<AutomationSettings> {
  const row = await db.query.appSettings.findFirst({ where: eq(appSettings.key, KEY) });
  return { ...AUTOMATION_DEFAULTS, ...((row?.value as Partial<AutomationSettings>) ?? {}) };
}

export async function saveAutomationSettings(patch: Partial<AutomationSettings>): Promise<AutomationSettings> {
  const current = await getAutomationSettings();
  const next = { ...current, ...patch };
  await db
    .insert(appSettings)
    .values({ key: KEY, value: next, updatedAt: new Date() })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: next, updatedAt: new Date() } });
  return next;
}

export async function getSetting<T>(key: string): Promise<T | null> {
  const row = await db.query.appSettings.findFirst({ where: eq(appSettings.key, key) });
  return (row?.value as T) ?? null;
}

export async function setSetting(key: string, value: unknown) {
  await db
    .insert(appSettings)
    .values({ key, value: value as Record<string, unknown>, updatedAt: new Date() })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: value as Record<string, unknown>, updatedAt: new Date() } });
}
