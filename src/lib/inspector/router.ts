/**
 * The Unified Action Router. Every recommended action from an email or a conversation comes
 * through here, and only internal work is done automatically (the authority matrix:
 * src/lib/hermes/authority.ts):
 *
 *   automatically: internal notes, tasks, service cases, call reminders, follow-ups, research
 *   requests, filing a recording, filling blank facts, commitments kept (reversible), running the
 *   Business Brain, preparing a quote and an email draft (both wait in Approvals);
 *   with Chris: bookings, site visits, revised quotes, linking a sender, conflicting facts.
 *
 * The Business Brain's own outcome decides what follows a Brain run: a site visit when it requires
 * one, its own questions when it cannot design yet, a pricing task when only pricing Chris enters
 * is missing, otherwise the quote. The router acts on that outcome; it does not second-guess it.
 *
 * It never sends an email or a quote, confirms a booking or site visit, promises a price or date,
 * discounts or accepts terms. It runs as system:inspector, which the guard refuses for every
 * customer-facing function, so that holds in code, not just here. A prepared draft is never treated
 * as sent: nothing here changes a lead's status or contact date.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { commitments, emails, inspectorActions, leads, quotes, recordings } from "@/db/schema";
import { logActivity } from "@/lib/activity";
import { createDraft } from "@/lib/drafts/workflow";
import { prepareFromAssessment, runAssessment } from "@/lib/brain/store";
import { type Actor, GuardrailError } from "@/lib/guard/actor";
import { dateInAppTz } from "@/lib/email/pipeline";
import { AUTHORITY } from "@/lib/hermes/authority";
import { requestResearch } from "@/lib/hermes/research";
import { enquiryWithFacts } from "./brain";
import { serviceKey } from "./sources";
import { alreadyInHand, businessDay, composeQuestionsEmail, createTask, dueDate, waitingDraft } from "./work";
import { pricingGaps, pricingTaskTitle } from "./validate";
import { ACTION_TYPES, type ActionType, type InspectorInput, type PlannedAction } from "./types";

export const INSPECTOR_ACTOR: Actor = { kind: "system", process: "inspector" };

/** Action types the router may complete without Chris (autonomous in the authority matrix). Everything else waits for him. */
export const AUTO_ALLOWED: ActionType[] = ACTION_TYPES.filter((t) => AUTHORITY[t].autonomous);

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
  /** The sender is not a verified customer (work runs in Hermes's context): replies go to the sender. */
  senderUnverified?: boolean;
};

/** Carry out one planned task through the shared work module (one de-duplication for the router and Hermes's tools). */
async function task(ctx: RouteContext, a: PlannedAction, def: { title: string; kind: string; due: string; detail?: string }) {
  const r = await createTask({ leadId: ctx.leadId, contactId: ctx.contactId, jobId: ctx.jobId }, { title: def.title, kind: def.kind, due: def.due, detail: def.detail ?? a.reason, ruleKey: `inspector:${a.type}:${a.rule}`, entityId: ctx.jobId ?? ctx.leadId ?? ctx.contactId ?? ctx.inspectionId });
  if (r.alreadyOpen) return { taskId: r.taskId, note: "an open task like this already exists", inHand: `Already open: ${r.title}.` };
  return { taskId: r.taskId };
}

