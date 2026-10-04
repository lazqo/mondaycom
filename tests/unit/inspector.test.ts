/**
 * Lead + Conversation Inspector: the deterministic reading of emails and Plaud conversations, the
 * blocking/non-blocking rules, commitments with due times, identity from several signals, and the
 * recommended actions. Pure; no database.
 */
import { describe, it, expect } from "vitest";
import { analyse } from "@/lib/inspector/analyse";
import { resolveDue } from "@/lib/inspector/dates";
import { decideIdentity, mergeCandidates, SIGNAL_WEIGHTS } from "@/lib/inspector/identity";
import { composeQuestionsEmail, planActions, type CrmState } from "@/lib/inspector/plan";
import { getSecureSpeaker, parseTranscript } from "@/lib/inspector/text";
import type { IdentityResult, InspectorInput } from "@/lib/inspector/types";

// Wednesday 7 October 2026, 2pm in Auckland (01:00 UTC).
const WHEN = new Date("2026-10-07T01:00:00Z");
const nz = (d: Date | string | null) => (d ? new Date(d).toLocaleString("en-NZ", { timeZone: "Pacific/Auckland", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: false }) : null);

const email = (text: string, over: Partial<InspectorInput> = {}): InspectorInput => ({
  sourceType: "email",
  sourceId: "e1",
  direction: "inbound",
  at: WHEN,
  title: over.title ?? "CCTV enquiry",
  text,
  utterances: [],
  from: { name: "Aroha Ngata", email: "aroha@example.com", phone: null },
  context: [],
  linked: { leadId: null, contactId: null, jobId: null, how: null },
  ...over,
});
const call = (transcript: string): InspectorInput => ({
  sourceType: "recording",
  sourceId: "r1",
  direction: "conversation",
  at: WHEN,
  title: "Call",
  text: transcript,
  utterances: parseTranscript(transcript),
  from: { name: null, email: null, phone: null },
  context: [],
  linked: { leadId: null, contactId: null, jobId: null, how: null },
});
const ctx = { staffNames: ["Chris"], hasQuote: false, hasSentQuote: false, hasOpenJob: false, known: false };
const matched: IdentityResult = { status: "matched", chosen: { leadId: "L1", contactId: null, jobId: null, label: "Aroha", score: 0.95, signals: [{ kind: "thread", detail: "thread", weight: 0.95 }] }, candidates: [], confidence: 0.95, reason: "thread" };
const crm = (over: Partial<CrmState> = {}): CrmState => ({ leadId: "L1", contactId: null, jobId: null, leadStatus: "new", hasOpenBrainQuote: false, hasSentQuote: false, hasOpenJob: false, recordingLinked: false, newFacts: 3, customerEmail: "aroha@example.com", customerPhone: null, ...over });
const run = (input: InspectorInput, c: Partial<typeof ctx> = {}, s: Partial<CrmState> = {}, identity: IdentityResult = matched) => {
  const { understanding, known } = analyse(input, { ...ctx, ...c }, {}, "Aroha");
  return { u: understanding, known, actions: planActions(input, understanding, identity, known, crm(s)) };
};
const types = (a: { type: string }[]) => a.map((x) => x.type);
const fact = (u: { facts: { key: string; value: unknown }[] }, k: string) => u.facts.find((f) => f.key === k)?.value;

