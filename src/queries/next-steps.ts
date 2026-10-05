import "server-only";
/**
 * Next steps from the database: the records' state gathered in a few batched queries and handed
 * to the pure engine (src/lib/next-step.ts). Home, the Next steps page, the lead and job pages
 * and Hermes's context pack all read the same thing.
 */
import { and, desc, eq, inArray, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { commitments, contacts, drafts, emails, events, inspectorActions, jobs, leads, quotes, recordings, tasks } from "@/db/schema";
import { OPEN_JOB_STATUSES, type JobStatus, type LeadStatus, type QuoteStatus } from "@/lib/constants";
import { env } from "@/lib/env";
import { ACTION_LABELS } from "@/lib/inspector/labels";
import type { ActionType } from "@/lib/inspector/types";
import { getAutomationSettings } from "@/lib/settings";
import { isOpenStep, nextStepFor, type JobState, type LeadState, type NextStep, type StepCommitment, type StepContext, type StepDecision, type StepEvent, type StepTask } from "@/lib/next-step";
import { IDENTITY_ACTIONS } from "./inspector";
import { appDay } from "./dashboard";

export type StepRecord = { type: "lead" | "job" | "task" | "commitment"; id: string; label: string; href: string | null };
export type StepRow = { record: StepRecord; step: NextStep };

type LeadRowIn = { id: string; name: string; status: LeadStatus; nextAction: string | null; nextActionFor: LeadStatus | null; lostReason: string | null; followUpAt: string | null; followUpSetAt: Date | null; assignedToId: string | null; createdAt: Date };
type JobRowIn = { id: string; number: number; title: string; status: JobStatus; assignedToId: string | null; createdAt: Date; doneAt: Date | null };

const ids = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x))];
const inOrNone = (col: AnyPgColumn, xs: string[]): SQL => (xs.length ? inArray(col, xs) : sql`false`);

export async function stepContext(now = new Date()): Promise<StepContext> {
  return { today: appDay(now).today, now, settings: await getAutomationSettings(), tz: env.APP_TIMEZONE };
}

/** What the decision is, in the words of the queue card. */
function decisionWhat(type: string): string {
  switch (type as ActionType) {
    case "PROPOSE_SITE_VISIT":
      return "Decide: pencil in the site visit";
    case "PROPOSE_BOOKING":
      return "Decide: pencil in the booking";
    case "PREPARE_QUOTE":
    case "PREPARE_REVISED_QUOTE":
      return "Approve the quote";
    case "DRAFT_EMAIL":
    case "PREPARE_FOLLOW_UP":
      return "Approve the reply";
    default:
      return `Decide: ${ACTION_LABELS[type as ActionType] ?? type}`;
  }
}