async function openBrainQuoteNumber(leadId: string | null): Promise<number | null> {
  if (!leadId) return null;
  const q = await db.query.quotes.findFirst({ where: and(eq(quotes.leadId, leadId), eq(quotes.origin, "brain"), inArray(quotes.status, ["ai_prepared", "needs_review", "approved"])), orderBy: [desc(quotes.createdAt)], columns: { number: true } });
  return q?.number ?? null;
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
    case "RESOLVE_COMMITMENT": {
      // Only a commitment of this same work, still outstanding. Reversible: Chris can reopen it.
      const id = String(a.payload.commitmentId ?? "");
      const c = await db.query.commitments.findFirst({ where: eq(commitments.id, id), columns: { id: true, action: true, status: true, leadId: true, contactId: true } });
      const ours = !!c && ((!!ctx.leadId && c.leadId === ctx.leadId) || (!!ctx.contactId && c.contactId === ctx.contactId));
      if (!c || !ours) return { status: "blocked", result: { reason: "That commitment does not belong to this work." } };
      if (c.status !== "outstanding") return { status: "done", result: { commitmentId: id, note: `already ${c.status}` } };
      const status = a.payload.status === "cancelled" ? "cancelled" : "done";
      await db.update(commitments).set({ status, completedAt: new Date(), completedById: null, updatedAt: new Date() }).where(and(eq(commitments.id, id), eq(commitments.status, "outstanding")));
      if (ctx.leadId) await logActivity({ entity: "lead", entityId: ctx.leadId, actorId: null, action: "commitment_resolved", detail: { commitmentId: id, action: c.action, status, evidence: a.payload.evidenceRef ?? null, reason: a.reason, by: "Hermes" } });
      return { status: "done", result: { commitmentId: id, action: c.action, resolvedAs: status, evidenceRef: a.payload.evidenceRef ?? null } };
    }
    case "OUTSTANDING":
      // Nothing new is created: the commitment or task is already in the CRM (Today, the lead page).
      return { status: "outstanding", result: { items: a.payload.items ?? [] } };
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
      return { status: "done", result: await task(ctx, a, { title: String(a.payload.title ?? a.reason), kind: String(a.payload.kind ?? "task"), due: dueDate(a.payload.due, today), detail: a.payload.detail ? String(a.payload.detail) : undefined }) };
    case "CREATE_SERVICE_CASE":
      return { status: "done", result: await task(ctx, a, { title: `Service case: ${await who(ctx.leadId)}`, kind: "service_case", due: a.payload.urgency === "urgent" ? today : businessDay(new Date(), 1), detail: `${a.reason} "${ctx.input.text.slice(0, 300)}"` }) };
    case "CALL_CUSTOMER": {
      const ask = Array.isArray(a.payload.ask) ? ` Ask: ${(a.payload.ask as string[]).join("; ")}.` : "";
      return { status: "done", result: await task(ctx, a, { title: a.payload.title ? String(a.payload.title) : `Call ${await who(ctx.leadId)}`, kind: "call", due: today, detail: `${a.payload.detail ? `${String(a.payload.detail)} ` : ""}${a.reason}${ask}` }) };
    }
    case "REQUEST_RESEARCH": {
      // Only the question (and product) goes to the research profile: never the customer's message.
      const question = String(a.payload.question ?? a.reason).slice(0, 1000);
      const product = a.payload.product ? String(a.payload.product).slice(0, 120) : null;
      const r = await requestResearch({ question: product && !question.toLowerCase().includes(product.toLowerCase()) ? `${question} (product: ${product})` : question, kind: (a.payload.kind as never) ?? "other", requestedBy: "agent:hermes (inspector)", leadId: ctx.leadId, inspectionId: ctx.inspectionId });
      if (r.status !== "ok") {
        // Research is not connected (or failed): the question becomes Chris's task, so it is not lost.
        const t = await task(ctx, a, { title: `Research: ${question.slice(0, 160)}`, kind: "task", due: businessDay(new Date(), 1), detail: `${a.reason}\n(Research ${r.status.replace(/_/g, " ")}${r.error ? `: ${r.error}` : ""}.)` });
        return { status: "done", result: { findingId: r.findingId, research: r.status, ...t, created: `Research: ${question.slice(0, 80)}` } };
      }
      if (ctx.leadId) await logActivity({ entity: "lead", entityId: ctx.leadId, actorId: null, action: "research_by_hermes", detail: { findingId: r.findingId, question, findings: r.findings.length, candidates: r.candidates.length } });
      return { status: "done", result: { findingId: r.findingId, research: r.status, summary: r.summary, findings: r.findings.length, candidates: r.candidates.map((c) => c.title) } };
    }
    case "PREPARE_FOLLOW_UP":
      return {
        status: "done",
        result: await task(ctx, a, { title: a.payload.title ? String(a.payload.title) : `Follow up ${await who(ctx.leadId)}`, kind: "follow_up", due: a.payload.due ? dueDate(a.payload.due, today) : businessDay(new Date(), Number(a.payload.inDays ?? 3)) }),
      };
    case "RUN_BUSINESS_BRAIN": {
      if (!ctx.leadId) return { status: "blocked", result: { reason: "No open lead to assess. Create a lead for this customer first." } };
      // BRAIN AUTHORITY: only CCTV has a Business Brain. Anything else is quoted by hand.
      const leadRow = await db.query.leads.findFirst({ where: eq(leads.id, ctx.leadId), columns: { service: true } });
      const svc = leadRow?.service ? serviceKey(leadRow.service) : null;
      if (svc && ["alarm", "access_control", "intercom"].includes(svc)) {
        const t = await task(ctx, a, { title: `Quote ${svc.replace(/_/g, " ")} enquiry manually`, kind: "quote", due: businessDay(new Date(), 1), detail: "Only CCTV has a Business Brain." });
        return { status: "blocked", result: { reason: `There is no Business Brain for ${svc.replace(/_/g, " ")}: it is quoted by hand.`, ...t, created: `Quote ${svc.replace(/_/g, " ")} enquiry manually` } };
      }
      const input = await enquiryWithFacts(ctx.leadId);
      if (!input) return { status: "blocked", result: { reason: "Lead not found." } };
      const run = await runAssessment(ctx.leadId, input, actor);
      const siteVisit = !!run.packet.siteVisit?.required;
      await logActivity({ entity: "lead", entityId: ctx.leadId, actorId: null, action: "brain_run_by_inspector", detail: { assessmentId: run.id, inspectionId: ctx.inspectionId, complete: run.packet.costing.complete, siteVisit } });
      // Lines a customer quote can carry: priced from approved costs only (the Brain never invents one).
      const pricedLines = run.packet.costing.lines.filter((l) => l.priced && l.unitSellExGst != null && !l.internalOnly).length;
      // What the Brain itself says it still needs before it can design (it never guesses an input).
      const needs = (run.packet.missing ?? []).filter((m) => m.importance === "blocks_quote").map((m) => ({ field: m.field, question: m.question }));
      return { status: "done", result: { assessmentId: run.id, complete: run.packet.costing.complete, pricedLines, unpriced: run.packet.costing.unpriced, siteVisitRequired: siteVisit, siteVisitReasons: run.packet.siteVisit?.reasons ?? [], needs, brainRecommends: run.packet.sales?.recommendedAction ?? null } };
    }
    case "PREPARE_QUOTE": {
      const brain = earlier.get("RUN_BUSINESS_BRAIN");
      if (!brain?.assessmentId) return { status: "blocked", result: { reason: "The Business Brain did not run." } };
      if (brain.siteVisitRequired) return { status: "blocked", result: { reason: "The Business Brain requires a site visit first.", siteVisitRequired: true } };
      const needs = (brain.needs as { question: string }[] | undefined) ?? [];
      if (needs.length) return { status: "blocked", result: { reason: `The Business Brain needs: ${needs.map((n) => n.question).join(" ")}` } };
      // No approved price for anything in it: no quote and no reply, a pricing task for Chris instead.
      if (!Number(brain.pricedLines ?? 0)) {
        const title = `Price the quote for ${await who(ctx.leadId)}`;
        const t = await task(ctx, a, { title, kind: "quote", due: today, detail: "The Business Brain designed the system but nothing in it has an approved price yet, so no quote was prepared. Approve the trade prices (or enter the quote by hand), then prepare it from the assessment." });
        return { status: "blocked", result: { reason: "Nothing in the design has an approved price yet, so no quote was prepared.", ...t, created: title } };
      }
      // Reply only if there is no unsent email already waiting for this lead.
      const waiting = await waitingDraft(ctx.leadId);
      const r = await prepareFromAssessment(String(brain.assessmentId), { quote: true, email: !waiting }, actor);
      await logActivity({ entity: "lead", entityId: ctx.leadId!, actorId: null, action: "quote_prepared_by_inspector", detail: { quoteId: r.quoteId, quoteNumber: r.quoteNumber, draftId: r.draftId ?? null, inspectionId: ctx.inspectionId } });
      return { status: "done", result: { quoteId: r.quoteId ?? null, quoteNumber: r.quoteNumber ?? null, draftId: r.draftId ?? null } };
    }
    case "DRAFT_EMAIL": {
      const lead = ctx.leadId ? await db.query.leads.findFirst({ where: eq(leads.id, ctx.leadId) }) : null;
      // An unverified sender in an existing job's context is answered at their own address.
      const to = ctx.senderUnverified ? ctx.input.from.email : (lead?.email ?? ctx.input.from.email);
      if (!to) return { status: "blocked", result: { reason: "No email address to reply to." } };
      // One reply waiting at a time: a re-read never stacks a second draft on the first.
      const waiting = await waitingDraft(ctx.leadId);
      if (waiting) return { status: "done", result: { draftId: waiting.id, note: "a reply is already waiting for review" } };
      const src = ctx.input.sourceType === "email" ? await db.query.emails.findFirst({ where: eq(emails.id, ctx.input.sourceId), columns: { threadId: true, subject: true } }) : null;
      // A reply Hermes wrote (already checked by the validator), or the blocking questions only.
      const mail =
        typeof a.payload.body === "string"
          ? { subject: String(a.payload.subject ?? (src?.subject ? (/^re:/i.test(src.subject) ? src.subject : `Re: ${src.subject}`) : "Your enquiry")), body: a.payload.body }
          : composeQuestionsEmail(ctx.senderUnverified ? ctx.input.from.name : (lead?.name ?? ctx.input.from.name), (a.payload.ask as string[]) ?? [], src?.subject ?? null);
      const d = await createDraft({ kind: "email", leadId: ctx.leadId, contactId: ctx.contactId, threadId: src?.threadId ?? null, to: [to], subject: mail.subject, body: mail.body }, actor, { submit: true });
      return { status: "done", result: { draftId: d.id } };
    }
    default:
      throw new GuardrailError(`${a.type} is not carried out automatically.`);
  }
}

