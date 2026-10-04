/**
 * The guardrail layer between Hermes and the CRM. Hermes is the operational judgement: what a
 * message means, whether it is a lead, which work it belongs to, whether it is resolved or waiting,
 * which commitments were kept, and the next step. This layer does not re-decide any of that. It
 * asks only: is Hermes authorised to do this safely?
 *
 *   GUARDRAILS (authority, safety, data integrity): a fact needs the source's own words and a sane
 *   value (a conflicting one is flagged, never overwritten: facts.ts); a commitment needs the
 *   source's words; a commitment marked kept, or an enquiry closed, must cite CRM records from the
 *   context pack; a person's identity is never decided by Hermes or a name alone (work may continue
 *   in an evidenced operational context while the sender stays unverified); a reply may not quote a
 *   price, a discount or a promised date; an acceptance never accepts terms; nothing customer-facing
 *   is executed, only prepared for Chris; low confidence waits for Chris.
 *
 *   BUSINESS BRAIN AUTHORITY: commercial CCTV is designed from a site visit; only CCTV has a Brain;
 *   the Brain runs only with its inputs; one prepared quote at a time; a revised quote after a sent
 *   one waits for Chris. After it runs, the Brain itself decides site visit / priced / unpriced.
 *
 *   ADVISORIES (shown, never deciding): two-storey complexity, unknown upgrade cabling, where the old
 *   rules read it differently, and Hermes's own notes.
 *
 * Pure: everything it needs is passed in.
 */
import type { HermesAction, HermesResult } from "@/lib/hermes/contract";
import { resolveDue } from "./dates";
import { normalisePhone, toNumber } from "./text";
import type { Known } from "./missing";
import type { Commitment, ExtractedFact, FactKey, IdentityResult, InspectorInput, MissingInfo, PlannedAction, Understanding } from "./types";

export type ValidateContext = {
  input: InspectorInput;
  /** Who the SENDER is, decided by the CRM's guarded identity rules before Hermes is asked. */
  identity: IdentityResult;
  /** What the CRM already holds for this lead/customer (applied facts and record fields). */
  known: Known;
  crm: {
    leadId: string | null;
    contactId: string | null;
    hasOpenBrainQuote: boolean;
    hasSentQuote: boolean;
    recordingLinked: boolean;
    customerEmail: string | null;
    customerPhone: string | null;
  };
  minConfidence: number;
  /** CRM records (refs from the context pack) Hermes may cite as evidence or choose as the work. */
  citable?: string[];
  /**
   * The operational context Hermes chose (operational_context.ref), as checked by the CRM: the record
   * exists and the source itself shows it (its site address, job or quote number, the thread).
   */
  context?: { ref: string; label: string; leadId: string | null; jobId: string | null; contactId: string | null; accepted: boolean; why: string } | null;
  /** The old deterministic reading, for the comparison advisory only. */
  rules?: { primaryIntent: string; firstAction: string | null; urgency: string } | null;
};

export type Check = { rule: string; message: string; effect?: string };

export type Validation = {
  understanding: Understanding;
  hard: Check[];
  business: Check[];
  advisories: Check[];
  rejectedFacts: { key: string; value: unknown; reason: string }[];
  plan: PlannedAction[];
  reviewKind: "identity" | "hermes_low_confidence" | "hermes_flagged" | null;
  /** Hermes's recommendation, and the action the CRM ends up taking. */
  headline: { recommended: HermesAction; final: string; changedBy: string | null };
  /** The work actions run against when the sender is not (yet) a verified customer. */
  workContext: { ref: string; label: string; leadId: string | null; jobId: string | null; contactId: string | null } | null;
  /** True when the sender's identity is verified by the CRM (facts may then be filled in). */
  personVerified: boolean;
};

const act = (type: PlannedAction["type"], mode: PlannedAction["mode"], rule: string, reason: string, payload: Record<string, unknown> = {}): PlannedAction => ({ type, mode, rule, reason, payload });

// ---------------- evidence and values ----------------

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9@.]+/g, " ")
    .trim();

