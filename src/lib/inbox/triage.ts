/**
 * What each email is and what to do about it, from Hermes's reading: a category Chris reads at a
 * glance (customer, existing work, supplier, provider, accounting, marketing, internal, other),
 * a headline that says the state of play ("Needs you: …", "Decide: pencil in the site visit",
 * "New lead", "Task: …", "Nothing to do"), and the one decision it waits on, if any. The filing
 * labels ("lead", "not a lead", "existing") are the mechanics underneath, not the headline.
 *
 * Plain module (server and client): no database.
 */
import type { EmailClassification } from "@/lib/constants";
import { isAutomatedMail } from "@/lib/email/parse";
import { ACTION_LABELS, REVIEW_KIND_LABELS } from "@/lib/inspector/labels";
import type { ActionType } from "@/lib/inspector/types";
import { type EmailCategory, type Triage } from "./categories";

export { CATEGORY_META, INBOX_TABS, LEGACY_TABS, inTab, type EmailCategory, type InboxTab, type Triage } from "./categories";

export type TriageEmail = {
  classification: EmailClassification;
  classificationError: string | null;
  headers: Record<string, string>;
  fromName: string | null;
  fromAddress: string;
  subject: string;
  lead?: { name: string } | null;
  contact?: { name: string } | null;
  job?: { number: number } | null;
};

export type TriageInspection = {
  status: string;
  reviewKind: string | null;
  /** Set when a person decided the review. */
  reviewedById: string | null;
  summary: string;
  hermes: { business_context?: string; conversation_type?: string; intent?: string; reason?: string; review_question?: string | null; summary?: string } | null;
};

export type TriageAction = { id: string; type: string; status: string; reason: string; payload: Record<string, unknown>; result: Record<string, unknown> | null };

const CONTEXT_CATEGORY: Record<string, EmailCategory> = {
  customer_prospect: "customer",
  existing_work: "work",
  supplier_vendor: "supplier",
  service_provider: "provider",
  accounting_payment: "accounting",
  internal_admin: "internal",
  irrelevant: "other",
  unknown: "other",
};

const DECISION_LABELS: Partial<Record<ActionType, string>> = {
  PROPOSE_SITE_VISIT: "pencil in the site visit",
  PROPOSE_BOOKING: "pencil in the booking",
  PREPARE_QUOTE: "approve the quote",
  PREPARE_REVISED_QUOTE: "prepare the revised quote",
  DRAFT_EMAIL: "approve the reply",
  PREPARE_FOLLOW_UP: "approve the follow-up",
  PROPOSE_LINK_SENDER: "link the sender",
  PROPOSE_LEAD_FACT_UPDATE: "check the lead's details",
};
/** Accepting these needs no further choice from Chris. */
const DIRECT: ActionType[] = ["PREPARE_REVISED_QUOTE", "PROPOSE_LINK_SENDER"];
const IDENTITY: string[] = ["NEEDS_REVIEW", "LINK_RECORDING"];

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

function categoryOf(email: TriageEmail, ins: TriageInspection | null, automated: string | null): EmailCategory {
  if (automated) return /unsubscribe|bulk/.test(automated) ? "marketing" : "other";
  const h = ins?.hermes;
  if (h?.conversation_type === "spam_or_marketing") return "marketing";
  if (h?.business_context && CONTEXT_CATEGORY[h.business_context]) {
    const c = CONTEXT_CATEGORY[h.business_context];
    if (c !== "other" || h.business_context === "irrelevant") return c;
  }
  if (email.classification === "lead") return "customer";
  if (email.classification === "existing") return email.job ? "work" : "customer";
  if (email.classification === "reading" || email.classification === "pending") return "reading";
  if (h) return "other";
  return email.classification === "needs_review" || email.classification === "error" ? "reading" : "other";
}

