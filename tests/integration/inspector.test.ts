/**
 * The Hermes-first Lead + Conversation Inspector against the database.
 *
 * Hermes is replaced by a scripted stand-in that answers the way the contract allows, so these
 * tests check what the CRM does with an answer: the hard guardrails Hermes cannot override, the
 * Business Brain's authority, the advisory checks, the fallback when Hermes is unavailable, and the
 * audit record of every run. (How well the real Hermes understands language is checked against the
 * live agent with `pnpm hermes:check`, not here.)
 *
 * Acceptance tests 1-8 from the brief are marked. Nothing here is sent: the tests check that too.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import { and, asc, desc, eq, inArray, like, or } from "drizzle-orm";

process.env.AI_PROVIDER = "rules";

const { db } = await import("@/db");
const S = await import("@/db/schema");
const { setClassifier } = await import("@/lib/ai");
const { processEmail } = await import("@/lib/email/pipeline");
const { inspect, confirmIdentity, acceptAction, resolveFact, setCommitmentStatus, closeReviews, resolveReview } = await import("@/lib/inspector/inspect");
const { settleInspectorQueue, enqueueInspection } = await import("@/lib/inspector/queue");
const { setJev } = await import("@/lib/inspector/jev");
const { setHermes, HermesApiRuntime, HermesUnavailableError } = await import("@/lib/hermes/runtime");
const { encryptSecret } = await import("@/lib/crypto");
const { sendDraft } = await import("@/lib/drafts/workflow");
const { GuardrailError } = await import("@/lib/guard/actor");
const { INSPECTOR_ACTOR } = await import("@/lib/inspector/router");
const { applyReferenceCatalogue, resetReferenceMarker } = await import("@/lib/brain/reference/apply");
const brain = await import("@/lib/brain/store");
const { getOutstandingCommitments } = await import("@/queries/inspector");
type HermesResult = import("@/lib/hermes/contract").HermesResult;

const RUN = `hi${Date.now().toString(36)}`;
let chris: { kind: "human"; userId: string; name: string; canApprove: true };
let mailboxId: string;
const leadIds: string[] = [];
const recordingIds: string[] = [];
const offerIds: string[] = [];
let pkgBefore: typeof S.installationPackages.$inferSelect | undefined;
let n = 0;
/** A quiet moment with nothing in the calendar, so other tests' appointments never interfere. */
const QUIET = new Date("2031-03-04T21:00:00Z"); // 10am, 5 March 2031 in Auckland

// ---------------- the stand-in Hermes ----------------

type Pack = { source: { origin: string; text: string; form: unknown }; identity: { status: string; candidates: { key: string }[] }; crm: unknown };
let script: (pack: Pack) => Partial<HermesResult> | string | Error = () => new Error("no script");
const packs: Pack[] = [];
let calls = 0;
const R = (over: Partial<HermesResult>): HermesResult => ({
  conversation_type: "new_enquiry",
  intent: "new_enquiry",
  service: "cctv",
  property_type: "residential",
  summary: "New enquiry",
  facts: [],
  objections: [],
  commitments: [],
  urgency: "normal",
  missing: [],
  recommended_action: "NO_ACTION",
  run_business_brain: false,
  task: null,
  reply_draft: null,
  identity: { suggestion: "unknown", candidate_key: null, reason: "" },
  conflicts: [],
  confidence: 0.9,
  reason: "test",
  advisories: [],
  ...over,
});
function useStandInHermes() {
  setHermes({
    name: "test-hermes",
    model: "stand-in-hermes",
    complete: async (messages) => {
      calls++;
      const pack = JSON.parse(messages[1].content.replace(/^Context pack:\n/, "")) as Pack;
      packs.push(pack);
      const out = script(pack);
      if (out instanceof Error) throw out;
      return { text: typeof out === "string" ? out : JSON.stringify(R(out)), model: "stand-in-hermes", durationMs: 3 };
    },
  });
}

// ---------------- data ----------------

async function email(opts: { from: string; name: string; subject: string; text: string; thread?: string }) {
  const now = new Date();
  const threadId =
    opts.thread ??
    (await db.insert(S.emailThreads).values({ mailboxId, subject: opts.subject, normalizedSubject: opts.subject.toLowerCase(), firstMessageAt: now, lastMessageAt: now }).returning())[0].id;
  const [e] = await db
    .insert(S.emails)
    .values({ mailboxId, threadId, messageId: `<${RUN}-${++n}@example.com>`, fromName: opts.name, fromAddress: opts.from, to: [{ name: "Get Secure", address: "info@getsecure.test" }], subject: opts.subject, textBody: opts.text, receivedAt: now })
    .returning();
  return e;
}
/** A CCTV landing-page submission, as the website sends it. */
function landingForm(o: { name: string; email: string; phone: string; cameras: number; storeys: string; address: string }) {
  return [
    "New Lead · CCTV Landing",
    "",
    o.name.toUpperCase(),
    "",
    `Phone ${o.phone} tel:${o.phone} Email ${o.email} ServiceCCTV Installation`,
    "",
    "REQUEST SUMMARY",
    "",
    `PropertyResidential HomeStoreys${o.storeys}Cameras${o.cameras}Current SetupNew InstallationTimelineAs Soon As PossibleAddress${o.address}`,
    "",
    `Sent from the Get Secure website. Reply to this email to respond directly to ${o.name}.`,
  ].join("\n");
}
async function recording(title: string, transcript: string, at = QUIET) {
  const [r] = await db.insert(S.recordings).values({ externalId: `${RUN}-${++n}`, source: "plaud", title, transcript, transcriptPolished: true, recordedAt: at, status: "review" }).returning();
  recordingIds.push(r.id);
  return r;
}
const actionsOf = (inspectionId: string) => db.query.inspectorActions.findMany({ where: eq(S.inspectorActions.inspectionId, inspectionId), orderBy: [asc(S.inspectorActions.createdAt)] });
const latestFor = (sourceId: string) => db.query.inspections.findFirst({ where: eq(S.inspections.sourceId, sourceId), orderBy: [desc(S.inspections.createdAt)] });
const runFor = (inspectionId: string) => db.query.inspectorRuns.findFirst({ where: eq(S.inspectorRuns.inspectionId, inspectionId) });

