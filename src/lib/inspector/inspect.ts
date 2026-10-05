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
import { commitments, contacts, emails, emailThreads, facts, inspections, inspectorActions, inspectorRuns, jobs, leads, quotes, recordings, tasks, users } from "@/db/schema";
import { logActivity } from "@/lib/activity";
import { createLeadFromEmail, markEmailNotLead } from "@/lib/email/pipeline";
import { type Actor, assertApprover, GuardrailError } from "@/lib/guard/actor";
import { NON_CUSTOMER_CONTEXTS, type HermesResult } from "@/lib/hermes/contract";
import { analyse } from "./analyse";
import { decideFact, diffFacts, storeFacts } from "./facts";
import { decideIdentity, mergeCandidates } from "./identity";
import { recordDecision, shadow } from "./jev";
import { recordFeedback } from "./feedback";
import { planActions } from "./plan";
import { alreadyInHand, routeActions, type RoutedAction } from "./router";
import { validateHermes, type Validation } from "./validate";
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
  let leadId = identity.status === "matched" ? (identity.chosen?.leadId ?? null) : null;
  const contactIdChosen = identity.status === "matched" ? (identity.chosen?.contactId ?? null) : null;
  let state = await crmState(leadId, contactIdChosen, input);
  let contactId = contactIdChosen ?? state.contactId;
  let known = identity.status === "matched" ? await crmKnown(leadId, contactId) : {};
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

  // ---- Hermes: the operational judgement ----
  const hermes = await askHermes(input, { identity, leadId, contactId, staffNames: staff });
  let engine: "hermes" | "fallback";
  let understanding: Understanding;
  let planned: PlannedAction[];
  let validation: Validation | null = null;
  let reviewKind: string | null;
  let jobId = state.jobId;
  let senderUnverified = false;
  let storeCommitmentsFor = true;
  const minConfidence = hermesMinConfidence();
  if (hermes.status === "ok" && hermes.result) {
    engine = "hermes";
    const h = hermes.result;
    const citable = ((hermes.contextRefs as { citable?: string[] }).citable ?? []) as string[];
    // The work Hermes places it in; if it only named it as its suggestion of who the sender is, that is
    // treated as the proposed work too. Either way it must pass the same evidence check.
    const contextRef = h.operational_context.ref ?? (h.identity.suggestion === "candidate" ? h.identity.candidate_key : null);
    const context = identity.status !== "matched" && contextRef ? await checkContext(contextRef, input, identity) : null;
    const validate = () =>
      validateHermes(h, {
        input,
        identity,
        known,
        crm: { leadId, contactId, hasOpenBrainQuote: state.hasOpenBrainQuote, hasSentQuote: state.hasSentQuote, recordingLinked: state.recordingLinked, customerEmail: state.customerEmail, customerPhone: state.customerPhone },
        minConfidence,
        citable: [...citable, ...(context?.accepted ? [context.ref] : [])],
        context,
        rules: { primaryIntent: rulesView.primaryIntent, firstAction: rulesView.firstAction, urgency: rulesView.urgency },
      });
    validation = validate();
    planned = validation.plan;
    reviewKind = validation.reviewKind;

    // Hermes's lead decision (emails), carried out internally: audited, and Chris can reverse it.
    const decision = validation.workContext ? null : await applyLeadDecision(h, input, minConfidence);
    if (decision?.kind === "created") {
      identity = { status: "matched", chosen: { leadId: decision.leadId, contactId: decision.contactId, jobId: null, label: decision.label, score: 1, signals: [{ kind: "linked", detail: "the lead Hermes created from this email", weight: 1 }] }, candidates: identity.candidates, confidence: 1, reason: "Hermes decided this is a new lead; the CRM created it from this email." };
      leadId = decision.leadId;
      state = await crmState(leadId, decision.contactId, input);
      contactId = decision.contactId ?? state.contactId;
      known = await crmKnown(leadId, contactId);
      jobId = state.jobId;
      validation = validate();
      validation.hard.push({ rule: "lead_created_by_hermes", message: "Hermes decided this is a new lead; the CRM created it through the normal path (a customer is linked only by an exact email match). Chris can mark it lost if not." });
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
          payload: { kind: "hermes_proposed_lead", hermesRecommendation: h.recommended_action, confidence: h.confidence, rulesClassification: input.rulesClassification ?? null, candidates: identity.candidates.slice(0, 5).map((c) => ({ leadId: c.leadId, contactId: c.contactId, label: c.label, score: c.score, signals: c.signals })) },
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
    // FALLBACK: keep the item, use the rules only where safe, and hand it to Chris.
    engine = "fallback";
    understanding = rules.understanding;
    const why = hermes.status === "not_configured" ? "Hermes is not connected" : `Hermes could not read it (${hermes.status.replace(/_/g, " ")}${hermes.error ? `: ${hermes.error}` : ""})`;
    if (input.sourceType === "email" && input.rulesClassification === "not_lead") {
      // The rules' "not a lead" stands until Hermes can read it (it is retried): nothing for Chris yet.
      planned = [];
      reviewKind = null;
      storeCommitmentsFor = false;
    } else if (identity.status === "needs_review") {
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

  // Facts: filled in only for a verified customer; an unverified sender's facts are proposed to Chris.
  const factsAbout = identity.status === "matched" || senderUnverified;
  const diffs = factsAbout && storeCommitmentsFor ? (engine === "fallback" ? rulesDiffs : await diffFacts(understanding.facts, leadId, contactId)) : [];
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
      validation: validation ? { hard: validation.hard, business: validation.business, advisories: validation.advisories, rejectedFacts: validation.rejectedFacts, headline: validation.headline, reviewKind: validation.reviewKind, decisions: validation.decisions } : { fallback: true, reviewKind },
    })
    .returning({ id: inspectorRuns.id });

  if (storeCommitmentsFor) await storeCommitments(row.id, input, understanding, factsAbout ? { leadId, contactId, jobId } : { leadId: null, contactId: null, jobId: null });
  const detail = { inspectionId: row.id, sourceType, sourceId, title: input.title, summary: understanding.summary, engine, recommended: hermes.result?.recommended_action ?? null, confidence: hermes.result?.confidence ?? null };
  if (leadId) await logActivity({ entity: "lead", entityId: leadId, actorId: null, action: "inspected", detail });
  else if (contactId) await logActivity({ entity: "contact", entityId: contactId, actorId: null, action: "inspected", detail });

  let actions: RoutedAction[];
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
  }
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

