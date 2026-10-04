/**
 * Lead + Conversation Inspector against the database: emails and Plaud recordings through the same
 * pipeline, identity from several signals (never a name alone), facts with provenance and
 * conflicts, commitments, the Unified Action Router (internal work done, customer-facing work
 * waiting for Chris), the Business Brain integration, and Jev in shadow.
 *
 * Nothing here is sent: the test checks that too.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, asc, eq, inArray } from "drizzle-orm";

process.env.AI_PROVIDER = "rules";

const { db } = await import("@/db");
const S = await import("@/db/schema");
const { setClassifier } = await import("@/lib/ai");
const { processEmail } = await import("@/lib/email/pipeline");
const { inspect, confirmIdentity, acceptAction, dismissAction, resolveFact, setCommitmentStatus, closeReviews } = await import("@/lib/inspector/inspect");
const { setJev } = await import("@/lib/inspector/jev");
const { encryptSecret } = await import("@/lib/crypto");
const { sendDraft } = await import("@/lib/drafts/workflow");
const { GuardrailError } = await import("@/lib/guard/actor");
const { INSPECTOR_ACTOR } = await import("@/lib/inspector/router");
const { applyReferenceCatalogue, resetReferenceMarker } = await import("@/lib/brain/reference/apply");
const brain = await import("@/lib/brain/store");

const RUN = `in${Date.now().toString(36)}`;
let chris: { kind: "human"; userId: string; name: string; canApprove: true };
let mailboxId: string;
const leadIds: string[] = [];
const contactIds: string[] = [];
const recordingIds: string[] = [];
const offerIds: string[] = [];
let pkgBefore: typeof S.installationPackages.$inferSelect | undefined;
let n = 0;
/** A quiet moment with nothing in the calendar, so other tests' appointments never interfere. */
const QUIET = new Date("2031-03-04T21:00:00Z");

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
async function recording(title: string, transcript: string, at = QUIET) {
  const [r] = await db.insert(S.recordings).values({ externalId: `${RUN}-${++n}`, source: "plaud", title, transcript, transcriptPolished: true, recordedAt: at, status: "review" }).returning();
  recordingIds.push(r.id);
  return r;
}
const actionsOf = (inspectionId: string) => db.query.inspectorActions.findMany({ where: eq(S.inspectorActions.inspectionId, inspectionId), orderBy: [asc(S.inspectorActions.createdAt)] });

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
  // A classifier that treats these test enquiries as leads (the real one is AI or rules).
  setClassifier({
    name: "test",
    classify: async (input) => ({
      provider: "test",
      model: null,
      result: { is_lead: true, confidence: 0.95, contact_name: input.from.name, company: null, email: input.from.address, phone: null, service: "CCTV", site_address: null, summary: input.subject, urgency: "normal", next_action: "Reply", reason: "test" },
      durationMs: 1,
    }),
  });
  setJev({ model: "fake-jev", classify: async () => ({ intent: "quote_request", conversation_type: "new_lead", urgency: "normal", quote_readiness: "ready", next_move: "quote", objection_type: "none", site_visit_probability: 0.1, confidence: 0.8, reason: "test" }) });
});

afterAll(async () => {
  setClassifier(null);
  setJev(undefined);
  const leadRows = await db.select({ id: S.leads.id }).from(S.leads).where(inArray(S.leads.email, [`aroha+${RUN}@example.com`, `vague+${RUN}@example.com`, `biz+${RUN}@example.com`, `unpriced+${RUN}@example.com`]));
  leadIds.push(...leadRows.map((l) => l.id));
  const emailIds = (await db.select({ id: S.emails.id }).from(S.emails).where(eq(S.emails.mailboxId, mailboxId))).map((e) => e.id);
  const ins = await db.select({ id: S.inspections.id }).from(S.inspections).where(inArray(S.inspections.sourceId, [...recordingIds, ...emailIds]));
  if (emailIds.length) await db.delete(S.commitments).where(inArray(S.commitments.sourceId, emailIds));
  if (ins.length) await db.delete(S.inspections).where(inArray(S.inspections.id, ins.map((i) => i.id)));
  if (leadIds.length) {
    await db.delete(S.quotes).where(inArray(S.quotes.leadId, leadIds));
    await db.delete(S.drafts).where(inArray(S.drafts.leadId, leadIds));
    await db.delete(S.tasks).where(inArray(S.tasks.leadId, leadIds));
    await db.delete(S.inspections).where(inArray(S.inspections.leadId, leadIds));
  }
  if (recordingIds.length) {
    await db.delete(S.commitments).where(inArray(S.commitments.sourceId, recordingIds));
    await db.delete(S.recordings).where(inArray(S.recordings.id, recordingIds));
  }
  await db.delete(S.emailThreads).where(eq(S.emailThreads.mailboxId, mailboxId));
  if (leadIds.length) await db.delete(S.leads).where(inArray(S.leads.id, leadIds));
  if (contactIds.length) await db.delete(S.contacts).where(inArray(S.contacts.id, contactIds));
  await db.delete(S.mailboxes).where(eq(S.mailboxes.id, mailboxId));
  if (offerIds.length) await db.delete(S.supplierProducts).where(inArray(S.supplierProducts.id, offerIds));
  if (pkgBefore) {
    const { id, ...rest } = pkgBefore;
    await db.update(S.installationPackages).set(rest).where(eq(S.installationPackages.id, id));
  }
  await db.delete(S.users).where(eq(S.users.id, chris.userId));
  resetReferenceMarker();
});

