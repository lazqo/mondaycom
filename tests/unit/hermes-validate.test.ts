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

  it("a real enquiry is never 'no action'; low confidence waits for Chris with the plan attached", () => {
    const i = input("Interested in cameras");
    expect(validateHermes(H({ recommended_action: "NO_ACTION" }), ctx(i)).reviewKind).toBe("hermes_flagged");
    const low = validateHermes(H({ intent: "follow_up", conversation_type: "existing_lead", recommended_action: "CREATE_INTERNAL_TASK", task: { title: "Ring", due: null, detail: null }, confidence: 0.3 }), ctx(i));
    expect(low.reviewKind).toBe("hermes_low_confidence");
    expect((low.plan.find((p) => p.type === "NEEDS_REVIEW")!.payload.plan as { type: string }[]).map((p) => p.type)).toEqual(["CREATE_INTERNAL_TASK"]);
  });

  describe("an enquiry Hermes would close ('no action') — lifecycle-aware", () => {
    const lc = (over: Partial<NonNullable<ValidateContext["crm"]["lifecycle"]>> = {}) => ({ progressed: [], openTasks: [], outstanding: [], settledFromSource: [], ...over });
    const withLc = (i: InspectorInput, l: ReturnType<typeof lc>) => ctx(i, { crm: { ...ctx(i).crm, lifecycle: l } });
    const old = input("Hi, we'd like a quote for cameras at the house.");

    it("allowed when the CRM shows it has moved on and nothing is outstanding", () => {
      for (const progressed of [["Job #12 invoiced"], ["Job #12 completed"], ["Site visit held on 3 Sept 2026"], ["Job #14 scheduled"], ["Quote Q-1004 accepted and job #14 created"]]) {
        const v = validateHermes(H({ recommended_action: "NO_ACTION" }), withLc(old, lc({ progressed })));
        expect(v.reviewKind).toBeNull();
        expect(v.headline).toMatchObject({ final: "NO_ACTION", changedBy: null });
        expect(v.hard.find((c) => c.rule === "enquiry_already_progressed")!.message).toContain(progressed[0]);
      }
    });

    it("no progress in the CRM: still sent to Chris", () => {
      const v = validateHermes(H({ recommended_action: "NO_ACTION" }), withLc(old, lc()));
      expect(v.reviewKind).toBe("hermes_flagged");
      expect(v.headline.changedBy).toBe("enquiry_never_no_action");
    });

    it("our unresolved commitment from the conversation is the outstanding action, not a generic review", () => {
      const call = input("Chris: I'll prepare and send the camera plan later that day.", { sourceType: "recording" });
      const h = H({ recommended_action: "NO_ACTION", commitments: [{ owner: "get_secure", owner_name: "Chris", action: "prepare and send the camera plan", action_key: "send_info", due_text: "later that day", due_at: null, evidence: "I'll prepare and send the camera plan later that day" }] });
      const v = validateHermes(h, withLc(call, lc({ progressed: ["Site visit held on 3 Sept 2026"] })));
      expect(v.reviewKind).toBeNull();
      expect(types(v)).toContain("OUTSTANDING");
      expect(types(v)).not.toContain("NEEDS_REVIEW");
      const o = v.plan.find((p) => p.type === "OUTSTANDING")!;
      expect(o.reason).toBe("We said we'd prepare and send the camera plan (later that day)");
      expect(v.headline).toMatchObject({ final: "OUTSTANDING", changedBy: "enquiry_outstanding_item" });
      // Marked done in the CRM: then "no action" stands.
      const done = validateHermes(h, withLc(call, lc({ progressed: ["Site visit held on 3 Sept 2026"], settledFromSource: ["get_secure:send_info"] })));
      expect(done.headline).toMatchObject({ final: "NO_ACTION", changedBy: null });
    });

    it("open tasks and outstanding CRM commitments are surfaced too (ours first, no duplicates)", () => {
      const v = validateHermes(
        H({ recommended_action: "NO_ACTION" }),
        withLc(old, lc({ progressed: ["Job #12 completed"], openTasks: ["Send the invoice"], outstanding: [{ owner: "customer", action: "Send photos of the eaves", dueText: null }, { owner: "get_secure", action: "Email the warranty", dueText: "Friday" }] })),
      );
      expect(v.plan.find((p) => p.type === "OUTSTANDING")!.payload.items).toEqual(["We said we'd email the warranty (Friday)", "Waiting on the customer to send photos of the eaves", "Open task: Send the invoice"]);
    });
  });

  it("not asked: anything the CRM already has", () => {
    const v = validateHermes(
      H({ recommended_action: "ASK_CUSTOMER", missing: [{ field: "storeys", label: "Storeys", blocking: true, for: "quote", reason: "", question: "Single or double?" }, { field: "camera_count", label: "Cameras", blocking: true, for: "quote", reason: "", question: "How many cameras?" }] }),
      ctx(input("Quote please"), { known: { storeys: 2 } }),
    );
    expect(v.plan.find((p) => p.type === "DRAFT_EMAIL")!.payload.ask).toEqual(["How many cameras?"]);
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
