/**
 * Lead + Conversation Inspector: one pipeline for emails and Plaud conversations.
 *
 *   source → InspectorInput → identity (the CRM's hard rules) → Hermes (understanding,
 *   recommendation) → validator (hard guardrails, business rules, advisories) → Unified Action
 *   Router (internal work now; Business Brain; customer-facing work prepared for Chris) → timeline
 *
 * Hermes is the only reader. The CRM finds identity signals (signals.ts) before Hermes is asked and
 * decides who the sender is by its own rules; everything else is Hermes's judgement, checked by the
 * guardrails. When Hermes cannot be reached the item waits in the queue and is retried; after the
 * retries it goes to Chris as "Hermes could not read it", with nothing invented.
 */
import { and, asc, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { brainCandidates, commitments, contacts, emailThreads, emails, events, facts, inspections, inspectorActions, inspectorFeedback, inspectorRuns, jobs, leads, quotes, recordings, tasks, users, type ExtractedLead } from "@/db/schema";
import { logActivity } from "@/lib/activity";
import { createLeadFromEmail, markEmailNotLead } from "@/lib/email/pipeline";
import { type Actor, assertApprover, GuardrailError } from "@/lib/guard/actor";
import { NON_CUSTOMER_CONTEXTS, type HermesResult } from "@/lib/hermes/contract";
import { decideFact, diffFacts, storeFacts } from "./facts";
import { decideIdentity, mergeCandidates } from "./identity";
import { recordFeedback } from "./feedback";
import { HERMES_ACTION_LABELS } from "./labels";
import { alreadyInHand, routeActions, type RoutedAction } from "./router";
import { collectSignals, recordsOnStreet, streetsIn } from "./signals";
import { validateHermes, type Validation, SERVICE_DISPLAY, evidenceFound, sourceHaystack } from "./validate";
import { askHermes, type HermesStatus } from "@/lib/hermes/inspector";
import { hermesAutonomy } from "@/lib/hermes/autonomy";
import { crmKnown, crmState, emailInput, recordingInput, staffNames } from "./sources";
import { digitSequence, digitsFitInside, normalisePhone } from "./text";
import { parseWebsiteLead, personalEmail } from "@/lib/email/website-lead";
import { recordSupplierPrice } from "@/lib/brain/store";
import { computeTotals } from "@/lib/quotes";
import { createDraft } from "@/lib/drafts/workflow";
import { nextNumber } from "@/lib/numbering";
import { loadPolicies } from "@/lib/brain/store";
import { bookEvent } from "@/lib/calendar/book";
import { TZ } from "./dates";
import { createTask } from "./work";
import { createLeadFromRecording } from "@/lib/recordings/lead";
import { INSPECTOR_VERSION, type IdentityCandidate, type IdentityResult, type InspectorInput, type PlannedAction, type SourceType, type Understanding } from "./types";

export type InspectOutcome = {
  inspectionId: string;
  status: string;
  engine: "hermes" | "fallback";
  /** How the Hermes call went (ok, not_configured, unavailable, timeout, invalid_output, error). */
  hermesStatus: HermesStatus | null;
  hermesError: string | null;
  actions: RoutedAction[];
} | null;

async function loadInput(sourceType: SourceType, sourceId: string) {
  return sourceType === "email" ? emailInput(sourceId) : recordingInput(sourceId);
}

/**
 * Read one email or recording and act on it.
 *
 *   identity (the CRM's hard rules) → Hermes (understanding and recommendation) → validator (the
 *   guardrails) → Unified Action Router (Business Brain, prepared drafts and quotes, tasks) →
 *   Chris approves anything customer-facing.
 *
 * If Hermes is not connected, unavailable, slow or returns something unusable, the item is kept
 * and retried; after the retries it goes to Chris as NEEDS_REVIEW ("Hermes could not read it"),
 * never "no action" and never read by anything else.
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
  let identity: IdentityResult;
  if (opts.identityOverride) identity = opts.identityOverride;
  else if (input.direction === "outbound" && !input.linked.leadId && !input.linked.contactId) identity = { status: "not_applicable", chosen: null, candidates: [], confidence: 0, reason: "Our own email with no customer linked." };
  else identity = decideIdentity(mergeCandidates(await collectSignals(input)), { allowNew: false });
  let leadId = identity.status === "matched" ? (identity.chosen?.leadId ?? null) : null;
  const contactIdChosen = identity.status === "matched" ? (identity.chosen?.contactId ?? null) : null;
  let state = await crmState(leadId, contactIdChosen, input);
  let contactId = contactIdChosen ?? state.contactId;
  let known = identity.status === "matched" ? await crmKnown(leadId, contactId) : {};
  const autonomy = await hermesAutonomy();
  const answers = await answersFor(sourceType, sourceId);

  // ---- Hermes: the operational judgement ----
  const hermes = await askHermes(input, { identity, leadId, contactId, staffNames: staff, answers });
  let engine: "hermes" | "fallback";
  let understanding: Understanding;
  let planned: PlannedAction[];
  let validation: Validation | null = null;
  let reviewKind: string | null;
  let jobId = state.jobId;
  let senderUnverified = false;
  let storeCommitmentsFor = true;
  const minConfidence = autonomy.thresholds.operational_state;
  if (hermes.status === "ok" && hermes.result) {
    engine = "hermes";
    let h = hermes.result;
    // A phone number Hermes read in the words (said at the end of a call, written under an email)
    // goes through the CRM's own identity rules: it has to be in the source verbatim and belong to
    // a record. Hermes never decides who it is; it only points the CRM at the number.
    if (identity.status !== "matched" && identity.status !== "not_applicable") {
      const phone = phoneReadByHermes(h, input);
      // On a call, the name Hermes read ("it was Gina") can point at a lead from the last fortnight;
      // a number said with digits missing can fit inside a stored one. Both are candidates to
      // confirm (the call is then proposed onto that lead), never a match on their own.
      const saidName = input.sourceType === "recording" ? ((h.facts.find((f) => f.key === "contact_name")?.value as string | undefined) ?? h.counterparty.name ?? null) : null;
      const again = phone || saidName ? decideIdentity(mergeCandidates(await collectSignals(input, { phones: phone ? [phone] : [], names: saidName ? [saidName] : [] })), { allowNew: false }) : null;
      if (again?.status === "matched" && again.chosen?.signals.some((x) => x.kind === "phone")) {
        identity = { ...again, reason: `${again.reason} The number was read by Hermes from the words.` };
        leadId = again.chosen.leadId;
        state = await crmState(leadId, again.chosen.contactId, input);
        contactId = again.chosen.contactId ?? state.contactId;
        known = await crmKnown(leadId, contactId);
        jobId = state.jobId;
      } else if (again && again.status !== "matched" && again.candidates.length > identity.candidates.length) {
        identity = { ...again, status: "needs_review", reason: `${again.reason} Someone the CRM already has may be this person: Chris confirms.` };
      }
    }
    const citable = ((hermes.contextRefs as { citable?: string[] }).citable ?? []) as string[];
    // The work Hermes places it in; if it only named it as its suggestion of who the sender is, that is
    // treated as the proposed work too. Either way it must pass the same evidence check.
    const contextRef = h.operational_context.ref ?? (h.identity.suggestion === "candidate" ? h.identity.candidate_key : null);
    const context = identity.status !== "matched" && contextRef ? await checkContext(contextRef, input, identity) : null;
    // Unknown work is new work: Hermes reads existing customer work, but the CRM has no record of
    // the person or the site anywhere (no candidates, no evidenced context). Whatever the customer
    // thinks, this is new to the CRM: it becomes a lead and the work continues there.
    const unknownWork = identity.status !== "matched" && identity.candidates.length === 0 && !context?.accepted && input.direction !== "outbound" && (h.lead_decision === "existing" || (h.lead_decision === "undecided" && h.business_context === "existing_work")) && !NON_CUSTOMER_CONTEXTS.includes(h.business_context) && h.business_context !== "accounting_payment" && substantialReading(h, input);
    if (unknownWork) h = { ...h, lead_decision: "lead" };
    const validate = () =>
      validateHermes(h, {
        input,
        identity,
        known,
        crm: { leadId, contactId, hasOpenBrainQuote: state.hasOpenBrainQuote, hasSentQuote: state.hasSentQuote, recordingLinked: state.recordingLinked, customerEmail: state.customerEmail, customerPhone: state.customerPhone },
        autonomy,
        answers,
        citable: [...citable, ...(context?.accepted ? [context.ref] : [])],
        context,
      });
    validation = validate();
    planned = validation.plan;
    reviewKind = validation.reviewKind;

    // Hermes's lead decision (emails), carried out internally: audited, and Chris can reverse it.
    const decision = validation.workContext ? null : await applyLeadDecision(h, input, validation.understanding, minConfidence, identity, unknownWork);
    if (decision?.kind === "created") {
      const what = input.sourceType === "recording" ? "conversation" : "email";
      identity = { status: "matched", chosen: { leadId: decision.leadId, contactId: decision.contactId, jobId: null, label: decision.label, score: 1, signals: [{ kind: "linked", detail: `the lead Hermes created from this ${what}`, weight: 1 }] }, candidates: identity.candidates, confidence: 1, reason: `Hermes decided this is a new lead; the CRM created it from this ${what}.` };
      leadId = decision.leadId;
      state = await crmState(leadId, decision.contactId, input);
      contactId = decision.contactId ?? state.contactId;
      known = await crmKnown(leadId, contactId);
      jobId = state.jobId;
      validation = validate();
      validation.hard.push({ rule: unknownWork ? "unknown_work_is_new" : "lead_created_by_hermes", message: unknownWork ? "Hermes read this as existing work, but the CRM has no record of the person or the site, so it is new work: a lead was created from the reading and the work continues there. Chris can mark it lost if not." : "Hermes decided this is a new lead; the CRM created it through the normal path (a customer is linked only by an exact email match). Chris can mark it lost if not." });
      planned = validation.plan;
      reviewKind = validation.reviewKind;
    } else if (decision?.kind === "proposed") {
      // Hermes thinks it is a lead but is not sure enough to act: Chris decides.
      planned = [
        {
          type: "NEEDS_REVIEW",
          mode: "approval",
          rule: "hermes_proposed_lead",
          reason: `Hermes reads this as ${h.intent.replace(/_/g, " ")} but is only ${Math.round(h.confidence * 100)}% sure it is a lead. ${h.reason}`,
          payload: { kind: "hermes_proposed_lead", hermesRecommendation: h.recommended_action, confidence: h.confidence, leadDraft: leadOverrides(h, input, validation.understanding), candidates: identity.candidates.slice(0, 5).map((c) => ({ leadId: c.leadId, contactId: c.contactId, label: c.label, score: c.score, signals: c.signals })) },
        },
      ];
      reviewKind = "hermes_proposed_lead";
      storeCommitmentsFor = false;
    } else if (decision?.kind === "reversed") {
      validation.hard.push({ rule: "lead_reversed_by_hermes", message: "Hermes decided this is not a lead: the lead the rules created from it was marked lost (\"Not a lead\"). Chris can reopen it." });
    } else if (decision?.kind === "kept_for_chris") {
      validation.hard.push({ rule: "worked_lead_kept", message: "Hermes reads this as not a lead, but the lead has already been worked on, so only Chris can close it.", effect: "NEEDS_REVIEW" });
      planned = [...planned.filter((p) => p.type !== "NEEDS_REVIEW"), { type: "NEEDS_REVIEW", mode: "approval", rule: "worked_lead_kept", reason: `Hermes: not a lead. ${h.reason}`, payload: { kind: "hermes_flagged", hermesRecommendation: h.recommended_action, confidence: h.confidence } }];
      reviewKind = reviewKind ?? "hermes_flagged";
    }
    if ((effectiveLeadDecision(h) === "not_lead" || NON_CUSTOMER_CONTEXTS.includes(h.business_context)) && !leadId && !validation.workContext) storeCommitmentsFor = false;

    // Work in Hermes's evidenced context while the sender stays unverified.
    if (validation.workContext) {
      leadId = validation.workContext.leadId;
      contactId = validation.workContext.contactId;
      jobId = validation.workContext.jobId ?? (leadId ? (await crmState(leadId, contactId, input)).jobId : null);
      senderUnverified = true;
      await fileInContext(input, validation.workContext);
    }
    understanding = validation.understanding;
  } else {
    // FALLBACK: Hermes could not read it. Nothing is invented: the item goes to Chris as it is.
    engine = "fallback";
    understanding = emptyUnderstanding(input);
    storeCommitmentsFor = false;
    const why = hermes.status === "not_configured" ? "Hermes is not connected" : `Hermes could not read it (${hermes.status.replace(/_/g, " ")}${hermes.error ? `: ${hermes.error}` : ""})`;
    if (identity.status === "not_applicable" || input.direction === "outbound") {
      planned = [];
      reviewKind = null;
    } else {
      planned = [{ type: "NEEDS_REVIEW", mode: "approval", rule: "hermes_unavailable", reason: `${why}. Nothing was prepared; read it again once Hermes is back, or deal with it by hand.`, payload: { kind: "hermes_unavailable", hermesStatus: hermes.status, error: hermes.error, question: "Hermes could not read this. Read it again, or deal with it by hand." } }];
      reviewKind = "hermes_unavailable";
    }
  }

  // Facts: filled in only for a verified customer; an unverified sender's facts are proposed to Chris.
  const factsAbout = identity.status === "matched" || senderUnverified;
  const diffs = factsAbout && storeCommitmentsFor ? await diffFacts(understanding.facts, leadId, contactId) : [];
  const factDiffs = senderUnverified ? diffs.map((d) => (d.outcome === "new" ? { ...d, outcome: "low_confidence" as const } : d)) : diffs;

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
      // A review is only shown once its actions (the decision Chris makes) are stored: see below.
      status: status === "needs_review" ? "routing" : status,
      engine,
      reviewKind,
      leadId,
      contactId,
      jobId,
      identity: identity as unknown as Record<string, unknown>,
      understanding: understanding as unknown as Record<string, unknown>,
      hermes: (hermes.result as unknown as Record<string, unknown>) ?? null,
      validation: validation
        ? { hard: validation.hard, business: validation.business, advisories: validation.advisories, rejectedFacts: validation.rejectedFacts, headline: validation.headline, reviewKind: validation.reviewKind, decisions: validation.decisions }
        : { fallback: { hermesStatus: hermes.status, error: hermes.error } },
      rulesView: null,
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
      validation: validation ? { hard: validation.hard, business: validation.business, advisories: validation.advisories, rejectedFacts: validation.rejectedFacts, headline: validation.headline, reviewKind: validation.reviewKind, decisions: validation.decisions } : { fallback: true, reviewKind },
    })
    .returning({ id: inspectorRuns.id });

  if (storeCommitmentsFor) await storeCommitments(row.id, input, understanding, factsAbout ? { leadId, contactId, jobId } : { leadId: null, contactId: null, jobId: null });
  await settleClassification(input, { status, leadId, contactId, engine, verified: identity.status === "matched" && !senderUnverified });

  let actions: RoutedAction[] = [];
  try {
    actions = await routeActions(planned, {
      inspectionId: row.id,
      input,
      leadId,
      contactId,
      jobId,
      senderUnverified,
      applyFacts: async () => storeFacts(factDiffs, { leadId, contactId, jobId }, input, row.id),
    });
  } finally {
    // Now the review (with its suggestion and buttons) can appear; even if routing failed, it is never lost.
    if (status === "needs_review") await db.update(inspections).set({ status: "needs_review" }).where(and(eq(inspections.id, row.id), eq(inspections.status, "routing")));
    // The timeline entry: what was read, and what was done about it.
    const detail = {
      inspectionId: row.id,
      sourceType,
      sourceId,
      title: input.title,
      summary: understanding.summary,
      engine,
      recommended: hermes.result?.recommended_action ?? null,
      confidence: hermes.result?.confidence ?? null,
      actions: actions.filter((a) => !["ADD_INTERNAL_NOTE", "NO_ACTION", "OUTSTANDING"].includes(a.type)).map((a) => ({ type: a.type, status: a.status, note: typeof a.result?.inHand === "string" ? a.result.inHand : a.status === "blocked" && typeof a.result?.reason === "string" ? a.result.reason : null })),
    };
    if (leadId) await logActivity({ entity: "lead", entityId: leadId, actorId: null, action: "inspected", detail });
  // A playbook Hermes proposes (a way of handling this kind of enquiry): a Business Brain candidate
  // for Chris; approved, it is in every future reading's approvedLearnings.
  if (hermes.status === "ok" && hermes.result?.playbook) {
    const pb = hermes.result.playbook;
    const exists = await db.query.brainCandidates.findFirst({ where: and(eq(brainCandidates.kind, "workflow"), sql`lower(${brainCandidates.title}) = lower(${`Playbook: ${pb.title}`})`, inArray(brainCandidates.status, ["proposed", "accepted"])), columns: { id: true } });
    if (!exists) {
      await db.insert(brainCandidates).values({
        kind: "workflow",
        title: `Playbook: ${pb.title}`,
        detail: [`When: ${pb.applies_when}`, pb.steps.length ? `Steps: ${pb.steps.map((x, i) => `${i + 1}. ${x}`).join(" ")}` : null, pb.options.length ? `Options: ${pb.options.join("; ")}` : null, pb.pricing_rule ? `Pricing: ${pb.pricing_rule}` : null].filter(Boolean).join("\n"),
        payload: { playbook: pb, from: { sourceType, sourceId } },
        sources: [{ kind: sourceType, id: sourceId }],
        confidence: hermes.result.confidence.toFixed(3),
        proposedBy: "agent:hermes",
      });
    }
  }
    else if (contactId) await logActivity({ entity: "contact", entityId: contactId, actorId: null, action: "inspected", detail });
  }
  const brain = actions.filter((a) => a.type === "RUN_BUSINESS_BRAIN" || a.type === "PREPARE_QUOTE" || (a.type === "PROPOSE_SITE_VISIT" && a.rule === "business_brain_site_visit"));
  await db
    .update(inspectorRuns)
    .set({
      brainResult: brain.length ? { steps: brain.map((b) => ({ type: b.type, status: b.status, rule: b.rule, result: b.result })) } : null,
      finalActions: actions.map((a) => ({ id: a.id, type: a.type, status: a.status, rule: a.rule, blocked: a.status === "blocked" ? (a.result?.reason ?? null) : null })),
    })
    .where(eq(inspectorRuns.id, run.id));
  return { inspectionId: row.id, status, engine, hermesStatus: hermes.status, hermesError: hermes.error, actions };
}

/** Chris's answers to Hermes's questions about this email or conversation, oldest first. */
export async function answersFor(sourceType: SourceType, sourceId: string): Promise<{ key: string; question: string; answer: string; at: string }[]> {
  const rows = await db
    .select({ value: inspectorFeedback.value, at: inspectorFeedback.createdAt })
    .from(inspectorFeedback)
    .innerJoin(inspections, eq(inspections.id, inspectorFeedback.inspectionId))
    .where(and(eq(inspections.sourceType, sourceType), eq(inspections.sourceId, sourceId), eq(inspectorFeedback.kind, "question_answered")))
    .orderBy(asc(inspectorFeedback.createdAt));
  return rows.map((r) => {
    const v = (r.value ?? {}) as { key?: string; question?: string; answer?: string };
    return { key: v.key ?? "", question: v.question ?? "", answer: v.answer ?? "", at: r.at.toISOString() };
  });
}

/**
 * Chris answers a question Hermes asked. The answer is kept as feedback (and, when Hermes marked it
 * as something to learn, as an approved lesson for every future reading), then the email or
 * conversation is read again with the answer in its context pack so Hermes carries on from it.
 * Only a person can answer; an agent never answers its own questions.
 */
export async function answerQuestion(actionId: string, answer: string, actor: Actor): Promise<InspectOutcome> {
  if (actor.kind !== "human") throw new Error("Only a person can answer Hermes's questions.");
  const text = answer.trim();
  if (!text) throw new Error("Type an answer first.");
  const a = await db.query.inspectorActions.findFirst({ where: eq(inspectorActions.id, actionId) });
  if (!a || a.type !== "ASK_CHRIS") throw new Error("That is not a question from Hermes.");
  if (a.status !== "awaiting_approval") throw new Error("This question has already been dealt with.");
  const ins = await db.query.inspections.findFirst({ where: eq(inspections.id, a.inspectionId) });
  if (!ins) throw new Error("The reading this question came from is gone.");
  const p = a.payload as { key?: string; question?: string; kind?: string; learn?: boolean; items?: PricingItem[] };
  if (p.kind === "pricing") return answerPricing(a, ins, p.items ?? [], text, actor);
  if (p.kind === "stated_pricing") return answerStatedPricing(a, ins, text, actor);
  await db.update(inspectorActions).set({ status: "accepted", decidedById: actor.userId, decidedAt: new Date(), result: { answer: text } }).where(eq(inspectorActions.id, actionId));
  await recordFeedback({ inspectionId: ins.id, leadId: a.leadId, contactId: a.contactId, kind: "question_answered", subject: p.key ?? null, value: { key: p.key ?? "", question: p.question ?? "", answer: text, kind: p.kind ?? "text", learn: !!p.learn }, userId: actor.userId });
  if (p.learn && p.question) {
    await db.insert(brainCandidates).values({
      kind: "workflow",
      title: p.question,
      detail: text,
      payload: { key: p.key ?? null, from: "question" },
      sources: [{ kind: "question", inspectionId: ins.id, actionId }],
      status: "accepted",
      proposedBy: "chris",
      decidedById: actor.userId,
      decidedAt: new Date(),
      decisionNote: "Answered on Home",
    });
  }
  const detail = { actionId, question: p.question ?? null, answer: text, learned: !!p.learn };
  if (a.leadId) await logActivity({ entity: "lead", entityId: a.leadId, actorId: actor.userId, action: "question_answered", detail });
  else if (a.contactId) await logActivity({ entity: "contact", entityId: a.contactId, actorId: actor.userId, action: "question_answered", detail });
  return inspect(ins.sourceType as SourceType, ins.sourceId, { force: true });
}

type PricingItem = { productId: string; model: string; key: string; suppliers: { id: string; name: string }[]; supplierId: string | null };

type StatedLine = { description: string; quantity: number; unitPrice: number; unit: string; kind: string };

/**
 * Chris confirms the prices he stated on a recording: they become a quote waiting for his approval
 * (never sent) and, when the lead has an email address, the options email he promised, as a draft.
 * Hermes recorded nothing; the amounts are Chris's own words, confirmed by his click.
 */
async function answerStatedPricing(a: typeof inspectorActions.$inferSelect, ins: typeof inspections.$inferSelect, answer: string, actor: Actor): Promise<InspectOutcome> {
  assertApprover(actor);
  if (!a.leadId) throw new Error("The call has no lead to quote against yet: decide who it is first.");
  let parsed: { items?: Partial<StatedLine>[]; gstIncluded?: boolean; title?: string };
  try {
    parsed = JSON.parse(answer) as typeof parsed;
  } catch {
    throw new Error("Confirm the prices on the card.");
  }
  const gst = (await loadPolicies()).gstRate.value;
  const lines: StatedLine[] = (parsed.items ?? [])
    .map((x) => ({ description: String(x.description ?? "").trim(), quantity: Number(x.quantity ?? 1), unitPrice: Number(x.unitPrice), unit: String(x.unit ?? "each"), kind: String(x.kind ?? "other") }))
    .filter((x) => x.description && Number.isFinite(x.unitPrice) && x.unitPrice > 0 && x.unitPrice < 1_000_000 && Number.isFinite(x.quantity) && x.quantity > 0);
  if (!lines.length) throw new Error("Keep at least one line with a price.");
  const ex = (v: number) => (parsed.gstIncluded ? Math.round((v / (1 + gst)) * 100) / 100 : v);
  const lead = (await db.query.leads.findFirst({ where: eq(leads.id, a.leadId) }))!;
  const lineItems = lines.map((l) => ({ description: `${l.description}${l.unit === "per_month" ? " (per month)" : l.unit === "per_hour" ? " (per hour)" : ""}`, quantity: l.quantity, unitPrice: ex(l.unitPrice) }));
  const taxRate = Math.round(gst * 10000) / 100;
  const totals = computeTotals(lineItems, taxRate);
  const title = parsed.title?.trim() || `${lines.some((l) => l.kind === "rental") ? "Camera rental" : lead.service ?? "Quote"} for ${lead.name}`;
  const quoteId = await db.transaction(async (tx) => {
    const number = await nextNumber(tx, "quotes");
    const [row] = await tx
      .insert(quotes)
      .values({ number, title, contactId: lead.contactId, leadId: lead.id, status: "needs_review", origin: "manual", taxRate: taxRate.toFixed(2), lineItems, subtotal: totals.subtotal, total: totals.total, notes: `Prices as stated by Chris on the recorded call, confirmed on Home.` })
      .returning({ id: quotes.id, number: quotes.number });
    return row;
  });
  const summary = lines.map((l) => `${l.description}: $${l.unitPrice.toFixed(2)}${l.unit === "per_month" ? "/month" : ""}${parsed.gstIncluded ? " inc GST" : " ex GST"}`).join("; ");
  let draftId: string | null = null;
  if (lead.email) {
    const first = lead.name.split(/\s+/)[0];
    const body = [
      `Hi ${first},`,
      "",
      "Thanks for your time on the phone. As discussed, here are the options:",
      "",
      ...lines.map((l) => `- ${l.description}`),
      "",
      `Quote Q-${quoteId.number} sets out the pricing. Have a look and let me know which option suits, and I can book it in.`,
      "",
      "Thanks,",
      "Chris",
      "Get Secure",
    ].join("\n");
    const thread = lead.emailThreadId ? await db.query.emailThreads.findFirst({ where: eq(emailThreads.id, lead.emailThreadId), columns: { id: true, subject: true } }) : null;
    const d = await createDraft({ kind: "email", leadId: lead.id, contactId: lead.contactId, threadId: thread?.id ?? null, to: [lead.email], subject: thread?.subject ? (/^re:/i.test(thread.subject) ? thread.subject : `Re: ${thread.subject}`) : `Your options from Get Secure`, body }, actor, { submit: true });
    draftId = d.id;
  }
  await db.update(inspectorActions).set({ status: "accepted", decidedById: actor.userId, decidedAt: new Date(), result: { answer: summary, quoteId: quoteId.id, quoteNumber: quoteId.number, draftId } }).where(eq(inspectorActions.id, a.id));
  await recordFeedback({ inspectionId: ins.id, leadId: a.leadId, contactId: a.contactId, kind: "question_answered", subject: "stated_pricing", value: { key: `stated_pricing:${ins.sourceId}`, question: "stated pricing", answer: summary, kind: "stated_pricing", quoteId: quoteId.id }, userId: actor.userId });
  await logActivity({ entity: "lead", entityId: a.leadId, actorId: actor.userId, action: "quote_prepared_by_inspector", detail: { quoteId: quoteId.id, quoteNumber: quoteId.number, draftId, inspectionId: ins.id, from: "stated_pricing", summary } });
  return inspect(ins.sourceType as SourceType, ins.sourceId, { force: true });
}

/**
 * Chris answers a pricing question: each cost goes through the catalogue's own price path AS CHRIS
 * (entered and approved in one step, with history); then the Brain re-runs and the quote is prepared
 * for his approval. Hermes never enters a price. Items left blank stay unpriced.
 */
async function answerPricing(a: typeof inspectorActions.$inferSelect, ins: typeof inspections.$inferSelect, items: PricingItem[], answer: string, actor: Actor): Promise<InspectOutcome> {
  assertApprover(actor);
  let parsed: { items?: { productId?: string; supplierId?: string; costExGst?: number | string }[] };
  try {
    parsed = JSON.parse(answer) as typeof parsed;
  } catch {
    throw new Error("Enter the costs in the pricing card.");
  }
  const entered = (parsed.items ?? [])
    .map((x) => ({ productId: String(x.productId ?? ""), supplierId: String(x.supplierId ?? ""), costExGst: Number(x.costExGst) }))
    .filter((x) => x.productId && x.supplierId && Number.isFinite(x.costExGst) && x.costExGst > 0 && x.costExGst < 1_000_000);
  if (!entered.length) throw new Error("Enter at least one cost (ex GST).");
  const priced: { productId: string; model: string; supplierId: string; costExGst: number; offerId: string }[] = [];
  for (const x of entered) {
    const item = items.find((i) => i.productId === x.productId);
    if (!item || !item.suppliers.some((s) => s.id === x.supplierId)) throw new Error("That product or supplier is not on the card.");
    const r = await recordSupplierPrice({ productId: x.productId, supplierId: x.supplierId, costExGst: x.costExGst, source: "hermes_question", priceSource: "manual" }, actor);
    priced.push({ productId: x.productId, model: item.model, supplierId: x.supplierId, costExGst: x.costExGst, offerId: r.offerId });
  }
  const summary = priced.map((x) => `${x.model}: $${x.costExGst.toFixed(2)} ex GST`).join("; ");
  await db.update(inspectorActions).set({ status: "accepted", decidedById: actor.userId, decidedAt: new Date(), result: { answer: summary, prices: priced } }).where(eq(inspectorActions.id, a.id));
  await recordFeedback({ inspectionId: ins.id, leadId: a.leadId, contactId: a.contactId, kind: "question_answered", subject: "pricing", value: { key: `pricing:${a.leadId}`, question: "pricing", answer: summary, kind: "pricing", prices: priced }, userId: actor.userId });
  if (a.leadId) await logActivity({ entity: "lead", entityId: a.leadId, actorId: actor.userId, action: "question_answered", detail: { actionId: a.id, question: "Trade costs for the design", answer: summary, learned: false } });
  // The costs are in: the Brain re-runs and the quote is prepared for Chris's approval (never sent).
  const input = await loadInput(ins.sourceType as SourceType, ins.sourceId);
  const actions = input
    ? await routeActions(
        [
          { type: "RUN_BUSINESS_BRAIN", mode: "auto", rule: "pricing_answered", reason: "Costs entered by Chris; re-run with them.", payload: {} },
          { type: "PREPARE_QUOTE", mode: "auto", rule: "pricing_answered", reason: "Quote prepared from the approved costs; waits for Chris's approval.", payload: {} },
        ],
        { inspectionId: ins.id, input, leadId: a.leadId, contactId: a.contactId, jobId: a.jobId, actor },
      )
    : [];
  return { inspectionId: ins.id, status: ins.status, engine: ins.engine as "hermes", hermesStatus: null, hermesError: null, actions };
}

/** What is known when Hermes could not read the source: nothing, honestly. */
function emptyUnderstanding(input: InspectorInput): Understanding {
  return { service: null, propertyType: null, intents: ["information"], primaryIntent: "information", urgency: "normal", facts: [], requested: [], timing: [], budget: [], objections: [], decisions: [], commitments: [], missing: [], quoteRefs: [], summary: input.title || "(no subject)" };
}

/**
 * The email's filing follows Hermes's decision: an email "reading" becomes a lead (createLeadFromEmail
 * does that), existing work when filed on a lead or customer, "needs review" when Chris has to decide
 * (or Hermes could not read it), and otherwise stays read with nothing to file. A not-a-lead decision
 * is applied by applyLeadDecision.
 */
async function settleClassification(input: InspectorInput, s: { status: string; leadId: string | null; contactId: string | null; engine: "hermes" | "fallback"; verified: boolean }) {
  if (input.sourceType !== "email" || input.direction !== "inbound") return;
  const e = await db.query.emails.findFirst({ where: eq(emails.id, input.sourceId), columns: { classification: true, leadId: true, contactId: true } });
  if (!e || !["reading", "pending", "needs_review"].includes(e.classification)) return;
  const next = s.status === "needs_review" ? "needs_review" : s.leadId || e.leadId || s.contactId || e.contactId ? "existing" : s.engine === "hermes" ? "not_lead" : null;
  if (!next || next === e.classification) return;
  // The sender is linked to a lead or customer only when the CRM verified who they are (an email
  // address, phone number or thread). Work filed in Hermes's evidenced context stays unlinked.
  const link = next === "existing" && s.verified ? { leadId: e.leadId ?? s.leadId, contactId: e.contactId ?? s.contactId } : {};
  await db.update(emails).set({ classification: next as "existing", ...link, classifiedAt: new Date() }).where(eq(emails.id, input.sourceId));
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

// ---------------- Hermes's operational decisions ----------------

/** Supplier, provider, internal and irrelevant mail is never a lead, even when Hermes left the decision open. */
/**
 * Hermes's lead decision, or what its reading amounts to when it left the field blank: a supplier,
 * provider or internal message is not a lead; a new enquiry or quote request from a customer is one.
 */
const effectiveLeadDecision = (h: HermesResult) => {
  if (h.lead_decision !== "undecided") return h.lead_decision;
  if (NON_CUSTOMER_CONTEXTS.includes(h.business_context)) return "not_lead";
  if (h.business_context !== "accounting_payment" && (h.conversation_type === "new_enquiry" || h.intent === "new_enquiry" || h.intent === "quote_request")) return "lead";
  return "undecided";
};

type LeadDecision = { kind: "created"; leadId: string; contactId: string | null; label: string } | { kind: "proposed" } | { kind: "reversed"; leadId: string } | { kind: "kept_for_chris"; leadId: string } | { kind: "not_lead" };

/**
 * Hermes decides whether an email is a lead. "lead": the lead is created through the normal path
 * (a customer is linked only by an exact email match), or proposed to Chris when Hermes is not sure
 * enough. "not_lead": a lead the rules created from this very email and nobody has touched is marked
 * lost ("Not a lead"); a lead someone has worked on is left for Chris. Every step is on the timeline
 * and reversible.
 */
/** Enough to make a lead from: someone named (a name or company) and a way to reach them or a site. */
function substantialReading(h: HermesResult, input: InspectorInput): boolean {
  const has = (k: string) => h.facts.some((f) => f.key === k && f.value != null && String(f.value).trim() !== "");
  const named = has("contact_name") || has("company") || !!input.form?.name || !!input.from.name || !!h.counterparty.name;
  const reachable = has("phone") || has("email") || has("site_address") || !!input.form?.phone || !!input.form?.email || !!input.from.email || !!input.from.phone;
  return named && reachable;
}

/** The lead a reading becomes: Hermes's checked facts first, then what the source itself gives. */
function leadOverrides(h: HermesResult, input: InspectorInput, u: Understanding): Partial<ExtractedLead> {
  const fact = (k: string) => u.facts.find((f) => f.key === k);
  return {
    is_lead: true,
    confidence: h.confidence,
    contact_name: (fact("contact_name")?.value as string | undefined) ?? input.form?.name ?? input.from.name ?? h.counterparty.name ?? null,
    company: (fact("company")?.value as string | undefined) ?? null,
    email: (fact("email")?.value as string | undefined) ?? input.form?.email ?? input.from.email ?? null,
    phone: fact("phone")?.display ?? input.form?.phone ?? input.from.phone ?? null,
    service: fact("service")?.display ?? (u.service ? (SERVICE_DISPLAY[u.service] ?? null) : null) ?? input.form?.service ?? null,
    site_address: (fact("site_address")?.value as string | undefined) ?? input.form?.address ?? null,
    summary: h.summary,
    urgency: h.urgency,
    next_action: HERMES_ACTION_LABELS[h.recommended_action] ?? h.recommended_action,
    reason: h.reason,
  };
}

/**
 * Hermes's lead decision, carried out: a new enquiry (by email or on a recorded call) becomes a
 * lead from the reading; not a lead files the email or marks an untouched lead lost. Audited, and
 * Chris can reverse it.
 */
async function applyLeadDecision(h: HermesResult, input: InspectorInput, u: Understanding, minConfidence: number, identity: IdentityResult, unknownWork = false): Promise<LeadDecision | null> {
  if (input.direction === "outbound") return null;
  const decision = effectiveLeadDecision(h);
  const draft = leadOverrides(h, input, u);
  // A lead needs someone to be about: a name or company, and a way to reach them or a site. Work
  // the CRM cannot place (unknown work) needs both; a nameless, numberless call waits for Chris.
  const named = !!(draft.contact_name || draft.company);
  const reachable = !!(draft.phone || draft.email || draft.site_address);
  const substantial = unknownWork ? named && reachable : input.sourceType === "recording" ? named || !!draft.phone : true;
  // Someone in the CRM may already be this person: creating another lead would duplicate them, so
  // Chris chooses between the candidate and a new lead. On a call the name is often all there is,
  // so a name alone counts; an email comes from an address the CRM does not know, so a name alone
  // is a coincidence (common names) until something else agrees: the site, the company, a job.
  const knownBy = (c: IdentityCandidate) => input.sourceType === "recording" || c.signals.some((s) => s.kind !== "name");
  const maybeKnown = identity.status !== "matched" && identity.candidates.some(knownBy);
  if (input.sourceType === "recording") {
    const r = await db.query.recordings.findFirst({ where: eq(recordings.id, input.sourceId), columns: { id: true, leadId: true, contactId: true } });
    if (!r || r.leadId || r.contactId || decision !== "lead") return null;
    if (!substantial) return null;
    if (h.confidence < minConfidence || maybeKnown) return { kind: "proposed" };
    const leadId = await createLeadFromRecording(r.id, { actorId: null, overrides: draft });
    const lead = (await db.query.leads.findFirst({ where: eq(leads.id, leadId), columns: { name: true, contactId: true } }))!;
    await logActivity({ entity: "lead", entityId: leadId, actorId: null, action: "lead_created_by_hermes", detail: { recordingId: r.id, reason: h.reason, confidence: h.confidence } });
    return { kind: "created", leadId, contactId: lead.contactId, label: lead.name };
  }
  const e = await db.query.emails.findFirst({ where: eq(emails.id, input.sourceId), columns: { id: true, leadId: true, classification: true, contactId: true } });
  if (!e) return null;
  if (decision === "lead") {
    if (e.leadId) return null;
    if (!substantial) return null;
    if (h.confidence < minConfidence || maybeKnown) return { kind: "proposed" };
    // The lead carries Hermes's reading of the email (checked facts), not a second extraction.
    const leadId = await createLeadFromEmail(e.id, { actorId: null, overrides: draft });
    const lead = (await db.query.leads.findFirst({ where: eq(leads.id, leadId), columns: { name: true, contactId: true } }))!;
    await logActivity({ entity: "lead", entityId: leadId, actorId: null, action: "lead_created_by_hermes", detail: { emailId: e.id, reason: h.reason, confidence: h.confidence } });
    return { kind: "created", leadId, contactId: lead.contactId, label: lead.name };
  }
  if (decision === "not_lead" && h.confidence >= minConfidence) {
    if (!e.leadId) {
      if (e.classification === "needs_review" || e.classification === "reading") await db.update(emails).set({ classification: "not_lead", classifiedAt: new Date() }).where(eq(emails.id, e.id));
      return { kind: "not_lead" };
    }
    const lead = await db.query.leads.findFirst({ where: eq(leads.id, e.leadId), columns: { id: true, status: true, sourceEmailId: true, createdById: true } });
    if (!lead) return null;
    const [quoteRow, jobRow, taskRow, otherEmail] = await Promise.all([
      db.query.quotes.findFirst({ where: eq(quotes.leadId, lead.id), columns: { id: true } }),
      db.query.jobs.findFirst({ where: eq(jobs.leadId, lead.id), columns: { id: true } }),
      db.query.tasks.findFirst({ where: and(eq(tasks.leadId, lead.id), ne(tasks.status, "open")), columns: { id: true } }),
      db.query.emails.findFirst({ where: and(eq(emails.leadId, lead.id), ne(emails.id, e.id)), columns: { id: true } }),
    ]);
    const untouched = lead.sourceEmailId === e.id && !lead.createdById && lead.status === "new" && !quoteRow && !jobRow && !taskRow && !otherEmail;
    if (!untouched) return lead.status === "lost" ? null : { kind: "kept_for_chris", leadId: lead.id };
    await db.update(leads).set({ status: "lost", lostReason: `Not a lead (Hermes): ${h.reason}`.slice(0, 500), updatedAt: new Date() }).where(eq(leads.id, lead.id));
    await db.update(emails).set({ classification: "not_lead", classifiedAt: new Date() }).where(eq(emails.id, e.id));
    await logActivity({ entity: "lead", entityId: lead.id, actorId: null, action: "lead_reversed_by_hermes", detail: { emailId: e.id, reason: h.reason, confidence: h.confidence } });
    return { kind: "reversed", leadId: lead.id };
  }
  return null;
}

/**
 * A phone number Hermes gives as a fact, only when its cited words are in the source verbatim and
 * read as that number (digits or spoken digits, "oh two one…"). Anything else is ignored.
 */
function phoneReadByHermes(h: HermesResult, input: InspectorInput): string | null {
  const hay = sourceHaystack(input);
  for (const f of h.facts) {
    if (f.key !== "phone" || (typeof f.value !== "string" && typeof f.value !== "number") || !f.evidence) continue;
    const value = normalisePhone(String(f.value));
    if (value.length < 8 || value.length > 12 || !evidenceFound(f.evidence, hay)) continue;
    if (normalisePhone(digitSequence(f.evidence)) === value) return value;
  }
  return null;
}

const plain = (s: string) => s.toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9]+/g, " ").trim();
/** "138 Wiri Station Road, Manukau" → "138 wiri": the street number and the first word of the street. */
function siteKey(address: string | null | undefined): string | null {
  const m = plain((address ?? "").split(",")[0]).match(/\b(\d+[a-z]?)\s+([a-z]{3,})/);
  return m ? `${m[1]} ${m[2]}` : null;
}

