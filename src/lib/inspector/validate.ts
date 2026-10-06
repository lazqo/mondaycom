/**
 * The guardrail layer between Hermes and the CRM. Hermes is the operational judgement: what a
 * message is, its business context, whether it is a lead, which work it belongs to, what is
 * resolved or outstanding, which commitments were kept, the next step, whether research is needed
 * and which internal work to do. This layer does NOT re-decide any of that. It asks only:
 *
 *   1. Is the evidence sufficient for this kind of write? (provenance: a fact or commitment must come
 *      from the source or the record: a quote of its words, or a structured ref to a form field,
 *      transcript turn, header or CRM field that supports the value; a commitment kept, or customer
 *      work closed, must cite CRM records that exist in the context.)
 *   2. Is Hermes authorised to do this on its own? (src/lib/hermes/authority.ts: internal work is
 *      autonomous; customer-facing work is only prepared; proposals wait for Chris.)
 *   3. Does it need a verified identity or a record to work on? (Only the actions that do wait; the
 *      rest of the work goes ahead, and the sender stays unlinked until evidence or Chris links them.)
 *   4. Is it customer-facing or commercially binding? (A reply may not quote a price, a discount or a
 *      date; an acceptance never accepts terms; nothing is sent.)
 *   5. Does the Business Brain own it? (Only CCTV has a Brain; one prepared quote at a time; a quote
 *      already sent is only revised with Chris. Everything else, including the inputs it needs and
 *      whether a site visit comes first, the Brain decides when it runs: see the router.)
 *   6. Is it destructive or irreversible? (Nothing here deletes, merges or approves anything.)
 *
 * Low confidence: Hermes's own doubt. Safe internal work still goes ahead; what prepares customer
 * output or changes state waits for Chris.
 *
 * Pure: everything it needs is passed in.
 */
import { commandNeedsClick, describeCommand } from "./commands";
import { NON_CUSTOMER_CONTEXTS, type HermesAction, type HermesResult } from "@/lib/hermes/contract";
import { AUTHORITY, lacksRecord } from "@/lib/hermes/authority";
import { AUTONOMY_DEFAULTS, dialFor, type AutonomySettings } from "@/lib/hermes/autonomy";
import { BUSINESS_CONTEXT_LABELS } from "./labels";
import { resolveDue, clockTime } from "./dates";
import { applySpelling, normalisePhone, spelledWordsIn, toNumber } from "./text";
import { maybeKnown } from "./identity";
import type { Commitment, ExtractedFact, FactKey, IdentityResult, InspectorInput, Known, MissingInfo, PlannedAction, Understanding } from "./types";

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
  /** The autonomy dial (Settings → Hermes): how far each class goes on its own, and how sure Hermes must be. */
  autonomy?: AutonomySettings;
  /** Chris's answers to earlier questions about this same email or conversation. */
  answers?: { key: string; question: string; answer: string }[];
  /** CRM records (refs from the context pack) Hermes may cite as evidence or choose as the work. */
  citable?: string[];
  /**
   * The operational context Hermes chose (operational_context.ref), as checked by the CRM: the record
   * exists and the source itself shows it (its site address, job or quote number, the thread).
   */
  context?: { ref: string; label: string; leadId: string | null; jobId: string | null; contactId: string | null; accepted: boolean; why: string } | null;
};

export type Check = { rule: string; message: string; effect?: string };

export type Validation = {
  understanding: Understanding;
  /** Guardrails that restricted something (authority, evidence, identity, customer-facing). */
  hard: Check[];
  /** Business Brain authority that changed what was done. */
  business: Check[];
  /** Shown, never deciding. */
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
  /** Every guardrail decision, allowed or refused, for the audit (concise; no reasoning). */
  decisions: { action: string; allowed: boolean; rule: string }[];
};

const act = (type: PlannedAction["type"], mode: PlannedAction["mode"], rule: string, reason: string, payload: Record<string, unknown> = {}): PlannedAction => ({ type, mode, rule, reason, payload });

// ---------------- evidence and provenance ----------------

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
  return haystackOf(parts.join(" \n "));
}

const haystackOf = (raw: string) => {
  const text = norm(raw);
  return { text, tokens: new Set(text.split(" ").filter(Boolean)) };
};

/** Words that describe where a quote came from rather than being part of it ("form field Cameras: 4"). */
const PROVENANCE_WORDS = new Set(["form", "field", "fields", "website", "source", "the", "says", "said", "per", "from", "submission", "value", "transcript", "turn", "email", "subject"]);

/** Did the source really say this? Exact (normalised) quote, or nearly all of its words. */
export function evidenceFound(evidence: string, hay: { text: string; tokens: Set<string> }): boolean {
  const e = norm(evidence);
  if (!e) return false;
  if (hay.text.includes(e)) return true;
  const words = e.split(" ").filter((w) => w.length > 1 || /\d/.test(w));
  // "form field Cameras: 4": the words saying where it came from are not part of the quote.
  const content = words.filter((w) => hay.tokens.has(w) || !PROVENANCE_WORDS.has(w));
  if (!content.length) return false;
  const found = content.filter((w) => hay.tokens.has(w)).length;
  if (content.length === 1) return found === 1 && content[0].length >= 4;
  return found / content.length >= 0.8;
}