beforeAll(async () => {
  resetReferenceMarker();
  await applyReferenceCatalogue();
  const [c] = await db.insert(S.users).values({ email: `chris-${RUN}@test.local`, name: "Chris", passwordHash: "x", role: "admin", canApprove: true }).returning();
  chris = { kind: "human", userId: c.id, name: c.name, canApprove: true };
  const [mb] = await db
    .insert(S.mailboxes)
    .values({ name: `Inspector ${RUN}`, emailAddress: `info+${RUN}@getsecure.test`, imapHost: "127.0.0.1", imapPort: 1, imapSecure: false, smtpHost: "127.0.0.1", smtpPort: 1, smtpSecure: false, username: "x", passwordEncrypted: encryptSecret("x"), active: false })
    .returning();
  mailboxId = mb.id;
  setClassifier({
    name: "test",
    classify: async (input) => ({
      provider: "test",
      model: null,
      result: { is_lead: true, confidence: 0.95, contact_name: input.from.name, company: null, email: input.from.address, phone: null, service: "CCTV", site_address: null, summary: input.subject, urgency: "normal", next_action: "Reply", reason: "test" },
      durationMs: 1,
    }),
  });
  setJev(null);
  useStandInHermes();
});

beforeEach(() => {
  packs.length = 0;
  calls = 0;
});

afterAll(async () => {
  setClassifier(null);
  setJev(undefined);
  setHermes(undefined);
  const emailIds = (await db.select({ id: S.emails.id }).from(S.emails).where(eq(S.emails.mailboxId, mailboxId))).map((e) => e.id);
  const leadRows = await db.select({ id: S.leads.id }).from(S.leads).where(or(like(S.leads.email, `%${RUN}%`), inArray(S.leads.sourceEmailId, emailIds.length ? emailIds : ["00000000-0000-0000-0000-000000000000"])));
  leadIds.push(...leadRows.map((l) => l.id));
  const sources = [...recordingIds, ...emailIds];
  if (sources.length) {
    await db.delete(S.inspectorQueue).where(inArray(S.inspectorQueue.sourceId, sources));
    await db.delete(S.commitments).where(inArray(S.commitments.sourceId, sources));
    await db.delete(S.inspectorRuns).where(inArray(S.inspectorRuns.sourceId, sources));
    await db.delete(S.inspections).where(inArray(S.inspections.sourceId, sources));
  }
  if (leadIds.length) {
    await db.delete(S.inspectorFeedback).where(inArray(S.inspectorFeedback.leadId, leadIds));
    await db.delete(S.quotes).where(inArray(S.quotes.leadId, leadIds));
    await db.delete(S.drafts).where(inArray(S.drafts.leadId, leadIds));
    await db.delete(S.tasks).where(inArray(S.tasks.leadId, leadIds));
  }
  if (recordingIds.length) await db.delete(S.recordings).where(inArray(S.recordings.id, recordingIds));
  await db.delete(S.emailThreads).where(eq(S.emailThreads.mailboxId, mailboxId));
  if (leadIds.length) await db.delete(S.leads).where(inArray(S.leads.id, leadIds));
  await db.delete(S.mailboxes).where(eq(S.mailboxes.id, mailboxId));
  if (offerIds.length) await db.delete(S.supplierProducts).where(inArray(S.supplierProducts.id, offerIds));
  if (pkgBefore) {
    const { id, ...rest } = pkgBefore;
    await db.update(S.installationPackages).set(rest).where(eq(S.installationPackages.id, id));
  }
  await db.delete(S.inspectorFeedback).where(eq(S.inspectorFeedback.userId, chris.userId));
  await db.delete(S.users).where(eq(S.users.id, chris.userId));
  resetReferenceMarker();
});

/** What Hermes says about a landing-page form: understood as a new residential CCTV enquiry. */
const landingReading = (cams: number, storeys: number, address: string): Partial<HermesResult> => ({
  conversation_type: "new_enquiry",
  intent: "new_enquiry",
  summary: `New residential CCTV enquiry from the CCTV landing page: ${cams} cameras, ${storeys === 2 ? "two-storey" : "single-storey"}, new installation.`,
  facts: [
    { key: "property_type", value: "residential", evidence: "Property: Residential Home", confidence: 0.97 },
    { key: "camera_count", value: cams, evidence: `Cameras: ${cams}`, confidence: 0.97 },
    { key: "storeys", value: storeys, evidence: `Storeys: ${storeys === 2 ? "Double storey" : "Single storey"}`, confidence: 0.95 },
    { key: "job_type", value: "new", evidence: "Current Setup: New Installation", confidence: 0.95 },
    { key: "site_address", value: address, evidence: `Address: ${address}`, confidence: 0.95 },
  ],
  missing: [{ field: "budget", label: "Budget", blocking: false, for: "quote", reason: "Tiers cover the range.", question: null }],
  recommended_action: "PREPARE_QUOTE",
  run_business_brain: true,
  confidence: 0.94,
  reason: "New CCTV landing-page enquiry with the core residential quote requirements supplied.",
});

// =====================================================================================