/** Store and carry out an inspection's actions. Approval actions wait; auto ones run now. */
export type RoutedAction = { id: string; type: ActionType; status: string; rule: string; result: Record<string, unknown> | null };

export async function routeActions(planned: PlannedAction[], ctx: RouteContext): Promise<RoutedAction[]> {
  const out: RoutedAction[] = [];
  const earlier = new Map<ActionType, Record<string, unknown>>();
  const queue = [...planned];
  while (queue.length) {
    const a = queue.shift()!;
    let status = a.mode === "approval" ? "awaiting_approval" : "done";
    let result: Record<string, unknown> | null = null;
    // Never offer what is already in hand (an open task to arrange it, the same proposal waiting).
    const inHand = a.mode === "approval" ? await alreadyInHand(a, ctx) : null;
    if (inHand) {
      status = "already_in_hand";
      result = inHand;
    } else if (a.mode === "auto") {
      try {
        const r = await execute(a, ctx, earlier);
        status = r.status;
        result = r.result;
        earlier.set(a.type, r.result);
        // The Brain cannot finish the costing only because of pricing Chris enters: a task to do that,
        // after the quote step (which makes its own "Price the quote" task when nothing is priced).
        const later = [...queue].some((p) => p.type === "PREPARE_QUOTE");
        const brainOut = earlier.get("RUN_BUSINESS_BRAIN");
        const gaps = brainOut && !brainOut.complete && !brainOut.siteVisitRequired ? pricingGaps((brainOut.unpriced as string[] | undefined) ?? []) : null;
        if (gaps && ((a.type === "RUN_BUSINESS_BRAIN" && !later) || (a.type === "PREPARE_QUOTE" && r.status === "done")) && !queue.some((p) => p.rule === "pricing_only_blocker") && !planned.some((p) => p.rule === "pricing_only_blocker")) {
          const qn = a.type === "PREPARE_QUOTE" ? ((r.result.quoteNumber as number | null) ?? null) : await openBrainQuoteNumber(ctx.leadId);
          queue.push({
            type: "CREATE_INTERNAL_TASK",
            mode: "auto",
            rule: "pricing_only_blocker",
            reason: `The Business Brain cannot finish the costing: ${gaps.join("; ")}.`,
            payload: { title: pricingTaskTitle(qn, await who(ctx.leadId)), kind: "quote", due: "today", detail: `Enter or approve these, then re-run the Brain: ${gaps.join("; ")}.` },
          });
        }
        // The Brain cannot design yet: its own questions go to the customer (a draft for Chris), once.
        const brainNeeds = a.type === "RUN_BUSINESS_BRAIN" && !r.result.siteVisitRequired ? ((r.result.needs as { question: string }[] | undefined) ?? []) : [];
        if (brainNeeds.length && ![...planned, ...queue].some((p) => p.type === "DRAFT_EMAIL" || p.type === "CALL_CUSTOMER") && !out.some((o) => o.type === "DRAFT_EMAIL")) {
          queue.push({ type: "DRAFT_EMAIL", mode: "auto", rule: "business_brain_needs", reason: `The Business Brain needs a little more before it can design: ${brainNeeds.map((n) => n.question).join(" ")}`, payload: { ask: brainNeeds.map((n) => n.question) } });
        }
        // The Brain decides a site visit is needed: propose one instead of quoting.
        if ((a.type === "PREPARE_QUOTE" || a.type === "RUN_BUSINESS_BRAIN") && r.result.siteVisitRequired && ![...planned, ...queue].some((p) => p.type === "PROPOSE_SITE_VISIT") && !out.some((o) => o.type === "PROPOSE_SITE_VISIT")) {
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
    out.push({ id: row.id, type: a.type, status, rule: a.rule, result });
  }
  return out;
}

/** The latest actions waiting for Chris, newest first. */
export async function awaitingActions(limit = 50) {
  return db.query.inspectorActions.findMany({ where: eq(inspectorActions.status, "awaiting_approval"), orderBy: [desc(inspectorActions.createdAt)], limit });
}

export { alreadyInHand, openTaskTitled } from "./work";
