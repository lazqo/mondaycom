/**
 * Hermes's wider authority, end to end against the database: attachments as content (never a path),
 * candidate Business Brain packages (proposed by Hermes or found in repeated quotes; only Chris makes
 * one an approved kit), research requested from the Inspector (only the question leaves), and the
 * Business Brain's own outcome deciding what follows a run.
 */
import { deflateSync } from "node:zlib";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import sharp from "sharp";

const { db } = await import("@/db");
const S = await import("@/db/schema");
const { handleMcp, HERMES_RESEARCH_ACTOR } = await import("@/lib/hermes/mcp");
const { setResearchRuntime } = await import("@/lib/hermes/research");
const { decidePackage, detectPackagePatterns } = await import("@/lib/brain/packages");
const { kitFor } = await import("@/lib/brain/engine");
const { loadCatalogue } = await import("@/lib/brain/store");
const { routeActions } = await import("@/lib/inspector/router");
const { applyReferenceCatalogue, resetReferenceMarker } = await import("@/lib/brain/reference/apply");
const { GuardrailError } = await import("@/lib/guard/actor");
const { encryptSecret } = await import("@/lib/crypto");

const RUN = `auth${Date.now().toString(36)}`;
let rpc = 0;
const call = async (name: string, args: Record<string, unknown>, profile: "inspector" | "research" = "inspector") => {
  const res = (await handleMcp({ jsonrpc: "2.0", id: ++rpc, method: "tools/call", params: { name, arguments: args } }, profile === "research" ? HERMES_RESEARCH_ACTOR : undefined, profile)) as {
    result: { isError: boolean; content: { type: string; text?: string; data?: string; mimeType?: string }[]; structuredContent?: Record<string, unknown> };
  };
  return res.result;
};
const made = { leads: [] as string[], emails: [] as string[], threads: [] as string[], kits: [] as string[], candidates: [] as string[], quotes: [] as string[] };
let chris: { kind: "human"; userId: string; name: string; canApprove: true };
let cam: { id: string; model: string };
let cam2: { id: string };
let nvr: { id: string; model: string };
let hdd: { id: string } | undefined;
let mailboxId: string;

beforeAll(async () => {
  resetReferenceMarker();
  await applyReferenceCatalogue();
  const u = (await db.query.users.findFirst({ where: eq(S.users.canApprove, true) }))!;
  chris = { kind: "human", userId: u.id, name: u.name, canApprove: true };
  const prods = await db.select({ id: S.products.id, model: S.products.model, category: S.products.category, specs: S.products.specs, residential: S.products.residentialAllowed }).from(S.products);
  const cams = prods.filter((p) => p.category === "camera" && p.residential);
  cam = cams[0];
  cam2 = cams[1];
  nvr = prods.find((p) => p.category === "nvr" && Number((p.specs as { channels?: number }).channels ?? 0) >= 8) ?? prods.find((p) => p.category === "nvr")!;
  hdd = prods.find((p) => p.category === "hdd");
  const [mb] = await db
    .insert(S.mailboxes)
    .values({ name: `Authority ${RUN}`, emailAddress: `auth+${RUN}@getsecure.test`, imapHost: "127.0.0.1", imapPort: 1, imapSecure: false, smtpHost: "127.0.0.1", smtpPort: 1, smtpSecure: false, username: "x", passwordEncrypted: encryptSecret("x"), active: false })
    .returning();
  mailboxId = mb.id;
});

afterAll(async () => {
  if (made.candidates.length) await db.delete(S.packageCandidates).where(inArray(S.packageCandidates.id, made.candidates));
  await db.delete(S.packageCandidates).where(eq(S.packageCandidates.proposedBy, `test:${RUN}`));
  if (made.kits.length) await db.delete(S.cctvKits).where(inArray(S.cctvKits.id, made.kits));
  if (made.quotes.length) await db.delete(S.quotes).where(inArray(S.quotes.id, made.quotes));
  if (made.emails.length) await db.delete(S.emails).where(inArray(S.emails.id, made.emails));
  if (made.threads.length) await db.delete(S.emailThreads).where(inArray(S.emailThreads.id, made.threads));
  if (mailboxId) await db.delete(S.mailboxes).where(eq(S.mailboxes.id, mailboxId));
  if (made.leads.length) {
    await db.delete(S.tasks).where(inArray(S.tasks.leadId, made.leads));
    await db.delete(S.drafts).where(inArray(S.drafts.leadId, made.leads));
    await db.delete(S.leads).where(inArray(S.leads.id, made.leads));
  }
  setResearchRuntime(undefined);
});

