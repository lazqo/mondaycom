/**
 * The validation + policy layer between Hermes and the CRM. Hermes understands and recommends;
 * this decides what may actually happen, in three tiers:
 *
 *   HARD GUARDRAILS (Hermes cannot override): identity is decided by the CRM's signals, never by a
 *   name or by Hermes; facts are only accepted with evidence found in the source and a sane value;
 *   conflicting facts are flagged, never overwritten (facts.ts); a prepared reply may not quote a
 *   price, a discount or a promised date; nothing customer-facing is executed, only prepared; an
 *   acceptance never accepts terms; a real enquiry is never "no action"; low confidence goes to Chris.
 *
 *   BUSINESS RULES (deterministic, authoritative): commercial CCTV and customer-requested visits go
 *   to a site visit; only CCTV has a Business Brain; the Brain needs its inputs (home or business,
 *   cameras or areas, storeys) before it runs; one prepared quote at a time; a revised quote after a
 *   sent one needs Chris. After it runs, the Brain itself decides site visit / priced / unpriced.
 *
 *   ADVISORY CHECKS (logged, never blocking): two-storey complexity, unknown upgrade cabling,
 *   non-blocking gaps, low-confidence facts, where the old rules read it differently, and Hermes's
 *   own advisories.
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
  /** Decided by the CRM's identity rules before Hermes is asked. */
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
  if (input.form) parts.push(...Object.entries(input.form.fields).map(([k, v]) => `${k}: ${v}`), input.form.name ?? "", input.form.email ?? "", input.form.phone ?? "", input.form.address ?? "", input.form.service ?? "");
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

