/**
 * Lead + Conversation Inspector: one pipeline for emails and Plaud conversations.
 *
 *   source → InspectorInput → identity (several signals) → understanding (facts, intents,
 *   commitments, blocking/non-blocking gaps) → recommended actions (fixed rules) → Unified Action
 *   Router (internal work now; customer-facing work to Chris) → timeline
 *
 * Jev, when switched on, classifies the same source in shadow and never drives anything.
 */
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { db } from "@/db";
import { commitments, emails, emailThreads, facts, inspections, inspectorActions, leads, recordings, users } from "@/db/schema";
import { logActivity } from "@/lib/activity";
import { markEmailNotLead } from "@/lib/email/pipeline";
import { type Actor, assertApprover, GuardrailError } from "@/lib/guard/actor";
import { analyse } from "./analyse";
import { decideFact, diffFacts, storeFacts } from "./facts";
import { decideIdentity, mergeCandidates } from "./identity";
import { recordDecision, shadow } from "./jev";
import { planActions } from "./plan";
import { routeActions } from "./router";
import { collectSignals, crmKnown, crmState, emailInput, recordingInput, staffNames } from "./sources";
import { INSPECTOR_VERSION, type IdentityResult, type InspectorInput, type PlannedAction, type SourceType, type Understanding } from "./types";

export type InspectOutcome = { inspectionId: string; status: string; actions: { id: string; type: string; status: string }[] } | null;

async function loadInput(sourceType: SourceType, sourceId: string) {
  return sourceType === "email" ? emailInput(sourceId) : recordingInput(sourceId);
}

/**
 * Read one email or recording and act on it. Safe to call again: a source already inspected by
 * this version is skipped unless `force` (a re-read supersedes the earlier one).
 */
export async function inspect(sourceType: SourceType, sourceId: string, opts: { force?: boolean; identityOverride?: IdentityResult } = {}): Promise<InspectOutcome> {
  const input = await loadInput(sourceType, sourceId);
  if (!input) return null;
  const previous = await db.query.inspections.findFirst({ where: and(eq(inspections.sourceType, sourceType), eq(inspections.sourceId, sourceId), ne(inspections.status, "superseded")), orderBy: [desc(inspections.createdAt)] });
  if (previous && previous.version === INSPECTOR_VERSION && !opts.force) return { inspectionId: previous.id, status: previous.status, actions: [] };

  const staff = await staffNames();
  // First pass: what does it say (for identity signals)?
  const first = analyse(input, { staffNames: staff, hasQuote: false, hasSentQuote: false, hasOpenJob: false, known: false }, {}, null);
  let identity: IdentityResult;
  if (opts.identityOverride) identity = opts.identityOverride;
  else if (input.direction === "outbound" && !input.linked.leadId && !input.linked.contactId) identity = { status: "not_applicable", chosen: null, candidates: [], confidence: 0, reason: "Our own email with no customer linked." };
  else {
    const raw = await collectSignals(input, first.understanding);
    identity = decideIdentity(mergeCandidates(raw), { allowNew: false });
  }
  const leadId = identity.chosen?.leadId ?? null;
  const contactIdChosen = identity.chosen?.contactId ?? null;
  const state = await crmState(leadId, contactIdChosen, input);
  const contactId = contactIdChosen ?? state.contactId;
  const known = identity.status === "matched" ? await crmKnown(leadId, contactId) : {};
  const who = state.lead?.name ?? identity.chosen?.label ?? input.from.name ?? null;
  const { understanding, known: merged } = analyse(input, { staffNames: staff, hasQuote: state.hasQuote, hasSentQuote: state.hasSentQuote, hasOpenJob: state.hasOpenJob, known: !!(leadId || contactId) }, known, who);

  const diffs = identity.status === "matched" ? await diffFacts(understanding.facts, leadId, contactId) : [];
  const newFacts = diffs.filter((d) => d.outcome !== "same").length;
  const planned =
    identity.status === "not_applicable"
      ? []
      : planActions(input, understanding, identity, merged, {
          leadId,
          contactId,
          jobId: state.jobId,
          leadStatus: state.lead?.status ?? null,
          hasOpenBrainQuote: state.hasOpenBrainQuote,
          hasSentQuote: state.hasSentQuote,
          hasOpenJob: state.hasOpenJob,
          recordingLinked: state.recordingLinked,
          newFacts,
          customerEmail: state.customerEmail,
          customerPhone: state.customerPhone,
        });

  if (previous) {
    await db.update(inspections).set({ status: "superseded", updatedAt: new Date() }).where(eq(inspections.id, previous.id));
    await db.update(inspectorActions).set({ status: "superseded" }).where(and(eq(inspectorActions.inspectionId, previous.id), eq(inspectorActions.status, "awaiting_approval")));
  }
  const status = identity.status === "needs_review" ? "needs_review" : "analysed";
  const [row] = await db
    .insert(inspections)
    .values({
      sourceType,
      sourceId,
      direction: input.direction,
      sourceAt: input.at,
      version: INSPECTOR_VERSION,
      status,
      leadId,
      contactId,
      jobId: state.jobId,
      identity: identity as unknown as Record<string, unknown>,
      understanding: understanding as unknown as Record<string, unknown>,
      summary: understanding.summary,
    })
    .returning({ id: inspections.id });

  await storeCommitments(row.id, input, understanding, identity.status === "matched" ? { leadId, contactId, jobId: state.jobId } : { leadId: null, contactId: null, jobId: null });
  if (leadId) await logActivity({ entity: "lead", entityId: leadId, actorId: null, action: "inspected", detail: { inspectionId: row.id, sourceType, sourceId, title: input.title, summary: understanding.summary } });
  else if (contactId) await logActivity({ entity: "contact", entityId: contactId, actorId: null, action: "inspected", detail: { inspectionId: row.id, sourceType, sourceId, title: input.title, summary: understanding.summary } });

  const actions = await routeActions(planned, {
    inspectionId: row.id,
    input,
    leadId,
    contactId,
    jobId: state.jobId,
    applyFacts: async () => storeFacts(diffs, { leadId, contactId, jobId: state.jobId }, input, row.id),
  });
  await shadow(row.id, input, understanding, planned).catch(() => {});
  return { inspectionId: row.id, status, actions };
}

