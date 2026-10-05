/**
 * The Hermes contract and the validator, without a database: what Hermes may say, and what the
 * CRM's hard guardrails, business rules and advisory checks make of it.
 */
import { describe, it, expect } from "vitest";
import { parseHermesResult, HermesOutputError, type HermesResult } from "@/lib/hermes/contract";
import { evidenceFound, normaliseFact, replyProblem, sourceHaystack, validateHermes, type ValidateContext } from "@/lib/inspector/validate";
import type { IdentityResult, InspectorInput } from "@/lib/inspector/types";

const AT = new Date("2026-10-07T01:00:00Z"); // 2pm Wednesday 7 Oct, Auckland
const input = (text: string, over: Partial<InspectorInput> = {}): InspectorInput => ({
  sourceType: "email",
  sourceId: "00000000-0000-0000-0000-000000000001",
  direction: "inbound",
  at: AT,
  title: "Enquiry",
  text,
  utterances: [],
  from: { name: "Aroha", email: "aroha@example.com", phone: null },
  context: [],
  linked: { leadId: "L1", contactId: null, jobId: null, how: "the email thread" },
  ...over,
});
const matched: IdentityResult = { status: "matched", chosen: { leadId: "L1", contactId: null, jobId: null, label: "Aroha", score: 0.95, signals: [{ kind: "thread", detail: "thread", weight: 0.95 }] }, candidates: [], confidence: 0.95, reason: "thread" };
const ctx = (i: InspectorInput, over: Partial<ValidateContext> = {}): ValidateContext => ({
  input: i,
  identity: matched,
  known: {},
  crm: { leadId: "L1", contactId: null, hasOpenBrainQuote: false, hasSentQuote: false, recordingLinked: false, customerEmail: "aroha@example.com", customerPhone: null },
  minConfidence: 0.6,
  rules: null,
  ...over,
});
const H = (over: Partial<HermesResult>): HermesResult =>
  parseHermesResult(JSON.stringify({ conversation_type: "new_enquiry", intent: "new_enquiry", service: "cctv", property_type: "residential", summary: "s", recommended_action: "NO_ACTION", confidence: 0.9, reason: "r", ...over }));
const types = (v: { plan: { type: string }[] }) => v.plan.map((p) => p.type);

describe("the contract", () => {
  it("takes JSON from a code fence or prose, and fills the optional parts", () => {
    const r = parseHermesResult('Here it is:\n```json\n{"conversation_type":"new_enquiry","intent":"quote_request","summary":"x","recommended_action":"PREPARE_QUOTE","confidence":0.9,"reason":"r","service":null}\n```');
    expect(r).toMatchObject({ recommended_action: "PREPARE_QUOTE", facts: [], missing: [], identity: { suggestion: "unknown" } });
  });
  it("refuses anything outside the contract", () => {
    expect(() => parseHermesResult("I think it's a lead")).toThrow(HermesOutputError);
    expect(() => parseHermesResult('{"conversation_type":"new_enquiry","intent":"quote_request","summary":"x","recommended_action":"SEND_EMAIL","confidence":0.9,"reason":"r"}')).toThrow(/recommended_action/);
    expect(() => parseHermesResult('{"conversation_type":"new_enquiry","intent":"quote_request","summary":"x","recommended_action":"NO_ACTION","confidence":1.7,"reason":"r"}')).toThrow(/confidence/);
  });
});

