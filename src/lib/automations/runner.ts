import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { jobs, leads, tasks, users } from "@/db/schema";
import { env } from "@/lib/env";
import { getAutomationSettings, getSetting, setSetting } from "@/lib/settings";
import { notify } from "@/lib/notifications";
import { listNextSteps } from "@/queries/next-steps";
import { RULES } from "./rules";

/**
 * The daily checklist. Nothing is created here any more: every lead and job carries one next step
 * worked out from its state (src/lib/next-step.ts), and the checklist conditions ("quote sent, no
 * answer", "job done, not invoiced") are inputs to it. A run tidies up: tasks on a lost lead or a
 * cancelled job are closed, reminders the old rules made are resolved as their conditions clear,
 * and the counts are kept for the Next steps page and the health check.
 */
export type RunSummary = {
  ranAt: string;
  /** Tasks closed because their lead was lost or their job cancelled. */
  closed: number;
  /** Old rule-made reminders resolved because the condition cleared. */
  resolved: number;
  /** Next steps overdue, due today, waiting on a customer. */
  overdue: number;
  today: number;
  waiting: number;
  /** For the health check: steps that need someone today. */
  open: number;
  /** Matches per old rule, for the Next steps page's checklist. */
  perRule: Record<string, number>;
  durationMs: number;
  // Kept for older summaries stored before the checklist replaced the rules.
  created?: number;
};

const LAST_RUN_KEY = "automations_last_run";
export const LEGACY_REPLACED_KEY = "legacy_reminders_replaced";
export const LEGACY_RULE_KEYS = RULES.map((r) => r.key);

export function todayInAppTz(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: env.APP_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Close open tasks whose record is finished: a lost or archived lead, a cancelled job. */
async function closeTasksOnFinishedRecords(now: Date): Promise<number> {
  const rows = await db
    .select({ id: tasks.id, leadStatus: leads.status, leadArchived: leads.archivedAt, jobStatus: jobs.status })
    .from(tasks)
    .leftJoin(leads, eq(tasks.leadId, leads.id))
    .leftJoin(jobs, eq(tasks.jobId, jobs.id))
    .where(and(eq(tasks.status, "open"), or(eq(leads.status, "lost"), isNotNull(leads.archivedAt), eq(jobs.status, "cancelled"))));
  if (!rows.length) return 0;
  for (const r of rows) {
    const why = r.jobStatus === "cancelled" ? "the job was cancelled" : r.leadArchived ? "the lead was archived" : "the lead was marked lost";
    await db
      .update(tasks)
      .set({ status: "done", completedAt: now, updatedAt: now, detail: sql`coalesce(${tasks.detail}, '') || ${` (closed: ${why})`}` })
      .where(and(eq(tasks.id, r.id), eq(tasks.status, "open")));
  }
  return rows.length;
}

/** Reminders the old rules made: resolve the ones whose condition no longer holds. */
async function resolveStaleLegacy(now: Date, today: string, perRule: Record<string, number>): Promise<number> {
  const existing = await db.query.tasks.findMany({ where: and(eq(tasks.status, "open"), inArray(tasks.ruleKey, LEGACY_RULE_KEYS)), columns: { id: true, ruleKey: true, entityId: true } });
  if (!existing.length) return 0;
  const settings = await getAutomationSettings();
  const wanted = new Set<string>();
  for (const rule of RULES) {
    const found = await rule.evaluate({ db, settings, now, today });
    perRule[rule.key] = found.length;
    for (const c of found) wanted.add(`${c.ruleKey}:${c.entityId}`);
  }
  const stale = existing.filter((t) => !wanted.has(`${t.ruleKey}:${t.entityId}`));
  if (stale.length) {
    await db
      .update(tasks)
      .set({ status: "done", completedAt: now, updatedAt: now, detail: sql`coalesce(${tasks.detail}, '') || ' (resolved automatically)'` })
      .where(and(eq(tasks.status, "open"), inArray(tasks.id, stale.map((t) => t.id))));
  }
  return stale.length;
}

/** Run the checklist: tidy up, recount. Safe to run as often as you like. */
export async function runAutomations(now = new Date()): Promise<RunSummary> {
  const started = Date.now();
  const today = todayInAppTz(now);
  const perRule: Record<string, number> = {};
  const closed = await closeTasksOnFinishedRecords(now);
  const resolved = await resolveStaleLegacy(now, today, perRule);
  const steps = await listNextSteps();
  const summary: RunSummary = {
    ranAt: now.toISOString(),
    closed,
    resolved,
    overdue: steps.overdue.length,
    today: steps.dueToday.length,
    waiting: steps.waiting.length,
    open: steps.overdue.length + steps.dueToday.length,
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

export type LegacySummary = { total: number; perRule: { key: string; name: string; count: number }[]; replacedAt: string | null; replacedCount: number | null };

/** The reminders the old rules left open, counted per rule, for Chris to see before they are closed. */
export async function legacyReminderSummary(): Promise<LegacySummary> {
  const rows = await db.select({ ruleKey: tasks.ruleKey, n: sql<number>`count(*)::int` }).from(tasks).where(and(eq(tasks.status, "open"), inArray(tasks.ruleKey, LEGACY_RULE_KEYS))).groupBy(tasks.ruleKey);
  const perRule = RULES.map((r) => ({ key: r.key, name: r.name, count: rows.find((x) => x.ruleKey === r.key)?.n ?? 0 })).filter((r) => r.count > 0);
  const replaced = await getSetting<{ at: string; count: number }>(LEGACY_REPLACED_KEY);
  return { total: perRule.reduce((n, r) => n + r.count, 0), perRule, replacedAt: replaced?.at ?? null, replacedCount: replaced?.count ?? null };
}

/**
 * Close every reminder the old rules made, in one go, on Chris's click: each record's next step
 * replaces them. Recorded on each task ("replaced by the record's next step") and as a setting.
 */
export async function replaceLegacyReminders(actorId: string | null, now = new Date()): Promise<{ count: number }> {
  const [row] = await db
    .update(tasks)
    .set({ status: "done", completedAt: now, updatedAt: now, detail: sql`coalesce(${tasks.detail}, '') || ' (replaced by the record''s next step)'` })
    .where(and(eq(tasks.status, "open"), inArray(tasks.ruleKey, LEGACY_RULE_KEYS)))
    .returning({ id: tasks.id })
    .then((rows) => [{ count: rows.length }]);
  await setSetting(LEGACY_REPLACED_KEY, { at: now.toISOString(), count: row.count, by: actorId });
  await runAutomations(now);
  return row;
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