/** Store what people said they would do. Never duplicates one already stored from the same source. */
async function storeCommitments(inspectionId: string, input: InspectorInput, u: Understanding, subject: { leadId: string | null; contactId: string | null; jobId: string | null }) {
  if (!u.commitments.length) return;
  const existing = await db.query.commitments.findMany({ where: and(eq(commitments.sourceType, input.sourceType), eq(commitments.sourceId, input.sourceId)), columns: { owner: true, actionKey: true, id: true } });
  const chris = await db.query.users.findFirst({ where: and(eq(users.canApprove, true), eq(users.active, true)), columns: { id: true } });
  for (const c of u.commitments) {
    const same = existing.find((e) => e.owner === c.owner && e.actionKey === c.actionKey);
    if (same) {
      // A re-read after Chris confirmed who it was: attach the existing commitment to the customer.
      if (subject.leadId || subject.contactId) await db.update(commitments).set({ leadId: subject.leadId, contactId: subject.contactId, jobId: subject.jobId, inspectionId, updatedAt: new Date() }).where(eq(commitments.id, same.id));
      continue;
    }
    await db.insert(commitments).values({
      owner: c.owner,
      ownerName: c.ownerName,
      ownerUserId: c.owner === "get_secure" ? (chris?.id ?? null) : null,
      action: c.action,
      actionKey: c.actionKey,
      dueAt: c.dueAt ? new Date(c.dueAt) : null,
      dueText: c.dueText,
      evidence: c.evidence,
      confidence: c.confidence.toFixed(3),
      leadId: subject.leadId,
      contactId: subject.contactId,
      jobId: subject.jobId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      inspectionId,
    });
  }
}

// ---------------- Chris's decisions ----------------

const humanId = (a: Actor) => (a.kind === "human" ? a.userId : null);

/**
 * Chris says who an uncertain email or recording is about (or that it is nobody). The source is
 * filed against them and read again with the identity confirmed, so its facts and actions follow.
 */
