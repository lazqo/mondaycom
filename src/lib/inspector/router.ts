/**
 * The Unified Action Router. Every recommended action from an email or a conversation comes
 * through here, and only internal work is done automatically:
 *
 *   automatically: internal notes, tasks, service cases, call reminders, follow-ups, filing a
 *   recording, filling blank facts, running the Business Brain, preparing a quote and an email
 *   draft (both wait in Approvals);
 *   with Chris: bookings, site visits, revised quotes, uncertain identity, conflicting facts.
 *
 * It never sends an email or a quote, confirms a booking or site visit, promises a price or date,
 * discounts or accepts terms. It runs as system:inspector, which the guard refuses for every
 * customer-facing function, so that holds in code, not just here. A prepared draft is never treated
 * as sent: nothing here changes a lead's status or contact date.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { drafts, emails, inspectorActions, leads, recordings, tasks, users } from "@/db/schema";
import { logActivity } from "@/lib/activity";
import { createDraft } from "@/lib/drafts/workflow";
import { prepareFromAssessment, runAssessment } from "@/lib/brain/store";
import { type Actor, GuardrailError } from "@/lib/guard/actor";
import { dateInAppTz } from "@/lib/email/pipeline";
import { enquiryWithFacts } from "./brain";
import { composeQuestionsEmail } from "./plan";
import type { ActionType, InspectorInput, PlannedAction } from "./types";

export const INSPECTOR_ACTOR: Actor = { kind: "system", process: "inspector" };

/** Action types the router may complete without Chris. Everything else waits for him. */
export const AUTO_ALLOWED: ActionType[] = [
  "ADD_INTERNAL_NOTE",
  "CREATE_INTERNAL_TASK",
  "CREATE_SERVICE_CASE",
  "CALL_CUSTOMER",
  "PREPARE_FOLLOW_UP",
  "LINK_RECORDING",
  "PROPOSE_LEAD_FACT_UPDATE",
  "RUN_BUSINESS_BRAIN",
  "PREPARE_QUOTE",
  "DRAFT_EMAIL",
  "NO_ACTION",
];

export type RouteContext = {
  inspectionId: string;
  input: InspectorInput;
  leadId: string | null;
  contactId: string | null;
  jobId: string | null;
  /** Run by a person (Chris accepting) rather than the Inspector itself. */
  actor?: Actor;
  /** Called for the fact update action (kept in inspect.ts, which has the diff). */
  applyFacts?: () => Promise<Record<string, unknown>>;
};

function businessDay(from: Date, add: number): string {
  const d = new Date(from);
  let n = add;
  while (n > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = new Date(dateInAppTz(d) + "T12:00:00Z").getUTCDay();
    if (day !== 0 && day !== 6) n--;
  }
  return dateInAppTz(d);
}

async function assignee(leadId: string | null): Promise<string | null> {
  if (leadId) {
    const l = await db.query.leads.findFirst({ where: eq(leads.id, leadId), columns: { assignedToId: true } });
    if (l?.assignedToId) return l.assignedToId;
  }
  const chris = await db.query.users.findFirst({ where: and(eq(users.canApprove, true), eq(users.active, true)), columns: { id: true } });
  return chris?.id ?? null;
}

async function task(ctx: RouteContext, a: PlannedAction, def: { title: string; kind: string; due: string; detail?: string }) {
  const entity = ctx.jobId ?? ctx.leadId ?? ctx.contactId ?? ctx.inspectionId;
  const [row] = await db
    .insert(tasks)
    .values({
      title: def.title,
      detail: def.detail ?? a.reason,
      dueAt: def.due,
      kind: def.kind,
      assignedToId: await assignee(ctx.leadId),
      leadId: ctx.leadId,
      contactId: ctx.contactId,
      jobId: ctx.jobId,
      ruleKey: `inspector:${a.type}:${a.rule}`,
      entityId: entity,
    })
    .onConflictDoNothing()
    .returning({ id: tasks.id });
  return row ? { taskId: row.id } : { taskId: null, note: "an open task of this kind already exists" };
}

const who = async (leadId: string | null) => (leadId ? ((await db.query.leads.findFirst({ where: eq(leads.id, leadId), columns: { name: true } }))?.name ?? "the customer") : "the customer");

