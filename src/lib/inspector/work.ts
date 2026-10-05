/**
 * Internal work the CRM does on Hermes's say-so: tasks and reply drafts, with one de-duplication
 * whoever asks for them (the Inspector's router or Hermes's MCP tools). Nothing here reaches a
 * customer: a draft waits in Approvals; a task is Chris's.
 */
import { and, desc, eq, gte, inArray, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { drafts, events, inspections, inspectorActions, leads, tasks, users } from "@/db/schema";
import { dateInAppTz } from "@/lib/email/pipeline";
import type { ActionType, PlannedAction } from "./types";

/** Rows about the same lead (or, without one, the same customer). */
export type Subject = { leadId: string | null; contactId: string | null };

export function sameSubject(cols: { leadId: AnyPgColumn; contactId: AnyPgColumn }, ctx: Subject): SQL | undefined {
  if (ctx.leadId) return eq(cols.leadId, ctx.leadId);
  if (ctx.contactId) return eq(cols.contactId, ctx.contactId);
  return undefined;
}

/** The next business day after `add` working days, in the business's time zone. */
export function businessDay(from: Date, add: number): string {
  const d = new Date(from);
  let n = add;
  while (n > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = new Date(dateInAppTz(d) + "T12:00:00Z").getUTCDay();
    if (day !== 0 && day !== 6) n--;
  }
  return dateInAppTz(d);
}

/** "today", "next_business_day", a YYYY-MM-DD or an ISO date: the task's due date in the business's time zone. */
export function dueDate(due: unknown, today = dateInAppTz(new Date())): string {
  if (due === "today") return today;
  if (typeof due === "string" && /^\d{4}-\d{2}-\d{2}/.test(due)) {
    const d = due.length === 10 ? due : dateInAppTz(new Date(due));
    return d < today ? today : d;
  }
  return businessDay(new Date(), 1);
}

export async function assignee(leadId: string | null): Promise<string | null> {
  if (leadId) {
    const l = await db.query.leads.findFirst({ where: eq(leads.id, leadId), columns: { assignedToId: true } });
    if (l?.assignedToId) return l.assignedToId;
  }
  const chris = await db.query.users.findFirst({ where: and(eq(users.canApprove, true), eq(users.active, true)), columns: { id: true } });
  return chris?.id ?? null;
}

/** An open task with the same title on the same lead or customer: never a second one. */
export async function openTaskTitled(ctx: Subject, title: string) {
  const subject = sameSubject(tasks, ctx);
  if (!subject) return null;
  return db.query.tasks.findFirst({ where: and(eq(tasks.status, "open"), subject, sql`lower(${tasks.title}) = lower(${title.trim()})`), columns: { id: true, title: true } });
}

const PRICING = /\bprice the quote\b|\bcomplete (the )?costing\b/i;

/** An open pricing task on the same lead ("Price the quote for …", "… complete costing …"). */
export async function openPricingTask(ctx: Subject) {
  const subject = sameSubject(tasks, ctx);
  if (!subject) return null;
  const open = await db.query.tasks.findMany({ where: and(eq(tasks.status, "open"), subject), columns: { id: true, title: true }, limit: 50 });
  return open.find((t) => PRICING.test(t.title)) ?? null;
}

export type TaskSpec = { title: string; kind?: string; due?: unknown; detail?: string | null; ruleKey?: string | null; entityId?: string | null };

/**
 * Create a task for Chris unless the same one is already open (same title, or another pricing task
 * on the same lead). Returns the existing one when so.
 */
export async function createTask(ctx: Subject & { jobId?: string | null }, spec: TaskSpec): Promise<{ taskId: string | null; alreadyOpen: boolean; title: string }> {
  const kind = spec.kind ?? "task";
  const same = (await openTaskTitled(ctx, spec.title)) ?? (kind === "quote" && PRICING.test(spec.title) ? await openPricingTask(ctx) : null);
  if (same) return { taskId: same.id, alreadyOpen: true, title: same.title };
  const [row] = await db
    .insert(tasks)
    .values({
      title: spec.title,
      detail: spec.detail ?? null,
      dueAt: dueDate(spec.due),
      kind,
      assignedToId: await assignee(ctx.leadId),
      leadId: ctx.leadId,
      contactId: ctx.contactId,
      jobId: ctx.jobId ?? null,
      // One open task per (rule, record) is the automations' rule; Hermes's tasks differ by title, so
      // the title is part of the key and two different tasks on the same lead both exist.
      ruleKey: spec.ruleKey ? `${spec.ruleKey}:${spec.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60)}` : null,
      entityId: spec.entityId ?? ctx.jobId ?? ctx.leadId ?? ctx.contactId ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: tasks.id });
  return row ? { taskId: row.id, alreadyOpen: false, title: spec.title } : { taskId: null, alreadyOpen: true, title: spec.title };
}

/** A reply already waiting for Chris on this lead: a second is never stacked on it. */
export async function waitingDraft(leadId: string | null) {
  if (!leadId) return null;
  return db.query.drafts.findFirst({ where: and(eq(drafts.leadId, leadId), eq(drafts.kind, "email"), inArray(drafts.status, ["draft", "ready_for_review", "approved"])), columns: { id: true } });
}

const PROPOSAL_MATCH: Partial<Record<ActionType, { task: RegExp; inHand: string }>> = {
  PROPOSE_SITE_VISIT: { task: /^site visit\b|\b(arrange|book|schedule|organi[sz]e|propose)\b.*\bsite (visit|inspection)\b/i, inHand: "Site visit already awaiting arrangement." },
  PROPOSE_BOOKING: { task: /\b(arrange|schedule) the (booking|install(ation)?|job)\b|^book(ing)?\b/i, inHand: "Booking already awaiting arrangement." },
  PREPARE_REVISED_QUOTE: { task: /\brevised quote\b|\brevise the quote\b/i, inHand: "A revised quote is already in hand." },
};

/**
 * A proposal Chris has effectively already got: an open task to arrange it, the same proposal still
 * waiting for him from another email or conversation, or (for a site visit) one already booked.
 * Then nothing new is offered, and the CRM says what is already in hand.
 */
export async function alreadyInHand(a: Pick<PlannedAction, "type">, ctx: Subject & { inspectionId: string | null }, opts: { ignoreWaiting?: boolean } = {}): Promise<Record<string, unknown> | null> {
  const m = PROPOSAL_MATCH[a.type];
  if (!m) return null;
  const taskSubject = sameSubject(tasks, ctx);
  if (!taskSubject) return null;
  if (a.type === "PROPOSE_SITE_VISIT") {
    const booked = await db.query.events.findFirst({ where: and(eq(events.kind, "site_visit"), gte(events.endsAt, new Date()), sameSubject(events, ctx)), columns: { id: true, startsAt: true } });
    if (booked) return { inHand: `Site visit already booked for ${dateInAppTz(booked.startsAt)}.`, eventId: booked.id };
  }
  const open = await db.query.tasks.findMany({ where: and(eq(tasks.status, "open"), taskSubject), columns: { id: true, title: true, ruleKey: true }, limit: 50 });
  const t = open.find((x) => m.task.test(x.title) || (x.ruleKey ?? "").includes(a.type));
  if (t) return { inHand: m.inHand, taskId: t.id, taskTitle: t.title };
  if (opts.ignoreWaiting) return null;
  const waiting = await db
    .select({ id: inspectorActions.id })
    .from(inspectorActions)
    .innerJoin(inspections, eq(inspections.id, inspectorActions.inspectionId))
    .where(and(eq(inspectorActions.type, a.type), eq(inspectorActions.status, "awaiting_approval"), sql`${inspections.status} <> 'superseded'`, ctx.inspectionId ? sql`${inspectorActions.inspectionId} <> ${ctx.inspectionId}` : undefined, sameSubject(inspectorActions, ctx)))
    .orderBy(desc(inspectorActions.createdAt))
    .limit(1);
  if (waiting[0]) return { inHand: "The same proposal is already waiting for your decision.", actionId: waiting[0].id };
  return null;
}

/** The email that asks the customer the questions the Business Brain still needs, for Chris to approve. */
export function composeQuestionsEmail(firstName: string | null, ask: string[], subject: string | null): { subject: string; body: string } {
  const qs: Record<string, string> = {
    "Home or business": "Is this for your home or for a business?",
    "How many cameras, or which areas to cover": "Roughly how many cameras are you after, or which areas would you like covered (for example driveway, front door, back yard)?",
    "Single or double storey": "Is the house single or double storey?",
    "Existing cable type and condition": "Do you know what cabling the current cameras use (network cable such as Cat5/Cat6, or coax), and is it in good condition?",
    "Site address": "What's the address of the property?",
    "What they want (CCTV, alarm, access…)": "Could you tell me a bit more about what you're after (cameras, alarm, access control…)?",
  };
  const lines = ask.map((a) => `- ${qs[a] ?? a}`);
  const body = [`Hi ${firstName?.split(/\s+/)[0] ?? "there"},`, "", "Thanks for getting in touch. So I can put an accurate quote together, could you let me know:", "", ...lines, "", "Thanks,", "Chris", "Get Secure"].join("\n");
  const subj = subject ? (/^re:/i.test(subject) ? subject : `Re: ${subject}`) : "Your enquiry";
  return { subject: subj, body };
}