/** Everything the source says, as Hermes could have quoted it. */
export function sourceHaystack(input: InspectorInput): { text: string; tokens: Set<string> } {
  const parts = [input.title, input.text, ...input.utterances.map((u) => u.text)];
  if (input.form) {
    const f = input.form;
    parts.push(...Object.entries(f.fields).map(([k, v]) => `${k}: ${v}`), f.name ?? "", f.email ?? "", f.phone ?? "", f.address ?? "", f.service ?? "");
    // The form's own parsed details, with the labels Hermes sees them under in the context pack
    // (name, email, phone, address, service) and the fact names, so "Name: Andre Bunton" quoted
    // from the form is found. Values come only from the submitted form.
    const labelled: [string[], string | null][] = [
      [["name", "contact name", "full name", "customer name"], f.name],
      [["email", "email address"], f.email],
      [["phone", "phone number", "mobile"], f.phone],
      [["address", "site address", "location"], f.address],
      [["service"], f.service],
    ];
    for (const [labels, v] of labelled) if (v) parts.push(...labels.map((l) => `${l}: ${v}`));
  }
  const text = norm(parts.join(" \n "));
  return { text, tokens: new Set(text.split(" ").filter(Boolean)) };
}

/** Did the source really say this? Exact (normalised) quote, or nearly all of its words. */
export function evidenceFound(evidence: string, hay: { text: string; tokens: Set<string> }): boolean {
  const e = norm(evidence);
  if (!e) return false;
  if (hay.text.includes(e)) return true;
  const words = e.split(" ").filter((w) => w.length > 1);
  if (!words.length) return false;
  const found = words.filter((w) => hay.tokens.has(w)).length;
  return words.length >= 2 && found / words.length >= 0.8;
}

const SERVICE_DISPLAY: Record<string, string> = { cctv: "CCTV", alarm: "Alarm", access_control: "Access control", intercom: "Intercom", networking: "Networking", other: "Other" };

/** A sane value for the CRM, and how it reads; null when the value is not usable. */
export function normaliseFact(key: FactKey, raw: string | number | boolean): { value: string | number | boolean; display: string } | null {
  const s = typeof raw === "string" ? raw.trim() : raw;
  const str = String(s).toLowerCase();
  switch (key) {
    case "camera_count": {
      const n = typeof s === "number" ? s : (Number(str.match(/\d+/)?.[0]) || toNumber(str.split(/\s+/)[0] ?? ""));
      return n && Number.isInteger(n) && n >= 1 && n <= 64 ? { value: n, display: `${n} camera${n === 1 ? "" : "s"}` } : null;
    }
    case "storeys": {
      const n = typeof s === "number" ? s : /single|one|\b1\b/.test(str) ? 1 : /double|two|\b2\b/.test(str) ? 2 : /three|\b3\b/.test(str) ? 3 : null;
      return n && Number.isInteger(n) && n >= 1 && n <= 5 ? { value: n, display: n === 1 ? "Single storey" : n === 2 ? "Two storeys" : `${n} storeys` } : null;
    }
    case "property_type":
      if (/commercial|business|office|shop|warehouse|retail|industrial/.test(str)) return { value: "commercial", display: "Commercial" };
      if (/residential|home|house|domestic/.test(str)) return { value: "residential", display: "Residential" };
      return null;
    case "job_type":
      if (/repair|fault|service/.test(str)) return { value: "repair", display: "Repair / service" };
      if (/upgrade|replace|existing/.test(str)) return { value: "upgrade", display: "Upgrade of an existing system" };
      if (/new/.test(str)) return { value: "new", display: "New installation" };
      return null;
    case "service": {
      const k = /cctv|camera/.test(str) ? "cctv" : /alarm/.test(str) ? "alarm" : /access/.test(str) ? "access_control" : /intercom|doorbell/.test(str) ? "intercom" : /network|wifi/.test(str) ? "networking" : null;
      return k ? { value: k, display: SERVICE_DISPLAY[k] } : null;
    }
    case "email":
      return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(str) ? { value: str, display: str } : null;
    case "phone": {
      const p = normalisePhone(String(s));
      return p.length >= 8 && p.length <= 13 ? { value: p, display: String(s) } : null;
    }
    case "remote_viewing":
    case "site_visit_requested": {
      const b = typeof s === "boolean" ? s : /^(true|yes|y)$/.test(str) ? true : /^(false|no|n)$/.test(str) ? false : null;
      return b === null ? null : { value: b, display: key === "remote_viewing" ? (b ? "Wants to view on phone/app" : "No phone viewing") : b ? "Asked for a site visit" : "No site visit asked for" };
    }
    case "existing_cabling":
      if (/coax|rg ?59|analog/.test(str)) return { value: "coax", display: "Coax (analogue)" };
      if (/cat ?6/.test(str)) return { value: "cat6", display: "Cat6" };
      if (/cat ?5|ethernet|network/.test(str)) return { value: "cat5e", display: "Cat5e" };
      return null;
    default: {
      const v = String(s).trim();
      return v ? { value: v.slice(0, 500), display: v.slice(0, 200) } : null;
    }
  }
}

