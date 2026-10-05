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


const { db } = await import("@/db");
const S = await import("@/db/schema");
const { processEmail } = await import("@/lib/email/pipeline");
const { inspect, confirmIdentity, acceptAction, resolveFact, setCommitmentStatus, closeReviews, resolveReview, acceptProposedLead } = await import("@/lib/inspector/inspect");
const { settleInspectorQueue, enqueueInspection } = await import("@/lib/inspector/queue");
const { setHermes, HermesApiRuntime, HermesUnavailableError } = await import("@/lib/hermes/runtime");
const { encryptSecret } = await import("@/lib/crypto");
const { sendDraft } = await import("@/lib/drafts/workflow");
const { GuardrailError } = await import("@/lib/guard/actor");
const { INSPECTOR_ACTOR } = await import("@/lib/inspector/router");
const { applyReferenceCatalogue, resetReferenceMarker } = await import("@/lib/brain/reference/apply");
const brain = await import("@/lib/brain/store");
const { getOutstandingCommitments } = await import("@/queries/inspector");
type HermesResult = import("@/lib/hermes/contract").HermesResult;
/** What a test scripts Hermes to say: structured evidence refs are optional, as in Hermes's own JSON. */
type Loose = Omit<Partial<HermesResult>, "facts" | "commitments"> & {
  facts?: (Omit<HermesResult["facts"][number], "evidence_ref" | "evidence"> & { evidence?: string; evidence_ref?: string | null })[];
  commitments?: (Omit<HermesResult["commitments"][number], "evidence_ref"> & { evidence_ref?: string | null })[];
};

const RUN = `hi${Date.now().toString(36)}`;
let chris: { kind: "human"; userId: string; name: string; canApprove: true };
let mailboxId: string;
const leadIds: string[] = [];
const recordingIds: string[] = [];
const contactIds: string[] = [];
const offerIds: string[] = [];
let pkgBefore: typeof S.installationPackages.$inferSelect | undefined;
let n = 0;
/** A quiet moment with nothing in the calendar, so other tests' appointments never interfere. */
const QUIET = new Date("2031-03-04T21:00:00Z"); // 10am, 5 March 2031 in Auckland

// ---------------- the stand-in Hermes ----------------

type Pack = { source: { origin: string; text: string; form: unknown }; identity: { status: string; candidates: { key: string }[] }; crm: unknown };
let script: (pack: Pack) => Loose | string | Error = () => new Error("no script");
const packs: Pack[] = [];
let calls = 0;
const R = ({ facts, commitments, ...over }: Loose): HermesResult => ({
  conversation_type: "new_enquiry",
  intent: "new_enquiry",
  service: "cctv",
  property_type: "residential",
  summary: "New enquiry",
  objections: [],
  urgency: "normal",
  missing: [],
  recommended_action: "NO_ACTION",
  run_business_brain: false,
  task: null,
  reply_draft: null,
  identity: { suggestion: "unknown", candidate_key: null, reason: "" },
  business_context: "unknown",
  counterparty: { name: null, kind: "unknown" },
  accounting: null,
  identity_review: { needed: false, reason: "" },
  lead_decision: "undecided",
  operational_context: { ref: null, reason: "" },
  resolution: { status: "open", evidence: [] },
  commitment_updates: [],
  conflicts: [],
  confidence: 0.9,
  reason: "test",
  advisories: [],
  internal_actions: [],
  research: [],
  review_question: null,
  ...over,
  facts: (facts ?? []).map((f: NonNullable<Loose["facts"]>[number]) => ({ evidence: "", evidence_ref: null, ...f })),
  commitments: (commitments ?? []).map((c: NonNullable<Loose["commitments"]>[number]) => ({ evidence_ref: null, ...c })),
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
  useStandInHermes();
});

beforeEach(() => {
  packs.length = 0;
  calls = 0;
});