describe("emails: understanding and blocking information", () => {
  it("a complete residential CCTV enquiry goes straight to the Business Brain and a prepared quote; nothing is asked", () => {
    const { u, actions } = run(email("Hi, we'd like a quote for 4 cameras at our house, single storey, at 12 Kauri Street, Grey Lynn. Would like to view them on my phone. Thanks, Aroha"));
    expect(u.service).toBe("cctv");
    expect(u.propertyType).toBe("residential");
    expect(fact(u, "camera_count")).toBe(4);
    expect(fact(u, "storeys")).toBe(1);
    expect(fact(u, "site_address")).toBe("12 Kauri Street, Grey Lynn");
    expect(fact(u, "remote_viewing")).toBe(true);
    expect(fact(u, "areas")).toBeUndefined(); // "Kauri Street" is the address, not a camera on the street
    expect(u.missing.filter((m) => m.blocking)).toEqual([]);
    expect(types(actions)).toEqual(["ADD_INTERNAL_NOTE", "PROPOSE_LEAD_FACT_UPDATE", "RUN_BUSINESS_BRAIN", "PREPARE_QUOTE"]);
    expect(actions.find((a) => a.type === "PREPARE_QUOTE")!.mode).toBe("auto"); // prepared, waits in Approvals
    for (const f of u.facts) expect(f.evidence.length).toBeGreaterThan(3); // every fact cites its words
  });

  it("a vague enquiry asks only what blocks a quote, never the non-blocking blanks", () => {
    const { u, actions } = run(email("Hi there, how much for some security cameras?", { title: "Cameras" }));
    const blocking = u.missing.filter((m) => m.blocking).map((m) => m.field);
    expect(blocking.sort()).toEqual(["camera_count", "property_type", "storeys"]);
    expect(u.missing.filter((m) => !m.blocking).map((m) => m.field)).toEqual(expect.arrayContaining(["site_address", "budget"]));
    const draft = actions.find((a) => a.type === "DRAFT_EMAIL")!;
    expect(draft.rule).toBe("ask_blocking_only");
    expect(draft.payload.ask).toEqual(["Home or business", "How many cameras, or which areas to cover", "Single or double storey"]);
    expect(types(actions)).not.toContain("PREPARE_QUOTE");
    const mail = composeQuestionsEmail("Aroha Ngata", draft.payload.ask as string[], "Cameras");
    expect(mail.subject).toBe("Re: Cameras");
    expect(mail.body).toMatch(/home or for a business/);
    expect(mail.body).not.toMatch(/address|budget|\$/i);
  });

  it("commercial CCTV always goes to a site visit (Business Brain rule), and asks for the address if it is missing", () => {
    const { u, actions } = run(email("We need CCTV for our warehouse, around 10 cameras inside and out. Can you quote?"));
    expect(u.propertyType).toBe("commercial");
    const sv = actions.find((a) => a.type === "PROPOSE_SITE_VISIT")!;
    expect(sv).toMatchObject({ mode: "approval", rule: "commercial_cctv_site_visit" });
    expect(types(actions)).not.toContain("PREPARE_QUOTE");
    expect(types(actions)).not.toContain("RUN_BUSINESS_BRAIN");
    expect(actions.find((a) => a.type === "DRAFT_EMAIL")!.payload.ask).toEqual(["Site address"]);
  });

  it("an explicit site-visit request at home proposes a visit, not a quote", () => {
    const { actions } = run(email("Could someone come out and have a look at our house at 3 Rata Road, Titirangi? We want a few cameras."));
    expect(actions.find((a) => a.type === "PROPOSE_SITE_VISIT")).toMatchObject({ rule: "explicit_site_visit_request", mode: "approval" });
    expect(types(actions)).not.toContain("PREPARE_QUOTE");
  });

  it("an upgrade with unknown cabling never runs the Brain on assumed upgrade labour", () => {
    const { u, actions } = run(email("We want to upgrade our old cameras at home. 6 cameras, double storey house."));
    expect(fact(u, "job_type")).toBe("upgrade");
    expect(u.missing.find((m) => m.field === "existing_cabling")).toMatchObject({ blocking: true, reason: /Existing cabling must be confirmed/ });
    expect(types(actions)).not.toContain("RUN_BUSINESS_BRAIN");
    expect(actions.find((a) => a.type === "DRAFT_EMAIL")!.payload.ask).toEqual(["Existing cable type and condition"]);
  });

  it("a price objection on a sent quote recommends a revision for Chris (no automatic discount) and a call", () => {
    const { actions } = run(email("Thanks for the quote, but it's a bit more than we expected. We got another quote that was cheaper."), { known: true, hasQuote: true, hasSentQuote: true }, { hasSentQuote: true, newFacts: 0 });
    expect(actions.find((a) => a.type === "PREPARE_REVISED_QUOTE")).toMatchObject({ mode: "approval", rule: "price_objection" });
    expect(types(actions)).toContain("CALL_CUSTOMER");
  });

  it("acceptance never accepts anything itself: a task for Chris and a booking proposal", () => {
    const { u, actions } = run(email("Happy to go ahead with the quote. When can you install? Next week would be great."), { known: true, hasQuote: true, hasSentQuote: true }, { hasSentQuote: true });
    expect(u.primaryIntent).toBe("acceptance");
    expect(actions.find((a) => a.type === "CREATE_INTERNAL_TASK")!.rule).toBe("customer_accepted");
    expect(actions.find((a) => a.type === "PROPOSE_BOOKING")).toMatchObject({ mode: "approval", payload: { timing: "next week" } });
    expect(u.decisions.length).toBeGreaterThan(0);
  });

  it("not ready to go ahead is not an acceptance", () => {
    const { u } = run(email("We're not ready to go ahead yet, will think about it."), { known: true, hasQuote: true, hasSentQuote: true });
    expect(u.intents).not.toContain("acceptance");
    expect(u.objections.map((o) => o.kind)).toContain("undecided");
  });

  it("a fault on an existing system becomes a service case, urgent ones a call too", () => {
    const { u, actions } = run(email("Our cameras stopped recording last night, urgent please as we had a break-in."), { known: true, hasOpenJob: true });
    expect(u.primaryIntent).toBe("service_issue");
    expect(u.urgency).toBe("urgent");
    expect(types(actions)).toEqual(["ADD_INTERNAL_NOTE", "PROPOSE_LEAD_FACT_UPDATE", "CREATE_SERVICE_CASE", "CALL_CUSTOMER"]);
  });

  it("an alarm enquiry gets a manual quote task (there is no Alarm Brain)", () => {
    const { u, actions } = run(email("Looking for a quote for a new alarm system with sensors for our home.", { title: "Alarm enquiry" }));
    expect(u.service).toBe("alarm");
    expect(actions.find((a) => a.type === "CREATE_INTERNAL_TASK")!.rule).toBe("manual_quote_service");
    expect(types(actions)).not.toContain("RUN_BUSINESS_BRAIN");
  });
});