describe("hard guardrails", () => {
  it("facts need evidence from the source, and a sane value", () => {
    const hay = sourceHaystack(input("We'd like 3 cameras for our two storey house."));
    expect(evidenceFound("3 cameras", hay)).toBe(true);
    expect(evidenceFound("two-storey house", hay)).toBe(true);
    expect(evidenceFound("eight cameras on the shed", hay)).toBe(false);
    expect(normaliseFact("camera_count", "three")).toMatchObject({ value: 3 });
    expect(normaliseFact("camera_count", 500)).toBeNull();
    expect(normaliseFact("storeys", "double storey")).toMatchObject({ value: 2 });
    expect(normaliseFact("property_type", "Residential Home")).toMatchObject({ value: "residential" });
    expect(normaliseFact("email", "not an email")).toBeNull();
  });

  it("website form fields count as evidence", () => {
    const hay = sourceHaystack(input("PropertyResidential HomeCameras2", { form: { fields: { Property: "Residential Home", Cameras: "2", Storeys: "Double storey" }, name: "I", email: null, phone: null, service: "CCTV", address: null } }));
    expect(evidenceFound("Cameras: 2", hay)).toBe(true);
    expect(evidenceFound("Storeys: Double storey", hay)).toBe(true);
  });

  it("a prepared reply may not quote a price, a discount or a date", () => {
    expect(replyProblem("A 4 camera system is about $1,890.")).toMatch(/price/);
    expect(replyProblem("It would be 1890 NZD all up")).toMatch(/price/);
    expect(replyProblem("We can do 10% off this month")).toMatch(/discount/);
    expect(replyProblem("We'll be there on Tuesday at 9am to install")).toMatch(/date/);
    expect(replyProblem("Thanks! Chris will put a quote together and be in touch.")).toBeNull();
  });

  it("identity: Hermes's suggestion never files anything; uncertain identity goes to Chris", () => {
    const i = input("Hemi Walker here, 4 cameras please");
    const v = validateHermes(H({ recommended_action: "PREPARE_QUOTE", identity: { suggestion: "candidate", candidate_key: "lead:L9", reason: "same name" } }), ctx(i, { identity: { status: "needs_review", chosen: null, candidates: [], confidence: 0.2, reason: "Only name evidence." } }));
    expect(types(v)).toEqual(["NEEDS_REVIEW"]);
    expect(v.reviewKind).toBe("identity");
    expect(v.plan[0].payload).toMatchObject({ hermesSuggestion: { key: "lead:L9" } });
  });

  it("an enquiry closed without CRM evidence goes to Chris; low confidence waits for Chris with the plan attached", () => {
    const i = input("Interested in cameras");
    expect(validateHermes(H({ recommended_action: "NO_ACTION" }), ctx(i)).reviewKind).toBe("hermes_flagged");
    const low = validateHermes(H({ intent: "follow_up", conversation_type: "existing_lead", recommended_action: "CREATE_INTERNAL_TASK", task: { title: "Ring", due: null, detail: null }, confidence: 0.3 }), ctx(i));
    expect(low.reviewKind).toBe("hermes_low_confidence");
    expect((low.plan.find((p) => p.type === "NEEDS_REVIEW")!.payload.plan as { type: string }[]).map((p) => p.type)).toEqual(["CREATE_INTERNAL_TASK"]);
  });

  describe("Hermes decides whether a matter is resolved; the CRM only checks the evidence is real", () => {
    const old = input("Hi, we'd like a quote for cameras at the house.");
    const withRefs = (refs: string[]) => ctx(old, { citable: refs });

    it("Hermes closes an old enquiry citing a completed job in the record: 'no action' stands", () => {
      const v = validateHermes(H({ recommended_action: "NO_ACTION", resolution: { status: "resolved", evidence: [{ ref: "job:J1", note: "J-1008 completed and invoiced" }] } }), withRefs(["job:J1"]));
      expect(v.reviewKind).toBeNull();
      expect(v.headline).toMatchObject({ final: "NO_ACTION", changedBy: null });
      expect(v.hard.find((c) => c.rule === "enquiry_closed_with_evidence")!.message).toContain("job:J1");
    });

    it("evidence that is not a record in this context does not count", () => {
      const v = validateHermes(H({ recommended_action: "NO_ACTION", resolution: { status: "resolved", evidence: [{ ref: "job:made-up", note: "" }] } }), withRefs(["job:J1"]));
      expect(v.reviewKind).toBe("hermes_flagged");
      expect(v.headline.changedBy).toBe("enquiry_close_needs_evidence");
    });

    it("Hermes marks a commitment kept when the record shows it; a made-up ref is refused", () => {
      const refs = ["commitment:C1", "job:J1"];
      const ok = validateHermes(H({ intent: "follow_up", conversation_type: "existing_lead", recommended_action: "CREATE_INTERNAL_TASK", task: { title: "x", due: null, detail: null }, commitment_updates: [{ id: "C1", status: "done", evidence_ref: "job:J1", note: "The install was done." }] }), withRefs(refs));
      expect(ok.plan.find((p) => p.type === "RESOLVE_COMMITMENT")).toMatchObject({ payload: { commitmentId: "C1", status: "done", evidenceRef: "job:J1" } });
      const bad = validateHermes(H({ intent: "follow_up", conversation_type: "existing_lead", recommended_action: "CREATE_INTERNAL_TASK", task: { title: "x", due: null, detail: null }, commitment_updates: [{ id: "C1", status: "done", evidence_ref: "job:J9", note: "" }, { id: "C7", status: "done", evidence_ref: "job:J1", note: "" }] }), withRefs(refs));
      expect(bad.plan.find((p) => p.type === "RESOLVE_COMMITMENT")).toBeUndefined();
      expect(bad.hard.filter((c) => c.rule === "commitment_update_evidence")).toHaveLength(2);
    });

    it("Hermes's own task for pricing is carried out as Hermes said (no CRM re-interpretation)", () => {
      const v = validateHermes(H({ intent: "follow_up", conversation_type: "existing_lead", recommended_action: "CREATE_INTERNAL_TASK", task: { title: "Price the quote / complete costing for Q-1006", due: "today", detail: null } }), ctx(input("Any update on my quote?")));
      expect(v.plan.find((p) => p.type === "CREATE_INTERNAL_TASK")).toMatchObject({ payload: { title: "Price the quote / complete costing for Q-1006", kind: "quote" } });
      expect(v.reviewKind).toBeNull();
    });
  });

  describe("the sender's identity is guarded; the work can continue in an evidenced context", () => {
    const unknown: IdentityResult = { status: "needs_review", chosen: null, candidates: [], confidence: 0.2, reason: "Nobody with this email or phone." };
    const zavier = input("Hi, the keypad at 138 Wiri Station Road is beeping again. Zavier", { from: { name: "Zavier", email: "zavier@example.com", phone: null } });
    const h = H({ intent: "service_issue", conversation_type: "existing_job", recommended_action: "CREATE_INTERNAL_TASK", task: { title: "Check the keypad at 138 Wiri Station Road", due: "today", detail: null }, operational_context: { ref: "lead:L2", reason: "same site" }, facts: [{ key: "site_address", value: "138 Wiri Station Road", evidence: "138 Wiri Station Road", confidence: 0.9 }] });

    it("Zavier: accepted context → the task runs there, facts are only proposed, and no 'Who is this?'", () => {
      const v = validateHermes({ ...h, business_context: "existing_work", lead_decision: "existing" }, ctx(zavier, { identity: unknown, context: { ref: "lead:L2", label: "Wiri Depot (138 Wiri Station Road)", leadId: "L2", jobId: null, contactId: "K2", accepted: true, why: "the message names the site" } }));
      expect(v.workContext).toMatchObject({ leadId: "L2" });
      expect(v.personVerified).toBe(false);
      expect(types(v)).toEqual(expect.arrayContaining(["CREATE_INTERNAL_TASK", "PROPOSE_LEAD_FACT_UPDATE"]));
      expect(types(v)).not.toContain("NEEDS_REVIEW");
      expect(v.plan.find((p) => p.type === "PROPOSE_LEAD_FACT_UPDATE")!.payload.proposeOnly).toBe(true);
      expect(v.reviewKind).toBeNull();
      expect(v.hard.map((c) => c.rule)).toContain("sender_unverified");
    });

    it("existing work the message does not evidence (a name alone): the work needs the customer, so 'Who is this?'", () => {
      const v = validateHermes({ ...h, business_context: "existing_work", lead_decision: "existing" }, ctx(zavier, { identity: unknown, context: { ref: "lead:L2", label: "Wiri Depot", leadId: "L2", jobId: null, contactId: "K2", accepted: false, why: "the message does not show its site" } }));
      expect(v.workContext).toBeNull();
      expect(types(v)).toEqual(["NEEDS_REVIEW"]);
      expect(v.reviewKind).toBe("identity");
    });

    it("supplier, provider and accounting mail from an unknown sender: routed by context, never 'Who is this?'", () => {
      for (const [bc, title] of [
        ["accounting_payment", "Check the Dicker Data statement"],
        ["service_provider", "Check the Alarm Watch statement"],
        ["supplier_vendor", "File the supplier price list"],
      ] as const) {
        const v = validateHermes(
          H({ intent: "information", conversation_type: "supplier", business_context: bc, counterparty: { name: "Dicker Data", kind: "supplier" }, accounting: bc === "accounting_payment" ? { document: "statement", reference: "Oct 2026", amount: 1234.5, due: null } : null, recommended_action: "CREATE_INTERNAL_TASK", task: { title, due: null, detail: null } }),
          ctx(input("Please find your statement attached."), { identity: unknown }),
        );
        expect(v.reviewKind).toBeNull();
        expect(types(v)).toContain("CREATE_INTERNAL_TASK");
        expect(types(v)).not.toContain("NEEDS_REVIEW");
      }
    });

    it("a prospect whose quote needs the customer record, with only a name to go on: 'Who is this?'", () => {
      const v = validateHermes(
        H({ business_context: "customer_prospect", lead_decision: "existing", recommended_action: "PREPARE_QUOTE", facts: [{ key: "camera_count", value: 4, evidence: "4 cameras", confidence: 0.9 }, { key: "storeys", value: 1, evidence: "single storey", confidence: 0.9 }] }),
        ctx(input("4 cameras for the single storey house please"), { identity: unknown }),
      );
      expect(v.reviewKind).toBe("identity");
      expect(types(v)).toEqual(["NEEDS_REVIEW"]);
    });

    it("Hermes may ask Chris to confirm the sender without holding the work up", () => {
      const v = validateHermes(
        H({ intent: "service_issue", conversation_type: "existing_job", business_context: "existing_work", recommended_action: "CREATE_INTERNAL_TASK", task: { title: "Check keypad", due: null, detail: null }, identity_review: { needed: true, reason: "Says they are the new owner." } }),
        ctx(zavier, { identity: unknown, context: { ref: "lead:L2", label: "Wiri Depot", leadId: "L2", jobId: null, contactId: "K2", accepted: true, why: "the message names the site" } }),
      );
      expect(v.reviewKind).toBe("identity");
      expect(types(v)).toEqual(expect.arrayContaining(["CREATE_INTERNAL_TASK", "NEEDS_REVIEW"]));
    });

    it("not a lead and nothing to do: nothing filed, no identity question", () => {
      const v = validateHermes(H({ intent: "not_relevant", conversation_type: "spam_or_marketing", lead_decision: "not_lead", recommended_action: "NO_ACTION" }), ctx(input("Buy SEO services"), { identity: unknown }));
      expect(v.plan).toEqual([]);
      expect(v.reviewKind).toBeNull();
    });
  });

  it("Andre: a name from the website form is sourced evidence ('Name: Andre Bunton')", () => {
    const form = { fields: { Property: "Commercial", Service: "CCTV Installation" }, name: "Andre Bunton", email: "andre@example.com", phone: "021 555 0101", service: "CCTV", address: "5 Depot Road, Penrose" };
    const i = input("New Lead · CCTV Landing\n\nANDRE BUNTON\n\nPhone 021 555 0101 Email andre@example.com", { form });
    const v = validateHermes(H({ recommended_action: "NO_ACTION", intent: "information", conversation_type: "other", facts: [{ key: "contact_name", value: "Andre Bunton", evidence: "Name: Andre Bunton", confidence: 0.95 }, { key: "site_address", value: "5 Depot Road, Penrose", evidence: "address: 5 Depot Road, Penrose", confidence: 0.9 }] }), ctx(i));
    expect(v.rejectedFacts).toEqual([]);
    expect(v.understanding.facts.map((f) => f.key)).toEqual(["contact_name", "site_address"]);
    // A name the form does not contain is still refused.
    const bad = validateHermes(H({ facts: [{ key: "contact_name", value: "Hemi Walker", evidence: "Name: Hemi Walker", confidence: 0.9 }] }), ctx(i));
    expect(bad.rejectedFacts.map((r) => r.key)).toEqual(["contact_name"]);
  });

  it("asking the customer is Hermes's call: what the CRM already has is only noted", () => {
    const v = validateHermes(
      H({ recommended_action: "ASK_CUSTOMER", missing: [{ field: "storeys", label: "Storeys", blocking: true, for: "quote", reason: "", question: "Single or double?" }, { field: "camera_count", label: "Cameras", blocking: true, for: "quote", reason: "", question: "How many cameras?" }] }),
      ctx(input("Quote please"), { known: { storeys: 2 } }),
    );
    expect(v.plan.find((p) => p.type === "DRAFT_EMAIL")!.payload.ask).toEqual(["Single or double?", "How many cameras?"]);
    expect(v.advisories.map((a) => a.rule)).toContain("already_known");
  });
});