export function validateHermes(h: HermesResult, ctx: ValidateContext): Validation {
  const hard: Check[] = [];
  const business: Check[] = [];
  const advisories: Check[] = [];
  const rejectedFacts: Validation["rejectedFacts"] = [];
  const { input, identity, crm } = ctx;
  const hay = sourceHaystack(input);

  // ---- HARD: facts need evidence in the source and a usable value ----
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

  // ---- HARD: commitments only with evidence; the CRM works out the due time where it can ----
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

  // Missing information: Hermes's judgement, minus anything the CRM already holds.
  const missing: MissingInfo[] = [];
  for (const m of h.missing) {
    const key = m.field as FactKey;
    if (has(known, key)) {
      advisories.push({ rule: "already_known", message: `Not asked: the CRM already has ${m.label.toLowerCase()}.` });
      continue;
    }
    missing.push({ field: key, label: m.label, blocking: m.blocking, for: m.for, reason: m.reason });
  }
  const nonBlocking = missing.filter((m) => !m.blocking);
  if (nonBlocking.length) advisories.push({ rule: "non_blocking_gaps", message: `Not asked (does not block progress): ${nonBlocking.map((m) => m.label).join(", ")}.` });

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

  // ---- Advisories that never block ----
  if (Number(known.storeys) >= 2 && service === "cctv") advisories.push({ rule: "two_storey_complexity", message: "Two-storey installation may increase cabling complexity; the Brain's two-storey package allows for it." });
  if (known.job_type === "upgrade" && !has(known, "existing_cabling")) advisories.push({ rule: "upgrade_cabling_unknown", message: "Upgrade with unknown cabling: the Brain will not assume reusable cable or cheaper upgrade labour." });
  if (ctx.rules && ctx.rules.primaryIntent !== h.intent) advisories.push({ rule: "rules_disagree", message: `The old rules read this as "${ctx.rules.primaryIntent.replace(/_/g, " ")}"${ctx.rules.firstAction ? ` (${ctx.rules.firstAction})` : ""}; Hermes's reading is used.` });
  if (ctx.rules && (ctx.rules.urgency === "urgent" || ctx.rules.urgency === "high") && h.urgency !== "urgent" && h.urgency !== "high") advisories.push({ rule: "possible_urgency", message: `The old rules saw urgency (${ctx.rules.urgency}); Hermes rated it ${h.urgency}.` });
  for (const a of h.advisories) advisories.push({ rule: "hermes", message: a });

  const recommended = h.recommended_action;
  const headline: Validation["headline"] = { recommended, final: recommended, changedBy: null };
  const base: PlannedAction[] = [];
  const out: PlannedAction[] = [];

  // ---- HARD: identity is the CRM's, never Hermes's ----
  if (identity.status === "needs_review") {
    const suggestion = h.identity.suggestion === "candidate" && h.identity.candidate_key ? { key: h.identity.candidate_key, reason: h.identity.reason } : h.identity.suggestion === "new" ? { key: "new", reason: h.identity.reason } : null;
    hard.push({ rule: "identity_uncertain", message: `${identity.reason}${suggestion ? ` Hermes suggests ${suggestion.key === "new" ? "a new customer" : suggestion.key}; that cannot file it on its own.` : ""}`, effect: "nothing written to a customer until Chris confirms" });
    out.push(act("NEEDS_REVIEW", "approval", "identity_uncertain", identity.reason, { kind: "identity", hermesSuggestion: suggestion, candidates: identity.candidates.slice(0, 5).map((c) => ({ leadId: c.leadId, contactId: c.contactId, label: c.label, score: c.score, signals: c.signals })) }));
    if (input.sourceType === "recording") out.push(act("LINK_RECORDING", "approval", "identity_uncertain", "File the recording once Chris confirms who it is with."));
    headline.final = "NEEDS_REVIEW";
    headline.changedBy = "identity_uncertain";
    return { understanding, hard, business, advisories, rejectedFacts, plan: out, reviewKind: "identity", headline };
  }
  if (identity.status === "matched" && h.identity.suggestion === "candidate" && h.identity.candidate_key && identity.chosen) {
    const chosenKey = identity.chosen.leadId ? `lead:${identity.chosen.leadId}` : `customer:${identity.chosen.contactId}`;
    if (h.identity.candidate_key !== chosenKey) advisories.push({ rule: "identity_disagreement", message: `Hermes suggested ${h.identity.candidate_key}; the CRM matched ${identity.chosen.label} on ${identity.chosen.signals.map((s) => s.detail).join(", ")}, which stands.` });
  }

  // Internal record keeping happens whatever the recommendation.
  if (identity.status !== "not_applicable") base.push(act("ADD_INTERNAL_NOTE", "auto", "always_note", "What Hermes understood.", { summary: h.summary }));
  if (input.sourceType === "recording" && identity.status === "matched" && !crm.recordingLinked) base.push(act("LINK_RECORDING", "auto", "identity_matched", identity.reason));
  if (identity.status === "matched" && facts.length) base.push(act("PROPOSE_LEAD_FACT_UPDATE", "auto", "new_facts", "Facts from this source with their evidence. Blank fields are filled; anything that differs from the CRM is flagged for Chris, never overwritten."));
  if (input.direction === "outbound" || identity.status === "not_applicable") {
    // Our own email: commitments and the note only; nothing is ever sent from here.
    return { understanding, hard, business, advisories, rejectedFacts, plan: base, reviewKind: null, headline: { ...headline, final: "NO_ACTION", changedBy: recommended === "NO_ACTION" ? null : "outbound_email" } };
  }

  const isEnquiry = ["new_enquiry", "quote_request", "site_visit_request", "booking_request"].includes(h.intent) || h.conversation_type === "new_enquiry";

  // ---- HARD: a real enquiry is never "no action"; Hermes's doubt and low confidence go to Chris ----
  let action: HermesAction = recommended;
  if (action === "NO_ACTION" && isEnquiry) {
    hard.push({ rule: "enquiry_never_no_action", message: "Hermes said no action, but it reads as an enquiry. Sent to Chris instead.", effect: "NEEDS_REVIEW" });
    action = "NEEDS_REVIEW";
  }
  const plan = (a: HermesAction): PlannedAction[] => planFor(a, h, ctx, { known, missing, service, property, commitments, business, hard });
  if (action === "NEEDS_REVIEW") {
    out.push(act("NEEDS_REVIEW", "approval", recommended === "NEEDS_REVIEW" ? "hermes_flagged" : "enquiry_never_no_action", h.reason, { kind: "hermes_flagged", hermesRecommendation: recommended, confidence: h.confidence }));
    headline.final = "NEEDS_REVIEW";
    if (recommended !== "NEEDS_REVIEW") headline.changedBy = "enquiry_never_no_action";
    return { understanding, hard, business, advisories, rejectedFacts, plan: [...base, ...out], reviewKind: "hermes_flagged", headline };
  }
  if (h.confidence < ctx.minConfidence) {
    const proposed = plan(action);
    hard.push({ rule: "low_confidence", message: `Hermes is ${Math.round(h.confidence * 100)}% sure (below ${Math.round(ctx.minConfidence * 100)}%). Its recommendation waits for Chris.`, effect: "NEEDS_REVIEW" });
    out.push(act("NEEDS_REVIEW", "approval", "low_confidence", h.reason, { kind: "hermes_low_confidence", hermesRecommendation: recommended, confidence: h.confidence, plan: proposed }));
    headline.final = "NEEDS_REVIEW";
    headline.changedBy = "low_confidence";
    return { understanding, hard, business, advisories, rejectedFacts, plan: [...base, ...out], reviewKind: "hermes_low_confidence", headline };
  }

  const planned = plan(action);
  if (h.run_business_brain && !planned.some((p) => p.type === "RUN_BUSINESS_BRAIN") && !planned.some((p) => p.type === "PROPOSE_SITE_VISIT" || p.type === "DRAFT_EMAIL" || p.type === "CREATE_INTERNAL_TASK")) {
    planned.push(...plan("RUN_BUSINESS_BRAIN"));
  }
  // ---- HARD: an acceptance never accepts anything: Chris confirms ----
  if (h.intent === "acceptance" && !planned.some((p) => p.type === "CREATE_INTERNAL_TASK")) {
    hard.push({ rule: "no_autonomous_acceptance", message: "The customer wants to go ahead: Chris confirms the terms; the CRM never accepts them itself.", effect: "task for Chris" });
    planned.push(act("CREATE_INTERNAL_TASK", "auto", "customer_accepted", "The customer says they want to go ahead. Chris confirms and marks the quote accepted.", { title: "Customer wants to go ahead: confirm and mark the quote accepted", kind: "task", due: "today" }));
  }
  const meaningful = planned.filter((p) => !["ADD_INTERNAL_NOTE", "LINK_RECORDING", "PROPOSE_LEAD_FACT_UPDATE"].includes(p.type));
  const first = meaningful.find((p) => p.type === "PREPARE_QUOTE") ?? meaningful[0];
  headline.final = first?.type ?? "NO_ACTION";
  const override = business.find((b) => b.effect) ?? hard.find((x) => x.effect && x.rule !== "fact_evidence" && x.rule !== "commitment_evidence");
  if (override) headline.changedBy = override.rule;
  return { understanding, hard, business, advisories, rejectedFacts, plan: [...base, ...planned], reviewKind: null, headline };
}