describe("Plaud conversations: speakers and commitments", () => {
  const transcript = [
    "[00:00 - 00:06] Speaker 1: Hi, it's Chris from Get Secure, thanks for having me round.",
    "[00:06 - 00:20] Speaker 2: No worries. We're after 4 cameras for the house, it's single storey.",
    "[00:20 - 00:31] Speaker 2: Mainly the driveway, front door and the side gate.",
    "[00:31 - 00:44] Speaker 1: Great, we'd recommend the VIGI turrets with a recorder. I'll send the quote tonight.",
    "[00:44 - 00:55] Speaker 2: Perfect. I'll send the photos of the garage tomorrow.",
  ].join("\n");

  it("works out which speaker is Get Secure", () => {
    expect(getSecureSpeaker(parseTranscript(transcript), ["Chris"])).toBe("Speaker 1");
    expect(getSecureSpeaker(parseTranscript("Chris: Hello\nMere: Hi, I'm after a quote"), ["Chris"])).toBe("Chris");
  });

  it("Chris's promise and the customer's promise become commitments with due times", () => {
    const { u } = run(call(transcript));
    const chris = u.commitments.find((c) => c.owner === "get_secure")!;
    // Plaud's "Speaker 1" is named from how they introduced themselves; the promise is in the words used.
    expect(chris).toMatchObject({ actionKey: "send_quote", dueText: "tonight", ownerName: "Chris", action: "Send the quote tonight" });
    expect(nz(chris.dueAt)).toBe(nz("2026-10-07T08:00:00Z")); // 9pm the same day in Auckland
    const cust = u.commitments.find((c) => c.owner === "customer")!;
    expect(cust).toMatchObject({ actionKey: "send_photos", dueText: "tomorrow", ownerName: null, action: "Send the photos of the garage tomorrow" });
    expect(nz(cust.dueAt)).toBe(nz("2026-10-08T04:00:00Z")); // 5pm the next day
  });

  it("facts come from what the customer said, not from Chris's recommendations", () => {
    const { u, actions } = run(call(transcript));
    expect(fact(u, "camera_count")).toBe(4);
    expect(fact(u, "storeys")).toBe(1);
    expect(fact(u, "areas")).toBe("driveway, front door, side gate");
    expect(fact(u, "brand")).toBeUndefined(); // "VIGI" was Chris's suggestion
    expect(types(actions)).toEqual(expect.arrayContaining(["LINK_RECORDING", "RUN_BUSINESS_BRAIN", "PREPARE_QUOTE"]));
  });

  it("a camera on the street is still an area when it is not part of the address", () => {
    const { u } = run(email("Hi, quote please for 3 cameras at 5 Rata Road, Ponsonby: the driveway, the front door and one looking at the street."));
    expect(fact(u, "areas")).toBe("driveway, front door, street");
  });

  it("an undecided caller gets a follow-up, not a quote", () => {
    const { actions } = run(call("Chris: The quote came to about four thousand.\nDave: Right, I'll need to talk to my wife and get back to you."), { known: true, hasQuote: true, hasSentQuote: true }, { hasSentQuote: true });
    expect(actions.find((a) => a.type === "PREPARE_FOLLOW_UP")).toMatchObject({ rule: "customer_undecided", payload: { inDays: 3 } });
  });
});