/**
 * The work Hermes says a message belongs to, checked: the record exists, and the source itself
 * shows it: an identity signal other than a name on that work, or a street address of that work
 * (its own, or of the lead, customer or job it belongs to), its job number or a quote number in the
 * message. A name alone never places it.
 */
async function checkContext(ref: string, input: InspectorInput, identity: IdentityResult): Promise<NonNullable<Parameters<typeof validateHermes>[1]["context"]>> {
  const [kind, id] = ref.split(":");
  const no = (label: string, why: string) => ({ ref, label, leadId: null, jobId: null, contactId: null, accepted: false, why });
  if (!id || !/^[0-9a-f-]{36}$/i.test(id) || !["lead", "job", "customer"].includes(kind)) return no(ref, "that is not a CRM record");
  // The record, and everything it belongs to: its lead, customer and jobs.
  let label = ref;
  let leadId: string | null = null;
  let jobId: string | null = null;
  let contactId: string | null = null;
  if (kind === "lead") {
    const l = await db.query.leads.findFirst({ where: eq(leads.id, id), columns: { id: true, name: true, site: true, contactId: true } });
    if (!l) return no(ref, "that record does not exist");
    label = `${l.name}${l.site ? ` (${l.site})` : ""}`;
    leadId = l.id;
    contactId = l.contactId;
  } else if (kind === "job") {
    const j = await db.query.jobs.findFirst({ where: eq(jobs.id, id), columns: { id: true, number: true, title: true, siteAddress: true, leadId: true, contactId: true } });
    if (!j) return no(ref, "that record does not exist");
    label = `J-${j.number} ${j.title}${j.siteAddress ? ` (${j.siteAddress})` : ""}`;
    jobId = j.id;
    leadId = j.leadId;
    contactId = j.contactId;
  } else {
    const c = await db.query.contacts.findFirst({ where: eq(contacts.id, id), columns: { id: true, name: true, address: true } });
    if (!c) return no(ref, "that record does not exist");
    label = `${c.name}${c.address ? ` (${c.address})` : ""}`;
    contactId = c.id;
  }
  const [lead, contact, relatedJobs, relatedLeads] = await Promise.all([
    leadId ? db.query.leads.findFirst({ where: eq(leads.id, leadId), columns: { site: true } }) : null,
    contactId ? db.query.contacts.findFirst({ where: eq(contacts.id, contactId), columns: { address: true } }) : null,
    db.query.jobs.findMany({ where: jobId ? eq(jobs.id, jobId) : leadId ? eq(jobs.leadId, leadId) : eq(jobs.contactId, contactId!), columns: { id: true, number: true, siteAddress: true }, limit: 20 }),
    kind === "customer" ? db.query.leads.findMany({ where: eq(leads.contactId, contactId!), columns: { id: true, site: true }, limit: 20 }) : Promise.resolve([] as { id: string; site: string | null }[]),
  ]);
  const leadIds = [...new Set([leadId, ...relatedLeads.map((l) => l.id)].filter((x): x is string => !!x))];
  const quoteRows = leadIds.length ? await db.query.quotes.findMany({ where: inArray(quotes.leadId, leadIds), columns: { number: true }, limit: 30 }) : [];
  const sites = [lead?.site, contact?.address, ...relatedJobs.map((j) => j.siteAddress), ...relatedLeads.map((l) => l.site)].filter((x): x is string => !!x);
  const numbers = [...relatedJobs.map((j) => new RegExp(`\\b(j|job)\\s?${j.number}\\b`)), ...quoteRows.map((q) => new RegExp(`\\bq\\s?${q.number}\\b`))];
  const base = { ref, label, leadId, jobId, contactId };

  // A CRM identity signal other than a name, on this work or the lead/customer/job it belongs to.
  const cand = identity.candidates.find((c) => (c.leadId && c.leadId === leadId) || (c.contactId && c.contactId === contactId) || (c.jobId && (c.jobId === jobId || relatedJobs.some((j) => j.id === c.jobId))));
  const strong = cand?.signals.filter((x) => x.kind !== "name") ?? [];
  if (strong.length) return { ...base, accepted: true, why: `the CRM matched it on ${strong.map((x) => x.detail).join(", ")}` };
  const text = plain([input.title, input.text, ...input.utterances.map((u) => u.text), ...(input.form ? Object.values(input.form.fields) : []), input.form?.address ?? ""].join(" \n "));
  const site = sites.find((x) => {
    const key = siteKey(x);
    return !!key && text.includes(key);
  });
  if (site) return { ...base, accepted: true, why: `the message names the site (${site})` };
  if (numbers.some((r) => r.test(text))) return { ...base, accepted: true, why: "the message gives its job or quote number" };
  // A street with no number places it only when this is the one open record on that street.
  for (const street of streetsIn([input.title, input.text, ...input.utterances.map((u) => u.text)].join(" \n "))) {
    if (!sites.some((x) => x.toLowerCase().includes(street))) continue;
    const on = await recordsOnStreet(street);
    if (on.length === 1 && ((leadId && on[0].leadId === leadId) || (contactId && on[0].contactId === contactId) || (jobId && on[0].jobId === jobId))) return { ...base, accepted: true, why: `the message names ${street}, and this is the only open record on it` };
  }
  return { ...base, accepted: false, why: "the message does not show its site, job or quote number (a name alone never places it)" };
}