describe("business rules decide over Hermes", () => {
  const ready = { facts: [{ key: "camera_count" as const, value: 4, evidence: "4 cameras", confidence: 0.9 }, { key: "storeys" as const, value: 1, evidence: "single storey", confidence: 0.9 }], recommended_action: "PREPARE_QUOTE" as const, run_business_brain: true };

  it("residential CCTV with the Brain's inputs: Brain then quote", () => {
    const v = validateHermes(H(ready), ctx(input("4 cameras, single storey house")));
    expect(types(v)).toEqual(["ADD_INTERNAL_NOTE", "PROPOSE_LEAD_FACT_UPDATE", "RUN_BUSINESS_BRAIN", "PREPARE_QUOTE"]);
    expect(v.headline).toMatchObject({ recommended: "PREPARE_QUOTE", final: "PREPARE_QUOTE", changedBy: null });
  });

  it("commercial CCTV: site visit, whatever Hermes recommended", () => {
    const v = validateHermes(H({ ...ready, property_type: "commercial" }), ctx(input("4 cameras, single storey warehouse"), { known: { site_address: "5 Allens Rd" } }));
    expect(types(v)).toContain("PROPOSE_SITE_VISIT");
    expect(types(v)).not.toContain("RUN_BUSINESS_BRAIN");
    expect(v.business[0].rule).toBe("commercial_cctv_site_visit");
  });

  it("the Brain never guesses its inputs: missing storeys → ask, not quote", () => {
    const v = validateHermes(H({ recommended_action: "PREPARE_QUOTE", facts: [{ key: "camera_count", value: 4, evidence: "4 cameras", confidence: 0.9 }] }), ctx(input("4 cameras please")));
    expect(types(v)).toContain("DRAFT_EMAIL");
    expect(types(v)).not.toContain("PREPARE_QUOTE");
    expect(v.business[0].rule).toBe("brain_inputs_missing");
  });

  it("no Business Brain for alarms: quoted by hand", () => {
    const v = validateHermes(H({ service: "alarm", recommended_action: "PREPARE_QUOTE" }), ctx(input("Alarm for the house please")));
    expect(v.plan.find((p) => p.type === "CREATE_INTERNAL_TASK")!.rule).toBe("manual_quote_service");
  });

  it("a sent quote is only revised with Chris; an open one is not duplicated", () => {
    const sent = validateHermes(H(ready), ctx(input("4 cameras, single storey"), { crm: { ...ctx(input("x")).crm, hasSentQuote: true } }));
    expect(sent.plan.find((p) => p.type === "PREPARE_REVISED_QUOTE")!.mode).toBe("approval");
    const open = validateHermes(H(ready), ctx(input("4 cameras, single storey"), { crm: { ...ctx(input("x")).crm, hasOpenBrainQuote: true } }));
    expect(types(open)).not.toContain("PREPARE_QUOTE");
  });

  it("an acceptance never accepts terms: Chris gets the task", () => {
    const v = validateHermes(H({ intent: "acceptance", conversation_type: "quote_follow_up", recommended_action: "WAITING_ON_CUSTOMER" }), ctx(input("Yes let's go ahead")));
    expect(v.plan.find((p) => p.rule === "customer_accepted")).toBeTruthy();
  });
});