/** Carry out one action. Returns what it produced, or throws (recorded as failed). */
async function execute(a: PlannedAction, ctx: RouteContext, earlier: Map<ActionType, Record<string, unknown>>): Promise<{ status: string; result: Record<string, unknown> }> {
  if (!AUTO_ALLOWED.includes(a.type)) throw new GuardrailError(`${a.type} needs Chris; the router does not carry it out on its own.`);
  const actor = ctx.actor ?? INSPECTOR_ACTOR;
  const today = dateInAppTz(new Date());
  switch (a.type) {
    case "NO_ACTION":
      return { status: "done", result: {} };
    case "ADD_INTERNAL_NOTE": {
      const entity = ctx.leadId ? { entity: "lead" as const, id: ctx.leadId } : ctx.contactId ? { entity: "contact" as const, id: ctx.contactId } : null;
      if (entity) await logActivity({ entity: entity.entity, entityId: entity.id, actorId: null, action: "inspector_note", detail: { summary: a.payload.summary, sourceType: ctx.input.sourceType, sourceId: ctx.input.sourceId, inspectionId: ctx.inspectionId } });
      return { status: "done", result: { logged: !!entity } };
    }
    case "LINK_RECORDING": {
      await db.update(recordings).set({ status: "attached", leadId: ctx.leadId, contactId: ctx.contactId, matchedBy: `Inspector: ${a.reason}`.slice(0, 300), updatedAt: new Date() }).where(eq(recordings.id, ctx.input.sourceId));
      if (ctx.contactId) await logActivity({ entity: "contact", entityId: ctx.contactId, actorId: null, action: "recording_attached", detail: { recordingId: ctx.input.sourceId, title: ctx.input.title, matchedBy: a.reason } });
      if (ctx.leadId) await logActivity({ entity: "lead", entityId: ctx.leadId, actorId: null, action: "recording_attached", detail: { recordingId: ctx.input.sourceId, title: ctx.input.title, matchedBy: a.reason } });
      return { status: "done", result: { recordingId: ctx.input.sourceId } };
    }
    case "PROPOSE_LEAD_FACT_UPDATE":
      return { status: "done", result: ctx.applyFacts ? await ctx.applyFacts() : {} };
    case "CREATE_INTERNAL_TASK":
      return { status: "done", result: await task(ctx, a, { title: String(a.payload.title ?? a.reason), kind: String(a.payload.kind ?? "task"), due: a.payload.due === "today" ? today : businessDay(new Date(), 1) }) };
    case "CREATE_SERVICE_CASE":
      return { status: "done", result: await task(ctx, a, { title: `Service case: ${await who(ctx.leadId)}`, kind: "service_case", due: a.payload.urgency === "urgent" ? today : businessDay(new Date(), 1), detail: `${a.reason} "${ctx.input.text.slice(0, 300)}"` }) };
    case "CALL_CUSTOMER": {
      const ask = Array.isArray(a.payload.ask) ? ` Ask: ${(a.payload.ask as string[]).join("; ")}.` : "";
      return { status: "done", result: await task(ctx, a, { title: `Call ${await who(ctx.leadId)}`, kind: "call", due: today, detail: `${a.reason}${ask}` }) };
    }
    case "PREPARE_FOLLOW_UP":
      return { status: "done", result: await task(ctx, a, { title: `Follow up ${await who(ctx.leadId)}`, kind: "follow_up", due: businessDay(new Date(), Number(a.payload.inDays ?? 3)) }) };
    case "RUN_BUSINESS_BRAIN": {
      if (!ctx.leadId) return { status: "blocked", result: { reason: "No open lead to assess. Create a lead for this customer first." } };
      const input = await enquiryWithFacts(ctx.leadId);
      if (!input) return { status: "blocked", result: { reason: "Lead not found." } };
      const run = await runAssessment(ctx.leadId, input, actor);
      const siteVisit = !!run.packet.siteVisit?.required;
      await logActivity({ entity: "lead", entityId: ctx.leadId, actorId: null, action: "brain_run_by_inspector", detail: { assessmentId: run.id, inspectionId: ctx.inspectionId, complete: run.packet.costing.complete, siteVisit } });
      // Lines a customer quote can carry: priced from approved costs only (the Brain never invents one).
      const pricedLines = run.packet.costing.lines.filter((l) => l.priced && l.unitSellExGst != null && !l.internalOnly).length;
      return { status: "done", result: { assessmentId: run.id, complete: run.packet.costing.complete, pricedLines, unpriced: run.packet.costing.unpriced, siteVisitRequired: siteVisit, siteVisitReasons: run.packet.siteVisit?.reasons ?? [] } };
    }
    case "PREPARE_QUOTE": {
      const brain = earlier.get("RUN_BUSINESS_BRAIN");
      if (!brain?.assessmentId) return { status: "blocked", result: { reason: "The Business Brain did not run." } };
      if (brain.siteVisitRequired) return { status: "blocked", result: { reason: "The Business Brain requires a site visit first.", siteVisitRequired: true } };
      // No approved price for anything in it: no quote and no reply, a pricing task for Chris instead.
      if (!Number(brain.pricedLines ?? 0)) {
        const t = await task(ctx, a, { title: `Price the quote for ${await who(ctx.leadId)}`, kind: "quote", due: today, detail: "The Business Brain designed the system but nothing in it has an approved price yet, so no quote was prepared. Approve the trade prices (or enter the quote by hand), then prepare it from the assessment." });
        return { status: "blocked", result: { reason: "Nothing in the design has an approved price yet, so no quote was prepared.", ...t } };
      }
      // Reply only if there is no unsent email already waiting for this lead.
      const waiting = ctx.leadId ? await db.query.drafts.findFirst({ where: and(eq(drafts.leadId, ctx.leadId), eq(drafts.kind, "email"), inArray(drafts.status, ["draft", "ready_for_review", "approved"])), columns: { id: true } }) : null;
      const r = await prepareFromAssessment(String(brain.assessmentId), { quote: true, email: !waiting }, actor);
      await logActivity({ entity: "lead", entityId: ctx.leadId!, actorId: null, action: "quote_prepared_by_inspector", detail: { quoteId: r.quoteId, quoteNumber: r.quoteNumber, draftId: r.draftId ?? null, inspectionId: ctx.inspectionId } });
      return { status: "done", result: { quoteId: r.quoteId ?? null, quoteNumber: r.quoteNumber ?? null, draftId: r.draftId ?? null } };
    }
    case "DRAFT_EMAIL": {
      const lead = ctx.leadId ? await db.query.leads.findFirst({ where: eq(leads.id, ctx.leadId) }) : null;
      const to = lead?.email ?? ctx.input.from.email;
      if (!to) return { status: "blocked", result: { reason: "No email address to reply to." } };
      // One reply waiting at a time: a re-read never stacks a second draft on the first.
      const waiting = ctx.leadId ? await db.query.drafts.findFirst({ where: and(eq(drafts.leadId, ctx.leadId), eq(drafts.kind, "email"), inArray(drafts.status, ["draft", "ready_for_review", "approved"])), columns: { id: true } }) : null;
      if (waiting) return { status: "done", result: { draftId: waiting.id, note: "a reply is already waiting for review" } };
      const src = ctx.input.sourceType === "email" ? await db.query.emails.findFirst({ where: eq(emails.id, ctx.input.sourceId), columns: { threadId: true, subject: true } }) : null;
      const mail = composeQuestionsEmail(lead?.name ?? ctx.input.from.name, (a.payload.ask as string[]) ?? [], src?.subject ?? null);
      const d = await createDraft({ kind: "email", leadId: ctx.leadId, contactId: ctx.contactId, threadId: src?.threadId ?? null, to: [to], subject: mail.subject, body: mail.body }, actor, { submit: true });
      return { status: "done", result: { draftId: d.id } };
    }
    default:
      throw new GuardrailError(`${a.type} is not carried out automatically.`);
  }
}