export async function confirmIdentity(inspectionId: string, choice: { leadId?: string | null; contactId?: string | null } | "not_a_customer", actor: Actor): Promise<InspectOutcome> {
  if (actor.kind !== "human") throw new GuardrailError("Only a person can confirm who a conversation is with.");
  const ins = await db.query.inspections.findFirst({ where: eq(inspections.id, inspectionId) });
  if (!ins) throw new Error("Inspection not found");
  if (choice === "not_a_customer") {
    await db.update(inspections).set({ status: "superseded", reviewedById: actor.userId, reviewedAt: new Date(), updatedAt: new Date() }).where(eq(inspections.id, inspectionId));
    await db.update(inspectorActions).set({ status: "dismissed", decidedById: actor.userId, decidedAt: new Date() }).where(and(eq(inspectorActions.inspectionId, inspectionId), eq(inspectorActions.status, "awaiting_approval")));
    if (ins.sourceType === "recording") await db.update(recordings).set({ status: "dismissed", updatedAt: new Date() }).where(eq(recordings.id, ins.sourceId));
    else {
      // The same decision clears the email from the Inbox's Needs review.
      const e = await db.query.emails.findFirst({ where: eq(emails.id, ins.sourceId), columns: { classification: true } });
      if (e?.classification === "needs_review") await markEmailNotLead(ins.sourceId, actor.userId);
    }
    await recordDecision(inspectionId, { identity: "not_a_customer" });
    return null;
  }
  const leadId = choice.leadId ?? null;
  let contactId = choice.contactId ?? null;
  if (leadId && !contactId) contactId = (await db.query.leads.findFirst({ where: eq(leads.id, leadId), columns: { contactId: true } }))?.contactId ?? null;
  if (!leadId && !contactId) throw new Error("Choose a lead or a customer.");
  const label = `chosen by ${actor.name}`;
  if (ins.sourceType === "recording") {
    await db.update(recordings).set({ status: "attached", leadId, contactId, matchedBy: label, updatedAt: new Date() }).where(eq(recordings.id, ins.sourceId));
  } else {
    const e = await db.query.emails.findFirst({ where: eq(emails.id, ins.sourceId), columns: { threadId: true } });
    await db.update(emails).set({ leadId, contactId }).where(eq(emails.id, ins.sourceId));
    if (e) await db.update(emailThreads).set({ leadId, contactId, updatedAt: new Date() }).where(eq(emailThreads.id, e.threadId));
    if (leadId) await logActivity({ entity: "lead", entityId: leadId, actorId: actor.userId, action: "email_linked", detail: { threadId: e?.threadId, via: "Inspector review" } });
  }
  await db.update(inspectorActions).set({ status: "accepted", decidedById: actor.userId, decidedAt: new Date() }).where(and(eq(inspectorActions.inspectionId, inspectionId), eq(inspectorActions.status, "awaiting_approval"), inArray(inspectorActions.type, ["NEEDS_REVIEW", "LINK_RECORDING"])));
  await db.update(inspections).set({ reviewedById: actor.userId, reviewedAt: new Date() }).where(eq(inspections.id, inspectionId));
  await recordDecision(inspectionId, { identity: { leadId, contactId } });
  const lead = leadId ? await db.query.leads.findFirst({ where: eq(leads.id, leadId), columns: { name: true } }) : null;
  return inspect(ins.sourceType as SourceType, ins.sourceId, {
    force: true,
    identityOverride: { status: "matched", chosen: { leadId, contactId, jobId: null, label: lead?.name ?? "customer", score: 1, signals: [{ kind: "linked", detail: label, weight: 1 }] }, candidates: [], confidence: 1, reason: `Confirmed by ${actor.name}.` },
  });
}

/**
 * Chris accepts an action that waits for him. Accepting is still not contact with the customer:
 * a booking or site visit becomes Chris's own task to arrange; a revised quote is prepared and
 * waits in Approvals like any other.
 */
