/**
 * One next step per record. A lead or job carries exactly one "what, who, when", worked out from
 * its state each time it is read, so anything that happens on the record (a reply, a call, a
 * recording, a visit held, a quote approved) supersedes the old step by changing the inputs:
 *
 *   1. the earliest-due of: something we promised the customer (a commitment), a decision
 *      waiting on Chris (a proposal, a prepared reply or quote), Chris's own typed next action,
 *      an open task (Hermes's or a person's), an appointment on the calendar, or a customer's
 *      overdue promise to chase; on the same day, in that order;
 *   2. (a question Hermes asked never blocks and lives in the Decisions queue, so it is not here);
 *   3. otherwise "nothing until the customer …" while a promise of theirs stands, or the daily
 *      checklist, timed from Settings → Next steps (a new lead not contacted, a visit held with no
 *      quote, a quote sent with no answer, a job done and not invoiced, a follow-up date reached);
 *   4. otherwise the stage default ("Book the site visit", "Prepare the quote").
 *
 * A follow-up date set before the customer's latest email or call no longer applies: what Hermes
 * made from that contact (a task, a commitment, a proposal) is the step instead.
 *
 * Plain module (server and client): no database, no I/O.
 */
import type { AutomationSettings, JobStatus, LeadStatus, QuoteStatus } from "@/lib/constants";
import { typedNextAction } from "@/lib/leads/next-action";

export type StepKind = "decision" | "commitment" | "typed" | "task" | "appointment" | "chase" | "waiting" | "checklist" | "stage" | "closed" | "none";

export type NextStep = {
  /** What to do, in Chris's words: "Call Dean Walker", "Approve Q-1006", "Site visit Thu 3 pm". */
  what: string;
  /** Why this is the step: "you promised it on the call", "quote sent 6 days ago, no answer". */
  why: string | null;
  /** YYYY-MM-DD it is due; null when nothing is due yet. */
  due: string | null;
  /** The instant, for an appointment. */
  at: string | null;
  overdue: boolean;
  /** Nothing for us until the customer acts. */
  waiting: boolean;
  kind: StepKind;
  /** The row the step comes from, for Done / Dismiss; null for derived steps. */
  source: { type: "task" | "commitment" | "action" | "draft" | "quote" | "event"; id: string } | null;
  assignedToId: string | null;
};

export type StepTask = { id: string; title: string; dueAt: string | null; assignedToId: string | null; kind: string; detail: string | null };
export type StepCommitment = { id: string; owner: string; ownerName: string | null; action: string; dueAt: Date | string | null; dueText: string | null };
export type StepDecision = { id: string; type: "action" | "draft" | "quote"; what: string };
export type StepEvent = { id: string; kind: string; title: string; startsAt: Date | string; endsAt: Date | string };
export type StepQuote = { id: string; number: number; status: QuoteStatus; sentAt: Date | string | null };

export type LeadState = {
  kind: "lead";
  id: string;
  name: string;
  status: LeadStatus;
  nextAction: string | null;
  nextActionFor: LeadStatus | null;
  lostReason: string | null;
  followUpAt: string | null;
  followUpSetAt: Date | string | null;
  assignedToId: string | null;
  createdAt: Date | string;
  /** The customer's latest email or recorded call on this lead. */
  lastInboundAt: Date | string | null;
  tasks: StepTask[];
  commitments: StepCommitment[];
  decisions: StepDecision[];
  events: StepEvent[];
  quotes: StepQuote[];
  jobs: { id: string; number: number; status: JobStatus }[];
};

export type JobState = {
  kind: "job";
  id: string;
  number: number;
  title: string;
  status: JobStatus;
  assignedToId: string | null;
  createdAt: Date | string;
  doneAt: Date | string | null;
  tasks: StepTask[];
  commitments: StepCommitment[];
  decisions: StepDecision[];
  events: StepEvent[];
};

export type RecordState = LeadState | JobState;

export type StepSettings = Pick<AutomationSettings, "new_lead_contact_hours" | "site_visit_quote_days" | "quote_followup_days" | "job_invoice_days">;
export type StepContext = { today: string; now: Date; settings: StepSettings; tz?: string };

const DEFAULT_TZ = "Pacific/Auckland";
const HOUR = 3600_000;

/** YYYY-MM-DD of an instant in the business's time zone. */
export function dayOf(d: Date | string, tz = DEFAULT_TZ): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(d));
}

export function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n, 12)).toISOString().slice(0, 10);
}

const toDate = (d: Date | string | null | undefined) => (d ? new Date(d) : null);