describe("no approved price: no invented price", () => {
  it("the Brain designs it, but no quote or reply is prepared; Chris gets a pricing task", async () => {
    const e = await email({ from: `unpriced+${RUN}@example.com`, name: "Wiremu Unpriced", subject: "Cameras for the house", text: "Hi, could I get a quote for 4 cameras at our house? Single storey, 3 Rimu Road, Mt Albert. Phone 021 555 0199." });
    const out = await processEmail(e.id);
    leadIds.push(out.leadId!);
    const ins = (await db.query.inspections.findFirst({ where: eq(S.inspections.sourceId, e.id) }))!;
    const acts = await actionsOf(ins.id);
    const byType = Object.fromEntries(acts.map((a) => [a.type, a]));
    expect(byType.RUN_BUSINESS_BRAIN).toMatchObject({ status: "done" });
    expect(byType.PREPARE_QUOTE).toMatchObject({ status: "blocked" });
    expect(acts.every((a) => a.status !== "failed")).toBe(true);
    expect(await db.query.quotes.findFirst({ where: eq(S.quotes.leadId, out.leadId!) })).toBeUndefined();
    expect(await db.query.drafts.findFirst({ where: eq(S.drafts.leadId, out.leadId!) })).toBeUndefined();
    const t = (await db.query.tasks.findFirst({ where: and(eq(S.tasks.leadId, out.leadId!), eq(S.tasks.kind, "quote")) }))!;
    expect(t.title).toMatch(/^Price the quote for /);
  });
});

