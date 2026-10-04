/**
 * Hermes's MCP tools: what it can read (nothing commercial or secret), what it can do (prepare and
 * propose only, through the guard), that everything is audited, and the endpoint's own lock.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray } from "drizzle-orm";

const { db } = await import("@/db");
const S = await import("@/db/schema");
const { handleMcp, HERMES_ACTOR, TOOLS } = await import("@/lib/hermes/mcp");
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
});