describe("Test 1: a CCTV landing-page lead is a genuine enquiry, never 'information' or 'no action'", () => {
  it("unpriced: Hermes says prepare quote, the Brain designs it, no price exists → Price the quote; nothing sent", async () => {
    script = (pack) => {
      expect(pack.source.origin).toMatch(/website form submission \(CCTV Landing page\)/);
      return landingReading(2, 2, `7 Solo Place, Manurewa ${RUN}`);
    };
    const e = await email({ from: "noreply@updates.getsecure.co.nz", name: "Get Secure Website", subject: "New Lead · CCTV Landing", text: landingForm({ name: "Isapela Masoe", email: `isapela+${RUN}@example.com`, phone: "021 088 5669", cameras: 2, storeys: "Double storey", address: `7 Solo Place, Manurewa ${RUN}` }) });
    await processEmail(e.id);
    await settleInspectorQueue();
    const ins = (await latestFor(e.id))!;
    expect(ins).toMatchObject({ engine: "hermes", status: "analysed" });
    leadIds.push(ins.leadId!);
    expect((ins.hermes as { intent: string }).intent).toBe("new_enquiry");
    const acts = await actionsOf(ins.id);
    const types = acts.map((a) => a.type);
    expect(types).not.toContain("NO_ACTION");
    expect(acts.find((a) => a.type === "RUN_BUSINESS_BRAIN")).toMatchObject({ status: "done" });
    const pq = acts.find((a) => a.type === "PREPARE_QUOTE");
    const visit = acts.find((a) => a.type === "PROPOSE_SITE_VISIT");
    // The Brain is the authority: either it needs a visit, or it priced nothing and Chris prices it.
    if (visit) expect(visit.rule).toBe("business_brain_site_visit");
    else {
      expect(pq).toMatchObject({ status: "blocked" });
      expect((pq!.result as { reason: string }).reason).toMatch(/approved price/);
      const t = (await db.query.tasks.findFirst({ where: and(eq(S.tasks.leadId, ins.leadId!), eq(S.tasks.kind, "quote")) }))!;
      expect(t.title).toMatch(/^Price the quote for /);
    }
    expect(await db.query.quotes.findFirst({ where: eq(S.quotes.leadId, ins.leadId!) })).toBeUndefined();
    // Facts came from the form, with evidence, and fed the Brain.
    const lead = (await db.query.leads.findFirst({ where: eq(S.leads.id, ins.leadId!) }))!;
    expect(lead.status).toBe("new");
    const f = await db.query.facts.findMany({ where: eq(S.facts.leadId, ins.leadId!) });
    expect(f.find((x) => x.key === "camera_count")).toMatchObject({ value: 2, state: "applied" });
    expect(f.find((x) => x.key === "storeys")).toMatchObject({ value: 2, state: "applied" });
    const a = (await db.query.cctvAssessments.findFirst({ where: eq(S.cctvAssessments.leadId, ins.leadId!) }))!;
    expect(a.input).toMatchObject({ cameraCount: 2, storeys: 2, propertyType: "residential", jobType: "new" });
    // Advisories: two storeys, and the old rules' different reading, logged but not used.
    const v = ins.validation as { advisories: { rule: string }[]; headline: { recommended: string } };
    expect(v.headline.recommended).toBe("PREPARE_QUOTE");
    expect(v.advisories.map((x) => x.rule)).toContain("two_storey_complexity");
    expect((ins.rulesView as { primaryIntent: string }).primaryIntent).toBeTruthy();
    // Audit: the run records the model, the context it was given, the recommendation and the outcome.
    const run = (await runFor(ins.id))!;
    expect(run).toMatchObject({ status: "ok", model: "stand-in-hermes", runtime: "test-hermes", recommendedAction: "PREPARE_QUOTE", version: "hermes-inspector-1" });
    expect(Number(run.confidence)).toBeCloseTo(0.94);
    expect(run.contextRefs).toMatchObject({ leadId: ins.leadId, source: { type: "email", id: e.id } });
    expect((run.brainResult as { steps: { type: string }[] }).steps.map((s) => s.type)).toContain("RUN_BUSINESS_BRAIN");
    expect(run.finalActions!.length).toBeGreaterThan(0);
  });

  it("priced: the Brain has approved data → quote and reply prepared for approval, the lead still New, nothing sent", async () => {
    const itPlus = (await db.query.suppliers.findFirst({ where: eq(S.suppliers.name, "IT Plus") }))!;
    // TEST VALUE trade prices for the VIGI range and drives, entered by Chris; put back afterwards.
    const rows = [...(await db.select().from(S.products).where(eq(S.products.family, "TP-Link VIGI"))), ...(await db.select().from(S.products).where(eq(S.products.category, "hdd")))];
    for (const row of rows) {
      const cost = row.category === "camera" ? 120 : row.category === "nvr" ? 210 : row.category === "hdd" ? 60 + 25 * Number((row.specs as { capacityTb?: number }).capacityTb ?? 1) : null;
      if (cost == null) continue;
      offerIds.push((await brain.recordSupplierPrice({ productId: row.id, supplierId: itPlus.id, costExGst: cost, stock: "In stock", source: "integration test" }, chris)).offerId);
    }
    pkgBefore = (await db.query.installationPackages.findFirst({ where: eq(S.installationPackages.key, "RES_CCTV_SINGLE_4") }))!;
    await db.update(S.installationPackages).set({ estimatedHours: "6.00", labourRate: "95.00", materialCostExGst: "80.00", complexityAllowanceExGst: "0.00", allowanceExGst: "790.00", status: "getsecure_approved" }).where(eq(S.installationPackages.key, "RES_CCTV_SINGLE_4"));

    script = () => landingReading(4, 1, `12 Kauri Street, Grey Lynn ${RUN}`);
    const e = await email({ from: "noreply@updates.getsecure.co.nz", name: "Get Secure Website", subject: "New Lead · CCTV Landing", text: landingForm({ name: "Aroha Ngata", email: `aroha+${RUN}@example.com`, phone: "021 555 0177", cameras: 4, storeys: "Single storey", address: `12 Kauri Street, Grey Lynn ${RUN}` }) });
    await processEmail(e.id);
    await settleInspectorQueue();
    const ins = (await latestFor(e.id))!;
    leadIds.push(ins.leadId!);
    const acts = await actionsOf(ins.id);
    const pq = acts.find((a) => a.type === "PREPARE_QUOTE")!;
    expect(pq.status).toBe("done");
    const q = (await db.query.quotes.findFirst({ where: eq(S.quotes.id, String((pq.result as { quoteId: string }).quoteId)) }))!;
    expect(q.status).toBe("needs_review");
    const d = (await db.query.drafts.findFirst({ where: eq(S.drafts.leadId, ins.leadId!) }))!;
    expect(d.status).toBe("ready_for_review");
    expect((await db.query.leads.findFirst({ where: eq(S.leads.id, ins.leadId!) }))!.status).toBe("new");
    // The system can never send it.
    await expect(sendDraft(d.id, INSPECTOR_ACTOR)).rejects.toBeInstanceOf(GuardrailError);
    await expect(sendDraft(d.id, { kind: "agent", agent: "hermes" })).rejects.toBeInstanceOf(GuardrailError);
  });

  it("the context Hermes gets carries no supplier, cost, margin or credential data", async () => {
    script = () => landingReading(4, 1, "1 Test Street");
    const lead = leadIds[leadIds.length - 1];
    const e = await email({ from: `aroha+${RUN}@example.com`, name: "Aroha Ngata", subject: "Re: CCTV", text: "Any update on the quote?" });
    await db.update(S.emails).set({ leadId: lead }).where(eq(S.emails.id, e.id));
    await inspect("email", e.id);
    const json = JSON.stringify(packs[0]);
    expect(packs[0].crm).toBeTruthy();
    for (const word of ["costExGst", "unitCost", "markup", "margin", "supplier", "password", "credential", "IT Plus", "internalCosting", "labourRate"]) expect(json).not.toContain(word);
  });
});