describe("advisories never block", () => {
  it("two storeys and the old rules' different reading are logged; the recommendation stands", () => {
    const v = validateHermes(
      H({ facts: [{ key: "camera_count", value: 2, evidence: "Cameras: 2", confidence: 0.95 }, { key: "storeys", value: 2, evidence: "Storeys: Double storey", confidence: 0.95 }], recommended_action: "PREPARE_QUOTE" }),
      ctx(input("Cameras: 2 Storeys: Double storey"), { rules: { primaryIntent: "information", firstAction: "NO_ACTION", urgency: "normal" } }),
    );
    expect(v.advisories.map((a) => a.rule)).toEqual(expect.arrayContaining(["two_storey_complexity", "rules_disagree"]));
    expect(types(v)).toContain("PREPARE_QUOTE");
  });
});

describe("commitments", () => {
  it("the CRM works out the due time from the words; Hermes cannot invent a commitment", () => {
    const i = input("Chris: I'll send the quote tonight. Customer: I'll send the photos tomorrow.");
    const v = validateHermes(
      H({
        intent: "follow_up",
        conversation_type: "existing_lead",
        recommended_action: "WAITING_ON_CUSTOMER",
        commitments: [
          { owner: "get_secure", owner_name: "Chris", action: "Send the quote", action_key: "send_quote", due_text: "tonight", due_at: "2030-01-01T00:00:00Z", evidence: "I'll send the quote tonight" },
          { owner: "customer", owner_name: null, action: "Send the photos", action_key: "send_photos", due_text: "tomorrow", due_at: null, evidence: "I'll send the photos tomorrow" },
          { owner: "get_secure", owner_name: "Chris", action: "Give a 10% discount", action_key: "other", due_text: null, due_at: null, evidence: "I'll knock 10% off" },
        ],
      }),
      ctx(i),
    );
    const [ours, theirs] = v.understanding.commitments;
    expect(v.understanding.commitments).toHaveLength(2);
    expect(ours.dueAt).toBe("2026-10-07T08:00:00.000Z"); // 9pm that day, not Hermes's date
    expect(theirs.dueAt).toBe("2026-10-08T04:00:00.000Z"); // 5pm the next day
    expect(v.plan.find((p) => p.rule === "waiting_on_customer")).toBeTruthy();
  });
});