describe("email → understood → internal actions done → quote prepared for Chris (nothing sent)", () => {
  let leadId: string;
  beforeAll(async () => {
    // TEST VALUE trade prices for the VIGI range and drives, entered by Chris; put back afterwards.
    const it = (await db.query.suppliers.findFirst({ where: eq(S.suppliers.name, "IT Plus") }))!;
    const rows = [...(await db.select().from(S.products).where(eq(S.products.family, "TP-Link VIGI"))), ...(await db.select().from(S.products).where(eq(S.products.category, "hdd")))];
    for (const row of rows) {
      const cost = row.category === "camera" ? 120 : row.category === "nvr" ? 210 : row.category === "hdd" ? 60 + 25 * Number((row.specs as { capacityTb?: number }).capacityTb ?? 1) : null;
      if (cost == null) continue;
      const r = await brain.recordSupplierPrice({ productId: row.id, supplierId: it.id, costExGst: cost, stock: "In stock", source: "integration test" }, chris);
      offerIds.push(r.offerId);
    }
    pkgBefore = (await db.query.installationPackages.findFirst({ where: eq(S.installationPackages.key, "RES_CCTV_SINGLE_4") }))!;
    await db
      .update(S.installationPackages)
      .set({ estimatedHours: "6.00", labourRate: "95.00", materialCostExGst: "80.00", complexityAllowanceExGst: "0.00", allowanceExGst: "790.00", status: "getsecure_approved" })
      .where(eq(S.installationPackages.key, "RES_CCTV_SINGLE_4"));
  });
  it("a complete residential CCTV enquiry runs the Business Brain and prepares a quote and reply", async () => {
    const e = await email({ from: `aroha+${RUN}@example.com`, name: "Aroha Ngata", subject: "CCTV quote", text: "Hi, we'd like a quote for 4 cameras at our house, single storey, at 12 Kauri Street, Grey Lynn. Would like to view them on my phone. My number is 021 555 0177. Thanks, Aroha" });
    const out = await processEmail(e.id);
    expect(out.classification).toBe("lead");
    leadId = out.leadId!;
    const ins = (await db.query.inspections.findFirst({ where: eq(S.inspections.sourceId, e.id) }))!;
    expect(ins).toMatchObject({ status: "analysed", leadId, sourceType: "email" });
    const acts = await actionsOf(ins.id);
    const byType = Object.fromEntries(acts.map((a) => [a.type, a]));
    expect(byType.RUN_BUSINESS_BRAIN.status).toBe("done");
    expect(byType.PREPARE_QUOTE.status).toBe("done");
    expect(acts.every((a) => a.status !== "failed")).toBe(true);
    // Facts filled the blank lead fields, with provenance.
    const lead = (await db.query.leads.findFirst({ where: eq(S.leads.id, leadId) }))!;
    expect(lead.site).toBe("12 Kauri Street, Grey Lynn");
    expect(lead.phone).toBe("0215550177");
    const f = await db.query.facts.findMany({ where: eq(S.facts.leadId, leadId) });
    expect(f.find((x) => x.key === "camera_count")).toMatchObject({ value: 4, state: "applied", sourceType: "email", sourceId: e.id });
    expect(f.every((x) => x.evidence && x.sourceAt && Number(x.confidence) > 0)).toBe(true);
    // The Brain ran on those facts; the quote and the reply wait for Chris.
    const assessment = (await db.query.cctvAssessments.findFirst({ where: eq(S.cctvAssessments.id, String(byType.RUN_BUSINESS_BRAIN.result!.assessmentId)) }))!;
    expect(assessment.input).toMatchObject({ cameraCount: 4, storeys: 1, propertyType: "residential" });
    const q = (await db.query.quotes.findFirst({ where: eq(S.quotes.id, String(byType.PREPARE_QUOTE.result!.quoteId)) }))!;
    expect(q.status).toBe("needs_review");
    const d = (await db.query.drafts.findFirst({ where: eq(S.drafts.leadId, leadId) }))!;
    expect(d.status).toBe("ready_for_review");
    // Prepared is not contacted.
    expect(lead.status).toBe("new");
    expect(await db.query.drafts.findFirst({ where: and(eq(S.drafts.leadId, leadId), eq(S.drafts.status, "sent")) })).toBeUndefined();
    // Jev ran in shadow, beside the rules' answer.
    const jev = (await db.query.jevObservations.findFirst({ where: eq(S.jevObservations.inspectionId, ins.id) }))!;
    expect(jev.output).toMatchObject({ next_move: "quote" });
    expect(jev.deterministic).toMatchObject({ next_move: "quote", quote_readiness: "ready" });
  });

  it("the router cannot send: the system actor is refused by the send path", async () => {
    const d = (await db.query.drafts.findFirst({ where: eq(S.drafts.leadId, leadId) }))!;
    await expect(sendDraft(d.id, INSPECTOR_ACTOR)).rejects.toBeInstanceOf(GuardrailError);
  });

  it("a second email in the thread with a different address is flagged, never overwritten", async () => {
    const first = (await db.query.emails.findFirst({ where: eq(S.emails.leadId, leadId) }))!;
    const e = await email({ from: `aroha+${RUN}@example.com`, name: "Aroha Ngata", subject: "Re: CCTV quote", text: "Sorry, the address is actually 14 Kauri Street, Grey Lynn.", thread: first.threadId });
    await processEmail(e.id);
    const conflict = (await db.query.facts.findFirst({ where: and(eq(S.facts.leadId, leadId), eq(S.facts.key, "site_address"), eq(S.facts.state, "conflict")) }))!;
    expect(conflict).toMatchObject({ value: "14 Kauri Street, Grey Lynn", currentValue: "12 Kauri Street, Grey Lynn" });
    expect((await db.query.leads.findFirst({ where: eq(S.leads.id, leadId) }))!.site).toBe("12 Kauri Street, Grey Lynn");
    await resolveFact(conflict.id, "apply", chris);
    expect((await db.query.leads.findFirst({ where: eq(S.leads.id, leadId) }))!.site).toBe("14 Kauri Street, Grey Lynn");
  });

  it("a vague enquiry gets a reply asking only the blocking questions, and no quote", async () => {
    const e = await email({ from: `vague+${RUN}@example.com`, name: "Sam Vague", subject: "Cameras", text: "Hi there, how much for some security cameras?" });
    await processEmail(e.id);
    const ins = (await db.query.inspections.findFirst({ where: eq(S.inspections.sourceId, e.id) }))!;
    const acts = await actionsOf(ins.id);
    expect(acts.map((a) => a.type)).toContain("DRAFT_EMAIL");
    expect(acts.map((a) => a.type)).not.toContain("PREPARE_QUOTE");
    const d = (await db.query.drafts.findFirst({ where: eq(S.drafts.id, String(acts.find((a) => a.type === "DRAFT_EMAIL")!.result!.draftId)) }))!;
    expect(d.status).toBe("ready_for_review");
    expect(d.body).toMatch(/home or for a business/);
    expect(d.body).not.toMatch(/budget|address/i);
  });

  it("commercial CCTV waits for Chris as a site-visit proposal; accepting makes his task, never a confirmed visit", async () => {
    const e = await email({ from: `biz+${RUN}@example.com`, name: "Pat Warehouse", subject: "Warehouse CCTV", text: "We need CCTV for our warehouse at 5 Allens Road, East Tamaki. Around 10 cameras." });
    await processEmail(e.id);
    const ins = (await db.query.inspections.findFirst({ where: eq(S.inspections.sourceId, e.id) }))!;
    const sv = (await actionsOf(ins.id)).find((a) => a.type === "PROPOSE_SITE_VISIT")!;
    expect(sv).toMatchObject({ status: "awaiting_approval", rule: "commercial_cctv_site_visit" });
    const before = await db.select().from(S.events).where(eq(S.events.leadId, ins.leadId!));
    await acceptAction(sv.id, chris);
    expect((await db.query.inspectorActions.findFirst({ where: eq(S.inspectorActions.id, sv.id) }))!.status).toBe("accepted");
    const t = await db.query.tasks.findFirst({ where: and(eq(S.tasks.leadId, ins.leadId!), eq(S.tasks.title, "Arrange a site visit")) });
    expect(t).toBeTruthy();
    expect(await db.select().from(S.events).where(eq(S.events.leadId, ins.leadId!))).toHaveLength(before.length);
    const jev = (await db.query.jevObservations.findFirst({ where: eq(S.jevObservations.inspectionId, ins.id) }))!;
    expect(jev.chrisDecision).toMatchObject({ "action:PROPOSE_SITE_VISIT": "accepted" });
  });
});