describe("Test 2: a vague residential CCTV email asks only what blocks a quote", () => {
  it("Hermes sees an enquiry; the reply asks the blocking questions and nothing optional", async () => {
    script = () => ({
      intent: "quote_request",
      property_type: null,
      summary: "Wants a price for security cameras; nothing else known.",
      missing: [
        { field: "property_type", label: "Home or business", blocking: true, for: "quote", reason: "Decides the design.", question: "Is this for your home or for a business?" },
        { field: "camera_count", label: "Cameras or areas", blocking: true, for: "quote", reason: "Sizes the system.", question: "Roughly how many cameras, or which areas would you like covered?" },
        { field: "storeys", label: "Storeys", blocking: true, for: "quote", reason: "Installation package.", question: "Is the property single or double storey?" },
        { field: "budget", label: "Budget", blocking: false, for: "quote", reason: "Not needed.", question: "What's your budget?" },
        { field: "site_address", label: "Address", blocking: false, for: "quote", reason: "Not needed for a quote.", question: "What's the address?" },
      ],
      recommended_action: "ASK_CUSTOMER",
      confidence: 0.88,
      reason: "A genuine CCTV enquiry with nothing to size it from yet.",
    });
    const e = await email({ from: `vague+${RUN}@example.com`, name: "Sam Vague", subject: "Cameras", text: "Hi there, how much for some security cameras?" });
    await processEmail(e.id);
    await settleInspectorQueue();
    const ins = (await latestFor(e.id))!;
    leadIds.push(ins.leadId!);
    const acts = await actionsOf(ins.id);
    expect(acts.map((a) => a.type)).not.toContain("PREPARE_QUOTE");
    const ask = acts.find((a) => a.type === "DRAFT_EMAIL")!;
    const d = (await db.query.drafts.findFirst({ where: eq(S.drafts.id, String((ask.result as { draftId: string }).draftId)) }))!;
    expect(d.status).toBe("ready_for_review");
    expect(d.body).toMatch(/home or for a business/);
    expect(d.body).toMatch(/single or double storey/);
    expect(d.body).not.toMatch(/budget|address/i);
    expect((ins.validation as { advisories: { rule: string }[] }).advisories.map((a) => a.rule)).toContain("non_blocking_gaps");
  });
});

describe("Test 3: commercial CCTV — Hermes understands it, the Business Brain policy still decides", () => {
  it("Hermes recommends a quote; commercial CCTV goes to a site visit proposal for Chris instead", async () => {
    script = () => ({
      property_type: "commercial",
      summary: "Commercial CCTV for a warehouse, around 10 cameras.",
      facts: [
        { key: "property_type", value: "commercial", evidence: "CCTV for our warehouse", confidence: 0.95 },
        { key: "camera_count", value: 10, evidence: "Around 10 cameras", confidence: 0.85 },
        { key: "site_address", value: "5 Allens Road, East Tamaki", evidence: "5 Allens Road, East Tamaki", confidence: 0.95 },
      ],
      recommended_action: "PREPARE_QUOTE",
      run_business_brain: true,
      confidence: 0.9,
      reason: "Clear commercial CCTV enquiry with size and address.",
    });
    const e = await email({ from: `biz+${RUN}@example.com`, name: "Pat Warehouse", subject: "Warehouse CCTV", text: "We need CCTV for our warehouse at 5 Allens Road, East Tamaki. Around 10 cameras." });
    await processEmail(e.id);
    await settleInspectorQueue();
    const ins = (await latestFor(e.id))!;
    leadIds.push(ins.leadId!);
    const acts = await actionsOf(ins.id);
    expect(acts.map((a) => a.type)).not.toContain("RUN_BUSINESS_BRAIN");
    const sv = acts.find((a) => a.type === "PROPOSE_SITE_VISIT")!;
    expect(sv).toMatchObject({ status: "awaiting_approval", rule: "commercial_cctv_site_visit" });
    const v = ins.validation as { business: { rule: string }[]; headline: { recommended: string; final: string; changedBy: string } };
    expect(v.headline).toMatchObject({ recommended: "PREPARE_QUOTE", final: "PROPOSE_SITE_VISIT", changedBy: "commercial_cctv_site_visit" });
    // Accepting makes Chris's task; nothing is booked or confirmed.
    const before = await db.select().from(S.events).where(eq(S.events.leadId, ins.leadId!));
    await acceptAction(sv.id, chris);
    expect(await db.query.tasks.findFirst({ where: and(eq(S.tasks.leadId, ins.leadId!), eq(S.tasks.title, "Arrange a site visit")) })).toBeTruthy();
    expect(await db.select().from(S.events).where(eq(S.events.leadId, ins.leadId!))).toHaveLength(before.length);
    const fb = await db.query.inspectorFeedback.findFirst({ where: and(eq(S.inspectorFeedback.inspectionId, ins.id), eq(S.inspectorFeedback.kind, "action_accepted")) });
    expect(fb).toMatchObject({ subject: "PROPOSE_SITE_VISIT", hermesRecommendation: "PREPARE_QUOTE" });
  });
});