/** "today", "tomorrow", "Fri 10 Oct", or "was due 3 Oct". */
export function dueLabel(step: Pick<NextStep, "due" | "at" | "overdue" | "waiting">, today: string, tz = DEFAULT_TZ): string | null {
  if (step.at) {
    const d = new Date(step.at);
    const day = dayOf(d, tz);
    const time = d.toLocaleTimeString("en-NZ", { timeZone: tz, hour: "numeric", minute: "2-digit" });
    if (day === today) return `today ${time}`;
    if (day === addDays(today, 1)) return `tomorrow ${time}`;
    return `${d.toLocaleDateString("en-NZ", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).replace(",", "")} ${time}`;
  }
  if (!step.due) return step.waiting ? "waiting" : null;
  const [y, m, d] = step.due.split("-").map(Number);
  const text = new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-NZ", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).replace(",", "");
  if (step.overdue) return `was due ${text.replace(/^\w+ /, "")}`;
  if (step.due === today) return "today";
  if (step.due === addDays(today, 1)) return "tomorrow";
  return step.waiting ? `by ${text}` : text;
}

type Candidate = NextStep & { rank: number };

const RANK = { commitment: 0, decision: 1, typed: 2, task: 3, appointment: 4, chase: 5, checklist: 6, waiting: 7, stage: 8 } as const;

function candidate(kind: Exclude<StepKind, "closed" | "none">, what: string, why: string | null, opts: { due?: string | null; at?: Date | string | null; source?: NextStep["source"]; assignedToId?: string | null; waiting?: boolean; today: string }): Candidate {
  const at = opts.at ? new Date(opts.at).toISOString() : null;
  const due = opts.due ?? null;
  return { kind, what, why, due, at, overdue: !!due && due < opts.today && !opts.waiting, waiting: !!opts.waiting, source: opts.source ?? null, assignedToId: opts.assignedToId ?? null, rank: RANK[kind] };
}

/**
 * The one that wins: overdue first (oldest), then today, then dated; then specific work with no
 * date; then waiting on the customer; a stage default only when there is nothing else.
 */
function pick(cands: Candidate[]): Candidate | null {
  const group = (c: Candidate) => (c.waiting ? 2 : c.due ? 0 : c.kind === "stage" ? 3 : 1);
  const sorted = [...cands].sort((a, b) => group(a) - group(b) || (a.due ?? "").localeCompare(b.due ?? "") || a.rank - b.rank);
  return sorted[0] ?? null;
}

function firstName(name: string) {
  return name.split(/\s+/)[0] || name;
}

/** Candidates every record has: decisions, our commitments, tasks, appointments, the customer's promises. */
function sharedCandidates(r: RecordState, ctx: StepContext, who: string): { cands: Candidate[]; specific: boolean; waitingOn: Candidate | null } {
  const tz = ctx.tz ?? DEFAULT_TZ;
  const cands: Candidate[] = [];
  const assignee = r.assignedToId;
  for (const d of r.decisions) cands.push(candidate("decision", d.what, "waiting on your decision", { due: ctx.today, source: { type: d.type, id: d.id }, assignedToId: assignee, today: ctx.today }));
  let waitingOn: Candidate | null = null;
  for (const c of r.commitments) {
    const dueAt = toDate(c.dueAt);
    const due = dueAt ? dayOf(dueAt, tz) : null;
    if (c.owner === "customer") {
      const name = c.ownerName ?? who;
      if (due && due < ctx.today) cands.push(candidate("chase", `Chase ${name}: ${c.action}`, `they said ${c.dueText ?? `by ${due}`}, nothing yet`, { due: ctx.today, source: { type: "commitment", id: c.id }, assignedToId: assignee, today: ctx.today }));
      else {
        const w = candidate("waiting", `Nothing until ${name} ${c.action.replace(/^(will |to )/i, "")}`, c.dueText ? `they said ${c.dueText}` : "the customer's move", { due, source: { type: "commitment", id: c.id }, assignedToId: assignee, waiting: true, today: ctx.today });
        if (!waitingOn || (w.due ?? "9") < (waitingOn.due ?? "9")) waitingOn = w;
      }
    } else {
      cands.push(candidate("commitment", c.action.replace(/^./, (ch) => ch.toUpperCase()), `you promised${c.dueText ? ` ${c.dueText}` : ""}`, { due: due ?? ctx.today, source: { type: "commitment", id: c.id }, assignedToId: assignee, today: ctx.today }));
    }
  }
  for (const t of r.tasks) {
    // Hermes's check-in on a customer's promise ("Check: customer said they'd send the photos") is
    // the waiting state itself, not a second step; the wait carries its date.
    if (waitingOn && /^check: customer said/i.test(t.title)) {
      if (t.dueAt) waitingOn.why = `${waitingOn.why ?? "their move"}; check in ${t.dueAt === ctx.today ? "today" : t.dueAt}`;
      continue;
    }
    cands.push(candidate("task", t.title, t.kind === "call" ? "a call to make" : t.kind === "follow_up" ? "a follow-up" : t.kind === "service_case" ? "a service case" : t.kind === "quote" ? "the quote needs this" : t.detail ? t.detail.slice(0, 80) : null, { due: t.dueAt, source: { type: "task", id: t.id }, assignedToId: t.assignedToId ?? assignee, today: ctx.today }));
  }
  const upcoming = r.events.filter((e) => new Date(e.endsAt).getTime() >= ctx.now.getTime()).sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime())[0];
  if (upcoming) {
    const label = upcoming.kind === "site_visit" ? "Site visit" : upcoming.kind === "job" ? (r.kind === "job" ? `J-${r.number} on site` : "Job") : upcoming.title;
    cands.push(candidate("appointment", label, "on the calendar", { due: dayOf(upcoming.startsAt, tz), at: upcoming.startsAt, source: { type: "event", id: upcoming.id }, assignedToId: assignee, today: ctx.today }));
  }
  const specific = cands.some((c) => c.kind !== "appointment");
  return { cands, specific, waitingOn };
}

