/**
 * Recommended actions, by Get Secure's fixed rules. Every action says which rule produced it.
 * The Inspector recommends and routes; the Business Brain still designs and prices, and anything
 * customer-facing waits for Chris. Pure.
 */
import { sitePath, type Known } from "./missing";
import type { ActionType, IdentityResult, InspectorInput, PlannedAction, Understanding } from "./types";

export type CrmState = {
  leadId: string | null;
  contactId: string | null;
  jobId: string | null;
  leadStatus: string | null;
  /** An unsent quote the Business Brain prepared already exists for this lead. */
  hasOpenBrainQuote: boolean;
  hasSentQuote: boolean;
  hasOpenJob: boolean;
  /** The recording is already filed against this lead/customer. */
  recordingLinked: boolean;
  /** How many facts this source adds or changes. */
  newFacts: number;
  /** Customer contact details the CRM holds. */
  customerEmail: string | null;
  customerPhone: string | null;
};

const act = (type: ActionType, mode: PlannedAction["mode"], rule: string, reason: string, payload: Record<string, unknown> = {}): PlannedAction => ({ type, mode, rule, reason, payload });

export function planActions(input: InspectorInput, u: Understanding, identity: IdentityResult, known: Known, crm: CrmState): PlannedAction[] {
  const out: PlannedAction[] = [];

  // 1. Not sure who it is: nothing customer-specific happens until Chris confirms.
  if (identity.status === "needs_review") {
    out.push(act("NEEDS_REVIEW", "approval", "identity_uncertain", identity.reason, { candidates: identity.candidates.slice(0, 5).map((c) => ({ leadId: c.leadId, contactId: c.contactId, label: c.label, score: c.score, signals: c.signals })) }));
    if (input.sourceType === "recording") out.push(act("LINK_RECORDING", "approval", "identity_uncertain", "File the recording once Chris confirms who it is with."));
    return out;
  }
  if (u.primaryIntent === "not_relevant" && !u.commitments.length && !u.facts.length) {
    return [act("NO_ACTION", "auto", "nothing_to_act_on", "Nothing in it needs a next step.")];
  }

  // 2. Always: the record of what was understood, and filing the recording.
  out.push(act("ADD_INTERNAL_NOTE", "auto", "always_note", "Summary of what the Inspector read.", { summary: u.summary }));
  if (input.sourceType === "recording" && !crm.recordingLinked && identity.status === "matched") {
    out.push(act("LINK_RECORDING", "auto", "identity_matched", identity.reason));
  }
  if (crm.newFacts > 0) out.push(act("PROPOSE_LEAD_FACT_UPDATE", "auto", "new_facts", `${crm.newFacts} fact${crm.newFacts > 1 ? "s" : ""} read from this ${input.sourceType === "email" ? "email" : "conversation"}. Blank fields are filled; anything that differs from the CRM is flagged for Chris, never overwritten.`));

  // Our own outgoing emails: only commitments (handled when stored) and the note.
  if (input.direction === "outbound") return out;

  const blocking = u.missing.filter((m) => m.blocking && m.for === "quote");
  const svc = String(known.service ?? u.service ?? "") || null;
  const path = sitePath(u, known);
  const has = (i: Understanding["intents"][number]) => u.intents.includes(i);
  const gsQuotePromise = u.commitments.find((c) => c.owner === "get_secure" && c.actionKey === "send_quote");
  const callRequested = /\b(call me|give me a (call|ring|bell)|ring me|phone me|can you call)\b/i.test(input.text);

  // 3. Problems with an existing system: a service case, never a sales quote.
  if (has("service_issue")) {
    out.push(act("CREATE_SERVICE_CASE", "auto", "service_issue", "The customer reports a problem with an existing system.", { urgency: u.urgency }));
    if (u.urgency === "urgent" || u.urgency === "high") out.push(act("CALL_CUSTOMER", "auto", "urgent_service_issue", "Urgent service problem: call rather than email."));
    return out;
  }

  // 4. Acceptance: Chris confirms the terms; nothing is accepted automatically.
  if (has("acceptance")) {
    out.push(act("CREATE_INTERNAL_TASK", "auto", "customer_accepted", "The customer says they want to go ahead. Chris confirms and marks the quote accepted (the CRM never accepts terms itself).", { title: "Customer wants to go ahead: confirm and mark the quote accepted", kind: "task", due: "today" }));
    out.push(act("PROPOSE_BOOKING", "approval", "customer_accepted", "Book the installation once Chris has confirmed.", { timing: u.timing[0]?.text ?? null }));
    return out;
  }

  // 5. Objections: a person deals with them.
  if (has("objection")) {
    const kinds = u.objections.map((o) => o.kind);
    if ((kinds.includes("price") || kinds.includes("competitor") || kinds.includes("scope")) && (crm.hasSentQuote || crm.hasOpenBrainQuote)) {
      out.push(act("PREPARE_REVISED_QUOTE", "approval", "price_objection", "The customer pushed back on the quote. Chris decides whether to revise it (no automatic discount).", { objections: u.objections }));
      out.push(act("CALL_CUSTOMER", "auto", "price_objection", "A price objection is best handled by phone.", {}));
    } else if (kinds.includes("undecided") || kinds.includes("timing")) {
      out.push(act("PREPARE_FOLLOW_UP", "auto", "customer_undecided", kinds.includes("timing") ? "The customer is not ready yet: follow up later." : "The customer is thinking about it: follow up in a few days.", { inDays: kinds.includes("timing") ? 21 : 3 }));
    } else {
      out.push(act("CALL_CUSTOMER", "auto", "objection", "The customer raised a concern."));
    }
    return out;
  }

  // 6. Changes to an existing quote.
  if (has("quote_change") && (crm.hasOpenBrainQuote || crm.hasSentQuote)) {
    out.push(act("PREPARE_REVISED_QUOTE", "approval", "quote_change_requested", "The customer asked for a change to the quote. Accepting re-runs the Business Brain with the updated facts and prepares a revised quote for approval."));
    return out;
  }

  // 7. Site visit first: commercial CCTV, or the customer asked for one.
  if (path.siteVisit) {
    out.push(act("PROPOSE_SITE_VISIT", "approval", path.rule!, path.reason!, { address: known.site_address ?? null, timing: u.timing[0]?.text ?? null }));
    if (u.missing.some((m) => m.blocking && m.for === "site visit")) out.push(act("DRAFT_EMAIL", "auto", "site_visit_needs_address", "Ask for the site address so the visit can be arranged.", { ask: u.missing.filter((m) => m.blocking && m.for === "site visit").map((m) => m.label) }));
    return out;
  }

  // 8. Residential CCTV wanting a price.
  const wantsQuote = has("new_enquiry") || has("quote_request") || !!gsQuotePromise;
  if (svc === "cctv" && wantsQuote) {
    if (blocking.length) {
      const ask = blocking.map((m) => m.label);
      if ((crm.customerPhone || known.phone) && (u.urgency === "urgent" || u.urgency === "high" || blocking.length >= 3 || callRequested)) {
        out.push(act("CALL_CUSTOMER", "auto", "blocking_info_call", `Before a quote: ${ask.join("; ")}. Quicker to ask by phone.`, { ask }));
      } else {
        out.push(act("DRAFT_EMAIL", "auto", "ask_blocking_only", `Before a quote, only this is needed: ${ask.join("; ")}. Nothing else is asked.`, { ask }));
      }
    } else if (crm.hasOpenBrainQuote && crm.newFacts === 0) {
      out.push(act("NO_ACTION", "auto", "quote_already_prepared", "A quote is already prepared for this lead and nothing new was learned."));
    } else {
      out.push(act("RUN_BUSINESS_BRAIN", "auto", "quote_ready", "Everything the Business Brain needs is known."));
      out.push(act("PREPARE_QUOTE", "auto", "quote_ready", gsQuotePromise ? `Chris said: "${gsQuotePromise.evidence}"` : "The customer wants a price and nothing blocking is missing. The quote and reply wait for Chris's approval."));
    }
  } else if (svc && svc !== "cctv" && (has("new_enquiry") || has("quote_request"))) {
    // 9. Other services: no Brain yet, so a person quotes them.
    out.push(act("CREATE_INTERNAL_TASK", "auto", "manual_quote_service", `${svc.replace("_", " ")} enquiry: quote it manually (only CCTV has a Business Brain).`, { title: `Quote ${svc.replace("_", " ")} enquiry manually`, kind: "task", due: "next_business_day" }));
  }

  // 10. A time asked for, outside the quote path.
  if (has("booking_request") && !out.some((a) => a.type === "PROPOSE_BOOKING")) out.push(act("PROPOSE_BOOKING", "approval", "booking_requested", "The customer asked about a time. Chris proposes or confirms it (nothing is confirmed automatically).", { timing: u.timing[0]?.text ?? null }));
  if (callRequested && !out.some((a) => a.type === "CALL_CUSTOMER")) out.push(act("CALL_CUSTOMER", "auto", "call_requested", "The customer asked to be called."));
  if (has("follow_up")) out.push(act("CREATE_INTERNAL_TASK", "auto", "customer_chasing", "The customer is chasing a reply.", { title: "Customer is chasing: reply today", kind: "task", due: "today" }));
  if (has("question") && out.length <= 2) out.push(act("CREATE_INTERNAL_TASK", "auto", "question_needs_reply", "The customer asked a question that needs a person to answer.", { title: "Reply to the customer's question", kind: "task", due: "next_business_day" }));
  if (out.every((a) => ["ADD_INTERNAL_NOTE", "PROPOSE_LEAD_FACT_UPDATE", "LINK_RECORDING"].includes(a.type)) && !u.commitments.length) out.push(act("NO_ACTION", "auto", "nothing_further", "Recorded; no next step needed."));
  return out;
}