// ---------------- reply safety ----------------

const PRICE = /(\$\s?\d)|(\b\d[\d,]*(\.\d{1,2})?\s?(nzd|dollars?)\b)|\b(inc|incl|including|ex|excl|excluding)\.?\s+gst\b/i;
const DISCOUNT = /\b(discount|\d+\s?% off|special price|cheaper price|price match|waive|free of charge)\b/i;
const DATE_PROMISE =
  /\b(we|i)\s*(will|'ll|can)\s+(be there|come|come out|install|start|book you in|confirm)\b[^.?!]*\b(today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|this week|\d{1,2}(st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*|\d{1,2}(:\d{2})?\s?(am|pm))\b/i;

/** Why a prepared reply cannot go to Chris as written, or null when it can. */
export function replyProblem(body: string): string | null {
  if (PRICE.test(body)) return "it quotes a price (prices come only from the Business Brain's approved quote)";
  if (DISCOUNT.test(body)) return "it offers a discount or special price";
  if (DATE_PROMISE.test(body)) return "it promises a date or time (only Chris confirms bookings)";
  return null;
}

// ---------------- the validator ----------------

const has = (k: Known, key: FactKey) => k[key] !== undefined && k[key] !== null && k[key] !== "";
const ENQUIRY_INTENTS = ["new_enquiry", "quote_request", "site_visit_request", "booking_request"];

export function validateHermes(h: HermesResult, ctx: ValidateContext): Validation {
  const hard: Check[] = [];
  const business: Check[] = [];
  const advisories: Check[] = [];
  const rejectedFacts: Validation["rejectedFacts"] = [];
  const { input, identity, crm } = ctx;
  const hay = sourceHaystack(input);
  const citable = new Set(ctx.citable ?? []);

  // ---- GUARDRAIL: facts need evidence in the source and a usable value ----
  const facts: ExtractedFact[] = [];
  for (const f of h.facts) {
    if (!evidenceFound(f.evidence, hay)) {
      rejectedFacts.push({ key: f.key, value: f.value, reason: "evidence not found in the source" });
      continue;
    }
    const n = normaliseFact(f.key, f.value);
    if (!n) {
      rejectedFacts.push({ key: f.key, value: f.value, reason: "value not usable" });
      continue;
    }
    if (facts.some((x) => x.key === f.key)) continue;
    facts.push({ key: f.key, value: n.value, display: n.display, evidence: f.evidence.slice(0, 500), confidence: f.confidence });
  }
  if (rejectedFacts.length) hard.push({ rule: "fact_evidence", message: `Not used (${rejectedFacts.map((r) => `${r.key}: ${r.reason}`).join("; ")}).`, effect: "facts rejected" });
  const low = facts.filter((f) => f.confidence < 0.7);
  if (low.length) advisories.push({ rule: "low_confidence_facts", message: `Proposed for Chris rather than filled in: ${low.map((f) => f.display).join(", ")}.` });

  // What is known now: the CRM first, then what this source says.
  const known: Known = { ...ctx.known };
  for (const f of facts) if (!has(known, f.key)) known[f.key] = f.value;
  if (h.service && !has(known, "service")) known.service = h.service;
  if (h.property_type && !has(known, "property_type")) known.property_type = h.property_type;
  const service = (known.service as string | undefined) ?? h.service ?? null;
  const property = (known.property_type as string | undefined) ?? h.property_type ?? null;

  // ---- GUARDRAIL: commitments only with evidence; the CRM works out the due time where it can ----
  const commitments: Commitment[] = [];
  for (const c of h.commitments) {
    if (!evidenceFound(c.evidence, hay)) {
      hard.push({ rule: "commitment_evidence", message: `Commitment "${c.action}" not used: its words were not found in the source.`, effect: "commitment rejected" });
      continue;
    }
    const fromText = c.due_text ? resolveDue(c.due_text, input.at) : null;
    const fromHermes = c.due_at && !Number.isNaN(Date.parse(c.due_at)) ? new Date(c.due_at) : null;
    const due = fromText ?? fromHermes;
    commitments.push({ owner: c.owner, ownerName: c.owner_name, action: c.action.charAt(0).toUpperCase() + c.action.slice(1), actionKey: c.action_key, dueAt: due ? due.toISOString() : null, dueText: c.due_text, evidence: c.evidence.slice(0, 500), confidence: Math.min(h.confidence, 0.95) });
  }

  // ---- GUARDRAIL: a kept/void commitment and a resolution must cite real CRM records ----
  const resolveCommitments: PlannedAction[] = [];
  for (const u of h.commitment_updates) {
    const ref = u.id.startsWith("commitment:") ? u.id : `commitment:${u.id}`;
    if (!citable.has(ref) || !citable.has(u.evidence_ref) || u.evidence_ref === ref) {
      hard.push({ rule: "commitment_update_evidence", message: `Commitment update not used: ${!citable.has(ref) ? "that commitment is not in this record" : "its evidence is not a CRM record in this context"}.`, effect: "update rejected" });
      continue;
    }
    resolveCommitments.push(act("RESOLVE_COMMITMENT", "auto", "hermes_commitment_update", u.note || `Hermes: the CRM shows this was ${u.status === "done" ? "kept" : "made void"}.`, { commitmentId: ref.slice("commitment:".length), status: u.status, evidenceRef: u.evidence_ref }));
  }
  const evidence = h.resolution.evidence.filter((e) => citable.has(e.ref));
  if (evidence.length < h.resolution.evidence.length) advisories.push({ rule: "resolution_evidence", message: "Some of Hermes's evidence refs were not CRM records in this context and were ignored." });

  // Missing information is Hermes's judgement.
  const missing: MissingInfo[] = h.missing.map((m) => ({ field: m.field as FactKey, label: m.label, blocking: m.blocking, for: m.for, reason: m.reason }));
  const nonBlocking = missing.filter((m) => !m.blocking);
  if (nonBlocking.length) advisories.push({ rule: "non_blocking_gaps", message: `Not blocking progress: ${nonBlocking.map((m) => m.label).join(", ")}.` });
  const alreadyKnown = h.missing.filter((m) => has(known, m.field as FactKey));
  if (alreadyKnown.length) advisories.push({ rule: "already_known", message: `The CRM already has: ${alreadyKnown.map((m) => m.label.toLowerCase()).join(", ")}.` });

  const understanding: Understanding = {
    service: (service as Understanding["service"]) ?? null,
    propertyType: (property as Understanding["propertyType"]) ?? null,
    intents: [h.intent],
    primaryIntent: h.intent,
    urgency: h.urgency,
    facts,
    requested: [],
    timing: facts.filter((f) => f.key === "timing").map((f) => ({ text: String(f.value), evidence: f.evidence })),
    budget: facts.filter((f) => f.key === "budget").map((f) => ({ text: String(f.value), amount: null, evidence: f.evidence })),
    objections: h.objections.map((o) => ({ kind: o.kind, evidence: o.evidence })),
    decisions: [],
    commitments,
    missing,
    quoteRefs: [...new Set([...`${input.title}\n${input.text}`.matchAll(/\bQ-?(\d{3,6})\b/g)].map((m) => Number(m[1])))],
    summary: h.summary,
  };

  // ---- Advisories: shown, never deciding ----
  if (Number(known.storeys) >= 2 && service === "cctv") advisories.push({ rule: "two_storey_complexity", message: "Two-storey installation may increase cabling complexity; the Brain's two-storey package allows for it." });
  if (known.job_type === "upgrade" && !has(known, "existing_cabling")) advisories.push({ rule: "upgrade_cabling_unknown", message: "Upgrade with unknown cabling: the Brain will not assume reusable cable or cheaper upgrade labour." });
  if (ctx.rules && ctx.rules.primaryIntent !== h.intent) advisories.push({ rule: "rules_disagree", message: `The old rules read this as "${ctx.rules.primaryIntent.replace(/_/g, " ")}"${ctx.rules.firstAction ? ` (${ctx.rules.firstAction})` : ""}; Hermes's reading is used.` });
  for (const a of h.advisories) advisories.push({ rule: "hermes", message: a });

  const recommended = h.recommended_action;
  const headline: Validation["headline"] = { recommended, final: recommended, changedBy: null };
  const base: PlannedAction[] = [];
  const out: PlannedAction[] = [];
  const result = (plan: PlannedAction[], reviewKind: Validation["reviewKind"], workContext: Validation["workContext"], personVerified: boolean): Validation => ({ understanding, hard, business, advisories, rejectedFacts, plan, reviewKind, headline, workContext, personVerified });

  // Hermes is sure this is not a lead and nothing needs doing: no sender to identify, nothing to file.
  if (h.lead_decision === "not_lead" && recommended === "NO_ACTION" && h.confidence >= ctx.minConfidence && identity.status !== "matched") {
    advisories.push({ rule: "not_a_lead", message: "Hermes: not a lead, nothing to do. Nothing filed." });
    return result([], null, null, false);
  }

  // ---- GUARDRAIL: the sender's identity is the CRM's; the work can still go on in an evidenced context ----
  let workContext: Validation["workContext"] = null;
  const personVerified = identity.status === "matched";
  const identityReview: PlannedAction[] = [];
  if (identity.status === "needs_review" || identity.status === "new") {
    const suggestion = h.identity.suggestion === "candidate" && h.identity.candidate_key ? { key: h.identity.candidate_key, reason: h.identity.reason } : h.identity.suggestion === "new" ? { key: "new", reason: h.identity.reason } : null;
    const c = ctx.context;
    if (c?.accepted) {
      workContext = { ref: c.ref, label: c.label, leadId: c.leadId, jobId: c.jobId, contactId: c.contactId };
      hard.push({ rule: "sender_unverified", message: `The sender is not a verified customer (${identity.reason}). Hermes places this in ${c.label} (${c.why}); work continues there, and nothing about the person is written until Chris links them.`, effect: "work continues; sender unlinked" });
    } else if (c) {
      advisories.push({ rule: "context_not_evidenced", message: `Hermes placed this in ${c.label}, but ${c.why}, so the work is not filed there.` });
    }
    if (identity.status === "needs_review" || !workContext) {
      if (identity.status === "needs_review") {
        hard.push({ rule: "identity_uncertain", message: `${identity.reason}${suggestion ? ` Hermes suggests ${suggestion.key === "new" ? "a new customer" : suggestion.key}; that cannot link the person on its own.` : ""}`, effect: workContext ? "Chris links the sender" : "nothing written to a customer until Chris confirms" });
        identityReview.push(act("NEEDS_REVIEW", "approval", "identity_uncertain", identity.reason, { kind: "identity", hermesSuggestion: suggestion, workContext: workContext?.label ?? null, candidates: identity.candidates.slice(0, 5).map((x) => ({ leadId: x.leadId, contactId: x.contactId, label: x.label, score: x.score, signals: x.signals })) }));
        if (input.sourceType === "recording") identityReview.push(act("LINK_RECORDING", "approval", "identity_uncertain", "File the recording once Chris confirms who it is with."));
      }
      if (!workContext) {
        if (identity.status === "needs_review") {
          headline.final = "NEEDS_REVIEW";
          headline.changedBy = "identity_uncertain";
          return result(identityReview, "identity", null, false);
        }
      }
    }
  }
  if (identity.status === "matched" && h.identity.suggestion === "candidate" && h.identity.candidate_key && identity.chosen) {
    const chosenKey = identity.chosen.leadId ? `lead:${identity.chosen.leadId}` : `customer:${identity.chosen.contactId}`;
    if (h.identity.candidate_key !== chosenKey) advisories.push({ rule: "identity_disagreement", message: `Hermes suggested ${h.identity.candidate_key}; the CRM matched ${identity.chosen.label} on ${identity.chosen.signals.map((s) => s.detail).join(", ")}, which stands.` });
  }
  const onWork = personVerified || !!workContext;

  // Internal record keeping happens whatever the recommendation.
  if (identity.status !== "not_applicable") base.push(act("ADD_INTERNAL_NOTE", "auto", "always_note", "What Hermes understood.", { summary: h.summary }));
  if (input.sourceType === "recording" && personVerified && !crm.recordingLinked) base.push(act("LINK_RECORDING", "auto", "identity_matched", identity.reason));
  if (onWork && facts.length)
    base.push(
      act(
        "PROPOSE_LEAD_FACT_UPDATE",
        "auto",
        "new_facts",
        personVerified ? "Facts from this source with their evidence. Blank fields are filled; anything that differs from the CRM is flagged for Chris, never overwritten." : "Facts from an unverified sender: proposed for Chris, not filled in.",
        { proposeOnly: !personVerified },
      ),
    );
  if (onWork) base.push(...resolveCommitments);
  if (input.direction === "outbound" || identity.status === "not_applicable") {
    // Our own email: commitments and the note only; nothing is ever sent from here.
    return result(base, null, null, personVerified);
  }

  const isEnquiry = ENQUIRY_INTENTS.includes(h.intent) || h.conversation_type === "new_enquiry";
  const reviewKind = identityReview.length ? ("identity" as const) : null;

  // ---- GUARDRAIL: closing an enquiry needs evidence; Hermes's own doubt and low confidence go to Chris ----
  let action: HermesAction = recommended;
  if (action === "NO_ACTION" && isEnquiry && h.lead_decision !== "not_lead") {
    if (h.resolution.status === "resolved" && evidence.length) {
      hard.push({ rule: "enquiry_closed_with_evidence", message: `Hermes closed this enquiry, citing ${evidence.map((e) => `${e.ref}${e.note ? ` (${e.note})` : ""}`).join("; ")}.` });
    } else {
      hard.push({ rule: "enquiry_close_needs_evidence", message: "Hermes said no action on an enquiry without citing CRM records that show it was dealt with. Sent to Chris instead.", effect: "NEEDS_REVIEW" });
      action = "NEEDS_REVIEW";
    }
  }
  const plan = (a: HermesAction): PlannedAction[] => planFor(a, h, ctx, { known, missing, service, property, commitments, business, hard });
  if (action === "NEEDS_REVIEW") {
    out.push(act("NEEDS_REVIEW", "approval", recommended === "NEEDS_REVIEW" ? "hermes_flagged" : "enquiry_close_needs_evidence", h.reason, { kind: "hermes_flagged", hermesRecommendation: recommended, confidence: h.confidence }));
    headline.final = "NEEDS_REVIEW";
    if (recommended !== "NEEDS_REVIEW") headline.changedBy = "enquiry_close_needs_evidence";
    return result([...base, ...identityReview, ...out], reviewKind ?? "hermes_flagged", workContext, personVerified);
  }
  if (h.confidence < ctx.minConfidence) {
    const proposed = plan(action);
    hard.push({ rule: "low_confidence", message: `Hermes is ${Math.round(h.confidence * 100)}% sure (below ${Math.round(ctx.minConfidence * 100)}%). Its recommendation waits for Chris.`, effect: "NEEDS_REVIEW" });
    out.push(act("NEEDS_REVIEW", "approval", "low_confidence", h.reason, { kind: "hermes_low_confidence", hermesRecommendation: recommended, confidence: h.confidence, plan: proposed }));
    headline.final = "NEEDS_REVIEW";
    headline.changedBy = "low_confidence";
    return result([...base, ...identityReview, ...out], reviewKind ?? "hermes_low_confidence", workContext, personVerified);
  }

  const planned = plan(action);
  if (h.run_business_brain && !planned.some((p) => p.type === "RUN_BUSINESS_BRAIN") && !planned.some((p) => p.type === "PROPOSE_SITE_VISIT" || p.type === "DRAFT_EMAIL" || p.type === "CREATE_INTERNAL_TASK")) {
    planned.push(...plan("RUN_BUSINESS_BRAIN"));
  }
  // ---- GUARDRAIL: an acceptance never accepts anything: Chris confirms ----
  if (h.intent === "acceptance" && !planned.some((p) => p.type === "CREATE_INTERNAL_TASK")) {
    hard.push({ rule: "no_autonomous_acceptance", message: "The customer wants to go ahead: Chris confirms the terms; the CRM never accepts them itself.", effect: "task for Chris" });
    planned.push(act("CREATE_INTERNAL_TASK", "auto", "customer_accepted", "The customer says they want to go ahead. Chris confirms and marks the quote accepted.", { title: "Customer wants to go ahead: confirm and mark the quote accepted", kind: "task", due: "today" }));
  }
  const meaningful = planned.filter((p) => !["ADD_INTERNAL_NOTE", "LINK_RECORDING", "PROPOSE_LEAD_FACT_UPDATE"].includes(p.type));
  const first = meaningful.find((p) => p.type === "PREPARE_QUOTE") ?? meaningful[0];
  headline.final = first?.type ?? "NO_ACTION";
  const override = business.find((b) => b.effect) ?? hard.find((x) => x.effect && !["fact_evidence", "commitment_evidence", "commitment_update_evidence", "sender_unverified", "identity_uncertain"].includes(x.rule));
  if (override) headline.changedBy = override.rule;
  return result([...base, ...identityReview, ...planned], reviewKind, workContext, personVerified);
}

/**
 * What the Brain lists as stopping the costing, when every item is a commercial input Chris enters
 * (a price not approved yet, labour hours or an allowance not set); null when anything else is in
 * the way (no suitable product, nothing selected), which needs a decision.
 */
export function pricingGaps(unpriced: string[]): string[] | null {
  if (!unpriced.length) return null;
  return unpriced.every((u) => /no approved price|not set\b/i.test(u)) ? unpriced : null;
}

export const pricingTaskTitle = (quoteNumber: number | null, who: string | null) => `Price the quote / complete costing for ${quoteNumber ? `Q-${quoteNumber}` : (who ?? "this lead")}`;

/** One recommended action, turned into the router's actions under the Business Brain's authority. */
function planFor(
  action: HermesAction,
  h: HermesResult,
  ctx: ValidateContext,
  s: { known: Known; missing: MissingInfo[]; service: string | null; property: string | null; commitments: Commitment[]; business: Check[]; hard: Check[] },
): PlannedAction[] {
  const { known, service, property } = s;
  const timing = (known.timing as string | undefined) ?? null;
  const address = (known.site_address as string | undefined) ?? null;
  const questionsFrom = (list: MissingInfo[]) => list.map((m) => h.missing.find((x) => x.field === m.field)?.question ?? m.label);
  const ask = (questions: string[], rule: string, why: string): PlannedAction[] => {
    const phone = ctx.crm.customerPhone ?? (known.phone as string | undefined) ?? null;
    if (phone && (h.urgency === "urgent" || h.urgency === "high")) return [act("CALL_CUSTOMER", "auto", rule, `${why} Quicker to ask by phone: ${questions.join("; ")}.`, { ask: questions })];
    return [act("DRAFT_EMAIL", "auto", rule, `${why} Asked: ${questions.join("; ")}.`, { ask: questions })];
  };
  const siteVisit = (rule: string, reason: string): PlannedAction[] => {
    const out = [act("PROPOSE_SITE_VISIT", "approval", rule, reason, { address, timing })];
    if (!address) out.push(...ask(["What's the address of the property?"], "site_visit_needs_address", "A site visit needs the address."));
    return out;
  };

  switch (action) {
    case "RUN_BUSINESS_BRAIN":
    case "PREPARE_QUOTE": {
      const what = action === "PREPARE_QUOTE" ? "Prepare quote" : "Run the Business Brain";
      // BRAIN POLICY: commercial CCTV is designed from a site visit.
      if (service === "cctv" && property === "commercial") {
        s.business.push({ rule: "commercial_cctv_site_visit", message: `Hermes recommended "${what}"; Business Brain policy: commercial CCTV is always designed from a site visit.`, effect: "PROPOSE_SITE_VISIT" });
        return siteVisit("commercial_cctv_site_visit", "Commercial CCTV is always designed from a site visit.");
      }
      // BRAIN AUTHORITY: only CCTV has a Business Brain.
      if (service !== "cctv") {
        const svc = service ? service.replace(/_/g, " ") : null;
        if (!svc) {
          s.business.push({ rule: "brain_needs_service", message: `Hermes recommended "${what}" but the service is not known; the Brain only designs CCTV.`, effect: "ASK_CUSTOMER" });
          return ask(["Could you tell me a bit more about what you're after (cameras, alarm, access control…)?"], "ask_service", "The service decides how it is quoted.");
        }
        s.business.push({ rule: "manual_quote_service", message: `Hermes recommended "${what}"; there is no Business Brain for ${svc}, so it is quoted by hand.`, effect: "CREATE_INTERNAL_TASK" });
        return [act("CREATE_INTERNAL_TASK", "auto", "manual_quote_service", `${svc} enquiry: quote it manually (only CCTV has a Business Brain).`, { title: `Quote ${svc} enquiry manually`, kind: "quote", due: "next_business_day" })];
      }
      // BRAIN AUTHORITY: the Brain's inputs. It never guesses them.
      const need: string[] = [];
      if (!property) need.push("Is this for your home or for a business?");
      if (!has(known, "camera_count") && !has(known, "areas")) need.push("Roughly how many cameras are you after, or which areas would you like covered?");
      if (property !== "commercial" && !has(known, "storeys")) need.push("Is the house single or double storey?");
      if (need.length) {
        s.business.push({ rule: "brain_inputs_missing", message: `Hermes recommended "${what}"; the Business Brain still needs: ${need.join(" ")}`, effect: "ASK_CUSTOMER" });
        return ask(need, "ask_blocking_only", "Before a quote the Business Brain needs a little more.");
      }
      // AUTHORITY: one prepared quote at a time; a sent quote is only revised with Chris.
      if (action === "PREPARE_QUOTE" && ctx.crm.hasSentQuote) {
        s.business.push({ rule: "revised_quote_needs_chris", message: "A quote was already sent: a revised one waits for Chris (no automatic discount).", effect: "PREPARE_REVISED_QUOTE" });
        return [act("PREPARE_REVISED_QUOTE", "approval", "revised_quote_needs_chris", h.reason, { objections: h.objections })];
      }
      if (action === "PREPARE_QUOTE" && ctx.crm.hasOpenBrainQuote) {
        s.business.push({ rule: "quote_already_prepared", message: "A quote is already prepared and waiting in Approvals; another is not made.", effect: "NO_ACTION" });
        return [act("NO_ACTION", "auto", "quote_already_prepared", "A quote is already prepared for this lead and waits in Approvals.")];
      }
      const out = [act("RUN_BUSINESS_BRAIN", "auto", "hermes_recommendation", h.reason)];
      if (action === "PREPARE_QUOTE") out.push(act("PREPARE_QUOTE", "auto", "hermes_recommendation", `${h.reason} The quote and reply wait for Chris's approval.`));
      return out;
    }
    case "ASK_CUSTOMER": {
      const blocking = s.missing.filter((m) => m.blocking);
      const qs = questionsFrom(blocking.length ? blocking : s.missing);
      if (!qs.length) return [act("CREATE_INTERNAL_TASK", "auto", "hermes_recommendation", `${h.reason} (Hermes listed no question to ask.)`, { title: h.task?.title ?? "Ask the customer what is needed", kind: "task", due: "next_business_day" })];
      return ask(qs, "hermes_recommendation", "Hermes:");
    }
    case "PROPOSE_SITE_VISIT":
      return siteVisit("hermes_recommendation", h.reason);
    case "DRAFT_REPLY": {
      const body = h.reply_draft?.body ?? null;
      const problem = body ? replyProblem(body) : "there was no reply text";
      if (problem) {
        s.hard.push({ rule: "reply_safety", message: `Hermes's reply was not prepared: ${problem}.`, effect: "CREATE_INTERNAL_TASK" });
        return [act("CREATE_INTERNAL_TASK", "auto", "reply_safety", `Reply needed. Hermes's draft was held back: ${problem}.`, { title: "Reply to the customer", kind: "task", due: "today" })];
      }
      return [act("DRAFT_EMAIL", "auto", "hermes_recommendation", `${h.reason} The reply waits for Chris's approval.`, { subject: h.reply_draft?.subject ?? null, body })];
    }
    case "CREATE_INTERNAL_TASK":
      return [act("CREATE_INTERNAL_TASK", "auto", "hermes_recommendation", h.reason, { title: h.task?.title ?? h.summary.slice(0, 120), kind: /\b(price|costing|quote)\b/i.test(h.task?.title ?? "") ? "quote" : "task", due: h.task?.due ?? "next_business_day", detail: h.task?.detail ?? h.reason })];
    case "FOLLOW_UP":
      return [act("PREPARE_FOLLOW_UP", "auto", "hermes_recommendation", h.reason, { title: h.task?.title ?? null, due: h.task?.due ?? null, inDays: 3 })];
    case "WAITING_ON_CUSTOMER": {
      const theirs = s.commitments.filter((c) => c.owner === "customer");
      const c = theirs.find((x) => x.dueAt) ?? theirs[0];
      if (!c) return [act("NO_ACTION", "auto", "waiting_on_customer", h.reason)];
      // Check the day after they said they would, unless it is already done by then.
      const check = c.dueAt ? new Date(new Date(c.dueAt).getTime() + 24 * 3600_000).toISOString() : null;
      return [act("PREPARE_FOLLOW_UP", "auto", "waiting_on_customer", `Waiting on the customer: ${c.action}${c.dueText ? ` (${c.dueText})` : ""}.`, { title: `Check: customer said they'd ${c.action.charAt(0).toLowerCase()}${c.action.slice(1)}`, due: check, inDays: 2 })];
    }
    case "NEEDS_REVIEW":
      return [act("NEEDS_REVIEW", "approval", "hermes_flagged", h.reason, { kind: "hermes_flagged" })];
    case "NO_ACTION":
      return [act("NO_ACTION", "auto", "hermes_recommendation", h.reason)];
  }
}