async function emailWith(attachments: { filename: string; contentType: string; content: Buffer }[]) {
  const now = new Date();
  const [t] = await db.insert(S.emailThreads).values({ mailboxId, subject: `Photos ${RUN}`, normalizedSubject: `photos ${RUN}`, firstMessageAt: now, lastMessageAt: now }).returning();
  made.threads.push(t.id);
  const [e] = await db
    .insert(S.emails)
    .values({ mailboxId, threadId: t.id, messageId: `<${RUN}-${Math.random()}@example.com>`, fromName: "Att", fromAddress: `att+${RUN}@example.com`, to: [{ name: "Get Secure", address: "info@getsecure.test" }], subject: `Photos ${RUN}`, textBody: "See attached", receivedAt: now })
    .returning();
  made.emails.push(e.id);
  const rows = await db
    .insert(S.emailAttachments)
    .values(attachments.map((a) => ({ emailId: e.id, filename: a.filename, contentType: a.contentType, size: a.content.length, content: a.content })))
    .returning({ id: S.emailAttachments.id, filename: S.emailAttachments.filename });
  return { emailId: e.id, ids: Object.fromEntries(rows.map((r) => [r.filename, r.id])) as Record<string, string> };
}

describe("attachments and photos: content for Hermes's own model, never a path", () => {
  it("lists, reads documents (PDF text, HTML) and returns images as image content; the audit holds no image data", async () => {
    const png = await sharp({ create: { width: 2400, height: 1200, channels: 3, background: { r: 200, g: 200, b: 200 } } }).png().toBuffer();
    const stream = deflateSync(Buffer.from("BT /F1 12 Tf 72 712 Td (Model: DS-2CD2143G2-I) Tj ET", "latin1"));
    const pdf = Buffer.concat([Buffer.from(`%PDF-1.4\n1 0 obj << /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`, "latin1"), stream, Buffer.from("\nendstream\nendobj\n%%EOF", "latin1")]);
    const { emailId, ids } = await emailWith([
      { filename: "sticker.png", contentType: "image/png", content: png },
      { filename: "quote.pdf", contentType: "application/pdf", content: pdf },
      { filename: "page.html", contentType: "text/html", content: Buffer.from("<p>NVR <b>DS-7608NI</b></p>") },
    ]);
    const list = await call("crm_list_attachments", { email_id: emailId });
    expect(JSON.parse(list.content[0].text!).map((a: { filename: string }) => a.filename).sort()).toEqual(["page.html", "quote.pdf", "sticker.png"]);
    expect(list.content[0].text).not.toMatch(/\/(tmp|var|opt|home)\//);

    const doc = await call("crm_read_document", { attachment_id: ids["quote.pdf"] });
    expect(doc.isError).toBe(false);
    expect(doc.structuredContent).toMatchObject({ kind: "document" });
    expect(String(doc.structuredContent!.text)).toContain("DS-2CD2143G2-I");
    expect(String((await call("crm_read_document", { attachment_id: ids["page.html"] })).structuredContent!.text)).toBe("NVR DS-7608NI");

    const img = await call("crm_analyse_image", { attachment_id: ids["sticker.png"] });
    expect(img.isError).toBe(false);
    const image = img.content.find((c) => c.type === "image")!;
    expect(image.mimeType).toBe("image/jpeg");
    const meta = await sharp(Buffer.from(image.data!, "base64")).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(1568);
    const audit = await db.query.agentAudit.findFirst({ where: and(eq(S.agentAudit.tool, "crm_analyse_image"), eq(S.agentAudit.status, "ok")), orderBy: (a, { desc }) => [desc(a.createdAt)] });
    expect(audit!.resultSummary!.length).toBeLessThan(400);
    expect(audit!.resultSummary).not.toContain(image.data!.slice(0, 40));
  });

  it("the research profile has no attachment tools (it never sees customer content)", async () => {
    const list = (await handleMcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, HERMES_RESEARCH_ACTOR, "research")) as { result: { tools: { name: string }[] } };
    const names = list.result.tools.map((t) => t.name);
    expect(names).not.toEqual(expect.arrayContaining(["crm_list_attachments"]));
    for (const n of ["crm_list_attachments", "crm_read_document", "crm_analyse_image", "crm_get_email_thread", "crm_get_recording"]) expect(names).not.toContain(n);
    expect(names).toEqual(expect.arrayContaining(["brain_quote_patterns", "brain_propose_package", "supplier_compare"]));
    expect((await call("crm_read_document", { attachment_id: "00000000-0000-0000-0000-000000000000" }, "research")).isError).toBe(true);
  });
});

