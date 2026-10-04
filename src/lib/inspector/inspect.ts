/**
 * Lead + Conversation Inspector: one pipeline for emails and Plaud conversations.
 *
 *   source → InspectorInput → identity (the CRM's hard rules) → Hermes (understanding,
 *   recommendation) → validator (hard guardrails, business rules, advisories) → Unified Action
 *   Router (internal work now; Business Brain; customer-facing work prepared for Chris) → timeline
 *
 * The old deterministic rules no longer decide what a customer means: they find identity signals,
 * provide the fallback when Hermes is unavailable, and are kept beside Hermes's reading for
 * comparison. Jev is redundant (off by default); if switched on it only classifies in shadow.
 */
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { db } from "@/db";
import { commitments, emails, emailThreads, facts, inspections, inspectorActions, inspectorRuns, leads, recordings, users } from "@/db/schema";
import { logActivity } from "@/lib/activity";
import { createLeadFromEmail, markEmailNotLead } from "@/lib/email/pipeline";
import { type Actor, assertApprover, GuardrailError } from "@/lib/guard/actor";
import { analyse } from "./analyse";
import { decideFact, diffFacts, storeFacts } from "./facts";
import { decideIdentity, mergeCandidates } from "./identity";
import { recordDecision, shadow } from "./jev";
import { recordFeedback } from "./feedback";
import { planActions } from "./plan";
import { alreadyInHand, routeActions, type RoutedAction } from "./router";
import { validateHermes, type Validation } from "./validate";
import { satisfiedBy, type Lifecycle } from "./lifecycle";
import { askHermes, type HermesStatus } from "@/lib/hermes/inspector";
import { hermesMinConfidence } from "@/lib/hermes/runtime";
import { collectSignals, crmKnown, crmState, emailInput, recordingInput, staffNames } from "./sources";
import { INSPECTOR_VERSION, type IdentityResult, type InspectorInput, type PlannedAction, type SourceType, type Understanding } from "./types";

export type InspectOutcome = {
  inspectionId: string;
  status: string;
  engine: "hermes" | "fallback" | "rules";
  /** How the Hermes call went (ok, not_configured, unavailable, timeout, invalid_output, error). */
  hermesStatus: HermesStatus | null;
  hermesError: string | null;
  actions: RoutedAction[];
} | null;

/** What reads as someone wanting Get Secure's services (for a "not a lead" email Hermes disagrees with). */
const ENQUIRY_INTENTS: string[] = ["new_enquiry", "quote_request", "site_visit_request", "booking_request", "service_issue"];

async function loadInput(sourceType: SourceType, sourceId: string) {
  return sourceType === "email" ? emailInput(sourceId) : recordingInput(sourceId);
}

/**
 * Read one email or recording and act on it.
 *
 *   identity (the CRM's hard rules) → Hermes (understanding and recommendation) → validator (hard
 *   guardrails, business rules, advisories) → Unified Action Router (Business Brain, prepared
 *   drafts and quotes, tasks) → Chris approves anything customer-facing.
 *
 * If Hermes is not connected, unavailable, slow or returns something unusable, the fallback keeps
 * the item: the deterministic extraction is used where it is safe (identity, blank facts,
 * commitments) and the item goes to Chris as NEEDS_REVIEW, never "no action".
 *
 * Safe to call again: a source already inspected by this version is skipped unless `force` (a
 * re-read supersedes the earlier one).
 */