function leadStep(l: LeadState, ctx: StepContext): NextStep {
  const tz = ctx.tz ?? DEFAULT_TZ;
  const s = ctx.settings;
  if (l.status === "lost") return { what: l.lostReason?.trim() || "Lost", why: null, due: null, at: null, overdue: false, waiting: false, kind: "closed", source: null, assignedToId: null };
  const who = firstName(l.name);
  const { cands, specific, waitingOn } = sharedCandidates(l, ctx, who);
  // Only a note a person typed counts (its stage is recorded then). A lead Hermes or the email
  // pipeline created carries its recommended-action label with no stage: that is a reading, and the
  // step is worked out from the record instead.
  const typed = l.nextActionFor ? typedNextAction(l) : null;
  const lastIn = toDate(l.lastInboundAt);
  const setAt = toDate(l.followUpSetAt);
  // A follow-up set before the customer's latest contact no longer applies.
  const followUpStale = !!(l.followUpAt && lastIn && setAt && lastIn.getTime() > setAt.getTime());
  const followUp = l.followUpAt && !followUpStale ? l.followUpAt : null;
  if (typed) cands.push(candidate("typed", typed, "your note on the lead", { due: followUp, assignedToId: l.assignedToId, today: ctx.today }));
  if (l.status === "won") {
    if (cands.some((c) => c.kind !== "appointment")) return finish(pick(cands)!);
    const j = l.jobs[0];
    return j ? { what: `Job J-${j.number} in hand`, why: null, due: null, at: null, overdue: false, waiting: false, kind: "closed", source: null, assignedToId: null } : finish(candidate("stage", "Convert to a job", "won, no job yet", { assignedToId: l.assignedToId, today: ctx.today }));
  }
  if (!specific && !typed && !waitingOn) {
    // The daily checklist: generic steps, timed from Settings; a specific plan on the record, or a
    // customer's promise we are waiting on, replaces them.
    const quote = (statuses: QuoteStatus[]) => l.quotes.find((q) => statuses.includes(q.status));
    const sent = quote(["sent"]);
    const heldVisit = l.events.filter((e) => e.kind === "site_visit" && new Date(e.endsAt).getTime() < ctx.now.getTime()).sort((a, b) => new Date(b.endsAt).getTime() - new Date(a.endsAt).getTime())[0];
    const hasRealQuote = l.quotes.some((q) => q.status !== "draft" && q.status !== "superseded");
    if (followUp) cands.push(candidate("checklist", l.status === "quote_sent" ? "Follow up on the quote" : `Follow up ${who}`, "follow-up date you set", { due: followUp, assignedToId: l.assignedToId, today: ctx.today }));
    switch (l.status) {
      case "new": {
        const due = dayOf(new Date(new Date(l.createdAt).getTime() + s.new_lead_contact_hours * HOUR), tz);
        cands.push(candidate("checklist", `Contact ${who}`, followUpStale ? `they wrote on ${dayOf(lastIn!, tz)}; no reply yet` : `new lead, not contacted yet`, { due: due < ctx.today ? due : ctx.today, assignedToId: l.assignedToId, today: ctx.today }));
        break;
      }
      case "contacted":
        if (!followUp) cands.push(candidate("stage", `Follow up ${who}`, followUpStale ? `they wrote on ${dayOf(lastIn!, tz)}` : "no follow-up date set", { due: followUpStale ? ctx.today : null, assignedToId: l.assignedToId, today: ctx.today }));
        break;
      case "site_visit":
        if (heldVisit && !hasRealQuote) cands.push(candidate("checklist", "Prepare the quote", `visit held on ${dayOf(heldVisit.endsAt, tz)}`, { due: addDays(dayOf(heldVisit.endsAt, tz), s.site_visit_quote_days), assignedToId: l.assignedToId, today: ctx.today }));
        else if (!cands.some((c) => c.kind === "appointment")) cands.push(candidate("stage", "Book the site visit", "no visit on the calendar", { assignedToId: l.assignedToId, today: ctx.today }));
        break;
      case "quote_required": {
        const draft = quote(["draft"]);
        if (heldVisit && !hasRealQuote && !draft) cands.push(candidate("checklist", "Prepare the quote", `visit held on ${dayOf(heldVisit.endsAt, tz)}`, { due: addDays(dayOf(heldVisit.endsAt, tz), s.site_visit_quote_days), assignedToId: l.assignedToId, today: ctx.today }));
        else cands.push(candidate("stage", draft ? `Finish Q-${draft.number}` : "Prepare the quote", draft ? "still a draft" : "quote needed", { assignedToId: l.assignedToId, today: ctx.today }));
        break;
      }
      case "quote_sent":
        if (sent?.sentAt) cands.push(candidate("checklist", `Follow up on Q-${sent.number}`, `sent ${dayOf(sent.sentAt, tz)}, no answer`, { due: addDays(dayOf(sent.sentAt, tz), s.quote_followup_days), assignedToId: l.assignedToId, today: ctx.today }));
        else if (!followUp) cands.push(candidate("stage", "Follow up on the quote", "no answer yet", { assignedToId: l.assignedToId, today: ctx.today }));
        break;
    }
  }
  if (waitingOn) cands.push(waitingOn);
  const best = pick(cands);
  if (best) return finish(best);
  return { what: "Nothing to do", why: null, due: null, at: null, overdue: false, waiting: false, kind: "none", source: null, assignedToId: null };
}