describe("candidate Business Brain packages", () => {
  it("Hermes proposes: the CRM attaches the evidence; unknown costs stay unknown; the candidate is never selected for quoting", async () => {
    const r = await call("brain_propose_package", {
      name: `Residential 6 camera double storey ${RUN}`,
      tier: "better",
      camera_count: 6,
      storey_type: "double",
      segment: "two-storey family homes wanting app viewing",
      components: [
        { role: "camera", product_id: cam.id, quantity: 6 },
        { role: "nvr", product_id: nvr.id, quantity: 1 },
        ...(hdd ? [{ role: "hdd", product_id: hdd.id, quantity: 1 }] : []),
      ],
      reasoning: "The configuration Chris keeps choosing for this kind of home.",
      proposed_markup_pct: 35,
      confidence: 0.8,
    });
    expect(r.isError).toBe(false);
    const id = String(r.structuredContent!.candidateId);
    made.candidates.push(id);
    const c = (await db.query.packageCandidates.findFirst({ where: eq(S.packageCandidates.id, id) }))!;
    expect(c).toMatchObject({ status: "candidate", proposedBy: "agent:hermes", cameraCount: 6, installationPackageKey: "RES_CCTV_DOUBLE_6" });
    const ev = c.evidence as { supplierRoute: { product: string }[]; costs: { hardwareTradeExGst: number | null; unknown: string[] }; compatibility: { name: string }[]; labour: { key: string } };
    expect(ev.supplierRoute.length).toBeGreaterThanOrEqual(2);
    expect(ev.compatibility.map((x) => x.name)).toContain("recorder channels");
    if (ev.costs.hardwareTradeExGst == null) expect(ev.costs.unknown.length).toBeGreaterThan(0); // never $0
    else expect(ev.costs.hardwareTradeExGst).toBeGreaterThan(0);
    // Not a kit: the Brain cannot select it.
    const cat = await loadCatalogue();
    expect((cat.kits ?? []).find((k) => k.name === c.name)).toBeUndefined();
  });

  it("Hermes cannot approve; a wrong component category is refused", async () => {
    const r = await call("brain_propose_package", { name: `Bad ${RUN}`, camera_count: 4, components: [{ role: "camera", product_id: nvr.id, quantity: 4 }, { role: "nvr", product_id: nvr.id, quantity: 1 }] });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/not a camera/);
    const c = await db.query.packageCandidates.findFirst({ where: eq(S.packageCandidates.status, "candidate") });
    await expect(decidePackage(c!.id, "approve", { kind: "agent", agent: "hermes" })).rejects.toBeInstanceOf(GuardrailError);
  });

  it("Chris approves as proposed (an approved kit the Brain selects), edits and approves, or rejects", async () => {
    const make = async (name: string, count: number) =>
      String(
        (
          await call("brain_propose_package", {
            name: `${name} ${RUN}`,
            key: `TEST_${name.toUpperCase().replace(/\W/g, "_")}_${RUN}`,
            tier: "better",
            camera_count: count,
            storey_type: "single",
            components: [
              { role: "camera", product_id: cam.id, quantity: count },
              { role: "nvr", product_id: nvr.id, quantity: 1 },
            ],
            confidence: 0.7,
          })
        ).structuredContent!.candidateId,
      );
    const a = await make("Approve", 3);
    const b = await make("Edit", 3);
    const c = await make("Reject", 3);
    made.candidates.push(a, b, c);
    const ra = await decidePackage(a, "approve", chris);
    made.kits.push(ra.kitId!);
    const kit = (await db.query.cctvKits.findFirst({ where: eq(S.cctvKits.id, ra.kitId!) }))!;
    expect(kit).toMatchObject({ status: "getsecure_approved", approvedById: chris.userId, cameraCount: 3, cameraProductId: cam.id, nvrProductId: nvr.id });
    const catalogue = await loadCatalogue();
    expect(kitFor((catalogue.kits ?? []).filter((k) => k.id === kit.id), "residential", "better", 3, catalogue.products)?.id).toBe(kit.id);

    const rb = await decidePackage(b, "approve", chris, { edits: { name: `Edited ${RUN}`, key: null, camera_count: 4, components: [{ role: "camera", product_id: cam2.id, quantity: 4, per_camera: false }, { role: "nvr", product_id: nvr.id, quantity: 1, per_camera: false }] }, note: "use the other camera" });
    made.kits.push(rb.kitId!);
    expect(await db.query.cctvKits.findFirst({ where: eq(S.cctvKits.id, rb.kitId!) })).toMatchObject({ name: `Edited ${RUN}`, cameraCount: 4, cameraProductId: cam2.id });
    expect(await db.query.packageCandidates.findFirst({ where: eq(S.packageCandidates.id, b) })).toMatchObject({ status: "approved", decisionNote: "Edited and approved: use the other camera" });

    await decidePackage(c, "reject", chris, { note: "Not a configuration we sell" });
    expect(await db.query.packageCandidates.findFirst({ where: eq(S.packageCandidates.id, c) })).toMatchObject({ status: "rejected", decisionNote: "Not a configuration we sell", createdKitId: null });
    await expect(decidePackage(c, "approve", chris)).rejects.toThrow(/Already rejected/);
  });

  it("a configuration quoted again and again with no approved kit becomes a candidate, once", async () => {
    const [lead] = await db.insert(S.leads).values({ name: `Pattern ${RUN}`, status: "won", source: "email", service: "CCTV" }).returning();
    made.leads.push(lead.id);
    const count = 7; // an unusual size, so no approved kit or other test data matches
    for (let i = 0; i < 4; i++) {
      const [a] = await db
        .insert(S.cctvAssessments)
        .values({ leadId: lead.id, input: {}, engineVersion: "test", actor: "user", packet: { propertyType: "residential", cameras: Array.from({ length: count }, () => ({ product: { id: cam.id } })), nvr: { selected: { id: nvr.id } }, recording: { storage: { drives: hdd ? { product: { id: hdd.id } } : null } }, installation: { storeys: 2 }, recommendedTier: "better" } })
        .returning();
      const [q] = await db.insert(S.quotes).values({ number: 800000 + Math.floor(Math.random() * 199999), title: `CCTV ${RUN}`, leadId: lead.id, status: "accepted", origin: "brain", assessmentId: a.id }).returning();
      made.quotes.push(q.id);
    }
    const first = await detectPackagePatterns();
    const mine = await db.query.packageCandidates.findMany({ where: and(eq(S.packageCandidates.proposedBy, "crm:pattern"), eq(S.packageCandidates.cameraCount, count)) });
    made.candidates.push(...mine.map((m) => m.id));
    expect(mine).toHaveLength(1);
    expect(first.proposed).toContain(mine[0].id);
    expect(mine[0].reasoning).toMatch(/in 4 of the last 4 similar quotes/);
    expect((mine[0].evidence as { quotes: unknown[] }).quotes).toHaveLength(4);
    expect(mine[0].status).toBe("candidate");
    await detectPackagePatterns();
    expect(await db.query.packageCandidates.findMany({ where: and(eq(S.packageCandidates.proposedBy, "crm:pattern"), eq(S.packageCandidates.cameraCount, count)) })).toHaveLength(1);
  });
});

