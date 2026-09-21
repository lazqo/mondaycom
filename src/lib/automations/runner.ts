import { and, eq, isNotNull, notInArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { tasks, users } from "@/db/schema";
import { env } from "@/lib/env";
import { getAutomationSettings, getSetting, setSetting } from "@/lib/settings";
import { notify } from "@/lib/notifications";
import { RULES, type RuleCandidate } from "./rules";

export type RunSummary = { ranAt: string; created: number; resolved: number; open: number; perRule: Record<string, number>; durationMs: number };

const LAST_RUN_KEY = "automations_last_run";

export function todayInAppTz(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: env.APP_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/**
 * Evaluate every rule, create one open task per new (rule, entity), and auto-resolve tasks whose
 * condition no longer holds. Safe to run as often as you like.
 */
export async function runAutomations(now = new Date()): Promise<RunSummary> {
  const started = Date.now();
  const settings = await getAutomationSettings();
  const today = todayInAppTz(now);
  const candidates: RuleCandidate[] = [];
  const perRule: Record<string, number> = {};
  for (const rule of RULES) {
    const found = await rule.evaluate({ db, settings, now, today });
    perRule[rule.key] = found.length;
    candidates.push(...found);
  }

  const existing = await db.query.tasks.findMany({
    where: and(eq(tasks.status, "open"), isNotNull(tasks.ruleKey)),
    columns: { id: true, ruleKey: true, entityId: true, assignedToId: true },
  });
  const openKey = (r: string, e: string) => `${r}:${e}`;
  const openSet = new Map(existing.map((t) => [openKey(t.ruleKey!, t.entityId!), t]));
  const wanted = new Set(candidates.map((c) => openKey(c.ruleKey, c.entityId)));

  let created = 0;
  for (const c of candidates) {
    const key = openKey(c.ruleKey, c.entityId);
    if (openSet.has(key)) continue;
    // Dismissed tasks stay dismissed: don't recreate the same reminder someone waved away.
    const dismissed = await db.query.tasks.findFirst({
      where: and(eq(tasks.ruleKey, c.ruleKey), eq(tasks.entityId, c.entityId), eq(tasks.status, "dismissed")),
      columns: { id: true },
    });
    if (dismissed) continue;
    const [row] = await db
      .insert(tasks)
      .values({
        title: c.title,
        detail: c.detail,
        dueAt: c.dueAt,
        assignedToId: c.assignedToId,
        leadId: c.leadId ?? null,
        contactId: c.contactId ?? null,
        quoteId: c.quoteId ?? null,
        jobId: c.jobId ?? null,
        ruleKey: c.ruleKey,
        entityId: c.entityId,
      })
      .onConflictDoNothing()
      .returning({ id: tasks.id });
    if (!row) continue;
    created++;
    if (c.assignedToId) {
      await notify({ userId: c.assignedToId, title: c.title, body: c.detail, link: c.link, kind: "task", dedupeKey: `task:${row.id}` });
    }
  }

  const stale = existing.filter((t) => !wanted.has(openKey(t.ruleKey!, t.entityId!)));
  if (stale.length) {
    await db
      .update(tasks)
      .set({ status: "done", completedAt: now, updatedAt: now, detail: sql`coalesce(${tasks.detail}, '') || ' (resolved automatically)'` })
      .where(
        and(
          eq(tasks.status, "open"),
          notInArray(
            tasks.id,
            existing.filter((t) => wanted.has(openKey(t.ruleKey!, t.entityId!))).map((t) => t.id).concat(["00000000-0000-0000-0000-000000000000"]),
          ),
          isNotNull(tasks.ruleKey),
        ),
      );
  }

  const summary: RunSummary = {
    ranAt: now.toISOString(),
    created,
    resolved: stale.length,
    open: existing.length - stale.length + created,
    perRule,
    durationMs: Date.now() - started,
  };
  await setSetting(LAST_RUN_KEY, summary);
  return summary;
}

/** Run when the last run is older than `minIntervalMinutes` (cheap enough to call from page loads). */
export async function runAutomationsIfDue(minIntervalMinutes = 5): Promise<RunSummary | null> {
  const last = await getSetting<RunSummary>(LAST_RUN_KEY);
  if (last && Date.now() - new Date(last.ranAt).getTime() < minIntervalMinutes * 60_000) return null;
  return runAutomations();
}

export async function lastAutomationRun() {
  return getSetting<RunSummary>(LAST_RUN_KEY);
}

/** Tell the assigned staff member about a job on their calendar (in-app; email optional). */
export async function notifyJobScheduled(job: { id: string; number: number; title: string; siteAddress: string | null; assignedToId: string | null }, startsAt: Date, endsAt: Date) {
  if (!job.assignedToId) return;
  const when = `${startsAt.toLocaleString("en-NZ", { timeZone: env.APP_TIMEZONE, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}–${endsAt.toLocaleTimeString("en-NZ", { timeZone: env.APP_TIMEZONE, hour: "numeric", minute: "2-digit" })}`;
  const inserted = await notify({
    userId: job.assignedToId,
    title: `Job J-${job.number} scheduled: ${when}`,
    body: `${job.title}${job.siteAddress ? ` · ${job.siteAddress}` : ""}`,
    link: `/jobs/${job.id}`,
    kind: "job_scheduled",
    dedupeKey: `job_scheduled:${job.id}:${startsAt.toISOString()}:${job.assignedToId}`,
  });
  if (!inserted) return;
  const settings = await getAutomationSettings();
  if (!settings.notify_assignee_by_email) return;
  try {
    const user = await db.query.users.findFirst({ where: eq(users.id, job.assignedToId), columns: { email: true, name: true } });
    if (!user) return;
    const { sendInternalEmail } = await import("@/lib/email/smtp");
    await sendInternalEmail({
      to: user.email,
      subject: `Job J-${job.number} scheduled ${when}`,
      text: `Hi ${user.name},\n\nYou have been scheduled for job J-${job.number}: ${job.title}\nWhen: ${when}\nSite: ${job.siteAddress ?? "not set"}\n\nOpen it: ${env.APP_URL}/jobs/${job.id}\n\nGet Secure CRM`,
    });
  } catch (err) {
    console.warn(`[automations] email notification failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
