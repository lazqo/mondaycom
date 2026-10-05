/**
 * Hermes's authority matrix and the invariants hermes:check runs, against fixed Hermes outputs (no
 * database, no live Hermes). The invariants are general: each case only sets up a situation.
 */
import { deflateSync } from "node:zlib";
import { describe, it, expect } from "vitest";
import { parseHermesResult, type HermesResult } from "@/lib/hermes/contract";
import { AUTHORITY, HARD_GUARDRAILS } from "@/lib/hermes/authority";
import { checkInvariants, INVARIANTS } from "@/lib/hermes/invariants";
import { validateHermes, type ValidateContext, type Validation } from "@/lib/inspector/validate";
import { ACTION_TYPES, type IdentityResult, type InspectorInput } from "@/lib/inspector/types";
import { AUTO_ALLOWED } from "@/lib/inspector/router";
import { AGENT_CAPABILITIES, CUSTOMER_FACING_ACTIONS } from "@/lib/guard/actor";
import { extractPdfText, htmlToText } from "@/lib/hermes/attachments";
import { findPatterns } from "@/lib/brain/packages";

const AT = new Date("2026-10-07T01:00:00Z");
const input = (text: string, over: Partial<InspectorInput> = {}): InspectorInput => ({
  sourceType: "email",
  sourceId: "00000000-0000-0000-0000-000000000001",
  direction: "inbound",
  at: AT,
  title: "Enquiry",
  text,
  utterances: [],
  from: { name: "Sam", email: "sam@example.com", phone: "021 555 0199" },
  context: [],
  linked: { leadId: null, contactId: null, jobId: null, how: null },
  ...over,
});
const matched: IdentityResult = { status: "matched", chosen: { leadId: "L1", contactId: null, jobId: null, label: "Sam", score: 0.95, signals: [{ kind: "thread", detail: "thread", weight: 0.95 }] }, candidates: [], confidence: 0.95, reason: "thread" };
const unknown: IdentityResult = { status: "needs_review", chosen: null, candidates: [], confidence: 0.2, reason: "Only name evidence." };
const ctx = (i: InspectorInput, over: Partial<ValidateContext> = {}): ValidateContext => ({
  input: i,
  identity: matched,
  known: {},
  crm: { leadId: "L1", contactId: null, hasOpenBrainQuote: false, hasSentQuote: false, recordingLinked: false, customerEmail: "sam@example.com", customerPhone: null },
  ...over,
});
const H = (over: Record<string, unknown>): HermesResult => parseHermesResult(JSON.stringify({ conversation_type: "new_enquiry", intent: "new_enquiry", service: "cctv", property_type: "residential", summary: "s", recommended_action: "NO_ACTION", confidence: 0.9, reason: "r", ...over }));
const run = (h: HermesResult, c: ValidateContext, pack?: unknown) => {
  const v = validateHermes(h, c);
  return { v, results: checkInvariants({ hermes: h, validation: v, ctx: c, pack: pack as never }) };
};
const broken = (r: { results: { ok: boolean; key: string }[] }) => r.results.filter((x) => !x.ok).map((x) => x.key);

describe("the authority matrix", () => {
  it("covers every action, and only autonomous ones run without Chris", () => {
    for (const t of ACTION_TYPES) expect(AUTHORITY[t], t).toBeTruthy();
    expect(AUTO_ALLOWED).toEqual(ACTION_TYPES.filter((t) => AUTHORITY[t].autonomous));
    for (const t of ["PROPOSE_SITE_VISIT", "PROPOSE_BOOKING", "PREPARE_REVISED_QUOTE", "PROPOSE_LINK_SENDER", "NEEDS_REVIEW"] as const) expect(AUTO_ALLOWED).not.toContain(t);
  });
  it("gives an agent no customer-facing capability, and lists the hard limits", () => {
    for (const a of CUSTOMER_FACING_ACTIONS) expect(AGENT_CAPABILITIES as readonly string[]).not.toContain(a);
    expect(AGENT_CAPABILITIES).toEqual(expect.arrayContaining(["propose_package", "read_attachments"]));
    expect(HARD_GUARDRAILS.customer_facing.length).toBeGreaterThan(0);
    expect(HARD_GUARDRAILS.commercial.join(" ")).toMatch(/approve a candidate package/);
  });
});

