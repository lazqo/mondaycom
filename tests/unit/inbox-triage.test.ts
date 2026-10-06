/** What each email is and what to do (src/lib/inbox/triage.ts), from Hermes's reading. Pure. */
import { describe, it, expect } from "vitest";
import { inTab, triageEmail, type TriageAction, type TriageEmail, type TriageInspection } from "@/lib/inbox/triage";

const email = (over: Partial<TriageEmail> = {}): TriageEmail => ({ classification: "not_lead", classificationError: null, headers: {}, fromName: "Dean Walker", fromAddress: "dean@example.com", subject: "Ajax alarm", lead: null, contact: null, job: null, ...over });
const reading = (over: Partial<TriageInspection> & { hermes?: TriageInspection["hermes"] } = {}): TriageInspection => ({ status: "analysed", reviewKind: null, reviewedById: null, summary: "An alarm enquiry.", hermes: { business_context: "customer_prospect", conversation_type: "new_enquiry", reason: "A clear enquiry." }, ...over });
const action = (type: string, status: string, over: Partial<TriageAction> = {}): TriageAction => ({ id: `a-${type}`, type, status, reason: "", payload: {}, result: null, ...over });

describe("category", () => {
  it("comes from Hermes's business context, or from the bulk-mail headers before Hermes", () => {
    expect(triageEmail(email(), reading(), []).category).toBe("customer");
    expect(triageEmail(email(), reading({ hermes: { business_context: "existing_work" } }), []).category).toBe("work");
    expect(triageEmail(email(), reading({ hermes: { business_context: "supplier_vendor" } }), []).category).toBe("supplier");
    expect(triageEmail(email(), reading({ hermes: { business_context: "service_provider" } }), []).category).toBe("provider");
    expect(triageEmail(email(), reading({ hermes: { business_context: "accounting_payment" } }), []).category).toBe("accounting");
    expect(triageEmail(email(), reading({ hermes: { business_context: "internal_admin" } }), []).category).toBe("internal");
    expect(triageEmail(email(), reading({ hermes: { business_context: "irrelevant", conversation_type: "spam_or_marketing" } }), []).category).toBe("marketing");
    const bulk = triageEmail(email({ headers: { "List-Unsubscribe": "<mailto:x>" } }), null, []);
    expect(bulk).toMatchObject({ category: "marketing", headline: "Filed: bulk mail", tone: "quiet" });
    expect(triageEmail(email({ headers: { "auto-submitted": "auto-replied" } }), null, [])).toMatchObject({ category: "other", headline: "Filed: automated mail" });
    expect(triageEmail(email({ classification: "reading" }), null, [])).toMatchObject({ category: "reading", headline: "Hermes is reading", tone: "info" });
  });
});

describe("the state of play", () => {
  it("needs you: the review question, decided from the row", () => {
    const t = triageEmail(email({ classification: "needs_review" }), reading({ status: "needs_review", reviewKind: "hermes_low_confidence", hermes: { business_context: "customer_prospect", review_question: "Is this worth a reply?" } }), [action("NEEDS_REVIEW", "awaiting_approval")]);
    expect(t).toMatchObject({ headline: "Needs you: Is this worth a reply?", tone: "attention", needsReview: true, category: "customer" });
    expect(inTab(t, "attention")).toBe(true);
    // Who-is-this reviews are decided on Home, not with the lead / not-a-lead buttons.
    expect(triageEmail(email({ classification: "needs_review" }), reading({ status: "needs_review", reviewKind: "identity" }), []).needsReview).toBe(false);
  });
  it("a proposal waiting: decide, directly when no time slot is needed", () => {
    const visit = triageEmail(email({ classification: "lead", lead: { name: "Dean Walker" } }), reading(), [action("PROPOSE_SITE_VISIT", "awaiting_approval", { reason: "Commercial CCTV needs a look.", payload: { slots: [{}] } })]);
    expect(visit).toMatchObject({ headline: "Decide: pencil in the site visit", tone: "attention", decision: { type: "PROPOSE_SITE_VISIT", direct: false } });
    const link = triageEmail(email(), reading({ hermes: { business_context: "existing_work" } }), [action("PROPOSE_LINK_SENDER", "awaiting_approval")]);
    expect(link.decision).toMatchObject({ direct: true, label: "link the sender" });
    expect(link.headline).toBe("Decide: link the sender");
  });
  it("a question Hermes asked points at Home", () => {
    const t = triageEmail(email({ classification: "lead", lead: { name: "Dean Walker" } }), reading(), [action("ASK_CHRIS", "awaiting_approval", { payload: { question: "Which panel?" } })]);
    expect(t).toMatchObject({ headline: "Hermes asks: Which panel?", question: "Which panel?", tone: "attention" });
  });
  it("what Hermes did: a new lead with the task it made; a task on a known record; a promise kept", () => {
    const lead = triageEmail(email({ classification: "lead", lead: { name: "Dean Walker" } }), reading(), [action("CREATE_INTERNAL_TASK", "done", { payload: { title: "Ring about the alarm" }, result: { title: "Ring about the alarm", taskId: "t" } })]);
    expect(lead).toMatchObject({ headline: "New lead", detail: "Dean Walker · Task: Ring about the alarm", tone: "done" });
    const work = triageEmail(email({ classification: "existing", contact: { name: "Hana Ruatapu" } }), reading({ hermes: { business_context: "existing_work" } }), [action("CREATE_SERVICE_CASE", "done", { payload: { title: "Service case: Hana" } })]);
    expect(work).toMatchObject({ category: "work", headline: "Task: Service case: Hana", detail: "on Hana Ruatapu" });
    const kept = triageEmail(email({ classification: "existing", lead: { name: "Dean Walker" } }), reading(), [action("RESOLVE_COMMITMENT", "done", { payload: { action: "send the photos" } })]);
    expect(kept.headline).toBe("Promise kept: send the photos");
  });
  it("nothing to do, with Hermes's reason; not a lead when a person decided", () => {
    const statement = triageEmail(email({ classification: "not_lead" }), reading({ hermes: { business_context: "supplier_vendor", reason: "A supplier's delivery note." } }), [action("NO_ACTION", "done")]);
    expect(statement).toMatchObject({ category: "supplier", headline: "Nothing to do", detail: "A supplier's delivery note.", tone: "quiet" });
    const decided = triageEmail(email({ classification: "not_lead" }), reading({ reviewedById: "u1" }), []);
    expect(decided.headline).toBe("Not a lead (you decided)");
    expect(inTab(decided, "customer")).toBe(true);
    expect(inTab(decided, "attention")).toBe(false);
  });
  it("could not read it waits for a person", () => {
    expect(triageEmail(email({ classification: "error", classificationError: "timeout" }), null, [])).toMatchObject({ headline: "Could not read it", detail: "timeout", tone: "attention" });
  });
});