/** File an email in the work Hermes placed it in, without linking the sender to any customer. */
async function fileInContext(input: InspectorInput, work: { leadId: string | null; label: string }) {
  if (input.sourceType !== "email" || !work.leadId) return;
  const e = await db.query.emails.findFirst({ where: eq(emails.id, input.sourceId), columns: { leadId: true, classification: true } });
  if (!e || e.leadId) return;
  await db
    .update(emails)
    .set({ leadId: work.leadId, ...(["needs_review", "not_lead", "pending"].includes(e.classification) ? { classification: "existing" as const } : {}) })
    .where(eq(emails.id, input.sourceId));
  await logActivity({ entity: "lead", entityId: work.leadId, actorId: null, action: "email_filed_by_hermes", detail: { emailId: input.sourceId, title: input.title, from: input.from.email ?? input.from.name } });
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
    const e = await db.query.emails.findFirst({ where: eq(emails.id, ins.sourceId), columns: { threadId: true, fromAddress: true, subject: true, textBody: true } });
    await db.update(emails).set({ leadId, contactId }).where(eq(emails.id, ins.sourceId));
    if (e) await db.update(emailThreads).set({ leadId, contactId, updatedAt: new Date() }).where(eq(emailThreads.id, e.threadId));
    if (leadId) {
      await logActivity({ entity: "lead", entityId: leadId, actorId: actor.userId, action: "email_linked", detail: { threadId: e?.threadId, via: "Inspector review" } });
      // The lead made from a call has no email (and often a number with a digit missing): the
      // email Chris just filed on it fills those blanks, so the quote and the reply can reach them.
      const lead = await db.query.leads.findFirst({ where: eq(leads.id, leadId), columns: { email: true, phone: true, emailThreadId: true } });
      if (lead && e) {
        const web = parseWebsiteLead({ subject: e.subject ?? "", text: e.textBody ?? "", fromAddress: e.fromAddress })?.extraction;
        const address = personalEmail(web?.email ?? null) ?? personalEmail(e.fromAddress);
        const fullPhone = web?.phone && normalisePhone(web.phone).length >= 10 ? web.phone : null;
        const shortOnFile = !lead.phone || normalisePhone(lead.phone).length < 10;
        const patch: Partial<typeof leads.$inferInsert> = {};
        if (!lead.email && address) patch.email = address;
        if (fullPhone && shortOnFile && (!lead.phone || digitsFitInside(normalisePhone(lead.phone), normalisePhone(fullPhone)))) patch.phone = fullPhone;
        if (!lead.emailThreadId) patch.emailThreadId = e.threadId;
        if (Object.keys(patch).length) {
          await db.update(leads).set({ ...patch, updatedAt: new Date() }).where(eq(leads.id, leadId));
          await logActivity({ entity: "lead", entityId: leadId, actorId: actor.userId, action: "lead_filled_from_email", detail: { ...patch, emailId: ins.sourceId } });
        }
      }
    }
  }
  await db.update(inspectorActions).set({ status: "accepted", decidedById: actor.userId, decidedAt: new Date() }).where(and(eq(inspectorActions.inspectionId, inspectionId), eq(inspectorActions.status, "awaiting_approval"), inArray(inspectorActions.type, ["NEEDS_REVIEW", "LINK_RECORDING"])));
  await db.update(inspections).set({ reviewedById: actor.userId, reviewedAt: new Date() }).where(eq(inspections.id, inspectionId));
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
export type AcceptChoice = { slot?: number };