describe("invariants (the same ones hermes:check runs on the live Hermes)", () => {
  const form = { fields: { Property: "Residential Home", Storeys: "Double storey", Cameras: "4", "Current Setup": "New Installation", Address: "7 Solo Place, Manurewa" }, name: "Isapela", email: "i@example.com", phone: null, service: "CCTV", address: "7 Solo Place, Manurewa" };
  const web = input("New Lead · CCTV Landing PropertyResidential HomeStoreysDouble storeyCameras4", { form, from: { name: "Isapela", email: "i@example.com", phone: null } });

  it("complete structured form: fields survive, reach the Brain, and nobody asks for them again", () => {
    const r = run(H({ recommended_action: "PREPARE_QUOTE", facts: [{ key: "camera_count", value: 4, evidence_ref: "form:Cameras", confidence: 0.95 }, { key: "storeys", value: 2, evidence_ref: "form:Storeys", confidence: 0.95 }] }), ctx(web), { source: { form } });
    expect(broken(r)).toEqual([]);
    expect(r.results.map((x) => x.key)).toEqual(expect.arrayContaining(["evidence_delivered", "structured_evidence_survives", "form_reaches_brain", "customer_facing_gated", "brain_authority"]));
  });

  it("asking the customer again for what the form supplied breaks form_reaches_brain", () => {
    const r = run(H({ recommended_action: "ASK_CUSTOMER", missing: [{ field: "camera_count", label: "Cameras", blocking: true, question: "Roughly how many cameras are you after?" }] }), ctx(web));
    expect(broken(r)).toContain("form_reaches_brain");
  });

  it("unknown sender + evidenced existing work: work proceeds, sender stays unverified", () => {
    const c = ctx(input("The keypad at 138 Wiri Station Road is beeping again."), { identity: unknown, crm: { ...ctx(web).crm, leadId: null }, context: { ref: "lead:L2", label: "Wiri Depot", leadId: "L2", jobId: null, contactId: "K2", accepted: true, why: "the message names the site" } });
    const r = run(H({ intent: "service_issue", conversation_type: "existing_job", business_context: "existing_work", lead_decision: "existing", recommended_action: "PROPOSE_SITE_VISIT", internal_actions: [{ action: "CREATE_INTERNAL_TASK", title: "Check the keypad fault history" }] }), c);
    expect(broken(r)).toEqual([]);
    expect(r.results.map((x) => x.key)).toEqual(expect.arrayContaining(["context_work_proceeds", "no_unsafe_linking"]));
    expect(r.v.plan.find((p) => p.type === "PROPOSE_SITE_VISIT")!.mode).toBe("approval");
  });

  it("ambiguous identity: nothing is linked, safe work continues, record-dependent work waits for Chris", () => {
    const c = ctx(input("Hemi here, can you quote 4 cameras? Also keen to know about the alarm."), { identity: unknown, crm: { ...ctx(web).crm, leadId: null } });
    const r = run(H({ lead_decision: "existing", recommended_action: "PREPARE_QUOTE", internal_actions: [{ action: "CREATE_INTERNAL_TASK", title: "Ask Chris about the alarm question" }] }), c);
    expect(broken(r)).toEqual([]);
    expect(r.v.reviewKind).toBe("identity");
    expect(r.v.plan.map((p) => p.type)).toContain("CREATE_INTERNAL_TASK");
    expect(r.v.plan.map((p) => p.type)).not.toContain("PREPARE_QUOTE");
  });

  it("research stays isolated: a question copying the customer's details is caught", () => {
    const i = input("Our old Hikvision recorder died at 7 Solo Place. Call me on 021 555 0199.");
    expect(broken(run(H({ intent: "question", conversation_type: "existing_lead", recommended_action: "REQUEST_RESEARCH", research: [{ question: "Which current Hikvision NVR replaces the DS-7608NI-K2?", product: "DS-7608NI-K2" }] }), ctx(i)))).toEqual([]);
    expect(broken(run(H({ intent: "question", conversation_type: "existing_lead", recommended_action: "REQUEST_RESEARCH", research: [{ question: "Replacement recorder for the customer on 021 555 0199" }] }), ctx(i)))).toContain("research_isolated");
  });

  it("the Brain's authority and customer-facing gating hold even if a plan were tampered with", () => {
    const c = ctx(input("Quote please"));
    const v = validateHermes(H({ recommended_action: "PREPARE_QUOTE" }), c);
    const tampered: Validation = { ...v, plan: [...v.plan.filter((p) => p.type !== "RUN_BUSINESS_BRAIN"), { type: "PROPOSE_BOOKING", mode: "auto", rule: "x", reason: "x", payload: {} }] };
    const r = checkInvariants({ hermes: H({}), validation: tampered, ctx: c });
    expect(r.filter((x) => !x.ok).map((x) => x.key)).toEqual(expect.arrayContaining(["customer_facing_gated", "brain_authority"]));
  });

  it("needs review is exceptional: a review must say what Chris has to decide", () => {
    const c = ctx(input("x"));
    const ok = run(H({ intent: "question", conversation_type: "existing_lead", recommended_action: "NEEDS_REVIEW", review_question: "Keep the Wiri contract at the old rate?" }), c);
    expect(broken(ok)).toEqual([]);
    const vague = run(H({ intent: "question", conversation_type: "existing_lead", recommended_action: "NEEDS_REVIEW" }), c);
    expect(broken(vague)).toContain("review_is_exceptional");
  });

  it("every invariant has a key and a title (hermes:check prints them)", () => {
    for (const i of INVARIANTS) expect(i.key && i.title).toBeTruthy();
  });
});