export async function inspect(sourceType: SourceType, sourceId: string, opts: { force?: boolean; identityOverride?: IdentityResult } = {}): Promise<InspectOutcome> {
  const input = await loadInput(sourceType, sourceId);
  if (!input) return null;
  const previous = await db.query.inspections.findFirst({ where: and(eq(inspections.sourceType, sourceType), eq(inspections.sourceId, sourceId), ne(inspections.status, "superseded")), orderBy: [desc(inspections.createdAt)] });
  if (previous && previous.version === INSPECTOR_VERSION && !opts.force) return { inspectionId: previous.id, status: previous.status, engine: previous.engine as "hermes", hermesStatus: null, hermesError: null, actions: [] };

  // ---- Identity: the CRM's hard rules, before and regardless of Hermes ----
  const staff = await staffNames();
  const first = analyse(input, { staffNames: staff, hasQuote: false, hasSentQuote: false, hasOpenJob: false, known: false }, {}, null);
  let identity: IdentityResult;
  if (opts.identityOverride) identity = opts.identityOverride;
  else if (input.direction === "outbound" && !input.linked.leadId && !input.linked.contactId) identity = { status: "not_applicable", chosen: null, candidates: [], confidence: 0, reason: "Our own email with no customer linked." };
  else {
    const raw = await collectSignals(input, first.understanding);
    identity = decideIdentity(mergeCandidates(raw), { allowNew: false });
  }
  const leadId = identity.status === "matched" ? (identity.chosen?.leadId ?? null) : null;
  const contactIdChosen = identity.status === "matched" ? (identity.chosen?.contactId ?? null) : null;
  const state = await crmState(leadId, contactIdChosen, input);
  const contactId = contactIdChosen ?? state.contactId;
  const known = identity.status === "matched" ? await crmKnown(leadId, contactId) : {};
  const who = state.lead?.name ?? identity.chosen?.label ?? input.from.name ?? null;

  // ---- The old deterministic reading: comparison, debugging and the fallback only ----
  const rules = analyse(input, { staffNames: staff, hasQuote: state.hasQuote, hasSentQuote: state.hasSentQuote, hasOpenJob: state.hasOpenJob, known: !!(leadId || contactId) }, known, who);
  const rulesDiffs = identity.status === "matched" ? await diffFacts(rules.understanding.facts, leadId, contactId) : [];
  const crmForPlan = {
    leadId,
    contactId,
    jobId: state.jobId,
    leadStatus: state.lead?.status ?? null,
    hasOpenBrainQuote: state.hasOpenBrainQuote,
    hasSentQuote: state.hasSentQuote,
    hasOpenJob: state.hasOpenJob,
    recordingLinked: state.recordingLinked,
    newFacts: rulesDiffs.filter((d) => d.outcome !== "same").length,
    customerEmail: state.customerEmail,
    customerPhone: state.customerPhone,
  };
  const rulesPlan = identity.status === "not_applicable" ? [] : planActions(input, rules.understanding, identity, rules.known, crmForPlan);
  const BASE = ["ADD_INTERNAL_NOTE", "LINK_RECORDING", "PROPOSE_LEAD_FACT_UPDATE"];
  const rulesView = {
    /** The rules classifier's verdict on an email (lead / not_lead / existing…): comparison only. */
    classification: input.rulesClassification ?? null,
    primaryIntent: rules.understanding.primaryIntent,
    intents: rules.understanding.intents,
    urgency: rules.understanding.urgency,
    summary: rules.understanding.summary,
    firstAction: rulesPlan.find((p) => !BASE.includes(p.type))?.type ?? null,
    plan: rulesPlan.map((p) => ({ type: p.type, rule: p.rule })),
  };

  // ---- Hermes ----
  const hermes = await askHermes(input, { identity, leadId, contactId, staffNames: staff });
  let engine: "hermes" | "fallback";
  let understanding: Understanding;
  let planned: PlannedAction[];
  let validation: Validation | null = null;
  let reviewKind: string | null;
  if (hermes.status === "ok" && hermes.result) {
    engine = "hermes";
    validation = validateHermes(hermes.result, {
      input,
      identity,
      known,
      crm: { leadId, contactId, hasOpenBrainQuote: state.hasOpenBrainQuote, hasSentQuote: state.hasSentQuote, recordingLinked: state.recordingLinked, customerEmail: state.customerEmail, customerPhone: state.customerPhone, lifecycle: state.lifecycle, brain: state.brain },
      minConfidence: hermesMinConfidence(),
      rules: { primaryIntent: rulesView.primaryIntent, firstAction: rulesView.firstAction, urgency: rulesView.urgency },
    });
    understanding = validation.understanding;
    planned = validation.plan;
    reviewKind = validation.reviewKind;
  } else {
    // FALLBACK: keep the item, use the rules only where safe, and hand it to Chris.
    engine = "fallback";
    understanding = rules.understanding;
    const why = hermes.status === "not_configured" ? "Hermes is not connected" : `Hermes could not read it (${hermes.status.replace(/_/g, " ")}${hermes.error ? `: ${hermes.error}` : ""})`;
    if (identity.status === "needs_review") {
      planned = rulesPlan.map((p) => (p.type === "NEEDS_REVIEW" ? { ...p, payload: { ...p.payload, kind: "identity", hermesUnavailable: why } } : p));
      reviewKind = "identity";
    } else if (identity.status === "not_applicable" || input.direction === "outbound") {
      // Our own email: commitments and a note only, nothing for Chris to decide.
      planned = rulesPlan.filter((p) => BASE.includes(p.type));
      reviewKind = null;
    } else {
      planned = [
        ...rulesPlan.filter((p) => BASE.includes(p.type)),
        {
          type: "NEEDS_REVIEW",
          mode: "approval",
          rule: "hermes_unavailable",
          reason: `${why}. Nothing was prepared; read it again once Hermes is back, or deal with it by hand.`,
          payload: { kind: "hermes_unavailable", hermesStatus: hermes.status, error: hermes.error, rulesSuggestion: rulesView.plan.filter((p) => !BASE.includes(p.type)) },
        },
      ];
      reviewKind = "hermes_unavailable";
    }
  }

  // The rules classifier said "not a lead". That is only a first signal: Hermes reads it too. If
  // Hermes sees a genuine enquiry, it is proposed to Chris as a lead and nothing is created or
  // changed until Chris accepts it. If Hermes agrees (or could not read it), the rules' verdict stands and
  // nothing is put in front of Chris.
  const rulesSaidNotLead = input.sourceType === "email" && input.rulesClassification === "not_lead";
  let storeCommitmentsFor = true;
  if (rulesSaidNotLead) {
    const h = hermes.result;
    const looksLikeLead = !!h && h.recommended_action !== "NO_ACTION" && (ENQUIRY_INTENTS.includes(h.intent) || ["new_enquiry", "service_request"].includes(h.conversation_type));
    if (engine === "hermes" && h && looksLikeLead) {
      planned = [
        {
          type: "NEEDS_REVIEW",
          mode: "approval",
          rule: "hermes_proposed_lead",
          reason: `The rules classifier said this is not a lead; Hermes reads it as ${h.intent.replace(/_/g, " ")}. ${h.reason}`,
          payload: { kind: "hermes_proposed_lead", hermesRecommendation: h.recommended_action, confidence: h.confidence, rulesClassification: "not_lead", candidates: identity.candidates.slice(0, 5).map((c) => ({ leadId: c.leadId, contactId: c.contactId, label: c.label, score: c.score, signals: c.signals })) },
        },
      ];
      reviewKind = "hermes_proposed_lead";
      if (validation) {
        validation.hard.push({ rule: "rules_not_lead_proposal", message: "The rules classifier said not a lead. Hermes's reading is proposed to Chris as a lead: no lead or customer is created or changed until Chris accepts it.", effect: "NEEDS_REVIEW" });
        validation.headline = { ...validation.headline, final: "NEEDS_REVIEW", changedBy: "rules_not_lead_proposal" };
      }
    } else {
      planned = [];
      reviewKind = null;
      storeCommitmentsFor = false;
    }
  }

  const diffs = identity.status === "matched" && !rulesSaidNotLead ? (engine === "fallback" ? rulesDiffs : await diffFacts(understanding.facts, leadId, contactId)) : [];

  if (previous) {
    await db.update(inspections).set({ status: "superseded", updatedAt: new Date() }).where(eq(inspections.id, previous.id));
    await db.update(inspectorActions).set({ status: "superseded" }).where(and(eq(inspectorActions.inspectionId, previous.id), eq(inspectorActions.status, "awaiting_approval")));
  }
  const status = reviewKind ? "needs_review" : "analysed";
  const [row] = await db
    .insert(inspections)
    .values({
      sourceType,
      sourceId,
      direction: input.direction,
      sourceAt: input.at,
      version: INSPECTOR_VERSION,
      status,
      engine,
      reviewKind,
      leadId,
      contactId,
      jobId: state.jobId,
      identity: identity as unknown as Record<string, unknown>,
      understanding: understanding as unknown as Record<string, unknown>,
      hermes: (hermes.result as unknown as Record<string, unknown>) ?? null,
      validation: validation
        ? { hard: validation.hard, business: validation.business, advisories: validation.advisories, rejectedFacts: validation.rejectedFacts, headline: validation.headline, reviewKind: validation.reviewKind }
        : { fallback: { hermesStatus: hermes.status, error: hermes.error } },
      rulesView,
      summary: understanding.summary,
      error: engine === "fallback" ? hermes.error : null,
    })
    .returning({ id: inspections.id });

  const [run] = await db
    .insert(inspectorRuns)
    .values({
      inspectionId: row.id,
      sourceType,
      sourceId,
      runtime: hermes.runtime,
      model: hermes.model,
      version: hermes.version,
      status: hermes.status,
      contextRefs: hermes.contextRefs,
      result: (hermes.result as unknown as Record<string, unknown>) ?? null,
      rawExcerpt: hermes.rawExcerpt,
      error: hermes.error,
      durationMs: hermes.durationMs,
      confidence: hermes.result ? hermes.result.confidence.toFixed(3) : null,
      recommendedAction: hermes.result?.recommended_action ?? null,
      reason: hermes.result?.reason ?? null,
      validation: validation ? { hard: validation.hard, business: validation.business, advisories: validation.advisories, rejectedFacts: validation.rejectedFacts, headline: validation.headline, reviewKind: validation.reviewKind } : { fallback: true, reviewKind },
    })
    .returning({ id: inspectorRuns.id });

  if (storeCommitmentsFor) await storeCommitments(row.id, input, understanding, identity.status === "matched" && !rulesSaidNotLead ? { leadId, contactId, jobId: state.jobId } : { leadId: null, contactId: null, jobId: null });
  if (storeCommitmentsFor && identity.status === "matched" && !rulesSaidNotLead) await settleKeptCommitments(input, state.lifecycle, leadId);
  const detail = { inspectionId: row.id, sourceType, sourceId, title: input.title, summary: understanding.summary, engine, recommended: hermes.result?.recommended_action ?? null, confidence: hermes.result?.confidence ?? null };
  if (leadId) await logActivity({ entity: "lead", entityId: leadId, actorId: null, action: "inspected", detail });
  else if (contactId) await logActivity({ entity: "contact", entityId: contactId, actorId: null, action: "inspected", detail });

  const actions = await routeActions(planned, {
    inspectionId: row.id,
    input,
    leadId,
    contactId,
    jobId: state.jobId,
    applyFacts: async () => storeFacts(diffs, { leadId, contactId, jobId: state.jobId }, input, row.id),
  });
  const brain = actions.filter((a) => a.type === "RUN_BUSINESS_BRAIN" || a.type === "PREPARE_QUOTE" || (a.type === "PROPOSE_SITE_VISIT" && a.rule === "business_brain_site_visit"));
  await db
    .update(inspectorRuns)
    .set({
      brainResult: brain.length ? { steps: brain.map((b) => ({ type: b.type, status: b.status, rule: b.rule, result: b.result })) } : null,
      finalActions: actions.map((a) => ({ id: a.id, type: a.type, status: a.status, rule: a.rule, blocked: a.status === "blocked" ? (a.result?.reason ?? null) : null })),
    })
    .where(eq(inspectorRuns.id, run.id));
  await shadow(row.id, input, rules.understanding, rulesPlan).catch(() => {});
  return { inspectionId: row.id, status, engine, hermesStatus: hermes.status, hermesError: hermes.error, actions };
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

/**
 * Commitments a later CRM event clearly proves were kept ("book the installation visit" and the job
 * was done after it) are closed, with the evidence on the lead's activity. Nothing is inferred for
 * anything else: those stay outstanding until someone marks them.
 */
async function settleKeptCommitments(input: InspectorInput, lc: Lifecycle, leadId: string | null) {
  if (!lc.events.length) return;
  const fromSource = await db.query.commitments.findMany({ where: and(eq(commitments.sourceType, input.sourceType), eq(commitments.sourceId, input.sourceId), eq(commitments.status, "outstanding")), columns: { id: true, owner: true, action: true, actionKey: true } });
  const candidates = [...fromSource.map((c) => ({ ...c, at: input.at.toISOString() })), ...lc.outstanding.filter((o) => !fromSource.some((c) => c.id === o.id))];
  for (const c of candidates) {
    const by = satisfiedBy(c, lc.events);
    if (!by) continue;
    await db.update(commitments).set({ status: "done", completedAt: new Date(), updatedAt: new Date() }).where(and(eq(commitments.id, c.id), eq(commitments.status, "outstanding")));
    if (leadId) await logActivity({ entity: "lead", entityId: leadId, actorId: null, action: "commitment_kept", detail: { commitmentId: c.id, action: c.action, evidence: by.label } });
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
    await recordFeedback({ inspectionId, kind: "not_a_customer", userId: actor.userId });
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
  await recordFeedback({ inspectionId, leadId, contactId, kind: "identity_confirmed", value: { suggested: ((ins.hermes as { identity?: unknown } | null)?.identity ?? null) as Record<string, unknown> | null, leadId, contactId }, userId: actor.userId });
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
    case "NEEDS_REVIEW": {
      // Hermes was unsure: accepting carries out what it recommended, as Chris.
      const proposed = Array.isArray(p.plan) ? (p.plan as PlannedAction[]) : null;
      if (p.kind !== "hermes_low_confidence" || !proposed) throw new Error("Nothing to accept here: decide who it is, read it again, or mark it reviewed.");
      follow = proposed;
      await db.update(inspections).set({ status: "analysed", reviewedById: actor.userId, reviewedAt: new Date(), updatedAt: new Date() }).where(eq(inspections.id, ins.id));
      break;
    }
    default:
      throw new Error(`${a.type} is decided elsewhere.`);
  }
  const routeCtx = { inspectionId: ins.id, input, leadId: a.leadId, contactId: a.contactId, jobId: a.jobId, actor };
  // An open task to arrange it already exists (made since this was proposed): no second one.
  const inHand = a.type === "PROPOSE_SITE_VISIT" || a.type === "PROPOSE_BOOKING" ? await alreadyInHand({ type: a.type }, routeCtx, { ignoreWaiting: true }) : null;
  const done = inHand ? [] : await routeActions(follow, routeCtx);
  result = inHand ? { followUp: [], ...inHand } : { followUp: done };
  await db.update(inspectorActions).set({ status: "accepted", decidedById: actor.userId, decidedAt: new Date(), result }).where(eq(inspectorActions.id, actionId));
  await recordDecision(ins.id, { [`action:${a.type}`]: "accepted" });
  await recordFeedback({ inspectionId: ins.id, kind: "action_accepted", subject: a.type, value: { rule: a.rule, followUp: done.map((d) => ({ type: d.type, status: d.status })) }, userId: actor.userId });
  if (a.leadId) await logActivity({ entity: "lead", entityId: a.leadId, actorId: actor.userId, action: "inspector_action_accepted", detail: { type: a.type, reason: a.reason } });
  return result;
}

export async function dismissAction(actionId: string, actor: Actor, note: string | null): Promise<void> {
  if (actor.kind !== "human") throw new GuardrailError("Only a person can dismiss a recommendation.");
  const a = await db.query.inspectorActions.findFirst({ where: eq(inspectorActions.id, actionId) });
  if (!a) throw new Error("Action not found");
  await db.update(inspectorActions).set({ status: "dismissed", decidedById: actor.userId, decidedAt: new Date(), result: { ...(a.result ?? {}), note } }).where(eq(inspectorActions.id, actionId));
  await recordDecision(a.inspectionId, { [`action:${a.type}`]: "dismissed" });
  await recordFeedback({ inspectionId: a.inspectionId, kind: "action_dismissed", subject: a.type, value: { rule: a.rule, note }, userId: actor.userId });
  // Dismissing the review card itself settles the review.
  if (a.type === "NEEDS_REVIEW") await db.update(inspections).set({ status: "analysed", reviewedById: actor.userId, reviewedAt: new Date(), updatedAt: new Date() }).where(and(eq(inspections.id, a.inspectionId), eq(inspections.status, "needs_review")));
}

/**
 * Chris agrees with Hermes that an email the rules called "not a lead" is a genuine enquiry: the
 * lead is created through the normal path (as when Chris accepts one in the Inbox), and Hermes reads
 * it again with the lead known.
 */
export async function acceptProposedLead(inspectionId: string, actor: Actor): Promise<InspectOutcome> {
  if (actor.kind !== "human") throw new GuardrailError("Only a person can turn a proposal into a lead.");
  const ins = await db.query.inspections.findFirst({ where: eq(inspections.id, inspectionId) });
  if (!ins || ins.sourceType !== "email" || ins.reviewKind !== "hermes_proposed_lead") throw new Error("This is not a proposed lead.");
  if (ins.status !== "needs_review") throw new Error("This proposal has already been dealt with.");
  const em = await db.query.emails.findFirst({ where: eq(emails.id, ins.sourceId), columns: { leadId: true } });
  if (em?.leadId) throw new Error("This email is already on a lead.");
  const leadId = await createLeadFromEmail(ins.sourceId, { actorId: actor.userId });
  await db.update(inspections).set({ reviewedById: actor.userId, reviewedAt: new Date(), updatedAt: new Date() }).where(eq(inspections.id, inspectionId));
  await recordFeedback({ inspectionId, leadId, kind: "proposed_lead_accepted", subject: "hermes_proposed_lead", userId: actor.userId });
  return inspect("email", ins.sourceId, { force: true });
}

/**
 * Chris has dealt with something Hermes could not decide (or could not read): the review is closed.
 * Identity reviews are closed by choosing who it is (confirmIdentity), not here.
 */
export async function resolveReview(inspectionId: string, actor: Actor, note: string | null): Promise<void> {
  if (actor.kind !== "human") throw new GuardrailError("Only a person can close a review.");
  const ins = await db.query.inspections.findFirst({ where: eq(inspections.id, inspectionId) });
  if (!ins) throw new Error("Inspection not found");
  if (ins.reviewKind === "identity") throw new Error("Choose who it is (or Not a customer) to close this review.");
  await db.update(inspectorActions).set({ status: "dismissed", decidedById: actor.userId, decidedAt: new Date() }).where(and(eq(inspectorActions.inspectionId, inspectionId), eq(inspectorActions.status, "awaiting_approval"), eq(inspectorActions.type, "NEEDS_REVIEW")));
  await db.update(inspections).set({ status: "analysed", reviewedById: actor.userId, reviewedAt: new Date(), updatedAt: new Date() }).where(eq(inspections.id, inspectionId));
  await recordFeedback({ inspectionId, kind: "review_resolved", subject: ins.reviewKind, value: { note }, userId: actor.userId });
}

export async function resolveFact(factId: string, decision: "apply" | "reject", actor: Actor): Promise<void> {
  if (actor.kind !== "human") throw new GuardrailError("Only a person can resolve a conflicting fact.");
  await decideFact(factId, decision, actor.userId);
  const f = await db.query.facts.findFirst({ where: eq(facts.id, factId), columns: { inspectionId: true, key: true, leadId: true } });
  if (f?.inspectionId) await recordDecision(f.inspectionId, { [`fact:${f.key}`]: decision });
  await recordFeedback({ inspectionId: f?.inspectionId ?? null, kind: decision === "apply" ? "fact_applied" : "fact_rejected", subject: f?.key ?? null, userId: actor.userId });
}

export async function setCommitmentStatus(id: string, status: "done" | "cancelled" | "outstanding", actor: Actor): Promise<void> {
  if (actor.kind !== "human") throw new GuardrailError("Only a person can close a commitment.");
  await db
    .update(commitments)
    .set({ status, completedAt: status === "outstanding" ? null : new Date(), completedById: status === "outstanding" ? null : humanId(actor), updatedAt: new Date() })
    .where(eq(commitments.id, id));
  if (status !== "outstanding") {
    const c = await db.query.commitments.findFirst({ where: eq(commitments.id, id), columns: { inspectionId: true, leadId: true, contactId: true, owner: true, actionKey: true } });
    if (c) await recordFeedback({ inspectionId: c.inspectionId, leadId: c.leadId, contactId: c.contactId, kind: status === "done" ? "commitment_done" : "commitment_cancelled", subject: `${c.owner}:${c.actionKey}`, userId: humanId(actor) });
  }
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