/** Everything the engine needs for these leads and jobs, in batched queries. */
async function loadStates(leadRows: LeadRowIn[], jobRows: JobRowIn[], ctx: StepContext): Promise<{ leads: LeadState[]; jobs: JobState[] }> {
  const leadIds = leadRows.map((l) => l.id);
  const jobIds = jobRows.map((j) => j.id);
  if (!leadIds.length && !jobIds.length) return { leads: [], jobs: [] };
  const byLead = (col: AnyPgColumn) => inOrNone(col, leadIds);
  const byJob = (col: AnyPgColumn) => inOrNone(col, jobIds);
  const [taskRows, commitmentRows, actionRows, draftRows, quoteRows, eventRows, jobOfLead, lastEmail, lastCall] = await Promise.all([
    db.query.tasks.findMany({ where: and(eq(tasks.status, "open"), or(byLead(tasks.leadId), byJob(tasks.jobId))), columns: { id: true, title: true, dueAt: true, assignedToId: true, kind: true, detail: true, leadId: true, jobId: true } }),
    db.query.commitments.findMany({ where: and(eq(commitments.status, "outstanding"), or(byLead(commitments.leadId), byJob(commitments.jobId))), columns: { id: true, owner: true, ownerName: true, action: true, dueAt: true, dueText: true, leadId: true, jobId: true } }),
    // A question Hermes asked (ASK_CHRIS) never blocks and is answered from the Decisions queue: not a record's step.
    db.query.inspectorActions.findMany({ where: and(eq(inspectorActions.status, "awaiting_approval"), notInArray(inspectorActions.type, [...IDENTITY_ACTIONS, "ASK_CHRIS"]), or(byLead(inspectorActions.leadId), byJob(inspectorActions.jobId))), columns: { id: true, type: true, leadId: true, jobId: true } }),
    leadIds.length ? db.query.drafts.findMany({ where: and(inArray(drafts.leadId, leadIds), inArray(drafts.status, ["ready_for_review", "approved", "revision_requested", "draft"]), eq(drafts.kind, "email")), columns: { id: true, leadId: true, status: true } }) : [],
    leadIds.length ? db.query.quotes.findMany({ where: inArray(quotes.leadId, leadIds), columns: { id: true, number: true, status: true, sentAt: true, leadId: true }, orderBy: [desc(quotes.createdAt)] }) : [],
    db.query.events.findMany({ where: or(byLead(events.leadId), byJob(events.jobId)), columns: { id: true, kind: true, title: true, startsAt: true, endsAt: true, leadId: true, jobId: true } }),
    leadIds.length ? db.query.jobs.findMany({ where: inArray(jobs.leadId, leadIds), columns: { id: true, number: true, status: true, leadId: true }, orderBy: [desc(jobs.createdAt)] }) : [],
    leadIds.length ? db.select({ leadId: emails.leadId, at: sql<Date>`max(${emails.receivedAt})` }).from(emails).where(and(inArray(emails.leadId, leadIds), eq(emails.direction, "inbound"))).groupBy(emails.leadId) : [],
    leadIds.length ? db.select({ leadId: recordings.leadId, at: sql<Date>`max(coalesce(${recordings.recordedAt}, ${recordings.createdAt}))` }).from(recordings).where(and(inArray(recordings.leadId, leadIds), eq(recordings.status, "attached"))).groupBy(recordings.leadId) : [],
  ]);
  const group = <T extends { leadId?: string | null; jobId?: string | null }>(rows: T[]) => {
    const l = new Map<string, T[]>();
    const j = new Map<string, T[]>();
    for (const r of rows) {
      if (r.leadId) (l.get(r.leadId) ?? l.set(r.leadId, []).get(r.leadId)!).push(r);
      else if (r.jobId) (j.get(r.jobId) ?? j.set(r.jobId, []).get(r.jobId)!).push(r);
    }
    return { l, j };
  };
  const T = group(taskRows);
  const C = group(commitmentRows);
  const A = group(actionRows);
  const E = group(eventRows);
  const D = new Map<string, typeof draftRows>();
  for (const d of draftRows) if (d.leadId) (D.get(d.leadId) ?? D.set(d.leadId, []).get(d.leadId)!).push(d);
  const Q = new Map<string, typeof quoteRows>();
  for (const q of quoteRows) if (q.leadId) (Q.get(q.leadId) ?? Q.set(q.leadId, []).get(q.leadId)!).push(q);
  const J = new Map<string, typeof jobOfLead>();
  for (const j of jobOfLead) if (j.leadId) (J.get(j.leadId) ?? J.set(j.leadId, []).get(j.leadId)!).push(j);
  const lastIn = new Map<string, Date>();
  for (const r of [...lastEmail, ...lastCall]) {
    if (!r.leadId || !r.at) continue;
    const at = new Date(r.at);
    const cur = lastIn.get(r.leadId);
    if (!cur || at > cur) lastIn.set(r.leadId, at);
  }
  const tasksOf = (rows: typeof taskRows | undefined): StepTask[] => (rows ?? []).map((t) => ({ id: t.id, title: t.title, dueAt: t.dueAt, assignedToId: t.assignedToId, kind: t.kind, detail: t.detail }));
  const commitmentsOf = (rows: typeof commitmentRows | undefined): StepCommitment[] => (rows ?? []).map((c) => ({ id: c.id, owner: c.owner, ownerName: c.ownerName, action: c.action, dueAt: c.dueAt, dueText: c.dueText }));
  const eventsOf = (rows: typeof eventRows | undefined): StepEvent[] => (rows ?? []).map((e) => ({ id: e.id, kind: e.kind, title: e.title, startsAt: e.startsAt, endsAt: e.endsAt }));
  const decisionsOf = (actions: typeof actionRows | undefined, leadDrafts: typeof draftRows | undefined, leadQuotes: typeof quoteRows | undefined): StepDecision[] => [
    ...(actions ?? []).map((a): StepDecision => ({ id: a.id, type: "action", what: decisionWhat(a.type) })),
    ...(leadDrafts ?? []).map((d): StepDecision => ({ id: d.id, type: "draft", what: d.status === "approved" ? "Send the approved reply" : "Approve the reply" })),
    ...(leadQuotes ?? []).filter((q) => ["ai_prepared", "needs_review", "approved"].includes(q.status)).map((q): StepDecision => ({ id: q.id, type: "quote", what: q.status === "approved" ? `Send Q-${q.number}` : `Approve Q-${q.number}` })),
  ];
  return {
    leads: leadRows.map((l) => ({
      kind: "lead",
      id: l.id,
      name: l.name,
      status: l.status,
      nextAction: l.nextAction,
      nextActionFor: l.nextActionFor,
      lostReason: l.lostReason,
      followUpAt: l.followUpAt,
      followUpSetAt: l.followUpSetAt,
      assignedToId: l.assignedToId,
      createdAt: l.createdAt,
      lastInboundAt: lastIn.get(l.id) ?? null,
      tasks: tasksOf(T.l.get(l.id)),
      commitments: commitmentsOf(C.l.get(l.id)),
      decisions: decisionsOf(A.l.get(l.id), D.get(l.id), Q.get(l.id)),
      events: eventsOf(E.l.get(l.id)),
      quotes: (Q.get(l.id) ?? []).map((q) => ({ id: q.id, number: q.number, status: q.status as QuoteStatus, sentAt: q.sentAt })),
      jobs: (J.get(l.id) ?? []).map((j) => ({ id: j.id, number: j.number, status: j.status })),
    })),
    jobs: jobRows.map((j) => ({
      kind: "job",
      id: j.id,
      number: j.number,
      title: j.title,
      status: j.status,
      assignedToId: j.assignedToId,
      createdAt: j.createdAt,
      doneAt: j.doneAt,
      tasks: tasksOf(T.j.get(j.id)),
      commitments: commitmentsOf(C.j.get(j.id)),
      decisions: decisionsOf(A.j.get(j.id), undefined, undefined),
      events: eventsOf(E.j.get(j.id)),
    })),
  };
  void ctx;
}