describe("attachments as content", () => {
  it("reads text from a generated PDF (compressed or not) and HTML", () => {
    const content = "BT /F1 12 Tf 72 712 Td (VIGI C540 Turret) Tj T* (Trade ex GST: see quote) Tj ET";
    const pdf = (body: Buffer, filter: string) => Buffer.concat([Buffer.from(`%PDF-1.4\n1 0 obj << /Length ${body.length}${filter} >>\nstream\n`, "latin1"), body, Buffer.from("\nendstream\nendobj\n%%EOF", "latin1")]);
    expect(extractPdfText(pdf(Buffer.from(content, "latin1"), ""))).toContain("VIGI C540 Turret");
    expect(extractPdfText(pdf(deflateSync(Buffer.from(content, "latin1")), " /Filter /FlateDecode"))).toMatch(/VIGI C540 Turret\s*\n?Trade ex GST/);
    expect(htmlToText("<p>Model: <b>DS-2CD2143</b></p><script>alert(1)</script>")).toBe("Model: DS-2CD2143");
  });
});

describe("candidate packages from repeated configurations", () => {
  const cfg = (n: number, cam: string, over: Record<string, unknown> = {}) => ({ quoteId: `q${n}`, quoteNumber: 1000 + n, quoteStatus: "accepted", at: new Date(2026, 8, n), propertyType: "residential", cameraCount: 6, storeys: 2, cameraId: cam, nvrId: "nvr8", hddId: "hdd4", tier: "better", jobDone: n % 2 === 0, ...over });
  it("finds the setup used in most of the last similar quotes, and nothing when it varies", () => {
    const same = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => cfg(n, "camA"));
    const other = [9, 10].map((n) => cfg(n, "camB"));
    const found = findPatterns([...same, ...other]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ count: 8, of: 10, group: "residential|6|2" });
    const mixed = [1, 2, 3, 4, 5, 6].map((n) => cfg(n, n % 3 === 0 ? "camA" : n % 3 === 1 ? "camB" : "camC"));
    expect(findPatterns(mixed)).toEqual([]);
  });
});