describe("relative dates (NZ time)", () => {
  it("resolves the common phrases", () => {
    expect(nz(resolveDue("tonight", WHEN))).toBe(nz("2026-10-07T08:00:00Z"));
    expect(nz(resolveDue("tomorrow morning", WHEN))).toBe(nz("2026-10-07T23:00:00Z"));
    expect(nz(resolveDue("by Friday", WHEN))).toBe(nz("2026-10-09T04:00:00Z"));
    expect(nz(resolveDue("next week", WHEN))).toBe(nz("2026-10-12T04:00:00Z"));
    expect(nz(resolveDue("12th of November", WHEN))).toBe(nz("2026-11-12T04:00:00Z"));
    expect(resolveDue("someday", WHEN)).toBeNull();
  });
});

describe("identity: several signals, never a name alone", () => {
  const cand = (id: string, kind: keyof typeof SIGNAL_WEIGHTS, detail: string = kind) => ({ leadId: id, contactId: null, jobId: null, label: id, signal: { kind, detail, weight: SIGNAL_WEIGHTS[kind] } });
  it("a name alone is never a match", () => {
    const r = decideIdentity(mergeCandidates([cand("A", "name")]), { allowNew: false });
    expect(r.status).toBe("needs_review");
    expect(r.reason).toMatch(/Only name evidence/);
  });
  it("a phone number or email is", () => {
    expect(decideIdentity(mergeCandidates([cand("A", "phone")]), { allowNew: false }).status).toBe("matched");
    expect(decideIdentity(mergeCandidates([cand("A", "email")]), { allowNew: false }).status).toBe("matched");
  });
  it("a same-day appointment plus the name is; the appointment alone is not", () => {
    expect(decideIdentity(mergeCandidates([cand("A", "calendar"), cand("A", "name")]), { allowNew: false }).status).toBe("matched");
    expect(decideIdentity(mergeCandidates([cand("A", "calendar")]), { allowNew: false }).status).toBe("needs_review");
  });
  it("two close candidates go to review with both shown", () => {
    const r = decideIdentity(mergeCandidates([cand("A", "phone"), cand("B", "phone", "phone 2")]), { allowNew: false });
    expect(r.status).toBe("needs_review");
    expect(r.candidates.map((c) => c.label)).toEqual(["A", "B"]);
  });
  it("an existing link (the email thread, or Chris) stands even when another record shares a phone", () => {
    const r = decideIdentity(mergeCandidates([cand("A", "thread"), cand("B", "phone")]), { allowNew: false });
    expect(r.status).toBe("matched");
    expect(r.chosen!.label).toBe("A");
    expect(r.reason).toMatch(/Note: B .* also matched/);
  });
  it("needs review: nothing customer-specific is written, only the review (and the recording waits)", () => {
    const r = decideIdentity(mergeCandidates([cand("A", "name")]), { allowNew: false });
    const { understanding, known } = analyse(call("Speaker 1: Hi it's Chris from Get Secure.\nSpeaker 2: We want 4 cameras for the house."), ctx, {}, null);
    const actions = planActions(call("x"), understanding, r, known, crm());
    expect(types(actions)).toEqual(["NEEDS_REVIEW", "LINK_RECORDING"]);
    expect(actions.every((a) => a.mode === "approval")).toBe(true);
  });
});