export async function acceptAction(actionId: string, actor: Actor): Promise<Record<string, unknown>> {
  assertApprover(actor);
  const a = await db.query.inspectorActions.findFirst({ where: eq(inspectorActions.id, actionId) });
  if (!a) throw new Error("Action not found");
  if (a.status !== "awaiting_approval") throw new Error(`This action is already ${a.status.replace(/_/g, " ")}.`);
  const ins = (await db.query.inspections.findFirst({ where: eq(inspections.id, a.inspectionId) }))!;
  const input = (await loadInput(ins.sourceType as SourceType, ins.sourceId))!;
  let result: Record<string, unknown> = {};
  const p = a.payload as Record<string, unknown>;
  const asTask = (title: string, detail: string): PlannedAction => ({ type: "CREATE_INTERNAL_TASK", mode: "auto", rule: `accepted:${a.type}`, reason: detail, payload: { title, kind: "task", due: "today" } });
  let follow: PlannedAction[] = [];
  switch (a.type) {
    case "PROPOSE_SITE_VISIT":
      follow = [asTask("Arrange a site visit", `${a.reason}${p.address ? ` Address: ${p.address}.` : ""}${p.timing ? ` They mentioned ${p.timing}.` : ""} Agree a time with the customer, then schedule it.`)];
      break;
    case "PROPOSE_BOOKING":
      follow = [asTask("Arrange the booking", `${a.reason}${p.timing ? ` They mentioned ${p.timing}.` : ""} Agree a time with the customer, then schedule it.`)];
      break;
    case "PREPARE_REVISED_QUOTE":
      follow = [
        { type: "RUN_BUSINESS_BRAIN", mode: "auto", rule: "accepted:PREPARE_REVISED_QUOTE", reason: "Re-run with the updated facts.", payload: {} },
        { type: "PREPARE_QUOTE", mode: "auto", rule: "accepted:PREPARE_REVISED_QUOTE", reason: "Revised quote for Chris to review (no discount is applied automatically).", payload: {} },
      ];
      break;
    default:
      throw new Error(`${a.type} is decided elsewhere.`);
  }
  const done = await routeActions(follow, { inspectionId: ins.id, input, leadId: a.leadId, contactId: a.contactId, jobId: a.jobId, actor });
  result = { followUp: done };
  await db.update(inspectorActions).set({ status: "accepted", decidedById: actor.userId, decidedAt: new Date(), result }).where(eq(inspectorActions.id, actionId));
  await recordDecision(ins.id, { [`action:${a.type}`]: "accepted" });
  if (a.leadId) await logActivity({ entity: "lead", entityId: a.leadId, actorId: actor.userId, action: "inspector_action_accepted", detail: { type: a.type, reason: a.reason } });
  return result;
}

export async function dismissAction(actionId: string, actor: Actor, note: string | null): Promise<void> {
  if (actor.kind !== "human") throw new GuardrailError("Only a person can dismiss a recommendation.");
  const a = await db.query.inspectorActions.findFirst({ where: eq(inspectorActions.id, actionId) });
  if (!a) throw new Error("Action not found");
  await db.update(inspectorActions).set({ status: "dismissed", decidedById: actor.userId, decidedAt: new Date(), result: { ...(a.result ?? {}), note } }).where(eq(inspectorActions.id, actionId));
  await recordDecision(a.inspectionId, { [`action:${a.type}`]: "dismissed" });
}

export async function resolveFact(factId: string, decision: "apply" | "reject", actor: Actor): Promise<void> {
  if (actor.kind !== "human") throw new GuardrailError("Only a person can resolve a conflicting fact.");
  await decideFact(factId, decision, actor.userId);
  const f = await db.query.facts.findFirst({ where: eq(facts.id, factId), columns: { inspectionId: true, key: true } });
  if (f?.inspectionId) await recordDecision(f.inspectionId, { [`fact:${f.key}`]: decision });
}

export async function setCommitmentStatus(id: string, status: "done" | "cancelled" | "outstanding", actor: Actor): Promise<void> {
  if (actor.kind !== "human") throw new GuardrailError("Only a person can close a commitment.");
  await db
    .update(commitments)
    .set({ status, completedAt: status === "outstanding" ? null : new Date(), completedById: status === "outstanding" ? null : humanId(actor), updatedAt: new Date() })
    .where(eq(commitments.id, id));
}

/**
 * Chris decided elsewhere (Inbox "Not a lead", Recordings "Dismiss"): any "Who is this?" still open
 * for these sources is closed the same way, so he never decides twice.
 */
export async function closeReviews(sourceType: SourceType, sourceIds: string[], actor: Actor): Promise<void> {
  if (!sourceIds.length || actor.kind !== "human") return;
  const open = await db.query.inspections.findMany({ where: and(eq(inspections.sourceType, sourceType), inArray(inspections.sourceId, sourceIds), eq(inspections.status, "needs_review")), columns: { id: true } });
  for (const i of open) await confirmIdentity(i.id, "not_a_customer", actor);
}

/** A thread was filed against someone in the Inbox: read its waiting emails again with that link. */
export async function reinspectThread(threadId: string): Promise<void> {
  const ids = (await db.select({ id: emails.id }).from(emails).where(eq(emails.threadId, threadId))).map((e) => e.id);
  if (!ids.length) return;
  const open = await db.query.inspections.findMany({ where: and(eq(inspections.sourceType, "email"), inArray(inspections.sourceId, ids), eq(inspections.status, "needs_review")), columns: { sourceId: true } });
  for (const i of open) await inspect("email", i.sourceId, { force: true });
}