/** What Hermes did, from the actions it carried out: the one line that matters most. */
function didWhat(actions: TriageAction[]): string | null {
  const done = actions.filter((a) => a.status === "done");
  const title = (a: TriageAction) => str(a.result?.title) ?? str(a.payload.title) ?? null;
  const task = done.find((a) => ["CREATE_INTERNAL_TASK", "CALL_CUSTOMER", "PREPARE_FOLLOW_UP", "CREATE_SERVICE_CASE"].includes(a.type));
  if (task) return `Task: ${title(task) ?? ACTION_LABELS[task.type as ActionType] ?? "created"}`;
  const kept = done.find((a) => a.type === "RESOLVE_COMMITMENT");
  if (kept) return `Promise kept: ${str(a(kept, "action")) ?? "noted"}`;
  const booked = done.find((a) => a.type === "PROPOSE_SITE_VISIT" || a.type === "PROPOSE_BOOKING");
  if (booked) return "Pencilled in";
  const brain = done.find((a) => a.type === "RUN_BUSINESS_BRAIN");
  if (brain) return "Business Brain ran";
  const research = done.find((a) => a.type === "REQUEST_RESEARCH");
  if (research) return "Research requested";
  const note = done.find((a) => a.type === "ADD_INTERNAL_NOTE");
  if (note) return "Noted on the record";
  return null;
}
const a = (x: TriageAction, k: string) => x.payload[k] ?? x.result?.[k];

export function triageEmail(email: TriageEmail, ins: TriageInspection | null, actions: TriageAction[]): Triage {
  const automated = isAutomatedMail({ headers: email.headers ?? {}, from: { name: email.fromName, address: email.fromAddress }, subject: email.subject });
  const category = categoryOf(email, ins, automated);
  const h = ins?.hermes ?? null;
  const base = { category, needsReview: false, decision: null, question: null } as const;
  const filed = email.lead ? email.lead.name : email.contact ? email.contact.name : email.job ? `J-${email.job.number}` : null;

  if (email.classification === "error") return { ...base, headline: "Could not read it", detail: email.classificationError ?? "Hermes was not reachable; it will be read again", tone: "attention" };
  if (automated && !ins) return { ...base, headline: category === "marketing" ? "Filed: bulk mail" : "Filed: automated mail", detail: automated, tone: "quiet" };
  if (!ins) {
    if (email.classification === "reading" || email.classification === "pending") return { ...base, headline: "Hermes is reading", detail: null, tone: "info" };
    if (email.classification === "existing") return { ...base, headline: filed ? `Filed on ${filed}` : "Filed on the thread", detail: "reply on a known thread", tone: "done" };
    if (email.classification === "lead") return { ...base, headline: "New lead", detail: filed, tone: "done" };
    if (email.classification === "not_lead") return { ...base, headline: "Not a lead", detail: "decided before Hermes read it", tone: "quiet" };
    return { ...base, headline: "Waiting", detail: null, tone: "info" };
  }

  const awaiting = actions.filter((x) => x.status === "awaiting_approval");
  const question = awaiting.find((x) => x.type === "ASK_CHRIS");
  const proposal = awaiting.find((x) => x.type !== "ASK_CHRIS" && !IDENTITY.includes(x.type));
  const did = didWhat(actions);

  if (ins.status === "needs_review") {
    const why = str(h?.review_question) ?? (ins.reviewKind ? (REVIEW_KIND_LABELS[ins.reviewKind] ?? ins.reviewKind) : null) ?? "needs a look";
    return { ...base, headline: `Needs you: ${why}`, detail: str(h?.summary) ?? ins.summary ?? null, tone: "attention", needsReview: ins.reviewKind !== "identity" };
  }
  if (proposal) {
    const label = DECISION_LABELS[proposal.type as ActionType] ?? (ACTION_LABELS[proposal.type as ActionType] ?? proposal.type).toLowerCase();
    return { ...base, headline: `Decide: ${label}`, detail: proposal.reason || null, tone: "attention", decision: { actionId: proposal.id, type: proposal.type, label, direct: DIRECT.includes(proposal.type as ActionType) && !proposal.payload.slots } };
  }
  if (question) return { ...base, headline: `Hermes asks: ${str(question.payload.question) ?? "a question"}`, detail: did, tone: "attention", question: str(question.payload.question) ?? "a question" };

  if (email.classification === "lead") return { ...base, headline: "New lead", detail: [filed, did].filter(Boolean).join(" · ") || null, tone: "done" };
  if (email.classification === "not_lead" && ins.reviewedById) return { ...base, headline: "Not a lead (you decided)", detail: did, tone: "quiet" };
  if (did) return { ...base, headline: did, detail: filed ? `on ${filed}` : (str(h?.reason) ?? null), tone: "done" };
  if (email.classification === "existing" && filed) return { ...base, headline: `Filed on ${filed}`, detail: str(h?.reason) ?? null, tone: "done" };
  if (email.classification === "not_lead") return { ...base, headline: "Nothing to do", detail: str(h?.reason) ?? null, tone: "quiet" };
  return { ...base, headline: "Nothing to do", detail: str(h?.reason) ?? null, tone: "quiet" };
}