const LEAD_COLS = { id: true, name: true, status: true, nextAction: true, nextActionFor: true, lostReason: true, followUpAt: true, followUpSetAt: true, assignedToId: true, createdAt: true } as const;
const JOB_COLS = { id: true, number: true, title: true, status: true, assignedToId: true, createdAt: true, doneAt: true } as const;

/** The next step of each lead, by id. */
export async function nextStepsForLeads(leadIds: string[], ctx?: StepContext): Promise<Map<string, NextStep>> {
  if (!leadIds.length) return new Map();
  const c = ctx ?? (await stepContext());
  const rows = await db.query.leads.findMany({ where: inArray(leads.id, leadIds), columns: LEAD_COLS });
  const { leads: states } = await loadStates(rows, [], c);
  return new Map(states.map((s) => [s.id, nextStepFor(s, c)]));
}

/** The next step of each job, by id. */
export async function nextStepsForJobs(jobIds: string[], ctx?: StepContext): Promise<Map<string, NextStep>> {
  if (!jobIds.length) return new Map();
  const c = ctx ?? (await stepContext());
  const rows = await db.query.jobs.findMany({ where: inArray(jobs.id, jobIds), columns: JOB_COLS });
  const { jobs: states } = await loadStates([], rows, c);
  return new Map(states.map((s) => [s.id, nextStepFor(s, c)]));
}

export async function nextStepForLead(leadId: string, ctx?: StepContext): Promise<NextStep | null> {
  return (await nextStepsForLeads([leadId], ctx)).get(leadId) ?? null;
}

export async function nextStepForJob(jobId: string, ctx?: StepContext): Promise<NextStep | null> {
  return (await nextStepsForJobs([jobId], ctx)).get(jobId) ?? null;
}

export type NextStepsList = {
  today: string;
  overdue: StepRow[];
  dueToday: StepRow[];
  later: StepRow[];
  waiting: StepRow[];
  /** Records with nothing to do (won with a job, nothing open). */
  quiet: number;
};

/**
 * Every open lead and job's next step, plus tasks and promises that belong to no lead or job
 * (a customer's, or none), sorted into overdue / today / later / waiting.
 */