afterAll(async () => {
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
  if (contactIds.length) {
    await db.delete(S.tasks).where(inArray(S.tasks.contactId, contactIds));
    await db.delete(S.contacts).where(inArray(S.contacts.id, contactIds));
  }
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
const landingReading = (cams: number, storeys: number, address: string): Loose => ({
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
    expect(v.advisories.map((x) => x.rule)).not.toContain("two_storey_complexity"); // the Brain allows for storeys itself
    // Audit: the run records the model, the context it was given, the recommendation and the outcome.
    const run = (await runFor(ins.id))!;
    expect(run).toMatchObject({ status: "ok", model: "stand-in-hermes", runtime: "test-hermes", recommendedAction: "PREPARE_QUOTE", version: "hermes-inspector-4" });
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

  it("the context Hermes gets carries no supplier pricing, cost, margin or credential data (supplier names only, for routing)", async () => {
    script = () => landingReading(4, 1, "1 Test Street");
    const lead = leadIds[leadIds.length - 1];
    const e = await email({ from: `aroha+${RUN}@example.com`, name: "Aroha Ngata", subject: "Re: CCTV", text: "Any update on the quote?" });
    await db.update(S.emails).set({ leadId: lead }).where(eq(S.emails.id, e.id));
    await inspect("email", e.id);
    const json = JSON.stringify(packs[0]);
    expect(packs[0].crm).toBeTruthy();
    for (const word of ["costExGst", "unitCost", "tradeCost", "supplierSku", "markup", "margin", "password", "credential", "secret", "username", "internalCosting", "labourRate"]) expect(json).not.toContain(word);
    // Suppliers appear by name and website only, so Hermes can recognise supplier mail.
    for (const s of (packs[0] as unknown as { business: { suppliers: Record<string, unknown>[] } }).business.suppliers) expect(Object.keys(s).sort()).toEqual(["name", "website"]);
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

describe("Test 3: commercial CCTV — Hermes understands it, the Business Brain itself decides the site visit", () => {
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
    // The validator does not second-guess it: the Brain runs, requires the visit, and no quote is made.
    expect(acts.find((a) => a.type === "RUN_BUSINESS_BRAIN")).toMatchObject({ status: "done", result: { siteVisitRequired: true } });
    expect(acts.find((a) => a.type === "PREPARE_QUOTE")).toMatchObject({ status: "blocked" });
    expect(await db.query.quotes.findFirst({ where: eq(S.quotes.leadId, ins.leadId!) })).toBeUndefined();
    const sv = acts.find((a) => a.type === "PROPOSE_SITE_VISIT")!;
    expect(sv).toMatchObject({ status: "awaiting_approval", rule: "business_brain_site_visit" });
    expect(String(sv.reason)).toMatch(/Commercial CCTV always needs a site visit/);
    const v = ins.validation as { business: { rule: string }[]; headline: { recommended: string; final: string; changedBy: string | null } };
    expect(v.business).toEqual([]);
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
  it("the number said at the end of a call, in words: the CRM matches it first and files the recording with what Hermes did", async () => {
    const phone = `021 ${String(Date.now()).slice(-7)}`;
    const WORDS: Record<string, string> = { "0": "oh", "1": "one", "2": "two", "3": "three", "4": "four", "5": "five", "6": "six", "7": "seven", "8": "eight", "9": "nine" };
    const said = phone.replace(/\D/g, "").split("").map((d) => WORDS[d]).join(" ");
    const [l] = await db.insert(S.leads).values({ name: `Aroha Ngata ${RUN}`, phone, status: "contacted", source: "phone", service: "CCTV" }).returning();
    leadIds.push(l.id);
    script = () => ({ conversation_type: "existing_lead", intent: "follow_up", summary: "Aroha wants the two side cameras moved; Chris will call back.", recommended_action: "CREATE_INTERNAL_TASK", task: { title: `Call Aroha about moving the side cameras ${RUN}`, due: "today", detail: null }, confidence: 0.9, reason: "Follow-up from the call." });
    const r = await recording("Site visit chat", ["Speaker 1: Hi it's Chris from Get Secure.", "Speaker 2: Could the two side cameras move to cover the gate?", "Speaker 1: Sure, I'll call you back about it.", `Speaker 1: Customer's number for the file: ${said}.`].join("\n"));
    const out = (await inspect("recording", r.id))!;
    expect(out).toMatchObject({ engine: "hermes", status: "analysed" });
    expect((await db.query.recordings.findFirst({ where: eq(S.recordings.id, r.id) }))!).toMatchObject({ status: "attached", leadId: l.id });
    expect((await db.query.tasks.findFirst({ where: eq(S.tasks.title, `Call Aroha about moving the side cameras ${RUN}`) }))!.leadId).toBe(l.id);
    // The lead's timeline carries the reading and what was done about it.
    const entry = (await db.query.activityLog.findFirst({ where: and(eq(S.activityLog.entityId, l.id), eq(S.activityLog.action, "inspected")), orderBy: [desc(S.activityLog.createdAt)] }))!;
    expect((entry.detail as { actions: { type: string; status: string }[] }).actions).toEqual(expect.arrayContaining([expect.objectContaining({ type: "CREATE_INTERNAL_TASK", status: "done" }), expect.objectContaining({ type: "LINK_RECORDING", status: "done" })]));
  });

  it("a number the CRM could not read but Hermes did, verbatim: it goes through the same phone rule and files the recording", async () => {
    const phone = `027 ${String(Date.now()).slice(-7)}`;
    const WORDS: Record<string, string> = { "0": "oh", "1": "one", "2": "two", "3": "three", "4": "four", "5": "five", "6": "six", "7": "seven", "8": "eight", "9": "nine" };
    const w = phone.replace(/\D/g, "").split("").map((d) => WORDS[d]);
    const said = `${w.slice(0, 3).join(", ")}, um, ${w.slice(3, 6).join(" ")}, then ${w.slice(6).join(" ")}`; // broken up by fillers: no unbroken run for the CRM
    const [c] = await db.insert(S.contacts).values({ name: `Rangi Parata ${RUN}`, phone }).returning();
    contactIds.push(c.id);
    script = () => ({ conversation_type: "existing_customer", intent: "service_issue", summary: "Rangi's keypad beeps at night.", facts: [{ key: "phone", value: phone, evidence: said, confidence: 0.9 }], recommended_action: "CREATE_INTERNAL_TASK", task: { title: `Check Rangi's keypad ${RUN}`, due: "today", detail: null }, confidence: 0.9, reason: "Service issue on an existing system." });
    const r = await recording("Call", ["Speaker 2: The keypad beeps every night around two.", `Speaker 1: Noted. And your number is ${said}?`, "Speaker 2: That's it."].join("\n"));
    const out = (await inspect("recording", r.id))!;
    expect(out).toMatchObject({ engine: "hermes", status: "analysed" });
    expect((await db.query.recordings.findFirst({ where: eq(S.recordings.id, r.id) }))!).toMatchObject({ status: "attached", contactId: c.id });
    expect((await db.query.tasks.findFirst({ where: eq(S.tasks.title, `Check Rangi's keypad ${RUN}`) }))!.contactId).toBe(c.id);
    const ins = (await latestFor(r.id))!;
    expect((ins.identity as { reason: string }).reason).toMatch(/read by Hermes/);

    // A number that is not in the words does nothing: Hermes cannot file a recording by assertion.
    script = () => ({ conversation_type: "existing_customer", intent: "service_issue", summary: "Keypad beeps.", facts: [{ key: "phone", value: phone, evidence: "your number is on file", confidence: 0.9 }], recommended_action: "CREATE_INTERNAL_TASK", task: { title: `Check the keypad again ${RUN}`, due: "today", detail: null }, confidence: 0.9, reason: "Service issue." });
    const r2 = await recording("Call 2", ["Speaker 2: The keypad still beeps.", "Speaker 1: Noted, your number is on file."].join("\n"));
    const out2 = (await inspect("recording", r2.id))!;
    expect((await db.query.recordings.findFirst({ where: eq(S.recordings.id, r2.id) }))!.status).toBe("review");
    expect(out2.status).toBe("analysed"); // the task still goes ahead, unfiled
  });

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
      ["ADD_INTERNAL_NOTE", "done"],
      ["NEEDS_REVIEW", "awaiting_approval"],
      ["LINK_RECORDING", "awaiting_approval"],
    ]);
    const p = acts[1].payload as { kind: string; hermesSuggestion: { key: string }; waitingFor: string[]; candidates: { leadId: string; signals: { kind: string }[] }[] };
    expect(p.kind).toBe("identity");
    expect(p.waitingFor).toEqual(["RUN_BUSINESS_BRAIN", "PREPARE_QUOTE"]);
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
    expect(ins).toMatchObject({ engine: "fallback", status: "needs_review", reviewKind: "hermes_unavailable", leadId: null });
    const acts = await actionsOf(ins.id);
    expect(acts.map((a) => a.type)).not.toContain("NO_ACTION");
    expect(acts.map((a) => a.type)).not.toContain("RUN_BUSINESS_BRAIN");
    expect(acts.find((a) => a.type === "NEEDS_REVIEW")).toMatchObject({ status: "awaiting_approval", rule: "hermes_unavailable" });
    // Nothing is invented without Hermes: no lead, no facts; the email waits for Chris.
    expect(await db.query.leads.findFirst({ where: eq(S.leads.sourceEmailId, e.id) })).toBeUndefined();
    expect((await db.query.emails.findFirst({ where: eq(S.emails.id, e.id) }))!.classification).toBe("needs_review");
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
    // A quote request from a new sender: the lead is made from Hermes's reading, with its facts.
    expect(again.leadId).toBeTruthy();
    leadIds.push(again.leadId!);
    expect((await db.query.facts.findMany({ where: eq(S.facts.leadId, again.leadId!) })).map((f) => f.key)).toContain("camera_count");
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

  it("low confidence: internal work still goes ahead; what prepares customer output waits for Chris, and accepting carries it out as Chris", async () => {
    const [l] = await db.insert(S.leads).values({ name: `Unsure ${RUN}`, email: `unsure+${RUN}@example.com`, status: "new", source: "email", service: "CCTV" }).returning();
    leadIds.push(l.id);
    script = () => ({ intent: "follow_up", recommended_action: "DRAFT_REPLY", reply_draft: { subject: "Re: Hmm", body: "Thanks, could you tell me a bit more about what you need?" }, internal_actions: [{ action: "CREATE_INTERNAL_TASK", title: `Ring the customer back ${RUN}`, due: "today", detail: null, reason: "check" }], confidence: 0.4, reason: "Not sure what they want." });
    const e = await email({ from: `unsure+${RUN}@example.com`, name: "U", subject: "Hmm", text: "Can we talk about the thing from before?" });
    await db.update(S.emails).set({ leadId: l.id }).where(eq(S.emails.id, e.id));
    const out = (await inspect("email", e.id))!;
    expect(out).toMatchObject({ status: "needs_review" });
    const nr = (await actionsOf(out.inspectionId)).find((a) => a.type === "NEEDS_REVIEW")!;
    expect(nr.payload).toMatchObject({ kind: "hermes_low_confidence", hermesRecommendation: "DRAFT_REPLY" });
    expect(await db.query.tasks.findFirst({ where: eq(S.tasks.title, `Ring the customer back ${RUN}`) })).toBeTruthy();
    expect(await db.query.drafts.findFirst({ where: eq(S.drafts.leadId, l.id) })).toBeUndefined();
    await acceptAction(nr.id, chris);
    expect(await db.query.drafts.findFirst({ where: eq(S.drafts.leadId, l.id) })).toBeTruthy();
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
    // A note to self needs nobody identified: nothing for Chris.
    script = () => ({ intent: "not_relevant", conversation_type: "internal", business_context: "internal_admin", recommended_action: "NO_ACTION", confidence: 0.9, service: null, property_type: null });
    const note = await recording("Note to self", "Speaker 1: Remember to order more cable for Tuesday.");
    expect((await inspect("recording", note.id))!.status).toBe("analysed");
    // A customer conversation nobody can place, whose next step needs the customer, waits in "Who is this?"; dismissing the recording closes it.
    script = () => ({ intent: "follow_up", conversation_type: "existing_customer", business_context: "existing_work", recommended_action: "PROPOSE_SITE_VISIT", confidence: 0.9, service: "cctv", property_type: null });
    const r = await recording("Customer call", "Speaker 1: Hi it's me again about the cameras. Speaker 2: Sure, I'll ring you back.");
    const out = (await inspect("recording", r.id))!;
    expect(out.status).toBe("needs_review"); // existing customer work, nobody identified
    await closeReviews("recording", [r.id], chris);
    expect((await db.query.inspections.findFirst({ where: eq(S.inspections.id, out.inspectionId) }))!.status).toBe("superseded");
    expect((await db.query.recordings.findFirst({ where: eq(S.recordings.id, r.id) }))!.status).toBe("dismissed");
  });
});

describe("Hermes decides lead / not lead (audited and reversible); the CRM files mechanically first", () => {
  const enquiry = (confidence: number): Loose => ({ intent: "quote_request", lead_decision: "lead", summary: "Wants cameras for a shop.", recommended_action: "CREATE_INTERNAL_TASK", task: { title: `Ring about the shop cameras ${RUN}`, due: null, detail: null }, facts: [{ key: "contact_name", value: "Shop Owner", evidence: "", evidence_ref: "email:from", confidence: 0.9 }, { key: "site_address", value: "5 Depot Road, Penrose", evidence: "5 Depot Road, Penrose", confidence: 0.9 }], service: "cctv", confidence, reason: "A shop owner asking for 6 cameras." });

  it("an unknown sender's email is 'reading' until Hermes decides; sure it is a lead → the lead is created from Hermes's reading", async () => {
    script = () => enquiry(0.9);
    const e = await email({ from: `hermeslead+${RUN}@example.com`, name: "Shop Owner", subject: "Re: your flyer", text: "Saw your flyer. We'd like 6 cameras for the shop at 5 Depot Road, Penrose, can someone call me?" });
    expect((await processEmail(e.id)).classification).toBe("reading");
    expect((await db.query.emails.findFirst({ where: eq(S.emails.id, e.id) }))!.classification).toBe("reading");
    await settleInspectorQueue();
    const lead = (await db.query.leads.findFirst({ where: eq(S.leads.sourceEmailId, e.id) }))!;
    leadIds.push(lead.id);
    expect(lead).toMatchObject({ status: "new", createdById: null, name: "Shop Owner", site: "5 Depot Road, Penrose", summary: "Wants cameras for a shop.", nextAction: "Create a task" });
    expect(Number(lead.aiConfidence)).toBeCloseTo(0.9);
    expect((await db.query.emails.findFirst({ where: eq(S.emails.id, e.id) }))!).toMatchObject({ classification: "lead", leadId: lead.id });
    const ins = (await latestFor(e.id))!;
    expect(ins).toMatchObject({ engine: "hermes", status: "analysed", leadId: lead.id });
    expect(await db.query.tasks.findFirst({ where: and(eq(S.tasks.leadId, lead.id), eq(S.tasks.title, `Ring about the shop cameras ${RUN}`)) })).toBeTruthy();
    expect(await db.query.activityLog.findFirst({ where: and(eq(S.activityLog.entityId, lead.id), eq(S.activityLog.action, "lead_created_by_hermes")) })).toBeTruthy();
  });

  it("Hermes thinks it is a lead but is not sure: proposed to Chris (the email shows Needs review); only a person accepts, once", async () => {
    script = () => enquiry(0.5);
    const e = await email({ from: `prop+${RUN}@example.com`, name: "Prop Owner", subject: "Re: your flyer", text: "Saw your flyer. Might want cameras for the shop at some point." });
    await processEmail(e.id);
    await settleInspectorQueue();
    const ins = (await latestFor(e.id))!;
    expect(ins).toMatchObject({ engine: "hermes", status: "needs_review", reviewKind: "hermes_proposed_lead", leadId: null });
    expect((await db.query.emails.findFirst({ where: eq(S.emails.id, e.id) }))!.classification).toBe("needs_review");
    expect(await db.query.leads.findFirst({ where: eq(S.leads.sourceEmailId, e.id) })).toBeUndefined();
    await expect(acceptProposedLead(ins.id, INSPECTOR_ACTOR)).rejects.toBeInstanceOf(GuardrailError);
    await acceptProposedLead(ins.id, chris);
    const lead = (await db.query.leads.findFirst({ where: eq(S.leads.sourceEmailId, e.id) }))!;
    leadIds.push(lead.id);
    expect(lead).toMatchObject({ createdById: chris.userId });
    await expect(acceptProposedLead(ins.id, chris)).rejects.toThrow();
  });

  it("Hermes says not a lead: the email is filed as not a lead; nothing for Chris, nothing written", async () => {
    script = () => ({ conversation_type: "supplier", intent: "not_relevant", lead_decision: "not_lead", business_context: "supplier_vendor", service: null, property_type: null, recommended_action: "NO_ACTION", confidence: 0.9, reason: "A supplier's delivery note." });
    const e = await email({ from: `supp+${RUN}@example.com`, name: "Supplier", subject: "Your delivery", text: "Your order has been dispatched." });
    await processEmail(e.id);
    await settleInspectorQueue();
    expect(calls).toBe(1);
    expect(await latestFor(e.id)).toMatchObject({ engine: "hermes", status: "analysed", reviewKind: null, leadId: null });
    expect(await actionsOf((await latestFor(e.id))!.id)).toEqual([]);
    expect((await db.query.emails.findFirst({ where: eq(S.emails.id, e.id) }))!.classification).toBe("not_lead");
  });

  it("a lead Hermes created and then, on a re-read, calls not a lead: the untouched lead is marked lost (reversible); a worked lead is left for Chris", async () => {
    script = () => enquiry(0.92);
    const e = await email({ from: `seo+${RUN}@example.com`, name: "SEO Agency", subject: "Grow your camera business", text: "We can get your CCTV business to page one of Google." });
    await processEmail(e.id);
    await settleInspectorQueue();
    const lead = (await db.query.leads.findFirst({ where: eq(S.leads.sourceEmailId, e.id) }))!;
    leadIds.push(lead.id);
    script = () => ({ conversation_type: "spam_or_marketing", intent: "not_relevant", lead_decision: "not_lead", service: null, property_type: null, recommended_action: "NO_ACTION", confidence: 0.92, reason: "A marketing email about SEO." });
    await inspect("email", e.id, { force: true });
    expect((await db.query.leads.findFirst({ where: eq(S.leads.id, lead.id) }))!.status).toBe("lost");
    expect((await db.query.leads.findFirst({ where: eq(S.leads.id, lead.id) }))!.lostReason).toMatch(/^Not a lead \(Hermes\)/);
    expect((await db.query.emails.findFirst({ where: eq(S.emails.id, e.id) }))!.classification).toBe("not_lead");

    // Once someone has worked on a lead (a quote exists), Hermes cannot close it: Chris decides.
    const notLeadScript = script;
    script = () => enquiry(0.9);
    const e2 = await email({ from: `seo2+${RUN}@example.com`, name: "SEO Agency 2", subject: "Cameras for our office", text: "We'd like cameras for our office." });
    await processEmail(e2.id);
    await settleInspectorQueue();
    script = notLeadScript;
    const lead2 = (await db.query.leads.findFirst({ where: eq(S.leads.sourceEmailId, e2.id) }))!;
    leadIds.push(lead2.id);
    await db.insert(S.quotes).values({ number: 900000 + Math.floor(Math.random() * 99999), title: "Office CCTV", leadId: lead2.id, status: "draft" });
    const out = (await inspect("email", e2.id, { force: true }))!;
    expect((await db.query.leads.findFirst({ where: eq(S.leads.id, lead2.id) }))!.status).not.toBe("lost");
    expect(out.status).toBe("needs_review");
    expect((await actionsOf(out.inspectionId)).find((a) => a.type === "NEEDS_REVIEW")).toMatchObject({ rule: "worked_lead_kept" });
  });

  it("Hermes unavailable: nothing is invented; the email waits for Chris as 'could not read it' and is retried", async () => {
    script = () => new HermesUnavailableError("Hermes could not be reached", "network");
    const e = await email({ from: `nl-down+${RUN}@example.com`, name: "Somebody", subject: "Hello", text: "Just saying hi." });
    await processEmail(e.id);
    await settleInspectorQueue();
    expect(await latestFor(e.id)).toMatchObject({ engine: "fallback", status: "needs_review", reviewKind: "hermes_unavailable", leadId: null });
    expect((await db.query.emails.findFirst({ where: eq(S.emails.id, e.id) }))!.classification).toBe("needs_review");
    expect(await db.query.inspectorQueue.findFirst({ where: eq(S.inspectorQueue.sourceId, e.id) })).toBeTruthy();
  });

  it("obvious automated mail is filtered before Hermes and never sent to it", async () => {
    const e = await email({ from: `news+${RUN}@example.com`, name: "Supplier News", subject: "October newsletter", text: "New products and offers." });
    await db.update(S.emails).set({ headers: { "list-unsubscribe": "<mailto:unsub@example.com>" } }).where(eq(S.emails.id, e.id));
    expect(await processEmail(e.id)).toMatchObject({ classification: "not_lead", prefiltered: true });
    await settleInspectorQueue();
    expect(calls).toBe(0);
    expect(await latestFor(e.id)).toBeUndefined();
  });
});

describe("Hermes judges; the guardrails only check evidence and authority (real cases)", () => {
  const made: { jobs: string[]; contacts: string[] } = { jobs: [], contacts: [] };
  afterAll(async () => {
    if (made.jobs.length) await db.delete(S.jobs).where(inArray(S.jobs.id, made.jobs));
    if (made.contacts.length) await db.delete(S.contacts).where(inArray(S.contacts.id, made.contacts));
  });
  async function customerWithLead(name: string, site: string | null = null) {
    const [c] = await db.insert(S.contacts).values({ name: `${name} ${RUN}` }).returning();
    made.contacts.push(c.id);
    const [l] = await db.insert(S.leads).values({ name: `${name} ${RUN}`, email: `${name.toLowerCase()}+${RUN}@example.com`, contactId: c.id, status: "won", source: "email", service: "CCTV", site }).returning();
    leadIds.push(l.id);
    return { contactId: c.id, leadId: l.id };
  }
  async function emailOn(leadId: string, text: string, from: string) {
    const e = await email({ from, name: "Customer", subject: "Cameras", text });
    await db.update(S.emails).set({ leadId }).where(eq(S.emails.id, e.id));
    return e;
  }
  const job = async (contactId: string, leadId: string, over: Partial<typeof S.jobs.$inferInsert> = {}) => {
    const [j] = await db.insert(S.jobs).values({ number: 900000 + Math.floor(Math.random() * 99999), title: "CCTV install", contactId, leadId, status: "invoiced", ...over }).returning();
    made.jobs.push(j.id);
    return j;
  };

  it("an old enquiry: Hermes closes it citing the invoiced job → 'no action' stands; without evidence it goes to Chris", async () => {
    const { contactId, leadId } = await customerWithLead("Finished");
    const j = await job(contactId, leadId);
    script = () => ({ intent: "quote_request", recommended_action: "NO_ACTION", confidence: 0.9, reason: "Historical enquiry: the job has been done.", resolution: { status: "resolved", evidence: [{ ref: `job:${j.id}`, note: `J-${j.number} invoiced` }] } });
    const e = await emailOn(leadId, "Hi, could we get a quote for cameras at the house?", `finished+${RUN}@example.com`);
    const out = (await inspect("email", e.id))!;
    expect(out.status).toBe("analysed");
    expect(((await latestFor(e.id))!.validation as { headline: { final: string; changedBy: string | null } }).headline).toMatchObject({ final: "NO_ACTION", changedBy: null });
    script = () => ({ intent: "quote_request", recommended_action: "NO_ACTION", confidence: 0.9, reason: "Nothing to do." });
    expect((await inspect("email", e.id, { force: true }))!.status).toBe("needs_review");
  });

  it("Aphichart: Hermes marks the visit commitments kept, citing the completed job; Chris can reopen (recorded as a correction)", async () => {
    const { contactId, leadId } = await customerWithLead("Aphichart");
    const j = await job(contactId, leadId, { doneAt: new Date(), invoicedAt: new Date() });
    const earlier = await emailOn(leadId, "Chris: I'll book the installation visit. Aphichart: I'll be available tomorrow.", `aphichart+${RUN}@example.com`);
    const [c1] = await db.insert(S.commitments).values({ owner: "get_secure", action: "Book the installation visit", actionKey: "visit", confidence: "0.9", leadId, contactId, sourceType: "email", sourceId: earlier.id }).returning();
    const [c2] = await db.insert(S.commitments).values({ owner: "customer", action: "Be available tomorrow", actionKey: "confirm", confidence: "0.9", leadId, contactId, sourceType: "email", sourceId: earlier.id }).returning();
    script = () => ({
      intent: "booking_request",
      recommended_action: "NO_ACTION",
      confidence: 0.9,
      reason: `J-${j.number} was completed and invoiced.`,
      resolution: { status: "resolved", evidence: [{ ref: `job:${j.id}`, note: "completed and invoiced" }] },
      commitment_updates: [
        { id: c1.id, status: "done", evidence_ref: `job:${j.id}`, note: "The installation took place." },
        { id: c2.id, status: "done", evidence_ref: `job:${j.id}`, note: "The visit happened." },
        { id: c2.id, status: "done", evidence_ref: "job:00000000-0000-0000-0000-000000000000", note: "made up" },
      ],
    });
    const e = await emailOn(leadId, "Following up on the install.", `aphichart+${RUN}@example.com`);
    const out = (await inspect("email", e.id))!;
    expect(out.status).toBe("analysed");
    const resolved = (await actionsOf(out.inspectionId)).filter((a) => a.type === "RESOLVE_COMMITMENT");
    expect(resolved).toHaveLength(2);
    expect(resolved.every((a) => a.status === "done")).toBe(true);
    expect((await db.query.commitments.findFirst({ where: eq(S.commitments.id, c1.id) }))!).toMatchObject({ status: "done", completedById: null });
    expect(await db.query.activityLog.findMany({ where: and(eq(S.activityLog.entityId, leadId), eq(S.activityLog.action, "commitment_resolved")) })).toHaveLength(2);
    // Chris disagrees: reopen. Recorded as a correction Hermes will see.
    await setCommitmentStatus(c1.id, "outstanding", chris);
    expect((await db.query.commitments.findFirst({ where: eq(S.commitments.id, c1.id) }))!.status).toBe("outstanding");
    expect(await db.query.inspectorFeedback.findFirst({ where: and(eq(S.inspectorFeedback.leadId, leadId), eq(S.inspectorFeedback.kind, "hermes_decision_reversed")) })).toBeTruthy();
  });

  it("Nympha: Hermes asks for the costing to be completed → that task, once; a re-read shows it already open", async () => {
    const { leadId } = await customerWithLead("Nympha");
    const [q] = await db.insert(S.quotes).values({ number: 900000 + Math.floor(Math.random() * 99999), title: "CCTV", leadId, status: "ai_prepared", origin: "brain" }).returning();
    const title = `Price the quote / complete costing for Q-${q.number}`;
    script = () => ({ intent: "follow_up", conversation_type: "existing_lead", recommended_action: "CREATE_INTERNAL_TASK", task: { title, due: "today", detail: "Labour and allowance inputs are unset." }, confidence: 0.9, reason: `Q-${q.number} cannot be finished until the labour and allowance inputs are entered.` });
    const e = await emailOn(leadId, "Hi, any update on the quote for the cameras?", `nympha+${RUN}@example.com`);
    const out = (await inspect("email", e.id))!;
    expect(out.status).toBe("analysed");
    expect(await db.query.tasks.findMany({ where: and(eq(S.tasks.leadId, leadId), eq(S.tasks.title, title), eq(S.tasks.status, "open")) })).toHaveLength(1);
    const again = (await inspect("email", e.id, { force: true }))!;
    expect((await actionsOf(again.inspectionId)).find((a) => a.type === "CREATE_INTERNAL_TASK")!.result).toMatchObject({ inHand: `Already open: ${title}.` });
    expect(await db.query.tasks.findMany({ where: and(eq(S.tasks.leadId, leadId), eq(S.tasks.status, "open")) })).toHaveLength(1);
  });

  it("Zavier: an unknown sender about an existing site → the work continues there; the sender stays unlinked", async () => {
    const site = `${700 + Math.floor(Math.random() * 99)} Wiri${RUN} Station Road, Manukau`;
    const { leadId } = await customerWithLead("Wiri Depot", site);
    const title = `Check the keypad at ${site.split(",")[0]}`;
    script = () => ({
      conversation_type: "existing_job",
      intent: "service_issue",
      lead_decision: "existing",
      recommended_action: "CREATE_INTERNAL_TASK",
      task: { title, due: "today", detail: null },
      operational_context: { ref: `lead:${leadId}`, reason: "Same site as the existing keypad issue." },
      facts: [{ key: "site_address", value: site.split(",")[0], evidence: site.split(",")[0], confidence: 0.9 }],
      confidence: 0.88,
      reason: "The keypad at this site is beeping again.",
    });
    const e = await email({ from: `zavier+${RUN}@example.com`, name: "Zavier", subject: "Keypad", text: `Hi, the keypad at ${site.split(",")[0]} is beeping again. Zavier` });
    const out = (await inspect("email", e.id))!;
    const ins = (await latestFor(e.id))!;
    expect(ins.leadId).toBe(leadId);
    expect(await db.query.tasks.findFirst({ where: and(eq(S.tasks.leadId, leadId), eq(S.tasks.title, title)) })).toBeTruthy();
    // Filed on the work, but the sender is not linked to the customer.
    expect((await db.query.emails.findFirst({ where: eq(S.emails.id, e.id) }))!).toMatchObject({ leadId, contactId: null });
    // Facts from an unverified sender are proposed, never filled in.
    expect((await db.query.facts.findMany({ where: and(eq(S.facts.sourceId, e.id)) })).every((f) => f.state !== "applied")).toBe(true);
    expect(JSON.stringify(ins.validation)).toContain("sender_unverified");
    // The sender's identity does not block this work: no "Who is this?".
    expect(out.status).toBe("analysed");
    expect(ins.reviewKind).toBeNull();

    // A context the message does not show (here: another lead, by name only) is not used: the task
    // still goes ahead (internal work needs no customer), but it is not filed on that lead.
    const { leadId: other } = await customerWithLead("Elsewhere");
    script = () => ({ conversation_type: "existing_job", intent: "service_issue", lead_decision: "existing", recommended_action: "CREATE_INTERNAL_TASK", task: { title: `Other ${RUN}`, due: null, detail: null }, operational_context: { ref: `lead:${other}`, reason: "Sounds like them." }, confidence: 0.9, reason: "?" });
    const e2 = await email({ from: `nobody+${RUN}@example.com`, name: "Nobody", subject: "Help", text: "Our alarm is beeping." });
    await inspect("email", e2.id);
    expect(await db.query.tasks.findFirst({ where: eq(S.tasks.title, `Other ${RUN}`) })).toMatchObject({ leadId: null, contactId: null });
    expect((await latestFor(e2.id))!.leadId).toBeNull();
  });

  it("unknown sender at a known site, Hermes thinks they belong there: an optional 'Link sender' proposal, never blocking; accepting links them", async () => {
    const site = `${800 + Math.floor(Math.random() * 99)} Link${RUN} Road, Penrose`;
    const { leadId, contactId } = await customerWithLead("Linkable", site);
    script = () => ({ conversation_type: "existing_job", intent: "service_issue", business_context: "existing_work", lead_decision: "existing", recommended_action: "CREATE_INTERNAL_TASK", task: { title: `Check camera 3 at ${site.split(",")[0]}`, due: "today", detail: null }, operational_context: { ref: `lead:${leadId}`, reason: "Same site." }, identity_review: { needed: true, reason: "Says they are the new site manager." }, confidence: 0.9, reason: "Camera 3 is offline at this site." });
    const e = await email({ from: `newmanager+${RUN}@example.com`, name: "Mere", subject: "Camera 3", text: `Hi, camera 3 at ${site.split(",")[0]} is offline. I'm the new site manager. Mere` });
    const out = (await inspect("email", e.id))!;
    expect(out.status).toBe("analysed"); // nothing waits on who they are
    const acts = await actionsOf(out.inspectionId);
    expect(acts.find((a) => a.type === "CREATE_INTERNAL_TASK")!.status).toBe("done");
    const link = acts.find((a) => a.type === "PROPOSE_LINK_SENDER")!;
    expect(link).toMatchObject({ status: "awaiting_approval", leadId });
    expect((await db.query.emails.findFirst({ where: eq(S.emails.id, e.id) }))!.contactId).toBeNull();
    await acceptAction(link.id, chris);
    expect((await db.query.emails.findFirst({ where: eq(S.emails.id, e.id) }))!).toMatchObject({ leadId, contactId });
  });

  it("Andre: an open task to arrange the site visit already exists, so another is not offered", async () => {
    const { leadId } = await customerWithLead("Andre");
    await db.update(S.leads).set({ status: "site_visit" }).where(eq(S.leads.id, leadId));
    await db.insert(S.tasks).values({ title: "Arrange commercial CCTV site visit", leadId, status: "open" });
    script = () => ({ intent: "quote_request", property_type: "commercial", recommended_action: "PREPARE_QUOTE", run_business_brain: true, confidence: 0.9, reason: "Commercial CCTV for the yard." });
    const e = await emailOn(leadId, "We need cameras for the yard at our depot.", `andre+${RUN}@example.com`);
    const out = (await inspect("email", e.id))!;
    const sv = (await actionsOf(out.inspectionId)).find((a) => a.type === "PROPOSE_SITE_VISIT")!;
    expect(sv).toMatchObject({ status: "already_in_hand", result: { inHand: "Site visit already awaiting arrangement." } });
    expect(await db.query.inspectorActions.findFirst({ where: and(eq(S.inspectorActions.inspectionId, out.inspectionId), eq(S.inspectorActions.status, "awaiting_approval")) })).toBeUndefined();
    const open = await db.query.tasks.findMany({ where: and(eq(S.tasks.leadId, leadId), eq(S.tasks.status, "open")) });
    expect(open).toHaveLength(1);
  });

  it("accepting a proposal after a task to arrange it was added does not create a second task", async () => {
    const { leadId } = await customerWithLead("Twice");
    script = () => ({ intent: "site_visit_request", recommended_action: "PROPOSE_SITE_VISIT", confidence: 0.9, reason: "Asked for someone to come out.", facts: [{ key: "site_address", value: `3 Twice Road ${RUN}`, evidence: `3 Twice Road ${RUN}`, confidence: 0.9 }] });
    const e = await emailOn(leadId, `Can someone come and look? We're at 3 Twice Road ${RUN}.`, `twice+${RUN}@example.com`);
    const out = (await inspect("email", e.id))!;
    const sv = (await actionsOf(out.inspectionId)).find((a) => a.type === "PROPOSE_SITE_VISIT")!;
    expect(sv.status).toBe("awaiting_approval");
    await db.insert(S.tasks).values({ title: "Arrange a site visit", leadId, status: "open" });
    const r = await acceptAction(sv.id, chris);
    expect(r).toMatchObject({ inHand: "Site visit already awaiting arrangement." });
    expect(await db.query.tasks.findMany({ where: and(eq(S.tasks.leadId, leadId), eq(S.tasks.status, "open")) })).toHaveLength(1);
  });
});

describe("business context first: route by what kind of business it is; 'Who is this?' only when identity blocks", () => {
  const made: { jobs: string[]; contacts: string[] } = { jobs: [], contacts: [] };
  afterAll(async () => {
    if (made.jobs.length) await db.delete(S.jobs).where(inArray(S.jobs.id, made.jobs));
    if (made.contacts.length) await db.delete(S.contacts).where(inArray(S.contacts.id, made.contacts));
  });

  it("a supplier statement from an unknown sender: accounting context, a task, no lead, no 'Who is this?'", async () => {
    script = () => ({
      conversation_type: "supplier",
      intent: "information",
      business_context: "accounting_payment",
      counterparty: { name: `Dicker Data ${RUN}`, kind: "supplier" },
      accounting: { document: "statement", reference: "October 2026", amount: 1840.25, due: "20 Nov" },
      lead_decision: "not_lead",
      service: null,
      property_type: null,
      recommended_action: "CREATE_INTERNAL_TASK",
      task: { title: `Check the Dicker Data statement ${RUN}`, due: null, detail: null },
      confidence: 0.92,
      reason: "Monthly supplier statement for accounts.",
    });
    const e = await email({ from: `accounts+${RUN}@dickerdata.example`, name: "Dicker Data Accounts", subject: "Statement of account", text: "Please find attached your statement for October 2026. Balance due $1,840.25." });
    const out = (await inspect("email", e.id))!;
    expect(out.status).toBe("analysed");
    const ins = (await latestFor(e.id))!;
    expect(ins).toMatchObject({ reviewKind: null, leadId: null });
    expect(await db.query.tasks.findFirst({ where: eq(S.tasks.title, `Check the Dicker Data statement ${RUN}`) })).toBeTruthy();
    expect(await db.query.leads.findFirst({ where: eq(S.leads.sourceEmailId, e.id) })).toBeUndefined();
  });

  it("a monitoring provider's statement: Hermes routes it as provider/accounting; no lead is ever made from it", async () => {
    script = () => ({ conversation_type: "supplier", intent: "information", business_context: "service_provider", counterparty: { name: "Alarm Watch", kind: "service_provider" }, accounting: { document: "statement", reference: null, amount: null, due: null }, service: null, property_type: null, recommended_action: "CREATE_INTERNAL_TASK", task: { title: `Check the Alarm Watch statement ${RUN}`, due: null, detail: null }, confidence: 0.9, reason: "Monitoring provider statement." });
    const e = await email({ from: `billing+${RUN}@alarmwatch.example`, name: "Alarm Watch", subject: "Your monitoring statement", text: "Monitoring statement for your alarm monitoring accounts. Need anything? Contact us." });
    expect((await processEmail(e.id)).classification).toBe("reading"); // nothing is guessed from the words
    await settleInspectorQueue();
    expect(await db.query.leads.findFirst({ where: eq(S.leads.sourceEmailId, e.id) })).toBeUndefined();
    expect((await db.query.emails.findFirst({ where: eq(S.emails.id, e.id) }))!.classification).toBe("not_lead");
    const ins = (await latestFor(e.id))!;
    expect(ins.reviewKind).toBeNull();
    expect(await db.query.tasks.findFirst({ where: eq(S.tasks.title, `Check the Alarm Watch statement ${RUN}`) })).toBeTruthy();
  });

  it("a customer's remittance quoting a job number: filed to that job's customer; without evidence the task stays unlinked (no 'Who is this?')", async () => {
    const [c] = await db.insert(S.contacts).values({ name: `Firehouse ${RUN}`, company: "Firehouse Ltd" }).returning();
    made.contacts.push(c.id);
    const [j] = await db.insert(S.jobs).values({ number: 900000 + Math.floor(Math.random() * 99999), title: "Alarm install", contactId: c.id, status: "invoiced" }).returning();
    made.jobs.push(j.id);
    const remit = (ref: string | null): Loose => ({ conversation_type: "existing_customer", intent: "information", business_context: "accounting_payment", counterparty: { name: "Firehouse Ltd", kind: "customer" }, accounting: { document: "remittance", reference: ref, amount: 2300, due: null }, operational_context: { ref: `customer:${c.id}`, reason: "Firehouse is the customer." }, lead_decision: "not_lead", service: null, property_type: null, recommended_action: "CREATE_INTERNAL_TASK", task: { title: `Reconcile Firehouse remittance ${ref ?? "?"} ${RUN}`, due: null, detail: null }, confidence: 0.9, reason: "Payment advice." });
    script = () => remit(`J-${j.number}`);
    const e = await email({ from: `ap+${RUN}@firehouse.example`, name: "Firehouse Accounts", subject: "Remittance advice", text: `Remittance advice: $2,300.00 paid for job J-${j.number}.` });
    const out = (await inspect("email", e.id))!;
    expect(out.status).toBe("analysed");
    const t = (await db.query.tasks.findFirst({ where: eq(S.tasks.title, `Reconcile Firehouse remittance J-${j.number} ${RUN}`) }))!;
    expect(t.contactId).toBe(c.id);
    // The sender (accounts@) stays unlinked.
    expect((await db.query.emails.findFirst({ where: eq(S.emails.id, e.id) }))!.contactId).toBeNull();

    script = () => remit(null);
    const e2 = await email({ from: `ap2+${RUN}@firehouse.example`, name: "Firehouse Accounts", subject: "Remittance advice", text: "Remittance advice: $2,300.00 paid. Thanks." });
    const out2 = (await inspect("email", e2.id))!;
    expect(out2.status).toBe("analysed");
    const t2 = (await db.query.tasks.findFirst({ where: eq(S.tasks.title, `Reconcile Firehouse remittance ? ${RUN}`) }))!;
    expect(t2.contactId).toBeNull();
  });

  it("Zavier (the production case): a job with no site address of its own still matches on its customer's site; Hermes named it only as its sender suggestion", async () => {
    const street = `${300 + Math.floor(Math.random() * 99)} Wiri${RUN} Station Road`;
    const [c] = await db.insert(S.contacts).values({ name: `Wiri Depot Ltd ${RUN}`, address: `${street}, Manukau` }).returning();
    made.contacts.push(c.id);
    const [j] = await db.insert(S.jobs).values({ number: 900000 + Math.floor(Math.random() * 99999), title: "Keypad fault", contactId: c.id, status: "scheduled" }).returning();
    made.jobs.push(j.id);
    script = () => ({
      conversation_type: "existing_job",
      intent: "service_issue",
      business_context: "existing_work",
      recommended_action: "CREATE_INTERNAL_TASK",
      task: { title: `Keypad still beeping at ${street}`, due: "today", detail: null },
      identity: { suggestion: "candidate", candidate_key: `job:${j.id}`, reason: "Same site as the keypad job." },
      confidence: 0.86,
      reason: "Follow-up on the keypad issue at the site.",
    });
    const e = await email({ from: `zavier.k+${RUN}@example.com`, name: "Zavier", subject: "Keypad", text: `Hi, the keypad at ${street} is still beeping. Can someone look? Zavier` });
    const out = (await inspect("email", e.id))!;
    expect(out.status).toBe("analysed");
    const ins = (await latestFor(e.id))!;
    expect(ins).toMatchObject({ reviewKind: null, jobId: j.id, contactId: c.id });
    const t = (await db.query.tasks.findFirst({ where: eq(S.tasks.title, `Keypad still beeping at ${street}`) }))!;
    expect(t).toMatchObject({ jobId: j.id, contactId: c.id });
    expect((await db.query.emails.findFirst({ where: eq(S.emails.id, e.id) }))!.contactId).toBeNull();
  });
});