describe("Plaud recordings → commitments, identity from signals", () => {
  const transcript = (phone: string) =>
    [
      "[00:00 - 00:06] Speaker 1: Hi, it's Chris from Get Secure.",
      `[00:06 - 00:20] Speaker 2: Hi Chris, it's Mere on ${phone}. We're after 4 cameras for the house, it's single storey.`,
      "[00:20 - 00:31] Speaker 1: Great, I'll send the quote tonight.",
      "[00:31 - 00:40] Speaker 2: Perfect, I'll send the photos tomorrow.",
    ].join("\n");

  it("a phone number matches the lead: filed, commitments stored for Chris and the customer", async () => {
    const [l] = await db.insert(S.leads).values({ name: `Mere Tawhiri ${RUN}`, phone: "021 777 1234", status: "new", source: "phone", service: "CCTV" }).returning();
    leadIds.push(l.id);
    const r = await recording("Call with Mere", transcript("021 777 1234"));
    const out = (await inspect("recording", r.id))!;
    expect(out.status).toBe("analysed");
    const rec = (await db.query.recordings.findFirst({ where: eq(S.recordings.id, r.id) }))!;
    expect(rec).toMatchObject({ status: "attached", leadId: l.id });
    expect(rec.matchedBy).toMatch(/^Inspector: .*phone 0217771234/);
    const cs = await db.query.commitments.findMany({ where: eq(S.commitments.sourceId, r.id) });
    expect(cs.find((c) => c.owner === "get_secure")).toMatchObject({ actionKey: "send_quote", dueText: "tonight", status: "outstanding", leadId: l.id, sourceType: "recording" });
    expect(cs.find((c) => c.owner === "customer")).toMatchObject({ actionKey: "send_photos", dueText: "tomorrow", leadId: l.id });
    const chrisC = cs.find((c) => c.owner === "get_secure")!;
    await setCommitmentStatus(chrisC.id, "done", chris);
    expect((await db.query.commitments.findFirst({ where: eq(S.commitments.id, chrisC.id) }))!.status).toBe("done");
  });

  it("a name alone is never enough: NEEDS_REVIEW, no customer facts written, until Chris confirms", async () => {
    const [l] = await db.insert(S.leads).values({ name: `Hemi Walker`, status: "new", source: "phone", service: "CCTV" }).returning();
    leadIds.push(l.id);
    const r = await recording("Site chat", ["Speaker 1: Hi it's Chris from Get Secure.", "Speaker 2: Hi, Hemi Walker here. We want 4 cameras for the house, single storey. I'll send the photos tomorrow."].join("\n"));
    const out = (await inspect("recording", r.id))!;
    expect(out.status).toBe("needs_review");
    const acts = await actionsOf(out.inspectionId);
    expect(acts.map((a) => [a.type, a.status])).toEqual([
      ["NEEDS_REVIEW", "awaiting_approval"],
      ["LINK_RECORDING", "awaiting_approval"],
    ]);
    const cands = (acts[0].payload as { candidates: { leadId: string; signals: { kind: string }[] }[] }).candidates;
    expect(cands[0]).toMatchObject({ leadId: l.id });
    expect(cands[0].signals.map((s) => s.kind)).toEqual(["name"]);
    expect(await db.query.facts.findMany({ where: eq(S.facts.leadId, l.id) })).toHaveLength(0);
    expect((await db.query.recordings.findFirst({ where: eq(S.recordings.id, r.id) }))!.status).toBe("review");
    // The customer's commitment is kept, not yet tied to anyone.
    expect((await db.query.commitments.findFirst({ where: eq(S.commitments.sourceId, r.id) }))!.leadId).toBeNull();

    const after = (await confirmIdentity(out.inspectionId, { leadId: l.id }, chris))!;
    expect(after.status).toBe("analysed");
    expect((await db.query.recordings.findFirst({ where: eq(S.recordings.id, r.id) }))!).toMatchObject({ status: "attached", leadId: l.id, matchedBy: "chosen by Chris" });
    expect((await db.query.facts.findMany({ where: eq(S.facts.leadId, l.id) })).map((f) => f.key)).toEqual(expect.arrayContaining(["camera_count", "storeys"]));
    expect((await db.query.commitments.findFirst({ where: eq(S.commitments.sourceId, r.id) }))!.leadId).toBe(l.id);
  });

  it("a recording made during a site visit, plus the name, files it; a different time does not", async () => {
    const [l] = await db.insert(S.leads).values({ name: `Tui Henare`, status: "new", source: "phone", service: "CCTV" }).returning();
    leadIds.push(l.id);
    const visit = new Date(QUIET.getTime() + 2 * 3600000);
    await db.insert(S.events).values({ title: `Site visit: Tui Henare ${RUN}`, kind: "site_visit", startsAt: visit, endsAt: new Date(visit.getTime() + 3600000), leadId: l.id });
    const words = ["Speaker 1: Hi, Chris from Get Secure.", "Speaker 2: Hi Chris, Tui Henare. Come through, the cameras would go on the garage and the deck."].join("\n");
    const r1 = await recording("Site visit chat", words, new Date(visit.getTime() + 20 * 60000));
    expect((await inspect("recording", r1.id))!.status).toBe("analysed");
    const rec = (await db.query.recordings.findFirst({ where: eq(S.recordings.id, r1.id) }))!;
    expect(rec).toMatchObject({ status: "attached", leadId: l.id });
    expect(rec.matchedBy).toMatch(/recorded during appointment/);
    // The same words at a time with no appointment: only a name, so Chris decides.
    const other = (await inspect("recording", (await recording("Site visit chat", words, new Date(visit.getTime() + 6 * 3600000))).id))!;
    expect(other.status).toBe("needs_review");
  });

  it("dismissing the recording on the Recordings page closes its “Who is this?” too", async () => {
    const r = await recording("Note to self", "Speaker 1: Remember to order more cable for Tuesday.");
    const out = (await inspect("recording", r.id))!;
    expect(out.status).toBe("needs_review");
    await closeReviews("recording", [r.id], chris);
    expect((await db.query.inspections.findFirst({ where: eq(S.inspections.id, out.inspectionId) }))!.status).toBe("superseded");
    expect((await db.query.recordings.findFirst({ where: eq(S.recordings.id, r.id) }))!.status).toBe("dismissed");
    expect((await actionsOf(out.inspectionId)).every((a) => a.status !== "awaiting_approval")).toBe(true);
  });

  it("dismissing a recommendation is recorded as Chris's decision", async () => {
    const r = await recording("Mystery", "Speaker 1: Hello?\nSpeaker 2: Wrong number, sorry.");
    const out = (await inspect("recording", r.id))!;
    const nr = (await actionsOf(out.inspectionId)).find((a) => a.type === "NEEDS_REVIEW")!;
    await dismissAction(nr.id, chris, "not a customer");
    expect((await db.query.inspectorActions.findFirst({ where: eq(S.inspectorActions.id, nr.id) }))!.status).toBe("dismissed");
  });
});