/** A structured reference into the source or the record, resolved to the text it points at; null when it points at nothing. */
export function resolveEvidenceRef(ref: string, input: InspectorInput, known: Known): { text: string; label: string } | null {
  const m = ref.trim().match(/^(?:source\.)?(form|turn|email|crm)(?:\.fields)?[:.]\s*(.+)$/i);
  if (!m) return null;
  const kind = m[1].toLowerCase();
  const key = m[2].trim();
  const k = key.toLowerCase();
  if (kind === "form") {
    const f = input.form;
    if (!f) return null;
    const parsed: Record<string, string | null> = { name: f.name, email: f.email, phone: f.phone, address: f.address, service: f.service };
    if (k in parsed) return parsed[k] ? { text: parsed[k]!, label: `form ${k}` } : null;
    const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const field = Object.keys(f.fields).find((x) => squash(x) === squash(key));
    return field && f.fields[field] ? { text: f.fields[field], label: `form field ${field}` } : null;
  }
  if (kind === "turn") {
    const n = Number(k.replace(/^#/, ""));
    const u = Number.isInteger(n) ? input.utterances[n] : undefined;
    return u ? { text: u.text, label: `turn ${n}` } : null;
  }
  if (kind === "email") {
    if (k === "subject") return input.title ? { text: input.title, label: "subject" } : null;
    if (k === "body" || k === "text") return input.text ? { text: input.text, label: "the message" } : null;
    if (k === "from") {
      const t = [input.from.name, input.from.email, input.from.phone].filter(Boolean).join(" ");
      return t ? { text: t, label: "sender" } : null;
    }
    return null;
  }
  const v = known[k as FactKey];
  return v !== undefined && v !== null && v !== "" ? { text: String(v), label: `CRM ${k}` } : null;
}

/**
 * Provenance for one fact or commitment. It stands if a structured ref resolves and supports the
 * value (or contains the quoted words), or if the quoted words are in the source. A quote that is
 * itself a ref ("form:Cameras", "source.form.fields.Cameras") is read as one.
 */
export function provenance(e: { evidence: string; evidence_ref?: string | null }, input: InspectorInput, known: Known, hay: { text: string; tokens: Set<string> }, fact?: { key: FactKey; value: string | number | boolean }): { ok: boolean; shown: string; reason?: string; cited?: boolean } {
  const quoted = e.evidence.trim();
  const ref = e.evidence_ref?.trim() || (/^(?:source\.)?(form|turn|email|crm)(?:\.fields)?[:.]/i.test(quoted) ? quoted : null);
  if (ref) {
    const r = resolveEvidenceRef(ref, input, known);
    if (r) {
      const within = haystackOf(r.text);
      const supports =
        !fact ||
        (() => {
          const a = normaliseFact(fact.key, r.text);
          const b = normaliseFact(fact.key, fact.value);
          if (a && b && String(a.value) === String(b.value)) return true;
          const v = norm(String(fact.value));
          // A number may be written as a word in the source ("six cameras").
          if (typeof fact.value === "number" && [...within.tokens].some((t) => Number(t) === fact.value || toNumber(t) === fact.value)) return true;
          return !!v && (within.text.includes(v) || evidenceFound(String(fact.value), within));
        })();
      const quoteFits = !quoted || quoted === ref || evidenceFound(quoted, within) || evidenceFound(quoted, hay);
      if (supports && quoteFits) return { ok: true, shown: quoted && quoted !== ref ? quoted : `${r.label}: ${r.text}`.slice(0, 500) };
      // The quoted words are in the source even though the ref was the wrong place: the quote stands.
      if (quoted && quoted !== ref && evidenceFound(quoted, hay)) return { ok: true, shown: quoted };
      // A reading of a transcript turn or the message ("residential", "alarm system") that is not
      // verbatim: the source is cited, so it is kept, but only proposed for Chris, never filled in.
      if (/^(turn|email)$/i.test(ref.split(/[:.]/)[0].replace(/^source\./, "")) && r.label !== "subject" && r.label !== "sender") return { ok: true, shown: `${r.label}: ${r.text}`.slice(0, 500), cited: true };
      return { ok: false, shown: quoted, reason: `${ref} does not show ${fact ? String(fact.value) : "that"}` };
    }
    if (!quoted || quoted === ref) return { ok: false, shown: quoted, reason: `${ref} is not in the source or the record` };
  }
  if (evidenceFound(quoted, hay)) return { ok: true, shown: quoted };
  return { ok: false, shown: quoted, reason: quoted ? "evidence not found in the source" : "no evidence given" };
}

export const SERVICE_DISPLAY: Record<string, string> = { cctv: "CCTV", alarm: "Alarm", access_control: "Access control", intercom: "Intercom", networking: "Networking", other: "Other" };

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
      if (/rent|hire|temporary|short[- ]term/.test(str)) return { value: "rental", display: "Rental / temporary" };
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
/** Record keeping that happens whatever the recommendation. */
const BASE_TYPES: PlannedAction["type"][] = ["ADD_INTERNAL_NOTE", "LINK_RECORDING", "PROPOSE_LEAD_FACT_UPDATE", "RESOLVE_COMMITMENT"];

export function validateHermes(h: HermesResult, ctx: ValidateContext): Validation {
  const hard: Check[] = [];
  const business: Check[] = [];
  const advisories: Check[] = [];
  const rejectedFacts: Validation["rejectedFacts"] = [];
  const decisions: Validation["decisions"] = [];
  const { input, identity, crm } = ctx;
  const autonomy = ctx.autonomy ?? AUTONOMY_DEFAULTS;
  const leadThreshold = autonomy.thresholds.operational_state;
  const hay = sourceHaystack(input);
  const citable = new Set(ctx.citable ?? []);

  // ---- EVIDENCE: a fact needs provenance (a quote, or a structured ref that supports it) and a usable value ----
  const facts: ExtractedFact[] = [];
  const spelled = spelledWordsIn(`${input.text}\n${input.utterances.map((u) => u.text).join("\n")}`);
  for (const f of h.facts) {
    const p = provenance(f, input, ctx.known, hay, { key: f.key, value: f.value });
    if (!p.ok) {
      rejectedFacts.push({ key: f.key, value: f.value, reason: p.reason ?? "evidence not found in the source" });
      continue;
    }
    const n = normaliseFact(f.key, f.value);
    if (!n) {
      rejectedFacts.push({ key: f.key, value: f.value, reason: "value not usable" });
      continue;
    }
    if (facts.some((x) => x.key === f.key)) continue;
    // A name or street the speaker spelled out letter by letter: the spelling wins over the
    // transcriber's word ("Houston" heard, E U S T O N said → Euston).
    let value = n.value;
    let display = n.display;
    if ((f.key === "site_address" || f.key === "contact_name" || f.key === "company") && typeof value === "string" && spelled.length) {
      const fix = applySpelling(value, spelled);
      if (fix) {
        value = fix.value;
        display = fix.value;
        advisories.push({ rule: "spelled_out", message: `${f.key === "site_address" ? "Street" : "Name"} taken from the spelling: “${fix.from}” was spelled out as ${fix.to.toUpperCase()}.` });
      }
    }
    // An NZ mobile said with digits missing cannot be dialled: say so, and the identity rules treat
    // it as a partial number (a candidate to confirm) rather than a new one.
    if (f.key === "phone" && typeof value === "string" && /^02/.test(value) && value.length < 10) advisories.push({ rule: "short_phone", message: `The number ${display} has only ${value.length} digits; an NZ mobile has 10 or 11. It may have been read out with digits missing.` });
    // Cited but not verbatim: proposed for Chris (below the fill-in confidence), never filled in.
    facts.push({ key: f.key, value, display, evidence: p.shown.slice(0, 500), confidence: p.cited ? Math.min(f.confidence, 0.69) : f.confidence });
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

  // ---- EVIDENCE: commitments need provenance too; the CRM works out the due time where it can ----
  const commitments: Commitment[] = [];
  for (const c of h.commitments) {
    const p = provenance(c, input, ctx.known, hay);
    if (!p.ok) {
      hard.push({ rule: "commitment_evidence", message: `Commitment "${c.action}" not used: ${p.reason ?? "its words were not found in the source"}.`, effect: "commitment rejected" });
      continue;
    }
    const fromText = c.due_text ? resolveDue(c.due_text, input.at) : null;
    const fromHermes = c.due_at && !Number.isNaN(Date.parse(c.due_at)) ? new Date(c.due_at) : null;
    const due = fromText ?? fromHermes;
    commitments.push({ owner: c.owner, ownerName: c.owner_name, action: c.action.charAt(0).toUpperCase() + c.action.slice(1), actionKey: c.action_key, dueAt: due ? due.toISOString() : null, dueText: c.due_text, evidence: p.shown.slice(0, 500), confidence: Math.min(h.confidence, 0.95) });
  }

  // ---- EVIDENCE: a commitment kept or void, and a resolution, must cite CRM records in the context ----
  const resolveCommitments: PlannedAction[] = [];
  for (const u of h.commitment_updates) {
    const ref = u.id.startsWith("commitment:") ? u.id : `commitment:${u.id}`;
    if (!citable.has(ref) || !citable.has(u.evidence_ref) || u.evidence_ref === ref) {
      hard.push({ rule: "commitment_update_evidence", message: `Commitment update not used: ${!citable.has(ref) ? "that commitment is not in this record" : "its evidence is not a CRM record in this context"}.`, effect: "update rejected" });
      decisions.push({ action: "RESOLVE_COMMITMENT", allowed: false, rule: "commitment_update_evidence" });
      continue;
    }
    resolveCommitments.push(act("RESOLVE_COMMITMENT", "auto", "hermes_commitment_update", u.note || `Hermes: the CRM shows this was ${u.status === "done" ? "kept" : "made void"}.`, { commitmentId: ref.slice("commitment:".length), status: u.status, evidenceRef: u.evidence_ref }));
  }
  const evidence = h.resolution.evidence.filter((e) => citable.has(e.ref));
  if (evidence.length < h.resolution.evidence.length) advisories.push({ rule: "resolution_evidence", message: "Some of Hermes's evidence refs were not CRM records in this context and were ignored." });

  // Missing information is Hermes's judgement (the Brain decides its own inputs when it runs).
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
  for (const a of h.advisories) advisories.push({ rule: "hermes", message: a });

  const recommended = h.recommended_action;
  const headline: Validation["headline"] = { recommended, final: recommended, changedBy: null };
  const result = (plan: PlannedAction[], reviewKind: Validation["reviewKind"], workContext: Validation["workContext"], personVerified: boolean): Validation => {
    for (const p of plan) if (!decisions.some((d) => d.action === p.type && d.rule === p.rule)) decisions.push({ action: p.type, allowed: true, rule: p.rule });
    return { understanding, hard, business, advisories, rejectedFacts, plan, reviewKind, headline, workContext, personVerified, decisions };
  };

  // ---- Business context: Hermes's judgement of what kind of relationship this is ----
  const nonCustomer = NON_CUSTOMER_CONTEXTS.includes(h.business_context);
  if (h.business_context !== "unknown") advisories.push({ rule: "business_context", message: `Hermes: ${BUSINESS_CONTEXT_LABELS[h.business_context]}${h.counterparty.name ? ` (${h.counterparty.name})` : ""}${h.accounting ? `; ${h.accounting.document}${h.accounting.reference ? ` ${h.accounting.reference}` : ""}` : ""}.` });

  // Hermes is sure this is not a lead or not customer business, and nothing needs doing: nothing to file.
  // Work beside the recommendation: internal actions, research, questions, or Chris's own commands.
  const extraWork = h.internal_actions.length > 0 || h.research.length > 0 || h.questions.length > 0 || (input.sourceType === "recording" && h.commands.length > 0);
  if ((h.lead_decision === "not_lead" || nonCustomer) && recommended === "NO_ACTION" && !extraWork && h.confidence >= leadThreshold && identity.status !== "matched") {
    advisories.push({ rule: "not_a_lead", message: "Hermes: nothing to do. Nothing filed." });
    return result([], null, null, false);
  }

  // ---- IDENTITY: who the sender is stays the CRM's; the work goes on in an evidenced context ----
  let workContext: Validation["workContext"] = null;
  const personVerified = identity.status === "matched";
  const personUnknown = identity.status === "needs_review" || identity.status === "new";
  const suggestion = h.identity.suggestion === "candidate" && h.identity.candidate_key ? { key: h.identity.candidate_key, reason: h.identity.reason } : h.identity.suggestion === "new" ? { key: "new", reason: h.identity.reason } : null;
  if (personUnknown) {
    const c = ctx.context;
    if (c?.accepted) {
      workContext = { ref: c.ref, label: c.label, leadId: c.leadId, jobId: c.jobId, contactId: c.contactId };
      advisories.push({ rule: "sender_unverified", message: `The sender is not linked to a customer (${identity.reason}). Hermes places this in ${c.label} (${c.why}); the work continues there, and nothing about the person is written until the evidence is strong enough or Chris links them.` });
    } else if (c) {
      advisories.push({ rule: "context_not_evidenced", message: `Hermes placed this in ${c.label}, but ${c.why}, so the work is not filed there.` });
    }
  }
  if (identity.status === "matched" && h.identity.suggestion === "candidate" && h.identity.candidate_key && identity.chosen) {
    const chosenKey = identity.chosen.leadId ? `lead:${identity.chosen.leadId}` : `customer:${identity.chosen.contactId}`;
    if (h.identity.candidate_key !== chosenKey) advisories.push({ rule: "identity_disagreement", message: `Hermes suggested ${h.identity.candidate_key}; the CRM matched ${identity.chosen.label} on ${identity.chosen.signals.map((s) => s.detail).join(", ")}, which stands.` });
  }
  const onWork = personVerified || !!workContext;
  // A record counts only for a verified sender, or for the evidenced work Hermes placed it in.
  const records = { lead: (personVerified && !!crm.leadId) || !!workContext?.leadId, work: (personVerified && !!(crm.leadId || crm.contactId)) || !!workContext };

  // Internal record keeping happens whatever the recommendation.
  const base: PlannedAction[] = [];
  if (identity.status !== "not_applicable") base.push(act("ADD_INTERNAL_NOTE", "auto", "always_note", "What Hermes understood.", { summary: h.summary }));
  if (input.sourceType === "recording" && personVerified && !crm.recordingLinked) base.push(act("LINK_RECORDING", "auto", "identity_matched", identity.reason));
  const customerContext = !nonCustomer && h.business_context !== "accounting_payment";
  if (onWork && facts.length && customerContext)
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

  // ---- Hermes's plan, translated into the router's actions (no re-interpretation) ----
  let planned = planFor(recommended, h, ctx, { known, missing, service, commitments, business, hard });
  for (const x of h.internal_actions) planned.push(...internalAction(x, h));
  for (const r of h.research) planned.push(act("REQUEST_RESEARCH", "auto", "hermes_research", r.why || `Research: ${r.question}`, { question: r.question, kind: r.kind, product: r.product }));
  // Instructions Chris gave on a recording. Only a recording is his own voice: commands in an email
  // (anyone can write "cancel my visit") are ignored and said so. The commanded words must be in the
  // transcript; what changes a customer's appointment, or cannot be undone, waits for his click.
  if (h.commands.length && input.sourceType !== "recording") advisories.push({ rule: "commands_ignored", message: `${h.commands.length} instruction${h.commands.length === 1 ? "" : "s"} ignored: only a recording of Chris is an operator channel, never an email.` });
  if (input.sourceType === "recording") {
    const hay = sourceHaystack(input);
    for (const [n, c] of h.commands.entries()) {
      if (!c.evidence || !evidenceFound(c.evidence, hay)) {
        advisories.push({ rule: "command_not_in_words", message: `Instruction not carried out: the words “${c.evidence || "(none quoted)"}” are not in the transcript.` });
        decisions.push({ action: "OPERATOR_COMMAND", allowed: false, rule: "command_not_in_words" });
        continue;
      }
      // Each command is its own action (the plan is de-duplicated on type and rule).
      planned.push(act("OPERATOR_COMMAND", commandNeedsClick(c) ? "approval" : "auto", `operator_command:${n + 1}:${c.action}`, c.why || describeCommand(c), { command: c, summary: describeCommand(c) }));
    }
  }
  // Questions for Chris: a card each, answered on Home. Nothing internal waits for an answer, and a
  // question Chris has already answered for this item is never asked again.
  const answered = ctx.answers ?? [];
  // Prices Chris stated himself on a recording: a card he confirms (never recorded by Hermes), which
  // then prepares the quote. On an email they are ignored: only Chris's own voice sets a price.
  const statedDone = answered.some((a) => a.key === `stated_pricing:${input.sourceId}`);
  const statedItems = input.sourceType === "recording" && !statedDone ? h.stated_pricing.filter((i) => !i.evidence || evidenceFound(i.evidence, hay)) : [];
  if (h.stated_pricing.length && input.sourceType !== "recording") advisories.push({ rule: "stated_pricing_ignored", message: "Prices in an email are never taken as Get Secure's; only Chris's own words on a recording are." });
  else if (statedDone) advisories.push({ rule: "stated_pricing_done", message: "The prices stated on this call were confirmed by Chris and the quote prepared." });
  else if (h.stated_pricing.length > statedItems.length) advisories.push({ rule: "stated_pricing_evidence", message: "Some stated prices were not found in the transcript and were left out." });
  if (statedItems.length) {
    planned.push(
      act("ASK_CHRIS", "approval", "stated_pricing", "You stated these prices on the recording; confirm them and the quote is prepared for your approval.", {
        key: `stated_pricing:${input.sourceId}`,
        kind: "stated_pricing",
        question: `Record the prices you stated (${statedItems.map((i) => `${i.description} $${i.amount}${i.unit === "per_month" ? "/month" : ""}`).join(", ")}) and prepare the quote?`,
        items: statedItems,
        unblocks: ["PREPARE_QUOTE"],
        learn: false,
      }),
    );
  }
  // Rental, hire or temporary work is not the Brain's installed-system design: it is priced by
  // Get Secure's rental rule. Without one, Hermes asks (and the answer is learnt).
  const rental = facts.some((f) => f.key === "job_type" && f.value === "rental") || /\b(rent(al|ed|ing)?|hire|temporary camera)\b/i.test(`${h.summary} ${facts.map((f) => f.display).join(" ")}`);
  if (rental) {
    const before = planned.length;
    planned = planned.filter((p) => p.type !== "RUN_BUSINESS_BRAIN" && p.type !== "PREPARE_QUOTE");
    if (planned.length < before) advisories.push({ rule: "rental_not_brain", message: "Rental or temporary work: the Business Brain designs installed systems, so it did not run; the rental rule or Chris's stated prices price it." });
    const learnt = (ctx.answers ?? []).some((a) => /rental/i.test(String(a.key ?? "")));
    if (!statedItems.length && !statedDone && !learnt && !h.questions.some((q) => /rental/i.test(q.key))) {
      planned.push(act("ASK_CHRIS", "approval", "rental_pricing", "Rental work is priced by Get Secure's rental rule, which the CRM does not have yet.", { key: "rental_pricing", kind: "text", question: "What do we charge for a short-term camera rental: per month (data included), the install, and which kit?", why: "Rental is not the Business Brain's installed-system design. Your answer is kept as the rental rule for every future reading.", unblocks: ["PREPARE_QUOTE"], learn: true }));
    }
  }
  for (const q of h.questions) {
    const already = answered.find((a) => a.key === q.key || a.question.trim().toLowerCase() === q.question.trim().toLowerCase());
    if (already) {
      advisories.push({ rule: "question_answered", message: `Hermes asked again: “${q.question}”. Chris already answered: ${already.answer}.` });
      continue;
    }
    planned.push(act("ASK_CHRIS", "approval", "hermes_question", q.why || q.question, { key: q.key, question: q.question, kind: q.kind, options: q.options, unblocks: q.unblocks, learn: q.learn }));
  }
  if (h.run_business_brain && !rental && !planned.some((p) => p.type === "RUN_BUSINESS_BRAIN")) planned.push(...planFor("RUN_BUSINESS_BRAIN", h, ctx, { known, missing, service, commitments, business, hard }));
  planned = dedupe(planned);

  // ---- GUARDRAIL: customer work is closed only with evidence (a cited record, or work already open) ----
  const customerWork = customerContext && h.lead_decision !== "not_lead";
  const saysOpen = ENQUIRY_INTENTS.includes(h.intent) || h.conversation_type === "new_enquiry" || h.resolution.status === "waiting_on_us";
  const openWork = [...citable].filter((r) => r.startsWith("task:") || r.startsWith("commitment:"));
  if (recommended === "NO_ACTION" && customerWork && saysOpen && !extraWork) {
    if (h.resolution.status === "resolved" && evidence.length) {
      advisories.push({ rule: "closed_with_evidence", message: `Hermes closed this, citing ${evidence.map((e) => `${e.ref}${e.note ? ` (${e.note})` : ""}`).join("; ")}.` });
    } else if (openWork.length && !ENQUIRY_INTENTS.includes(h.intent)) {
      // An acknowledgement on work that already has an open task or commitment: covered, nothing to add.
      advisories.push({ rule: "covered_by_open_work", message: `Nothing new to do: ${openWork.length} open task${openWork.length === 1 ? "" : "s"}/commitment${openWork.length === 1 ? "" : "s"} already cover${openWork.length === 1 ? "s" : ""} this.` });
    } else {
      hard.push({ rule: "close_needs_evidence", message: "Hermes said no action on open customer work without citing CRM records that show it was dealt with. Chris decides.", effect: "NEEDS_REVIEW" });
      decisions.push({ action: "NO_ACTION", allowed: false, rule: "close_needs_evidence" });
      headline.final = "NEEDS_REVIEW";
      headline.changedBy = "close_needs_evidence";
      const review = act("NEEDS_REVIEW", "approval", "close_needs_evidence", h.reason, { kind: "hermes_flagged", question: "Has this been dealt with? Hermes recommended no action but cited nothing that shows it.", hermesRecommendation: recommended, confidence: h.confidence });
      return result([...base, review], "hermes_flagged", workContext, personVerified);
    }
  }

  // ---- GUARDRAIL: an acceptance never accepts anything: Chris confirms ----
  if (h.intent === "acceptance" && !planned.some((p) => p.type === "CREATE_INTERNAL_TASK")) {
    hard.push({ rule: "no_autonomous_acceptance", message: "The customer wants to go ahead: Chris confirms the terms; the CRM never accepts them itself.", effect: "task for Chris" });
    planned.push(act("CREATE_INTERNAL_TASK", "auto", "customer_accepted", "The customer says they want to go ahead. Chris confirms and marks the quote accepted.", { title: "Customer wants to go ahead: confirm and mark the quote accepted", kind: "task", due: "today" }));
  }

  // ---- AUTONOMY: the dial per class (Settings → Hermes). "never" is refused; "ask_first" waits for
  // Chris; below the class's confidence threshold the action waits for Chris with the plan attached ----
  const refused: PlannedAction[] = [];
  const held: PlannedAction[] = [];
  const go0: PlannedAction[] = [];
  for (const p of planned) {
    const dial = dialFor(autonomy, AUTHORITY[p.type]?.class ?? "none");
    if (!dial) {
      go0.push(p);
      continue;
    }
    if (dial.level === "never") refused.push(p);
    else if (h.confidence < dial.threshold && p.type !== "NO_ACTION") held.push(p);
    else if (dial.level === "ask_first" && p.mode === "auto") go0.push({ ...p, mode: "approval" });
    else go0.push(p);
  }
  for (const p of refused) decisions.push({ action: p.type, allowed: false, rule: "autonomy_never" });
  if (refused.length) hard.push({ rule: "autonomy_never", message: `Not done: ${refused.map((p) => p.type.replace(/_/g, " ").toLowerCase()).join(", ")} ${refused.length === 1 ? "is" : "are"} switched off for Hermes in Settings → Hermes.`, effect: "refused" });
  planned = go0;
  if (held.length || (recommended === "NEEDS_REVIEW" && h.confidence < leadThreshold)) {
    const lowest = Math.min(...held.map((p) => dialFor(autonomy, AUTHORITY[p.type].class)?.threshold ?? 1));
    hard.push({ rule: "low_confidence", message: `Hermes is ${Math.round(h.confidence * 100)}% sure (below the ${Math.round(lowest * 100)}% needed). ${planned.some((p) => !BASE_TYPES.includes(p.type)) ? "Its other work went ahead; " : ""}${held.map((p) => p.type.replace(/_/g, " ").toLowerCase()).join(", ") || "its recommendation"} wait${held.length === 1 ? "s" : ""} for Chris.`, effect: "NEEDS_REVIEW" });
    for (const p of held) decisions.push({ action: p.type, allowed: false, rule: "low_confidence" });
    headline.final = "NEEDS_REVIEW";
    headline.changedBy = "low_confidence";
    const review = act("NEEDS_REVIEW", "approval", "low_confidence", h.reason, { kind: "hermes_low_confidence", question: h.review_question ?? `Hermes recommends: ${recommended.replace(/_/g, " ").toLowerCase()}. Go ahead?`, hermesRecommendation: recommended, confidence: h.confidence, plan: held });
    return result([...base, ...planned.filter((p) => p.type !== "NO_ACTION"), review], "hermes_low_confidence", workContext, personVerified);
  }

  // ---- GUARDRAIL: identity. Only actions that need a record wait for it; the rest goes ahead ----
  // A lead Hermes is sure about is created from this reading and the work runs against it, unless
  // someone the CRM has may already be this person: then the lead is only proposed to Chris, so
  // what needs a record waits with the "who is this?" question.
  const willHaveLead = h.lead_decision === "lead" && h.confidence >= leadThreshold && !maybeKnown(input.sourceType, identity);
  const need = { lead: records.lead || willHaveLead, work: records.work || willHaveLead };
  const needsRecord = (p: PlannedAction) => lacksRecord(p.type, need) && !p.payload.standalone;
  const waiting = planned.filter(needsRecord);
  const go = planned.filter((p) => !needsRecord(p));
  for (const p of waiting) decisions.push({ action: p.type, allowed: false, rule: "needs_record" });
  const candidates = identity.candidates.slice(0, 5).map((x) => ({ leadId: x.leadId, contactId: x.contactId, label: x.label, score: x.score, signals: x.signals }));
  let review: PlannedAction[] = [];
  let reviewKind: Validation["reviewKind"] = null;
  // Existing customer work (in Hermes's reading) with no evidenced home: the work goes ahead, but it
  // cannot be filed until Chris says whose it is. Nothing waits on his answer.
  // An appointment Chris stated himself, or a recording of his own instructions (each command names
  // its target), is its own home: nothing to file, nobody to ask about.
  const selfStated = planned.some((p) => !!p.payload.standalone) || (input.sourceType === "recording" && planned.some((p) => p.type === "OPERATOR_COMMAND"));
  const unfiled = personUnknown && !workContext && !willHaveLead && customerWork && !selfStated && (h.lead_decision === "existing" || h.business_context === "existing_work" || h.identity.suggestion === "candidate");
  if (waiting.length || unfiled) {
    const what = waiting.map((p) => p.type.replace(/_/g, " ").toLowerCase()).join(", ");
    hard.push({
      rule: "identity_needed",
      message: waiting.length
        ? `${identity.reason} ${what.charAt(0).toUpperCase() + what.slice(1)} need${waiting.length === 1 ? "s" : ""} a customer record, so ${waiting.length === 1 ? "it waits" : "they wait"} until Chris says who this is.${go.some((p) => p.type !== "NO_ACTION") ? " The rest of the work went ahead." : ""}${suggestion ? ` Hermes suggests ${suggestion.key === "new" ? "a new customer" : suggestion.key}; that cannot link the person on its own.` : ""}`
        : `${identity.reason} Hermes reads this as existing customer work but the source does not show whose, so it is not filed anywhere yet. The work went ahead; Chris says who this is to file it.${suggestion ? ` Hermes suggests ${suggestion.key === "new" ? "a new customer" : suggestion.key}; that cannot link the person on its own.` : ""}`,
      effect: waiting.length ? "waits for who this is" : undefined,
    });
    review = [
      act("NEEDS_REVIEW", "approval", "identity_needed", waiting.length ? `Who is this? Needed for: ${what}.` : "Who is this? The work went ahead; say whose it is so it is filed there.", { kind: "identity", hermesSuggestion: suggestion, workContext: workContext?.label ?? null, waitingFor: waiting.map((p) => p.type), unfiled: !waiting.length, candidates }),
      ...(input.sourceType === "recording" ? [act("LINK_RECORDING", "approval", "identity_needed", "File the recording once Chris confirms who it is with.")] : []),
    ];
    reviewKind = "identity";
  } else if (personUnknown && h.identity_review.needed) {
    if (workContext && input.from.email) {
      // Hermes thinks the sender belongs to the work: an optional link for Chris, never blocking.
      review = [act("PROPOSE_LINK_SENDER", "approval", "hermes_identity_review", h.identity_review.reason || `Link the sender to ${workContext.label}?`, { target: workContext.ref, label: workContext.label, sender: input.from.email })];
    } else {
      // Hermes asks Chris who it is: his judgement, but nothing is held up.
      review = [act("NEEDS_REVIEW", "approval", "hermes_identity_review", h.identity_review.reason || identity.reason, { kind: "identity", hermesSuggestion: suggestion, workContext: null, waitingFor: [], candidates })];
      reviewKind = "identity";
    }
  } else if (personUnknown && workContext && suggestion && suggestion.key === workContext.ref && input.from.email) {
    review = [act("PROPOSE_LINK_SENDER", "approval", "hermes_identity_suggestion", `Hermes thinks the sender belongs to ${workContext.label} (${suggestion.reason || "its reading"}). Optional.`, { target: workContext.ref, label: workContext.label, sender: input.from.email })];
  }
  if (!reviewKind && go.some((p) => p.type === "NEEDS_REVIEW")) reviewKind = "hermes_flagged";

  const meaningful = go.filter((p) => !BASE_TYPES.includes(p.type));
  const first = meaningful.find((p) => p.type === "PREPARE_QUOTE") ?? meaningful[0];
  headline.final = first?.type ?? (waiting.length ? "NEEDS_REVIEW" : "NO_ACTION");
  const override = business.find((b) => b.effect) ?? hard.find((x) => x.effect && !["fact_evidence", "commitment_evidence", "commitment_update_evidence"].includes(x.rule));
  if (override) headline.changedBy = override.rule;
  return result([...base, ...go, ...review], reviewKind, workContext, personVerified);
}

function dedupe(plan: PlannedAction[]): PlannedAction[] {
  const seen = new Set<string>();
  return plan.filter((p) => {
    const key = `${p.type}:${String(p.payload.title ?? p.payload.question ?? p.payload.summary ?? "").toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** One extra piece of internal work Hermes asked for. */
function internalAction(x: HermesResult["internal_actions"][number], h: HermesResult): PlannedAction[] {
  const why = x.reason || h.reason;
  switch (x.action) {
    case "CREATE_INTERNAL_TASK":
      return [act("CREATE_INTERNAL_TASK", "auto", "hermes_internal", why, { title: x.title ?? why.slice(0, 120), kind: /\b(price|costing|quote)\b/i.test(x.title ?? "") ? "quote" : "task", due: x.due ?? "next_business_day", detail: x.detail ?? why })];
    case "FOLLOW_UP":
      return [act("PREPARE_FOLLOW_UP", "auto", "hermes_internal", why, { title: x.title ?? null, due: x.due ?? null, inDays: 3 })];
    case "CALL_CUSTOMER":
      return [act("CALL_CUSTOMER", "auto", "hermes_internal", why, { title: x.title ?? null, detail: x.detail ?? null })];
    case "ADD_INTERNAL_NOTE":
      return [act("ADD_INTERNAL_NOTE", "auto", "hermes_internal", why, { summary: x.detail ?? x.title ?? why })];
    case "RUN_BUSINESS_BRAIN":
      return [act("RUN_BUSINESS_BRAIN", "auto", "hermes_internal", why)];
    case "PROPOSE_SITE_VISIT":
      return [act("PROPOSE_SITE_VISIT", "approval", "hermes_internal", why, {})];
    case "PROPOSE_BOOKING":
      return [act("PROPOSE_BOOKING", "approval", "hermes_internal", why, {})];
  }
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

/**
 * Hermes's recommendation as the router's actions. Translation only: the Business Brain decides its
 * own inputs and whether a site visit comes first when it runs (the router acts on its outcome).
 * What stays here is authority: only CCTV has a Brain; a sent quote is revised only with Chris; one
 * prepared quote at a time; a reply never quotes a price, a discount or a date.
 */
function planFor(
  action: HermesAction,
  h: HermesResult,
  ctx: ValidateContext,
  s: { known: Known; missing: MissingInfo[]; service: string | null; commitments: Commitment[]; business: Check[]; hard: Check[] },
): PlannedAction[] {
  const { known, service } = s;
  const timing = (known.timing as string | undefined) ?? null;
  const address = (known.site_address as string | undefined) ?? null;
  // An appointment Chris states himself on a recording ("install today at 3 pm at X") can be pencilled
  // with no customer attached and filed later: the time is the evidence, not a person.
  const standalone = ctx.input.sourceType === "recording" && !!timing && !!clockTime(timing);
  const questionsFrom = (list: MissingInfo[]) => list.map((m) => h.missing.find((x) => x.field === m.field)?.question ?? m.label);
  const ask = (questions: string[], rule: string, why: string): PlannedAction[] => {
    const phone = ctx.crm.customerPhone ?? (known.phone as string | undefined) ?? null;
    if (phone && (h.urgency === "urgent" || h.urgency === "high")) return [act("CALL_CUSTOMER", "auto", rule, `${why} Quicker to ask by phone: ${questions.join("; ")}.`, { ask: questions })];
    return [act("DRAFT_EMAIL", "auto", rule, `${why} Asked: ${questions.join("; ")}.`, { ask: questions })];
  };

  switch (action) {
    case "RUN_BUSINESS_BRAIN":
    case "PREPARE_QUOTE": {
      const what = action === "PREPARE_QUOTE" ? "Prepare quote" : "Run the Business Brain";
      // BRAIN AUTHORITY: only CCTV has a Business Brain. (Unknown service: the Brain reads the lead.)
      if (service && service !== "cctv") {
        const svc = service.replace(/_/g, " ");
        s.business.push({ rule: "manual_quote_service", message: `Hermes recommended "${what}"; there is no Business Brain for ${svc}, so it is quoted by hand.`, effect: "CREATE_INTERNAL_TASK" });
        return [act("CREATE_INTERNAL_TASK", "auto", "manual_quote_service", `${svc} enquiry: quote it manually (only CCTV has a Business Brain).`, { title: `Quote ${svc} enquiry manually`, kind: "quote", due: "next_business_day" })];
      }
      // COMMERCIAL AUTHORITY: a sent quote is only revised with Chris; one prepared quote at a time.
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
      return [act("PROPOSE_SITE_VISIT", "approval", "hermes_recommendation", h.reason, { address, timing, standalone })];
    case "PROPOSE_BOOKING":
      return [act("PROPOSE_BOOKING", "approval", "hermes_recommendation", h.reason, { address, timing, standalone })];
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
    case "CALL_CUSTOMER":
      return [act("CALL_CUSTOMER", "auto", "hermes_recommendation", h.reason, { title: h.task?.title ?? null, detail: h.task?.detail ?? null })];
    case "REQUEST_RESEARCH": {
      if (h.research.length) return []; // the research list itself becomes the actions
      const question = h.task?.detail ?? h.task?.title ?? h.reason;
      return [act("REQUEST_RESEARCH", "auto", "hermes_recommendation", h.reason, { question, kind: "other", product: null })];
    }
    case "WAITING_ON_CUSTOMER": {
      const theirs = s.commitments.filter((c) => c.owner === "customer");
      const c = theirs.find((x) => x.dueAt) ?? theirs[0];
      if (!c) return [act("NO_ACTION", "auto", "waiting_on_customer", h.reason)];
      // Check the day after they said they would, unless it is already done by then.
      const check = c.dueAt ? new Date(new Date(c.dueAt).getTime() + 24 * 3600_000).toISOString() : null;
      return [act("PREPARE_FOLLOW_UP", "auto", "waiting_on_customer", `Waiting on the customer: ${c.action}${c.dueText ? ` (${c.dueText})` : ""}.`, { title: `Check: customer said they'd ${c.action.charAt(0).toLowerCase()}${c.action.slice(1)}`, due: check, inDays: 2 })];
    }
    case "NEEDS_REVIEW":
      return [act("NEEDS_REVIEW", "approval", "hermes_flagged", h.reason, { kind: "hermes_flagged", question: h.review_question ?? null })];
    case "NO_ACTION":
      return [act("NO_ACTION", "auto", "hermes_recommendation", h.reason)];
  }
}