function jobStep(j: JobState, ctx: StepContext): NextStep {
  const tz = ctx.tz ?? DEFAULT_TZ;
  if (j.status === "cancelled" || j.status === "invoiced") return { what: j.status === "invoiced" ? "Invoiced" : "Cancelled", why: null, due: null, at: null, overdue: false, waiting: false, kind: "closed", source: null, assignedToId: null };
  const { cands, specific, waitingOn } = sharedCandidates(j, ctx, "the customer");
  if (!specific && !waitingOn) {
    const ref = `J-${j.number}`;
    const scheduled = cands.find((c) => c.kind === "appointment");
    const past = j.events.filter((e) => new Date(e.endsAt).getTime() < ctx.now.getTime()).sort((a, b) => new Date(b.endsAt).getTime() - new Date(a.endsAt).getTime())[0];
    switch (j.status) {
      case "unscheduled":
        cands.push(candidate("checklist", `Schedule ${ref}`, "no time on the calendar yet", { due: ctx.today, assignedToId: j.assignedToId, today: ctx.today }));
        break;
      case "scheduled":
        if (!scheduled) cands.push(past ? candidate("checklist", `Mark ${ref} done, or move it`, `was on the calendar ${dayOf(past.startsAt, tz)}`, { due: dayOf(past.endsAt, tz), assignedToId: j.assignedToId, today: ctx.today }) : candidate("checklist", `Put ${ref} on the calendar`, "scheduled with no time", { due: ctx.today, assignedToId: j.assignedToId, today: ctx.today }));
        break;
      case "en_route":
      case "on_site":
        cands.push(candidate("checklist", `Finish ${ref} and mark it done`, j.status === "on_site" ? "on site" : "en route", { due: ctx.today, assignedToId: j.assignedToId, today: ctx.today }));
        break;
      case "done":
        cands.push(candidate("checklist", `Invoice ${ref}`, `done ${j.doneAt ? dayOf(j.doneAt, tz) : "earlier"}, not invoiced`, { due: addDays(dayOf(j.doneAt ?? ctx.now, tz), ctx.settings.job_invoice_days), assignedToId: j.assignedToId, today: ctx.today }));
        break;
    }
  }
  if (waitingOn) cands.push(waitingOn);
  const best = pick(cands);
  return best ? finish(best) : { what: "Nothing to do", why: null, due: null, at: null, overdue: false, waiting: false, kind: "none", source: null, assignedToId: null };
}

function finish(c: Candidate): NextStep {
  const { rank: _rank, ...step } = c;
  void _rank;
  return step;
}

/** The one next step for a lead or job. */
export function nextStepFor(r: RecordState, ctx: StepContext): NextStep {
  return r.kind === "lead" ? leadStep(r, ctx) : jobStep(r, ctx);
}

/** A step that still needs someone: not closed, not "nothing". */
export function isOpenStep(s: NextStep): boolean {
  return s.kind !== "closed" && s.kind !== "none";
}