describe("Test 4: ambiguous identity — Hermes may suggest, the hard rule decides", () => {
  it("a name alone: Hermes's suggestion is shown, nothing is written until Chris confirms", async () => {
    const [l] = await db.insert(S.leads).values({ name: `Hemi Walker`, email: `hemi+${RUN}@example.com`, status: "new", source: "phone", service: "CCTV" }).returning();
    leadIds.push(l.id);
    script = (pack) => ({
      summary: "Hemi Walker wants 4 cameras, single storey.",
      facts: [
        { key: "camera_count", value: 4, evidence: "We want 4 cameras for the house", confidence: 0.9 },
        { key: "storeys", value: 1, evidence: "single storey", confidence: 0.9 },
      ],
      identity: { suggestion: "candidate", candidate_key: pack.identity.candidates[0]?.key ?? null, reason: "Same name as the lead." },
      recommended_action: "PREPARE_QUOTE",
      run_business_brain: true,
      confidence: 0.95,
      reason: "Clear request.",
    });
    const r = await recording("Site chat", ["Speaker 1: Hi it's Chris from Get Secure.", "Speaker 2: Hi, Hemi Walker here. We want 4 cameras for the house, single storey."].join("\n"));
    const out = (await inspect("recording", r.id))!;
    expect(out).toMatchObject({ engine: "hermes", status: "needs_review" });
    const acts = await actionsOf(out.inspectionId);
    expect(acts.map((a) => [a.type, a.status])).toEqual([
      ["NEEDS_REVIEW", "awaiting_approval"],
      ["LINK_RECORDING", "awaiting_approval"],
    ]);
    const p = acts[0].payload as { kind: string; hermesSuggestion: { key: string }; candidates: { leadId: string; signals: { kind: string }[] }[] };
    expect(p.kind).toBe("identity");
    expect(p.hermesSuggestion.key).toBe(`lead:${l.id}`);
    expect(p.candidates.find((c) => c.leadId === l.id)!.signals.map((s) => s.kind)).toEqual(["name"]);
    expect(await db.query.facts.findMany({ where: eq(S.facts.leadId, l.id) })).toHaveLength(0);
    expect((await db.query.recordings.findFirst({ where: eq(S.recordings.id, r.id) }))!.status).toBe("review");
    expect(await db.query.cctvAssessments.findFirst({ where: eq(S.cctvAssessments.leadId, l.id) })).toBeUndefined();

    // Chris confirms: read again with the identity confirmed, now filed and acted on.
    script = () => ({ summary: "Hemi Walker wants 4 cameras, single storey.", facts: [{ key: "camera_count", value: 4, evidence: "We want 4 cameras for the house", confidence: 0.9 }], recommended_action: "CREATE_INTERNAL_TASK", task: { title: "Call Hemi about the cameras", due: "today", detail: null }, confidence: 0.9, reason: "Follow up the conversation." });
    const after = (await confirmIdentity(out.inspectionId, { leadId: l.id }, chris))!;
    expect(after).toMatchObject({ status: "analysed", engine: "hermes" });
    expect((await db.query.recordings.findFirst({ where: eq(S.recordings.id, r.id) }))!).toMatchObject({ status: "attached", leadId: l.id });
    expect((await db.query.facts.findMany({ where: eq(S.facts.leadId, l.id) })).map((f) => f.key)).toContain("camera_count");
    const fb = await db.query.inspectorFeedback.findFirst({ where: and(eq(S.inspectorFeedback.inspectionId, out.inspectionId), eq(S.inspectorFeedback.kind, "identity_confirmed")) });
    expect(fb).toBeTruthy();
  });
});