/** The reply that asks only the blocking questions (a draft for Chris, never sent by itself). */
export function composeQuestionsEmail(firstName: string | null, ask: string[], subject: string | null): { subject: string; body: string } {
  const qs: Record<string, string> = {
    "Home or business": "Is this for your home or for a business?",
    "How many cameras, or which areas to cover": "Roughly how many cameras are you after, or which areas would you like covered (for example driveway, front door, back yard)?",
    "Single or double storey": "Is the house single or double storey?",
    "Existing cable type and condition": "Do you know what cabling the current cameras use (network cable such as Cat5/Cat6, or coax), and is it in good condition?",
    "Site address": "What's the address of the property?",
    "What they want (CCTV, alarm, access…)": "Could you tell me a bit more about what you're after (cameras, alarm, access control…)?",
  };
  const lines = ask.map((a) => `- ${qs[a] ?? a}`);
  const body = [`Hi ${firstName?.split(/\s+/)[0] ?? "there"},`, "", "Thanks for getting in touch. So I can put an accurate quote together, could you let me know:", "", ...lines, "", "Thanks,", "Chris", "Get Secure"].join("\n");
  const subj = subject ? (/^re:/i.test(subject) ? subject : `Re: ${subject}`) : "Your enquiry";
  return { subject: subj, body };
}