describe("from the Inspector: research and the Business Brain's own outcome", () => {
  const input = (leadId: string) => ({ sourceType: "email" as const, sourceId: leadId, direction: "inbound" as const, at: new Date(), title: "Recorder died", text: "Our old recorder at 9 Secret Lane died, call me on 021 999 8888", utterances: [], from: { name: "Kim", email: `kim+${RUN}@example.com`, phone: "021 999 8888" }, context: [], linked: { leadId, contactId: null, jobId: null, how: null } });

  it("research not connected: the question becomes Chris's task; connected: only the question goes out and the finding is stored", async () => {
    const [l] = await db.insert(S.leads).values({ name: `Research ${RUN}`, status: "new", source: "email", service: "CCTV" }).returning();
    made.leads.push(l.id);
    const ins = (await db.insert(S.inspections).values({ sourceType: "email", sourceId: l.id, direction: "inbound", sourceAt: new Date(), version: "test", status: "analysed", engine: "hermes", leadId: l.id, identity: {}, understanding: {} } as never).returning())[0];
    const question = "Which current Hikvision NVR replaces the DS-7608NI-K2?";
    setResearchRuntime(null);
    const off = await routeActions([{ type: "REQUEST_RESEARCH", mode: "auto", rule: "hermes_research", reason: "the recorder died", payload: { question, kind: "product", product: "DS-7608NI-K2" } }], { inspectionId: ins.id, input: input(l.id), leadId: l.id, contactId: null, jobId: null });
    expect(off[0]).toMatchObject({ status: "done", result: { research: "not_configured" } });
    expect(await db.query.tasks.findFirst({ where: and(eq(S.tasks.leadId, l.id), eq(S.tasks.title, `Research: ${question}`)) })).toBeTruthy();

    const seen: string[] = [];
    setResearchRuntime({
      name: "test-research",
      model: "stand-in",
      complete: async (messages) => {
        seen.push(messages.map((m) => m.content).join("\n"));
        return { text: JSON.stringify({ summary: "DS-7608NXI-K2 is the current model.", findings: [{ claim: "DS-7608NXI-K2 replaces DS-7608NI-K2", confidence: 0.8, knowledge: "new", product: "DS-7608NXI-K2", sources: [{ url: "https://www.hikvision.com/en/products/x" }] }] }), model: "stand-in", durationMs: 1 };
      },
    });
    const on = await routeActions([{ type: "REQUEST_RESEARCH", mode: "auto", rule: "hermes_research", reason: "the recorder died", payload: { question, kind: "product", product: "DS-7608NI-K2" } }], { inspectionId: ins.id, input: input(l.id), leadId: l.id, contactId: null, jobId: null });
    expect(on[0]).toMatchObject({ status: "done", result: { research: "ok", findings: 1 } });
    expect(seen[0]).toContain(question);
    for (const secret of ["9 Secret Lane", "021 999 8888", `kim+${RUN}`]) expect(seen[0]).not.toContain(secret);
    const finding = await db.query.researchFindings.findFirst({ where: eq(S.researchFindings.id, String(on[0].result!.findingId)) });
    expect(finding).toMatchObject({ status: "ok", leadId: l.id, inspectionId: ins.id, requestedBy: "agent:hermes (inspector)" });
    expect((finding!.findings[0] as { product: string; sources: { tier: number }[] }).product).toBe("DS-7608NXI-K2");
    await db.delete(S.researchFindings).where(eq(S.researchFindings.inspectionId, ins.id));
    await db.delete(S.inspectorActions).where(eq(S.inspectorActions.inspectionId, ins.id));
    await db.delete(S.inspections).where(eq(S.inspections.id, ins.id));
  });

  it("the Brain decides its own inputs: it cannot design without a camera count, so its own question is drafted and no quote is made", async () => {
    const [l] = await db.insert(S.leads).values({ name: `Needs ${RUN}`, email: `needs+${RUN}@example.com`, site: "4 Rimu Road, Mt Eden", status: "new", source: "email", service: "CCTV" }).returning();
    made.leads.push(l.id);
    await db.insert(S.facts).values({ key: "property_type", value: "residential", display: "Residential", evidence: "our house", leadId: l.id, sourceType: "email", sourceId: l.id, sourceAt: new Date(), confidence: "0.900", state: "applied" });
    const ins = (await db.insert(S.inspections).values({ sourceType: "email", sourceId: l.id, direction: "inbound", sourceAt: new Date(), version: "test", status: "analysed", engine: "hermes", leadId: l.id, identity: {}, understanding: {} } as never).returning())[0];
    const out = await routeActions(
      [
        { type: "RUN_BUSINESS_BRAIN", mode: "auto", rule: "hermes_recommendation", reason: "quote", payload: {} },
        { type: "PREPARE_QUOTE", mode: "auto", rule: "hermes_recommendation", reason: "quote", payload: {} },
      ],
      { inspectionId: ins.id, input: { ...input(l.id), text: "Cameras for our house please" }, leadId: l.id, contactId: null, jobId: null },
    );
    const brain = out.find((a) => a.type === "RUN_BUSINESS_BRAIN")!;
    expect((brain.result!.needs as { field: string }[]).map((n) => n.field)).toContain("cameraCount");
    expect(out.find((a) => a.type === "PREPARE_QUOTE")).toMatchObject({ status: "blocked" });
    const ask = out.find((a) => a.type === "DRAFT_EMAIL")!;
    expect(ask).toMatchObject({ status: "done", rule: "business_brain_needs" });
    expect(await db.query.quotes.findFirst({ where: eq(S.quotes.leadId, l.id) })).toBeUndefined();
    const draft = (await db.query.drafts.findFirst({ where: eq(S.drafts.leadId, l.id) }))!;
    expect(draft.status).not.toBe("sent");
    expect(draft.body).toMatch(/how many cameras/i);
    await db.delete(S.cctvAssessments).where(eq(S.cctvAssessments.leadId, l.id));
    await db.delete(S.facts).where(eq(S.facts.leadId, l.id));
    await db.delete(S.inspectorActions).where(eq(S.inspectorActions.inspectionId, ins.id));
    await db.delete(S.inspections).where(eq(S.inspections.id, ins.id));
  });
});