export async function acceptAction(actionId: string, actor: Actor, choice: AcceptChoice = {}): Promise<Record<string, unknown>> {
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
    case "ASK_CHRIS":
      throw new Error("Answer the question on Home; it cannot be accepted without an answer.");
    case "OPERATOR_COMMAND":
      follow = [{ type: "OPERATOR_COMMAND", mode: "auto", rule: "accepted:OPERATOR_COMMAND", reason: a.reason, payload: p }];
      break;
    case "PROPOSE_SITE_VISIT":
    case "PROPOSE_BOOKING": {
      const slots = (Array.isArray(p.slots) ? p.slots : []) as { startsAt: string; endsAt: string; label: string }[];
      const pick = choice.slot != null ? slots[choice.slot] : null;
      if (!pick) {
        // No slot chosen: a task to arrange it, as before.
        follow = a.type === "PROPOSE_SITE_VISIT" ? [asTask("Arrange a site visit", `${a.reason}${p.address ? ` Address: ${p.address}.` : ""}${p.timing ? ` They mentioned ${p.timing}.` : ""} Agree a time with the customer, then schedule it.`)] : [asTask("Arrange the booking", `${a.reason}${p.timing ? ` They mentioned ${p.timing}.` : ""} Agree a time with the customer, then schedule it.`)];
        break;
      }
      // Chris chose a slot: it goes in the calendar (pencilled), and the confirmation is drafted for
      // him to send. The customer learns the time only when he sends it.
      const visit = a.type === "PROPOSE_SITE_VISIT";
      const lead = a.leadId ? await db.query.leads.findFirst({ where: eq(leads.id, a.leadId), columns: { name: true, site: true, email: true } }) : null;
      const contact = !lead && a.contactId ? await db.query.contacts.findFirst({ where: eq(contacts.id, a.contactId), columns: { name: true, address: true } }) : null;
      const where = (typeof p.address === "string" && p.address) || lead?.site || contact?.address || null;
      const who = lead?.name ?? contact?.name ?? where ?? "appointment";
      if (visit) {
        const booked = await db.query.events.findFirst({ where: and(eq(events.kind, "site_visit"), gte(events.endsAt, new Date()), a.leadId ? eq(events.leadId, a.leadId) : eq(events.contactId, a.contactId!)), columns: { startsAt: true } });
        if (booked) throw new Error(`A site visit is already booked for ${booked.startsAt.toLocaleString("en-NZ", { timeZone: TZ, dateStyle: "medium", timeStyle: "short" })}.`);
      }
      const ev = await bookEvent(
        {
          kind: visit ? "site_visit" : "other",
          title: `${visit ? "Site visit" : "Booking"} — ${who} (pencilled)`,
          description: `${a.reason}\nProposed by Hermes; accepted by ${actor.name}. Confirm with the customer.`,
          location: where,
          startsAt: new Date(pick.startsAt),
          endsAt: new Date(pick.endsAt),
          leadId: a.leadId,
          contactId: a.contactId,
          jobId: a.jobId,
          assignedToId: typeof p.technicianId === "string" ? p.technicianId : null,
          via: "hermes_proposal",
        },
        actor,
      );
      result.eventId = ev.id;
      result.slot = pick;
      const first = who.split(" ")[0];
      // Nobody to write to (an appointment Chris stated himself): the calendar entry is the outcome.
      follow = !lead && !contact ? [] : [
        {
          type: "DRAFT_EMAIL",
          mode: "auto",
          rule: `accepted:${a.type}`,
          reason: `Confirmation of the ${visit ? "site visit" : "booking"} for Chris to send.`,
          payload: {
            subject: visit ? `Site visit${where ? ` at ${where}` : ""}` : `Your booking${where ? ` at ${where}` : ""}`,
            body: `Hi ${first},\n\nThanks for getting in touch. We can come out ${visit ? "for a site visit" : "to do the work"} on ${pick.label} if that suits — just reply to confirm and we'll lock it in.\n\nIf another time works better, let me know and we'll find one.\n\nThanks,\n${actor.name}\nGet Secure`,
          },
        },
      ];
      break;
    }
    case "PREPARE_REVISED_QUOTE":
      follow = [
        { type: "RUN_BUSINESS_BRAIN", mode: "auto", rule: "accepted:PREPARE_REVISED_QUOTE", reason: "Re-run with the updated facts.", payload: {} },
        { type: "PREPARE_QUOTE", mode: "auto", rule: "accepted:PREPARE_REVISED_QUOTE", reason: "Revised quote for Chris to review (no discount is applied automatically).", payload: {} },
      ];
      break;
    case "PROPOSE_LINK_SENDER": {
      // Chris agrees the sender belongs to the work: linked as if he had chosen it (the source is read again).
      await db.update(inspectorActions).set({ status: "accepted", decidedById: actor.userId, decidedAt: new Date() }).where(eq(inspectorActions.id, actionId));
      await recordFeedback({ inspectionId: ins.id, kind: "action_accepted", subject: a.type, value: { rule: a.rule, target: p.target ?? null }, userId: actor.userId });
      await confirmIdentity(ins.id, { leadId: a.leadId, contactId: a.contactId }, actor);
      return { linked: p.label ?? null };
    }
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
  // An open task to arrange it already exists (made since this was proposed): no second one. A
  // chosen slot is Chris's decision, so it goes ahead regardless.
  const inHand = (a.type === "PROPOSE_SITE_VISIT" || a.type === "PROPOSE_BOOKING") && !result.eventId ? await alreadyInHand({ type: a.type }, routeCtx, { ignoreWaiting: true }) : null;
  const done = inHand ? [] : await routeActions(follow, routeCtx);
  result = inHand ? { ...result, followUp: [], ...inHand } : { ...result, followUp: done };
  await db.update(inspectorActions).set({ status: "accepted", decidedById: actor.userId, decidedAt: new Date(), result }).where(eq(inspectorActions.id, actionId));
  await recordFeedback({ inspectionId: ins.id, kind: "action_accepted", subject: a.type, value: { rule: a.rule, followUp: done.map((d) => ({ type: d.type, status: d.status })) }, userId: actor.userId });
  if (a.leadId) await logActivity({ entity: "lead", entityId: a.leadId, actorId: actor.userId, action: "inspector_action_accepted", detail: { type: a.type, reason: a.reason } });
  return result;
}