describe("Test 5: a conflicting address is surfaced, never overwritten", () => {
  it("the new address waits for Chris with both values and the evidence", async () => {
    const [l] = await db.insert(S.leads).values({ name: `Rewi Conflict ${RUN}`, email: `rewi+${RUN}@example.com`, site: "12 Kauri Street, Grey Lynn", status: "contacted", source: "email", service: "CCTV" }).returning();
    leadIds.push(l.id);
    script = () => ({
      conversation_type: "existing_lead",
      intent: "information",
      summary: "Corrects the site address.",
      facts: [{ key: "site_address", value: "14 Kauri Street, Grey Lynn", evidence: "the address is actually 14 Kauri Street, Grey Lynn", confidence: 0.95 }],
      conflicts: [{ key: "site_address", crm_value: "12 Kauri Street, Grey Lynn", new_value: "14 Kauri Street, Grey Lynn", evidence: "the address is actually 14 Kauri Street" }],
      recommended_action: "CREATE_INTERNAL_TASK",
      task: { title: "Check the corrected address", due: null, detail: null },
      confidence: 0.9,
      reason: "Address correction for an existing lead.",
    });
    const e = await email({ from: `rewi+${RUN}@example.com`, name: "Rewi", subject: "Address", text: "Sorry, the address is actually 14 Kauri Street, Grey Lynn." });
    await db.update(S.emails).set({ leadId: l.id }).where(eq(S.emails.id, e.id));
    await inspect("email", e.id);
    const conflict = (await db.query.facts.findFirst({ where: and(eq(S.facts.leadId, l.id), eq(S.facts.key, "site_address"), eq(S.facts.state, "conflict")) }))!;
    expect(conflict).toMatchObject({ value: "14 Kauri Street, Grey Lynn", currentValue: "12 Kauri Street, Grey Lynn", sourceType: "email", sourceId: e.id });
    expect(conflict.evidence).toMatch(/actually 14 Kauri/);
    expect((await db.query.leads.findFirst({ where: eq(S.leads.id, l.id) }))!.site).toBe("12 Kauri Street, Grey Lynn");
    // A re-read never overwrites either.
    await inspect("email", e.id, { force: true });
    expect((await db.query.leads.findFirst({ where: eq(S.leads.id, l.id) }))!.site).toBe("12 Kauri Street, Grey Lynn");
    await resolveFact(conflict.id, "apply", chris);
    expect((await db.query.leads.findFirst({ where: eq(S.leads.id, l.id) }))!.site).toBe("14 Kauri Street, Grey Lynn");
  });

  it("a fact Hermes cannot show evidence for is rejected, not written", async () => {
    const [l] = await db.insert(S.leads).values({ name: `No Evidence ${RUN}`, email: `noev+${RUN}@example.com`, status: "new", source: "email", service: "CCTV" }).returning();
    leadIds.push(l.id);
    script = () => ({ facts: [{ key: "camera_count", value: 8, evidence: "we need eight cameras", confidence: 0.9 }], recommended_action: "CREATE_INTERNAL_TASK", task: { title: "Reply", due: null, detail: null } });
    const e = await email({ from: `noev+${RUN}@example.com`, name: "N", subject: "Hello", text: "Hello, please call me about cameras." });
    await db.update(S.emails).set({ leadId: l.id }).where(eq(S.emails.id, e.id));
    const out = (await inspect("email", e.id))!;
    expect(await db.query.facts.findMany({ where: eq(S.facts.leadId, l.id) })).toHaveLength(0);
    const ins = (await db.query.inspections.findFirst({ where: eq(S.inspections.id, out.inspectionId) }))!;
    expect((ins.validation as { hard: { rule: string }[] }).hard.map((h) => h.rule)).toContain("fact_evidence");
  });
});

