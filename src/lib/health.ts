import { and, count, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { emails } from "@/db/schema";
import { env } from "@/lib/env";
import { lastAutomationRun } from "@/lib/automations/runner";

export type Health = {
  ok: boolean;
  time: string;
  version: string;
  db: "up" | "down";
  ingestion: { mode: "in-process" | "worker" | "off"; mailboxes: { address: string; active: boolean; lastSyncAt: string | null; minutesSinceSync: number | null; lastError: string | null; stale: boolean }[] };
  emails: { pending: number; needsReview: number; errors: number };
  automations: { lastRunAt: string | null; minutesSinceRun: number | null; open: number | null };
  ai: { provider: "anthropic" | "rules"; model: string | null };
  warnings: string[];
};

const STALE_MINUTES = 30;

export async function getHealth(): Promise<Health> {
  const warnings: string[] = [];
  let dbUp: "up" | "down" = "up";
  try {
    await db.execute(sql`select 1`);
  } catch {
    dbUp = "down";
  }
  const now = Date.now();
  let boxes: Health["ingestion"]["mailboxes"] = [];
  let pending = 0;
  let needsReview = 0;
  let errors = 0;
  let auto: Health["automations"] = { lastRunAt: null, minutesSinceRun: null, open: null };
  if (dbUp === "up") {
    const rows = await db.query.mailboxes.findMany({ columns: { emailAddress: true, active: true, lastSyncAt: true, lastError: true } });
    boxes = rows.map((m) => {
      const mins = m.lastSyncAt ? Math.round((now - m.lastSyncAt.getTime()) / 60000) : null;
      const stale = m.active && (mins === null || mins > STALE_MINUTES);
      if (stale) warnings.push(`Mailbox ${m.emailAddress} has not synced for ${mins === null ? "ever" : `${mins} min`}`);
      if (m.lastError) warnings.push(`Mailbox ${m.emailAddress}: ${m.lastError}`);
      return { address: m.emailAddress, active: m.active, lastSyncAt: m.lastSyncAt?.toISOString() ?? null, minutesSinceSync: mins, lastError: m.lastError, stale };
    });
    const [[p], [r], [e]] = await Promise.all([
      db.select({ n: count() }).from(emails).where(and(eq(emails.direction, "inbound"), eq(emails.classification, "pending"))),
      db.select({ n: count() }).from(emails).where(and(eq(emails.direction, "inbound"), eq(emails.classification, "needs_review"))),
      db.select({ n: count() }).from(emails).where(and(eq(emails.direction, "inbound"), eq(emails.classification, "error"))),
    ]);
    pending = Number(p.n);
    needsReview = Number(r.n);
    errors = Number(e.n);
    if (pending > 20) warnings.push(`${pending} emails are waiting to be classified`);
    const last = await lastAutomationRun();
    const mins = last ? Math.round((now - new Date(last.ranAt).getTime()) / 60000) : null;
    auto = { lastRunAt: last?.ranAt ?? null, minutesSinceRun: mins, open: last?.open ?? null };
    if (mins !== null && mins > 60) warnings.push(`Reminder rules last ran ${mins} min ago`);
  } else {
    warnings.push("Database is unreachable");
  }
  const aiLive = env.AI_PROVIDER === "anthropic" || (env.AI_PROVIDER === "auto" && !!env.ANTHROPIC_API_KEY);
  const mode: Health["ingestion"]["mode"] = env.INGEST_IN_PROCESS ? "in-process" : process.env.PROCESS_TYPE === "worker" ? "worker" : "off";
  if (mode === "off" && boxes.some((b) => b.active)) warnings.push("Email ingestion is not running in this process (INGEST_IN_PROCESS is off and this is not the worker)");
  return {
    ok: dbUp === "up",
    time: new Date().toISOString(),
    version: process.env.APP_VERSION ?? process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? "dev",
    db: dbUp,
    ingestion: { mode, mailboxes: boxes },
    emails: { pending, needsReview, errors },
    automations: auto,
    ai: { provider: aiLive ? "anthropic" : "rules", model: aiLive ? env.AI_MODEL : null },
    warnings,
  };
}