export async function dismissAction(actionId: string, actor: Actor, note: string | null): Promise<void> {
  if (actor.kind !== "human") throw new GuardrailError("Only a person can dismiss a recommendation.");
  const a = await db.query.inspectorActions.findFirst({ where: eq(inspectorActions.id, actionId) });
  if (!a) throw new Error("Action not found");
  await db.update(inspectorActions).set({ status: "dismissed", decidedById: actor.userId, decidedAt: new Date(), result: { ...(a.result ?? {}), note } }).where(eq(inspectorActions.id, actionId));
  await recordFeedback({ inspectionId: a.inspectionId, kind: "action_dismissed", subject: a.type, value: { rule: a.rule, note }, userId: actor.userId });
  // A skipped pricing question leaves the quote unpriced: the pricing task stands in for the card.
  if (a.type === "ASK_CHRIS" && (a.payload as { kind?: string }).kind === "pricing" && a.leadId) {
    const lead = await db.query.leads.findFirst({ where: eq(leads.id, a.leadId), columns: { name: true, contactId: true } });
    await createTask({ leadId: a.leadId, contactId: lead?.contactId ?? null }, { title: `Price the quote for ${lead?.name ?? "the customer"}`, kind: "quote", due: "today", detail: "Hermes asked for the trade costs and the question was skipped. Approve the prices (or enter the quote by hand), then prepare it from the assessment.", ruleKey: "inspector:PREPARE_QUOTE:pricing_skipped" });
  }
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
  if (!ins || ins.reviewKind !== "hermes_proposed_lead") throw new Error("This is not a proposed lead.");
  if (ins.status !== "needs_review") throw new Error("This proposal has already been dealt with.");
  const review = await db.query.inspectorActions.findFirst({ where: and(eq(inspectorActions.inspectionId, ins.id), eq(inspectorActions.type, "NEEDS_REVIEW")), orderBy: [desc(inspectorActions.createdAt)], columns: { payload: true } });
  const draft = ((review?.payload as { leadDraft?: Partial<ExtractedLead> } | undefined)?.leadDraft ?? {}) as Partial<ExtractedLead>;
  let leadId: string;
  if (ins.sourceType === "recording") {
    const r = await db.query.recordings.findFirst({ where: eq(recordings.id, ins.sourceId), columns: { leadId: true } });
    if (r?.leadId) throw new Error("This conversation is already on a lead.");
    leadId = await createLeadFromRecording(ins.sourceId, { actorId: actor.userId, overrides: draft });
  } else {
    const em = await db.query.emails.findFirst({ where: eq(emails.id, ins.sourceId), columns: { leadId: true } });
    if (em?.leadId) throw new Error("This email is already on a lead.");
    leadId = await createLeadFromEmail(ins.sourceId, { actorId: actor.userId, overrides: draft });
  }
  await db.update(inspections).set({ reviewedById: actor.userId, reviewedAt: new Date(), updatedAt: new Date() }).where(eq(inspections.id, inspectionId));
  await recordFeedback({ inspectionId, leadId, kind: "proposed_lead_accepted", subject: "hermes_proposed_lead", userId: actor.userId });
  return inspect(ins.sourceType as SourceType, ins.sourceId, { force: true });
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
  await recordFeedback({ inspectionId: f?.inspectionId ?? null, kind: decision === "apply" ? "fact_applied" : "fact_rejected", subject: f?.key ?? null, userId: actor.userId });
}

export async function setCommitmentStatus(id: string, status: "done" | "cancelled" | "outstanding", actor: Actor): Promise<void> {
  if (actor.kind !== "human") throw new GuardrailError("Only a person can close a commitment.");
  const before = await db.query.commitments.findFirst({ where: eq(commitments.id, id), columns: { status: true, completedById: true, inspectionId: true, leadId: true, contactId: true, action: true } });
  // Reopening one Hermes closed is a correction of Hermes: recorded for its learning.
  if (status === "outstanding" && before && before.status !== "outstanding" && !before.completedById)
    await recordFeedback({ inspectionId: before.inspectionId, leadId: before.leadId, contactId: before.contactId, kind: "hermes_decision_reversed", subject: "commitment_resolved", value: { action: before.action, was: before.status }, userId: humanId(actor) });
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
