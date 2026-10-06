/**
 * Hermes's MCP tools: what it can read (nothing commercial or secret), what it can do (prepare and
 * propose only, through the guard), that everything is audited, and the endpoint's own lock.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";

const { db } = await import("@/db");
const S = await import("@/db/schema");
const { handleMcp, HERMES_ACTOR, HERMES_RESEARCH_ACTOR, TOOLS } = await import("@/lib/hermes/mcp");
const { setResearchRuntime, requestResearch, gradeFindings, decideCandidate } = await import("@/lib/hermes/research");
const { sendDraft, approveDraft } = await import("@/lib/drafts/workflow");
const { GuardrailError } = await import("@/lib/guard/actor");

const RUN = `mcp${Date.now().toString(36)}`;
let leadId: string;
let commercialId: string;
let rpcId = 0;
const call = async (name: string, args: Record<string, unknown>) => {
  const res = (await handleMcp({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } })) as { result: { isError: boolean; content: { text: string }[]; structuredContent?: Record<string, unknown> } };
  return res.result;
};

beforeAll(async () => {
  const [l] = await db.insert(S.leads).values({ name: `Kiri MCP ${RUN}`, email: `kiri+${RUN}@example.com`, phone: "021 555 0101", site: "3 Rata Road, Ponsonby", status: "new", source: "email", service: "CCTV" }).returning();
  leadId = l.id;
  const [c] = await db.insert(S.leads).values({ name: `Warehouse MCP ${RUN}`, email: `wh+${RUN}@example.com`, status: "new", source: "email", service: "CCTV" }).returning();
  commercialId = c.id;
  await db.insert(S.facts).values({ key: "property_type", value: "commercial", display: "Commercial", evidence: "our warehouse", leadId: c.id, sourceType: "email", sourceId: c.id, sourceAt: new Date(), confidence: "0.900", state: "applied" });
});

afterAll(async () => {
  const ids = [leadId, commercialId];
  await db.delete(S.agentAudit).where(inArray(S.agentAudit.leadId, ids));
  await db.delete(S.drafts).where(inArray(S.drafts.leadId, ids));
  await db.delete(S.tasks).where(inArray(S.tasks.leadId, ids));
  await db.delete(S.leads).where(inArray(S.leads.id, ids));
});

describe("the protocol", () => {
  it("initialises and lists only read and prepare/propose tools", async () => {
    const init = (await handleMcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "hermes-agent", version: "x" } } })) as { result: { protocolVersion: string; capabilities: { tools: unknown } } };
    expect(init.result.protocolVersion).toBe("2025-06-18");
    expect(init.result.capabilities.tools).toBeTruthy();
    expect(await handleMcp({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    const list = (await handleMcp({ jsonrpc: "2.0", id: 2, method: "tools/list" })) as { result: { tools: { name: string; inputSchema: { type: string } }[] } };
    const names = list.result.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["crm_get_lead", "crm_get_timeline", "crm_prepare_quote", "crm_prepare_draft_reply", "crm_propose_fact_update", "crm_request_review"]));
    for (const n of names) expect(n).not.toMatch(/send|approve|confirm|accept|discount|delete|apply_fact|price/);
    for (const t of list.result.tools) expect(t.inputSchema.type).toBe("object");
    expect(TOOLS.every((t) => t.access === "read" || t.access === "write")).toBe(true);
  });

  it("answers unknown methods with a JSON-RPC error", async () => {
    expect(await handleMcp({ jsonrpc: "2.0", id: 9, method: "resources/list" })).toMatchObject({ error: { code: -32601 } });
  });
});

describe("reading", () => {
  it("a lead, its quotes and its Brain outcome, without costs or supplier data; audited", async () => {
    const lead = await call("crm_get_lead", { lead_id: leadId });
    expect(lead.isError).toBe(false);
    expect(lead.structuredContent).toMatchObject({ name: `Kiri MCP ${RUN}`, site: "3 Rata Road, Ponsonby" });
    const quotes = await call("crm_get_quotes", { lead_id: leadId });
    expect(quotes.content[0].text).not.toMatch(/cost|margin|markup|supplier/i);
    const audit = await db.query.agentAudit.findFirst({ where: and(eq(S.agentAudit.leadId, leadId), eq(S.agentAudit.tool, "crm_get_lead")) });
    expect(audit).toMatchObject({ agent: "hermes", access: "read", status: "ok" });
  });
});

describe("acting: prepare and propose only", () => {
  it("a note and a task, audited as writes", async () => {
    expect((await call("crm_add_internal_note", { lead_id: leadId, text: "Prefers a call after 3pm." })).isError).toBe(false);
    const t = await call("crm_create_internal_task", { lead_id: leadId, title: `Ring Kiri ${RUN}` });
    expect(t.isError).toBe(false);
    expect(await db.query.tasks.findFirst({ where: eq(S.tasks.title, `Ring Kiri ${RUN}`) })).toBeTruthy();
    // The same task again: the open one is returned, never a second.
    expect((await call("crm_create_internal_task", { lead_id: leadId, title: `Ring Kiri ${RUN}` })).isError).toBe(false);
    expect(await db.query.tasks.findMany({ where: eq(S.tasks.title, `Ring Kiri ${RUN}`) })).toHaveLength(1);
    const audit = await db.query.agentAudit.findFirst({ where: and(eq(S.agentAudit.leadId, leadId), eq(S.agentAudit.tool, "crm_create_internal_task")) });
    expect(audit).toMatchObject({ access: "write", status: "ok" });
  });

  it("a reply draft waits for Chris; Hermes can neither approve nor send it; a price in it is refused", async () => {
    const ok = await call("crm_prepare_draft_reply", { lead_id: leadId, subject: "Your cameras", body: "Hi Kiri, thanks. Chris will put a quote together for you." });
    expect(ok.isError).toBe(false);
    const draftId = String(ok.structuredContent!.draftId);
    const d = (await db.query.drafts.findFirst({ where: eq(S.drafts.id, draftId) }))!;
    expect(d).toMatchObject({ status: "ready_for_review", createdByActor: "agent:hermes" });
    await expect(approveDraft(draftId, HERMES_ACTOR)).rejects.toBeInstanceOf(GuardrailError);
    await expect(sendDraft(draftId, HERMES_ACTOR)).rejects.toBeInstanceOf(GuardrailError);

    const priced = await call("crm_prepare_draft_reply", { lead_id: leadId, subject: "Price", body: "Hi Kiri, that's $1,450 including GST." });
    expect(priced.isError).toBe(true);
    expect(priced.content[0].text).toMatch(/Refused: Draft refused: it quotes a price/);
    const audit = await db.query.agentAudit.findFirst({ where: and(eq(S.agentAudit.leadId, leadId), eq(S.agentAudit.tool, "crm_prepare_draft_reply"), eq(S.agentAudit.status, "denied")) });
    expect(audit).toBeTruthy();
  });

  it("facts are proposed or flagged for Chris, never written over the CRM", async () => {
    const blank = await call("crm_propose_fact_update", { lead_id: leadId, key: "camera_count", value: 4, evidence: "four cameras please" });
    expect(blank.structuredContent).toMatchObject({ outcome: "proposed" });
    const conflict = await call("crm_propose_fact_update", { lead_id: leadId, key: "site_address", value: "5 Rata Road, Ponsonby", evidence: "it's actually number 5" });
    expect(conflict.structuredContent).toMatchObject({ outcome: "conflict" });
    expect((await db.query.leads.findFirst({ where: eq(S.leads.id, leadId) }))!.site).toBe("3 Rata Road, Ponsonby");
    const f = await db.query.facts.findMany({ where: eq(S.facts.leadId, leadId) });
    expect(f.map((x) => x.state).sort()).toEqual(["conflict", "proposed"]);
    expect((await call("crm_propose_fact_update", { lead_id: leadId, key: "camera_count", value: 900, evidence: "lots" })).isError).toBe(true);
    await db.delete(S.facts).where(eq(S.facts.leadId, leadId));
  });

  it("the Business Brain's policy holds: no quote for commercial CCTV", async () => {
    const r = await call("crm_prepare_quote", { lead_id: commercialId });
    expect(r.structuredContent).toMatchObject({ blocked: true });
    expect(r.content[0].text).toMatch(/site visit/);
    expect(await db.query.quotes.findFirst({ where: eq(S.quotes.leadId, commercialId) })).toBeUndefined();
    await db.delete(S.facts).where(eq(S.facts.leadId, commercialId));
  });

  it("an unknown tool and bad arguments are refused and audited", async () => {
    expect((await call("crm_send_email", { lead_id: leadId })).isError).toBe(true);
    expect(await db.query.agentAudit.findFirst({ where: and(eq(S.agentAudit.tool, "crm_send_email"), eq(S.agentAudit.status, "denied")) })).toBeTruthy();
    expect((await call("crm_get_lead", { lead_id: "not-a-uuid" })).isError).toBe(true);
    await db.delete(S.agentAudit).where(eq(S.agentAudit.tool, "crm_send_email"));
  });
});

describe("the endpoint's lock", () => {
  it("is off without HERMES_MCP_TOKEN, and refuses a wrong token", async () => {
    const { POST } = await import("@/app/api/mcp/route");
    const req = (auth?: string) => new Request("http://localhost/api/mcp", { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
    const before = process.env.HERMES_MCP_TOKEN;
    try {
      delete process.env.HERMES_MCP_TOKEN;
      expect((await POST(req("Bearer anything"))).status).toBe(404);
      process.env.HERMES_MCP_TOKEN = "test-token-not-a-secret-0123456789";
      expect((await POST(req())).status).toBe(401);
      expect((await POST(req("Bearer wrong-token-not-a-secret-012345"))).status).toBe(401);
      const ok = await POST(req("Bearer test-token-not-a-secret-0123456789"));
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ jsonrpc: "2.0", id: 1, result: {} });
    } finally {
      if (before === undefined) delete process.env.HERMES_MCP_TOKEN;
      else process.env.HERMES_MCP_TOKEN = before;
    }
  });

  it("is off while the inspector and research tokens are the same value (the research profile must never pass as the inspector)", async () => {
    const { POST } = await import("@/app/api/mcp/route");
    const { mcpTokensMisconfigured } = await import("@/lib/hermes/mcp-tokens");
    const req = (auth: string) => new Request("http://localhost/api/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: auth }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
    const before = { a: process.env.HERMES_MCP_TOKEN, b: process.env.HERMES_RESEARCH_MCP_TOKEN };
    try {
      process.env.HERMES_MCP_TOKEN = "same-token-not-a-secret-0123456789";
      process.env.HERMES_RESEARCH_MCP_TOKEN = "same-token-not-a-secret-0123456789";
      expect(mcpTokensMisconfigured()).toBe(true);
      expect((await POST(req("Bearer same-token-not-a-secret-0123456789"))).status).toBe(404);
      process.env.HERMES_RESEARCH_MCP_TOKEN = "other-token-not-a-secret-0123456789";
      expect(mcpTokensMisconfigured()).toBe(false);
      expect((await POST(req("Bearer same-token-not-a-secret-0123456789"))).status).toBe(200);
    } finally {
      for (const [k, v] of [["HERMES_MCP_TOKEN", before.a], ["HERMES_RESEARCH_MCP_TOKEN", before.b]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe("research and candidate Business Brain updates (stage 2)", () => {
  const asResearch = async (name: string, args: Record<string, unknown>) =>
    ((await handleMcp({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }, HERMES_RESEARCH_ACTOR, "research")) as { result: { isError: boolean; content: { text: string }[] } }).result;
  let researchReply = "";
  afterAll(async () => {
    setResearchRuntime(undefined);
    await db.delete(S.brainCandidates).where(sql`${S.brainCandidates.title} like ${`%${RUN}%`}`);
    await db.delete(S.researchFindings).where(sql`${S.researchFindings.question} like ${`%${RUN}%`}`);
  });

  it("each Hermes profile sees only its own tools", async () => {
    const list = async (profile: "inspector" | "research") => ((await handleMcp({ jsonrpc: "2.0", id: ++rpcId, method: "tools/list" }, profile === "research" ? HERMES_RESEARCH_ACTOR : HERMES_ACTOR, profile)) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
    const inspector = await list("inspector");
    const research = await list("research");
    expect(inspector).toEqual(expect.arrayContaining(["crm_search_catalogue", "crm_request_research", "crm_propose_brain_update"]));
    expect(inspector.some((n) => n.startsWith("supplier_"))).toBe(false);
    expect(research).toEqual(expect.arrayContaining(["supplier_list", "supplier_search_catalogue", "supplier_get_product", "supplier_compare", "supplier_check_stock", "crm_propose_brain_update"]));
    // The research profile reaches no customer data and cannot act on the CRM.
    for (const n of ["crm_get_lead", "crm_get_timeline", "crm_add_internal_note", "crm_prepare_quote", "crm_find_people"]) expect(research).not.toContain(n);
    expect(await asResearch("crm_get_lead", { lead_id: leadId })).toMatchObject({ isError: true });
  });

  it("the Inspector's catalogue has no costs; the research profile's shows stored trade prices with their approval state; no login anywhere", async () => {
    const inspectorView = await call("crm_search_catalogue", { query: "VIGI" });
    expect(inspectorView.isError).toBe(false);
    expect(inspectorView.content[0].text).not.toMatch(/tradeCost|costExGst|pendingCost/);
    const researchView = await asResearch("supplier_search_catalogue", { query: "VIGI" });
    expect(researchView.isError).toBe(false);
    if (/"suppliers":\[\{/.test(researchView.content[0].text)) expect(researchView.content[0].text).toContain("approvedByChris");
    const suppliersList = await asResearch("supplier_list", {});
    expect(suppliersList.content[0].text).not.toMatch(/secret|password|secretEncrypted|username/i);
  });

  it("research is brokered to the research profile: sources graded by tier, findings stored, proposed updates become candidates", async () => {
    setResearchRuntime({
      name: "test-research",
      model: "stand-in-research",
      complete: async (messages) => {
        // The research profile is given the question only, never a customer's message.
        expect(messages[1].content).toContain(`C540 ${RUN}`);
        return { text: researchReply, model: "stand-in-research", durationMs: 2 };
      },
    });
    researchReply = JSON.stringify({
      summary: "The VIGI C540 is current; firmware 1.2 adds smart detection.",
      findings: [
        { claim: `VIGI C540 ${RUN} supports 4MP and smart detection`, confidence: 0.9, knowledge: "new", sources: [{ url: "https://www.tp-link.com/nz/business-networking/vigi-network-camera/vigi-c540/", title: "VIGI C540 datasheet", publisher: "TP-Link" }], proposed_update: { kind: "technical_fact", title: `VIGI C540 smart detection ${RUN}`, detail: "Firmware 1.2 adds smart detection.", payload: { model: "VIGI C540" } } },
        { claim: "Some forum says it overheats", confidence: 0.8, knowledge: "approved", sources: [{ url: "https://forum.example.org/t/1", title: "Forum thread" }] },
        { claim: "No source at all", confidence: 0.9, knowledge: "new", sources: [] },
      ],
    });
    const r = await call("crm_request_research", { question: `Is the VIGI C540 ${RUN} current and does it do smart detection?`, kind: "product" });
    expect(r.isError).toBe(false);
    const out = JSON.parse(r.content[0].text);
    expect(out.status).toBe("ok");
    expect(out.findings).toHaveLength(2); // the unsourced claim is dropped
    expect(out.findings[0].sources[0].tier).toBe("Manufacturer documentation");
    // General web: capped and never "approved knowledge".
    expect(out.findings[1]).toMatchObject({ confidence: 0.4, knowledge: "new" });
    expect(out.candidates).toHaveLength(1);
    const cand = (await db.query.brainCandidates.findFirst({ where: eq(S.brainCandidates.id, out.candidates[0].id) }))!;
    expect(cand).toMatchObject({ status: "proposed", kind: "technical_fact" });
    expect(await db.query.researchFindings.findFirst({ where: and(eq(S.researchFindings.requestedBy, "agent:hermes"), sql`${S.researchFindings.question} like ${`%${RUN}%`}`) })).toBeTruthy();

    // Only Chris decides; accepting changes nothing in the catalogue.
    const productsBefore = (await db.select({ id: S.products.id }).from(S.products)).length;
    await expect(decideCandidate(cand.id, "accepted", null, HERMES_ACTOR)).rejects.toBeInstanceOf(GuardrailError);
    const [chris] = await db.insert(S.users).values({ email: `chris-${RUN}@test.local`, name: "Chris", passwordHash: "x", role: "admin", canApprove: true }).returning();
    try {
      await decideCandidate(cand.id, "accepted", "Add to the catalogue next week.", { kind: "human", userId: chris.id, name: "Chris", canApprove: true });
      expect((await db.query.brainCandidates.findFirst({ where: eq(S.brainCandidates.id, cand.id) }))!).toMatchObject({ status: "accepted", decidedById: chris.id });
      expect((await db.select({ id: S.products.id }).from(S.products)).length).toBe(productsBefore);
    } finally {
      await db.update(S.brainCandidates).set({ decidedById: null }).where(eq(S.brainCandidates.id, cand.id));
      await db.delete(S.users).where(eq(S.users.id, chris.id));
    }
  });

  it("not connected or unusable: recorded, nothing invented", async () => {
    setResearchRuntime(null);
    expect(await requestResearch({ question: `Anything ${RUN}`, requestedBy: "agent:hermes" })).toMatchObject({ status: "not_configured", findings: [] });
    setResearchRuntime({ name: "x", model: "x", complete: async () => ({ text: "I could not find much, sorry.", model: "x", durationMs: 1 }) });
    expect(await requestResearch({ question: `Unusable ${RUN}`, requestedBy: "agent:hermes" })).toMatchObject({ status: "failed", findings: [] });
  });

  it("a candidate proposed directly needs sources (except a workflow lesson); prices cannot be proposed", async () => {
    const noSource = await call("crm_propose_brain_update", { kind: "product", title: `New camera ${RUN}`, confidence: 0.8 });
    expect(noSource.isError).toBe(true);
    const ok = await asResearch("crm_propose_brain_update", { kind: "compatibility", title: `S455 works with NVR1004H ${RUN}`, sources: [{ url: "https://www.tp-link.com/nz/support/compat" }], confidence: 0.85 });
    expect(ok.isError).toBe(false);
    const lesson = await call("crm_propose_brain_update", { kind: "workflow", title: `Tenants reporting faults belong to the landlord's job ${RUN}`, confidence: 0.7 });
    expect(lesson.isError).toBe(false);
    expect((await call("crm_propose_brain_update", { kind: "price", title: `Cheaper price ${RUN}`, confidence: 0.9 })).isError).toBe(true);
    expect(gradeFindings({ summary: "", findings: [{ claim: "x", confidence: 0.9, knowledge: "approved", sources: [{ url: "crm:product:abc" }] }] }, { supplierHosts: [], manufacturerWords: [] })[0]).toMatchObject({ knowledge: "approved", bestTier: 0 });
  });
});