// ---------------- Hermes's operational decisions ----------------

/** Supplier, provider, internal and irrelevant mail is never a lead, even when Hermes left the decision open. */
const effectiveLeadDecision = (h: HermesResult) => (h.lead_decision !== "undecided" ? h.lead_decision : NON_CUSTOMER_CONTEXTS.includes(h.business_context) ? "not_lead" : "undecided");

type LeadDecision = { kind: "created"; leadId: string; contactId: string | null; label: string } | { kind: "proposed" } | { kind: "reversed"; leadId: string } | { kind: "kept_for_chris"; leadId: string } | { kind: "not_lead" };

/**
 * Hermes decides whether an email is a lead. "lead": the lead is created through the normal path
 * (a customer is linked only by an exact email match), or proposed to Chris when Hermes is not sure
 * enough. "not_lead": a lead the rules created from this very email and nobody has touched is marked
 * lost ("Not a lead"); a lead someone has worked on is left for Chris. Every step is on the timeline
 * and reversible.
 */
async function applyLeadDecision(h: HermesResult, input: InspectorInput, minConfidence: number): Promise<LeadDecision | null> {
  if (input.sourceType !== "email" || input.direction !== "inbound") return null;
  const e = await db.query.emails.findFirst({ where: eq(emails.id, input.sourceId), columns: { id: true, leadId: true, classification: true, contactId: true } });
  if (!e) return null;
  const decision = effectiveLeadDecision(h);
  if (decision === "lead") {
    if (e.leadId) return null;
    if (h.confidence < minConfidence) return { kind: "proposed" };
    const leadId = await createLeadFromEmail(e.id, { actorId: null });
    const lead = (await db.query.leads.findFirst({ where: eq(leads.id, leadId), columns: { name: true, contactId: true } }))!;
    await logActivity({ entity: "lead", entityId: leadId, actorId: null, action: "lead_created_by_hermes", detail: { emailId: e.id, reason: h.reason, confidence: h.confidence, rulesClassification: e.classification } });
    return { kind: "created", leadId, contactId: lead.contactId, label: lead.name };
  }
  if (decision === "not_lead" && h.confidence >= minConfidence) {
    if (!e.leadId) {
      if (e.classification === "needs_review") await db.update(emails).set({ classification: "not_lead", classifiedAt: new Date() }).where(eq(emails.id, e.id));
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