/** One recommended action, turned into the router's actions under the business rules. */
function planFor(
  action: HermesAction,
  h: HermesResult,
  ctx: ValidateContext,
  s: { known: Known; missing: MissingInfo[]; service: string | null; property: string | null; commitments: Commitment[]; business: Check[]; hard: Check[] },
): PlannedAction[] {
  const { known, service, property } = s;
  const timing = (known.timing as string | undefined) ?? null;
  const address = (known.site_address as string | undefined) ?? null;
  const siteVisitAsked = known.site_visit_requested === true || h.intent === "site_visit_request";
  const blockingQuestions = (forWhat?: string) =>
    s.missing.filter((m) => m.blocking && (!forWhat || m.for === forWhat)).map((m) => h.missing.find((x) => x.field === m.field)?.question ?? m.label);
  const ask = (questions: string[], rule: string, why: string): PlannedAction[] => {
    const phone = ctx.crm.customerPhone ?? (known.phone as string | undefined) ?? null;
    if (phone && (h.urgency === "urgent" || h.urgency === "high")) return [act("CALL_CUSTOMER", "auto", rule, `${why} Quicker to ask by phone: ${questions.join("; ")}.`, { ask: questions })];
    return [act("DRAFT_EMAIL", "auto", rule, `${why} Only this is asked: ${questions.join("; ")}.`, { ask: questions })];
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
      // BUSINESS: commercial CCTV, or a customer who asked for a visit, is seen first.
      if (service === "cctv" && property === "commercial") {
        s.business.push({ rule: "commercial_cctv_site_visit", message: `Hermes recommended "${what}"; commercial CCTV is always designed from a site visit.`, effect: "PROPOSE_SITE_VISIT" });
        return siteVisit("commercial_cctv_site_visit", "Commercial CCTV is always designed from a site visit.");
      }
      if (siteVisitAsked) {
        s.business.push({ rule: "explicit_site_visit_request", message: `Hermes recommended "${what}"; the customer asked for a site visit.`, effect: "PROPOSE_SITE_VISIT" });
        return siteVisit("explicit_site_visit_request", "The customer asked for a site visit.");
      }
      // BUSINESS: only CCTV has a Business Brain.
      if (service !== "cctv") {
        const svc = service ? service.replace(/_/g, " ") : null;
        if (!svc) {
          s.business.push({ rule: "brain_needs_service", message: `Hermes recommended "${what}" but the service is not known.`, effect: "ASK_CUSTOMER" });
          return ask(["Could you tell me a bit more about what you're after (cameras, alarm, access control…)?"], "ask_service", "The service decides how it is quoted.");
        }
        s.business.push({ rule: "manual_quote_service", message: `Hermes recommended "${what}"; there is no Business Brain for ${svc}, so it is quoted by hand.`, effect: "CREATE_INTERNAL_TASK" });
        return [act("CREATE_INTERNAL_TASK", "auto", "manual_quote_service", `${svc} enquiry: quote it manually (only CCTV has a Business Brain).`, { title: `Quote ${svc} enquiry manually`, kind: "quote", due: "next_business_day" })];
      }
      // BUSINESS: the Brain's inputs. It never guesses them.
      const need: string[] = [];
      if (!property) need.push("Is this for your home or for a business?");
      if (!has(known, "camera_count") && !has(known, "areas")) need.push("Roughly how many cameras are you after, or which areas would you like covered?");
      if (property !== "commercial" && !has(known, "storeys")) need.push("Is the house single or double storey?");
      if (need.length) {
        s.business.push({ rule: "brain_inputs_missing", message: `Hermes recommended "${what}"; the Business Brain still needs: ${need.join(" ")}`, effect: "ASK_CUSTOMER" });
        return ask(need, "ask_blocking_only", "Before a quote the Business Brain needs a little more.");
      }
      // BUSINESS: one prepared quote at a time; a sent quote is only revised with Chris.
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
      const qs = blockingQuestions();
      if (!qs.length) {
        s.business.push({ rule: "nothing_blocking", message: "Hermes recommended asking the customer, but nothing it listed blocks progress.", effect: "NEEDS_REVIEW" });
        return [act("NEEDS_REVIEW", "approval", "nothing_blocking", "Hermes wanted to ask the customer, but nothing blocking is missing.", { kind: "hermes_flagged", hermesRecommendation: action })];
      }
      return ask(qs, "ask_blocking_only", "Hermes: information that blocks progress is missing.");
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
      return [act("CREATE_INTERNAL_TASK", "auto", "hermes_recommendation", h.reason, { title: h.task?.title ?? h.summary.slice(0, 120), kind: "task", due: h.task?.due ?? "next_business_day", detail: h.task?.detail ?? h.reason })];
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