export async function listNextSteps(ctx?: StepContext): Promise<NextStepsList> {
  const c = ctx ?? (await stepContext());
  const [leadRows, jobRows] = await Promise.all([
    db.query.leads.findMany({ where: and(isNull(leads.archivedAt), notInArray(leads.status, ["lost"])), columns: LEAD_COLS, orderBy: [leads.createdAt] }),
    db.query.jobs.findMany({ where: inArray(jobs.status, [...OPEN_JOB_STATUSES, "done"]), columns: JOB_COLS, orderBy: [jobs.createdAt] }),
  ]);
  const { leads: ls, jobs: js } = await loadStates(leadRows, jobRows, c);
  const rows: StepRow[] = [];
  let quiet = 0;
  for (const l of ls) {
    const step = nextStepFor(l, c);
    if (!isOpenStep(step)) {
      quiet++;
      continue;
    }
    rows.push({ record: { type: "lead", id: l.id, label: l.name, href: `/leads/${l.id}` }, step });
  }
  for (const j of js) {
    const step = nextStepFor(j, c);
    if (!isOpenStep(step)) {
      quiet++;
      continue;
    }
    rows.push({ record: { type: "job", id: j.id, label: `J-${j.number} ${j.title}`, href: `/jobs/${j.id}` }, step });
  }
  // Tasks and promises on no lead or job: a customer's, or standalone ("order more cable").
  const [loose, loosePromises] = await Promise.all([
    db.query.tasks.findMany({ where: and(eq(tasks.status, "open"), isNull(tasks.leadId), isNull(tasks.jobId)), columns: { id: true, title: true, dueAt: true, assignedToId: true, kind: true, detail: true, contactId: true, quoteId: true }, orderBy: [tasks.dueAt, tasks.createdAt], limit: 200 }),
    db.query.commitments.findMany({ where: and(eq(commitments.status, "outstanding"), isNull(commitments.leadId), isNull(commitments.jobId), sql`${commitments.contactId} is not null`), columns: { id: true, owner: true, ownerName: true, action: true, dueAt: true, dueText: true, contactId: true }, limit: 100 }),
  ]);
  const contactIds = ids([...loose.map((t) => t.contactId), ...loosePromises.map((p) => p.contactId)]);
  const names = new Map((contactIds.length ? await db.query.contacts.findMany({ where: inArray(contacts.id, contactIds), columns: { id: true, name: true } }) : []).map((x) => [x.id, x.name]));
  for (const t of loose) {
    const overdue = !!t.dueAt && t.dueAt < c.today;
    rows.push({
      record: t.contactId ? { type: "task", id: t.id, label: names.get(t.contactId) ?? "Customer", href: `/contacts/${t.contactId}` } : { type: "task", id: t.id, label: "", href: t.quoteId ? `/quotes/${t.quoteId}` : null },
      step: { what: t.title, why: t.detail ? t.detail.slice(0, 80) : null, due: t.dueAt, at: null, overdue, waiting: false, kind: "task", source: { type: "task", id: t.id }, assignedToId: t.assignedToId },
    });
  }
  for (const p of loosePromises) {
    const who = p.contactId ? (names.get(p.contactId) ?? "Customer") : "Customer";
    const state: LeadState = { kind: "lead", id: p.id, name: who, status: "contacted", nextAction: null, nextActionFor: null, lostReason: null, followUpAt: null, followUpSetAt: null, assignedToId: null, createdAt: c.now, lastInboundAt: null, tasks: [], commitments: [{ id: p.id, owner: p.owner, ownerName: p.ownerName, action: p.action, dueAt: p.dueAt, dueText: p.dueText }], decisions: [], events: [], quotes: [], jobs: [] };
    const step = nextStepFor(state, c);
    if (step.kind === "commitment" || step.kind === "chase" || step.kind === "waiting") rows.push({ record: { type: "commitment", id: p.id, label: who, href: p.contactId ? `/contacts/${p.contactId}` : null }, step });
  }
  // Specific work first (a decision, a promise, a task), the checklist's generic steps after it.
  const KIND_ORDER: Record<string, number> = { commitment: 0, decision: 1, chase: 2, task: 3, typed: 4, appointment: 5, checklist: 6, stage: 7, waiting: 8 };
  const byKind = (a: StepRow, b: StepRow) => (KIND_ORDER[a.step.kind] ?? 9) - (KIND_ORDER[b.step.kind] ?? 9);
  const byDue = (a: StepRow, b: StepRow) => (a.step.due ?? "9999").localeCompare(b.step.due ?? "9999") || (a.step.at ?? "").localeCompare(b.step.at ?? "") || byKind(a, b) || a.record.label.localeCompare(b.record.label);
  const overdue = rows.filter((r) => r.step.overdue).sort(byDue);
  const dueToday = rows.filter((r) => !r.step.overdue && !r.step.waiting && r.step.due === c.today).sort((a, b) => byKind(a, b) || (a.step.at ?? "").localeCompare(b.step.at ?? "") || a.record.label.localeCompare(b.record.label));
  const later = rows.filter((r) => !r.step.overdue && !r.step.waiting && r.step.due !== c.today).sort(byDue);
  const waiting = rows.filter((r) => r.step.waiting).sort(byDue);
  return { today: c.today, overdue, dueToday, later, waiting, quiet };
}