describe("Tests 6 and 7: commitments from a Plaud call", () => {
  const transcript = (phone: string) =>
    [
      "[00:00 - 00:06] Speaker 1: Hi, it's Chris from Get Secure.",
      `[00:06 - 00:20] Speaker 2: Hi Chris, it's Mere on ${phone}. We're after 4 cameras for the house, it's single storey.`,
      "[00:20 - 00:31] Speaker 1: Great, I'll send the quote tonight.",
      "[00:31 - 00:40] Speaker 2: Perfect, I'll send the photos tomorrow.",
    ].join("\n");
  let leadId: string;
  let recId: string;

  it("Test 6: the customer's promise is recorded, and the CRM waits on them with a check-in", async () => {
    const phone = `021 ${String(Date.now()).slice(-7)}`;
    const [l] = await db.insert(S.leads).values({ name: `Mere Tawhiri ${RUN}`, phone, status: "contacted", source: "phone", service: "CCTV" }).returning();
    leadIds.push(l.id);
    leadId = l.id;
    script = () => ({
      conversation_type: "existing_lead",
      intent: "follow_up",
      summary: "Call with Mere: 4 cameras, single storey. Chris will send the quote tonight; Mere will send photos tomorrow.",
      commitments: [
        { owner: "get_secure", owner_name: "Chris", action: "Send the quote", action_key: "send_quote", due_text: "tonight", due_at: null, evidence: "I'll send the quote tonight" },
        { owner: "customer", owner_name: "Mere", action: "Send the photos", action_key: "send_photos", due_text: "tomorrow", due_at: null, evidence: "I'll send the photos tomorrow" },
      ],
      recommended_action: "WAITING_ON_CUSTOMER",
      confidence: 0.9,
      reason: "Waiting on photos from Mere; Chris promised the quote tonight.",
    });
    const r = await recording("Call with Mere", transcript(phone));
    recId = r.id;
    const out = (await inspect("recording", r.id))!;
    expect(out).toMatchObject({ engine: "hermes", status: "analysed" });
    expect((await db.query.recordings.findFirst({ where: eq(S.recordings.id, r.id) }))!).toMatchObject({ status: "attached", leadId: l.id });
    const cs = await db.query.commitments.findMany({ where: eq(S.commitments.sourceId, r.id) });
    const theirs = cs.find((c) => c.owner === "customer")!;
    expect(theirs).toMatchObject({ actionKey: "send_photos", dueText: "tomorrow", status: "outstanding", leadId: l.id, sourceType: "recording" });
    expect(theirs.dueAt!.toISOString()).toBe("2031-03-06T04:00:00.000Z"); // 5pm the next day, Auckland
    const check = (await actionsOf(out.inspectionId)).find((a) => a.type === "PREPARE_FOLLOW_UP")!;
    expect(check).toMatchObject({ status: "done", rule: "waiting_on_customer" });
    const t = (await db.query.tasks.findFirst({ where: eq(S.tasks.id, String((check.result as { taskId: string }).taskId)) }))!;
    expect(t.title).toMatch(/^Check: customer said they'd send the photos/);
  });

  it("Test 7: Chris's promise becomes a commitment due tonight, on Today", async () => {
    const cs = await db.query.commitments.findMany({ where: eq(S.commitments.sourceId, recId) });
    const ours = cs.find((c) => c.owner === "get_secure")!;
    expect(ours).toMatchObject({ actionKey: "send_quote", dueText: "tonight", status: "outstanding", leadId, ownerName: "Chris" });
    expect(ours.dueAt!.toISOString()).toBe("2031-03-05T08:00:00.000Z"); // 9pm the same day, Auckland
    const today = await getOutstandingCommitments();
    expect(today.map((c) => c.commitment.id)).toContain(ours.id);
    await setCommitmentStatus(ours.id, "done", chris);
    expect(await db.query.inspectorFeedback.findFirst({ where: and(eq(S.inspectorFeedback.leadId, leadId), eq(S.inspectorFeedback.kind, "commitment_done")) })).toBeTruthy();
  });
});

describe("Test 8: Hermes unavailable — kept, reviewed, never 'no action'", () => {
  it("unreachable: fallback reading, NEEDS_REVIEW, retried later; then Hermes's reading replaces it", async () => {
    script = () => new HermesUnavailableError("Hermes could not be reached: connect ECONNREFUSED", "network");
    const e = await email({ from: `down+${RUN}@example.com`, name: "Down Test", subject: "Quote for cameras", text: "Hi, could I get a quote for 4 cameras for my house? It's single storey." });
    await processEmail(e.id);
    await settleInspectorQueue();
    const ins = (await latestFor(e.id))!;
    leadIds.push(ins.leadId!);
    expect(ins).toMatchObject({ engine: "fallback", status: "needs_review", reviewKind: "hermes_unavailable" });
    const acts = await actionsOf(ins.id);
    expect(acts.map((a) => a.type)).not.toContain("NO_ACTION");
    expect(acts.map((a) => a.type)).not.toContain("RUN_BUSINESS_BRAIN");
    expect(acts.find((a) => a.type === "NEEDS_REVIEW")).toMatchObject({ status: "awaiting_approval", rule: "hermes_unavailable" });
    // Deterministic extraction used where safe: blank facts filled, with evidence.
    expect((await db.query.facts.findMany({ where: eq(S.facts.leadId, ins.leadId!) })).map((f) => f.key)).toContain("camera_count");
    expect(await runFor(ins.id)).toMatchObject({ status: "unavailable" });
    const q = (await db.query.inspectorQueue.findFirst({ where: eq(S.inspectorQueue.sourceId, e.id) }))!;
    expect(q.attempts).toBe(1);
    expect(q.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 4 * 60_000);

    // Hermes is back: the retry replaces the fallback (Chris had not dealt with it yet).
    script = () => ({ intent: "quote_request", facts: [{ key: "camera_count", value: 4, evidence: "4 cameras for my house", confidence: 0.95 }], recommended_action: "CREATE_INTERNAL_TASK", task: { title: "Ring about the quote", due: null, detail: null }, confidence: 0.9 });
    await db.update(S.inspectorQueue).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(S.inspectorQueue.id, q.id));
    await settleInspectorQueue();
    const again = (await latestFor(e.id))!;
    expect(again).toMatchObject({ engine: "hermes", status: "analysed" });
    expect(await db.query.inspectorQueue.findFirst({ where: eq(S.inspectorQueue.sourceId, e.id) })).toBeUndefined();
  });

  it("unusable output twice (after one repair attempt): fallback, the excerpt kept for diagnosis", async () => {
    script = () => "Sure! I think this is probably a lead, let me know.";
    const [l] = await db.insert(S.leads).values({ name: `Bad Output ${RUN}`, email: `bad+${RUN}@example.com`, status: "new", source: "email", service: "CCTV" }).returning();
    leadIds.push(l.id);
    const e = await email({ from: `bad+${RUN}@example.com`, name: "Bad", subject: "Cameras", text: "Could you quote 3 cameras?" });
    await db.update(S.emails).set({ leadId: l.id }).where(eq(S.emails.id, e.id));
    const out = (await inspect("email", e.id))!;
    expect(calls).toBe(2);
    expect(out).toMatchObject({ engine: "fallback", status: "needs_review", hermesStatus: "invalid_output" });
    const run = (await runFor(out.inspectionId))!;
    expect(run.rawExcerpt).toMatch(/probably a lead/);
    await resolveReview(out.inspectionId, chris, "handled by phone");
    expect((await db.query.inspections.findFirst({ where: eq(S.inspections.id, out.inspectionId) }))!.status).toBe("analysed");
  });

  it("not connected: fallback to review, no retries queued", async () => {
    setHermes(null);
    try {
      const [l] = await db.insert(S.leads).values({ name: `Off ${RUN}`, email: `off+${RUN}@example.com`, status: "new", source: "email", service: "CCTV" }).returning();
      leadIds.push(l.id);
      const e = await email({ from: `off+${RUN}@example.com`, name: "Off", subject: "Cameras", text: "Quote please for 2 cameras." });
      await db.update(S.emails).set({ leadId: l.id }).where(eq(S.emails.id, e.id));
      await enqueueInspection("email", e.id);
      await settleInspectorQueue();
      const ins = (await latestFor(e.id))!;
      expect(ins).toMatchObject({ engine: "fallback", reviewKind: "hermes_unavailable" });
      expect(await runFor(ins.id)).toMatchObject({ status: "not_configured" });
      expect(await db.query.inspectorQueue.findFirst({ where: eq(S.inspectorQueue.sourceId, e.id) })).toBeUndefined();
    } finally {
      useStandInHermes();
    }
  });

  it("the real HTTP runtime: timeout, HTTP error and prose-wrapped JSON against a stand-in Hermes Agent server", async () => {
    let mode: "slow" | "500" | "ok" = "slow";
    const seen: { auth?: string; session?: string; idem?: string; body?: { model: string; messages: unknown[] } } = {};
    const server: Server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.auth = req.headers.authorization;
        seen.session = String(req.headers["x-hermes-session-key"]);
        seen.idem = String(req.headers["idempotency-key"]);
        seen.body = JSON.parse(body);
        if (mode === "slow") return; // never answers
        if (mode === "500") return void res.writeHead(500).end("boom");
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ model: "hermes-agent", choices: [{ message: { content: `Here you go:\n\`\`\`json\n${JSON.stringify(R({ recommended_action: "NEEDS_REVIEW" }))}\n\`\`\`` } }] }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const rt = new HermesApiRuntime(`http://127.0.0.1:${port}`, "test-key-not-secret", "hermes-agent", 300);
      const msgs = [{ role: "user" as const, content: "x" }];
      await expect(rt.complete(msgs, { idempotencyKey: "k1" })).rejects.toMatchObject({ kind: "timeout" });
      mode = "500";
      await expect(rt.complete(msgs, { idempotencyKey: "k2" })).rejects.toMatchObject({ kind: "http" });
      mode = "ok";
      const reply = await rt.complete(msgs, { idempotencyKey: "k3" });
      expect(seen).toMatchObject({ auth: "Bearer test-key-not-secret", session: "getsecure-crm-inspector", idem: "k3" });
      expect(seen.body!.model).toBe("hermes-agent");
      const { parseHermesResult } = await import("@/lib/hermes/contract");
      expect(parseHermesResult(reply.text).recommended_action).toBe("NEEDS_REVIEW");
    } finally {
      server.close();
    }
  });
});