/** Store and carry out an inspection's actions. Approval actions wait; auto ones run now. */
export async function routeActions(planned: PlannedAction[], ctx: RouteContext): Promise<{ id: string; type: ActionType; status: string }[]> {
  const out: { id: string; type: ActionType; status: string }[] = [];
  const earlier = new Map<ActionType, Record<string, unknown>>();
  const queue = [...planned];
  while (queue.length) {
    const a = queue.shift()!;
    let status = a.mode === "approval" ? "awaiting_approval" : "done";
    let result: Record<string, unknown> | null = null;
    if (a.mode === "auto") {
      try {
        const r = await execute(a, ctx, earlier);
        status = r.status;
        result = r.result;
        earlier.set(a.type, r.result);
        // The Brain decides a site visit is needed: propose one instead of quoting.
        if (a.type === "PREPARE_QUOTE" && r.result.siteVisitRequired && !planned.some((p) => p.type === "PROPOSE_SITE_VISIT")) {
          const reasons = (earlier.get("RUN_BUSINESS_BRAIN")?.siteVisitReasons as string[] | undefined) ?? [];
          queue.push({ type: "PROPOSE_SITE_VISIT", mode: "approval", rule: "business_brain_site_visit", reason: `The Business Brain requires a site visit${reasons.length ? `: ${reasons.join("; ")}` : ""}.`, payload: {} });
        }
      } catch (err) {
        status = "failed";
        result = { error: err instanceof Error ? err.message : String(err) };
      }
    }
    const [row] = await db
      .insert(inspectorActions)
      .values({ inspectionId: ctx.inspectionId, type: a.type, mode: a.mode, status, rule: a.rule, reason: a.reason, payload: a.payload, result, leadId: ctx.leadId, contactId: ctx.contactId, jobId: ctx.jobId })
      .returning({ id: inspectorActions.id });
    out.push({ id: row.id, type: a.type, status });
  }
  return out;
}

/** The latest actions waiting for Chris, newest first. */
export async function awaitingActions(limit = 50) {
  return db.query.inspectorActions.findMany({ where: eq(inspectorActions.status, "awaiting_approval"), orderBy: [desc(inspectorActions.createdAt)], limit });
}