describe("other guardrails", () => {
  it("a reply quoting a price is never prepared: held back, Chris gets a task", async () => {
    const [l] = await db.insert(S.leads).values({ name: `Price Draft ${RUN}`, email: `pricedraft+${RUN}@example.com`, status: "new", source: "email", service: "CCTV" }).returning();
    leadIds.push(l.id);
    script = () => ({ intent: "question", recommended_action: "DRAFT_REPLY", reply_draft: { subject: null, body: "Hi, a 4 camera system would be about $1,890 incl GST. Thanks, Chris" }, confidence: 0.9 });
    const e = await email({ from: `pricedraft+${RUN}@example.com`, name: "P", subject: "Price?", text: "Roughly what would 4 cameras cost?" });
    await db.update(S.emails).set({ leadId: l.id }).where(eq(S.emails.id, e.id));
    const out = (await inspect("email", e.id))!;
    expect(await db.query.drafts.findFirst({ where: eq(S.drafts.leadId, l.id) })).toBeUndefined();
    const t = (await actionsOf(out.inspectionId)).find((a) => a.type === "CREATE_INTERNAL_TASK")!;
    expect(t.rule).toBe("reply_safety");
    expect(t.reason).toMatch(/quotes a price/);
  });

  it("low confidence: the recommendation waits for Chris; accepting carries it out as Chris", async () => {
    const [l] = await db.insert(S.leads).values({ name: `Unsure ${RUN}`, email: `unsure+${RUN}@example.com`, status: "new", source: "email", service: "CCTV" }).returning();
    leadIds.push(l.id);
    script = () => ({ intent: "follow_up", recommended_action: "CREATE_INTERNAL_TASK", task: { title: `Ring the customer back ${RUN}`, due: "today", detail: null }, confidence: 0.4, reason: "Not sure what they want." });
    const e = await email({ from: `unsure+${RUN}@example.com`, name: "U", subject: "Hmm", text: "Can we talk about the thing from before?" });
    await db.update(S.emails).set({ leadId: l.id }).where(eq(S.emails.id, e.id));
    const out = (await inspect("email", e.id))!;
    expect(out).toMatchObject({ status: "needs_review" });
    const nr = (await actionsOf(out.inspectionId)).find((a) => a.type === "NEEDS_REVIEW")!;
    expect(nr.payload).toMatchObject({ kind: "hermes_low_confidence", hermesRecommendation: "CREATE_INTERNAL_TASK" });
    expect(await db.query.tasks.findFirst({ where: eq(S.tasks.title, `Ring the customer back ${RUN}`) })).toBeUndefined();
    await acceptAction(nr.id, chris);
    expect(await db.query.tasks.findFirst({ where: eq(S.tasks.title, `Ring the customer back ${RUN}`) })).toBeTruthy();
    expect((await db.query.inspections.findFirst({ where: eq(S.inspections.id, out.inspectionId) }))!.status).toBe("analysed");
  });

  it("a real enquiry is never 'no action', even if Hermes says so", async () => {
    const [l] = await db.insert(S.leads).values({ name: `Never None ${RUN}`, email: `never+${RUN}@example.com`, status: "new", source: "email", service: "CCTV" }).returning();
    leadIds.push(l.id);
    script = () => ({ intent: "new_enquiry", recommended_action: "NO_ACTION", confidence: 0.9, reason: "Looks informational." });
    const e = await email({ from: `never+${RUN}@example.com`, name: "N", subject: "Cameras", text: "Interested in cameras for home." });
    await db.update(S.emails).set({ leadId: l.id }).where(eq(S.emails.id, e.id));
    const out = (await inspect("email", e.id))!;
    expect(out).toMatchObject({ status: "needs_review" });
    expect((await actionsOf(out.inspectionId)).map((a) => a.type)).not.toContain("NO_ACTION");
  });

  it("dismissing the recording on the Recordings page closes its review", async () => {
    script = () => ({ intent: "not_relevant", conversation_type: "internal", recommended_action: "NO_ACTION", confidence: 0.9, service: null, property_type: null });
    const r = await recording("Note to self", "Speaker 1: Remember to order more cable for Tuesday.");
    const out = (await inspect("recording", r.id))!;
    expect(out.status).toBe("needs_review"); // nobody identified: identity review
    await closeReviews("recording", [r.id], chris);
    expect((await db.query.inspections.findFirst({ where: eq(S.inspections.id, out.inspectionId) }))!.status).toBe("superseded");
    expect((await db.query.recordings.findFirst({ where: eq(S.recordings.id, r.id) }))!.status).toBe("dismissed");
  });
});
