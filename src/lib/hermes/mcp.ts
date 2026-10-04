/**
 * The CRM's tools for Hermes, over MCP (Model Context Protocol, JSON-RPC over HTTP; the route is
 * src/app/api/mcp/route.ts). Hermes Agent connects to it as an MCP server.
 *
 * Hermes has no database access. It gets these tools only, as agent:hermes:
 *   - read tools (through crm-read.ts: no supplier, cost, margin or credential data);
 *   - controlled actions that only ever prepare or propose: internal notes and tasks, a Business
 *     Brain run, a quote prepared for Approvals, a reply draft for Chris, a fact proposal or
 *     conflict for Chris, a review request, a proposal (site visit, booking, revised quote) for Chris.
 * There is no tool that sends, approves, confirms, accepts, discounts or writes a fact into the
 * CRM directly, and the guard (src/lib/guard/actor.ts) refuses those for agents anyway.
 *
 * Every call, allowed, refused or failed, is written to agent_audit.
 */
import { and, desc, eq, inArray, notInArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { agentAudit, drafts, facts, inspections, inspectorActions, leads, tasks, users } from "@/db/schema";
import { logActivity } from "@/lib/activity";
import { createDraft } from "@/lib/drafts/workflow";
import { prepareFromAssessment, runAssessment } from "@/lib/brain/store";
import { type Actor, assertAgentMay, GuardrailError, type AgentCapability } from "@/lib/guard/actor";
import { enquiryWithFacts } from "@/lib/inspector/brain";
import { normaliseFact, replyProblem } from "@/lib/inspector/validate";
import { crmKnown, serviceKey } from "@/lib/inspector/sources";
import { FACT_KEYS, type FactKey } from "@/lib/inspector/types";
import { dateInAppTz } from "@/lib/email/pipeline";
import { findPeople, readBrainOutcome, readCommitments, readCustomer, readEmailThread, readFacts, readInspection, readLead, readOpenTasks, readQuotes, readRecording, readTimeline, readVisitsAndJobs } from "./crm-read";

export const HERMES_ACTOR: Actor = { kind: "agent", agent: "hermes" };
export const MCP_PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const uuid = z.string().uuid();
const scope = z.object({ lead_id: uuid.optional(), customer_id: uuid.optional() }).refine((v) => v.lead_id || v.customer_id, "lead_id or customer_id is required");

type Tool = {
  name: string;
  description: string;
  access: "read" | "write";
  capability: AgentCapability;
  input: z.ZodType;
  run: (args: never) => Promise<unknown>;
  leadOf?: (args: Record<string, unknown>) => { leadId?: string | null; contactId?: string | null };
};

const tool = <S extends z.ZodType>(t: Omit<Tool, "input" | "run"> & { input: S; run: (args: z.infer<S>) => Promise<unknown> }): Tool => t as unknown as Tool;
const ids = (a: Record<string, unknown>) => ({ leadId: (a.lead_id as string) ?? null, contactId: (a.customer_id as string) ?? null });

async function requireLead(leadId: string) {
  const l = await db.query.leads.findFirst({ where: eq(leads.id, leadId), columns: { id: true, name: true, contactId: true, email: true } });
  if (!l) throw new Error("Lead not found.");
  return l;
}
async function chrisId() {
  return (await db.query.users.findFirst({ where: and(eq(users.canApprove, true), eq(users.active, true)), columns: { id: true } }))?.id ?? null;
}

export const TOOLS: Tool[] = [
  // ---------------- read ----------------
  tool({ name: "crm_find_people", access: "read", capability: "read_leads", description: "Find leads and customers by name, company, email, phone digits or address.", input: z.object({ query: z.string().min(2).max(200) }), run: (a) => findPeople(a.query) }),
  tool({ name: "crm_get_lead", access: "read", capability: "read_leads", description: "A lead's record: contact details, service, site, status, follow-up, summary.", input: z.object({ lead_id: uuid }), run: (a) => readLead(a.lead_id), leadOf: ids }),
  tool({ name: "crm_get_customer", access: "read", capability: "read_customers", description: "A customer's record.", input: z.object({ customer_id: uuid }), run: (a) => readCustomer(a.customer_id), leadOf: ids }),
  tool({
    name: "crm_get_timeline",
    access: "read",
    capability: "read_timeline",
    description: "The lead's or customer's history as headlines (emails, calls, notes, visits, quotes, jobs, Inspector steps).",
    input: z.object({ lead_id: uuid.optional(), customer_id: uuid.optional(), limit: z.number().int().min(1).max(50).optional() }),
    run: (a) => readTimeline({ leadId: a.lead_id, contactId: a.customer_id }, a.limit ?? 20),
    leadOf: ids,
  }),
  tool({ name: "crm_get_open_tasks", access: "read", capability: "read_leads", description: "Open tasks for a lead or customer.", input: scope, run: (a) => readOpenTasks({ leadId: a.lead_id, contactId: a.customer_id }), leadOf: ids }),
  tool({
    name: "crm_get_commitments",
    access: "read",
    capability: "read_leads",
    description: "What Get Secure and the customer said they would do (outstanding, or all).",
    input: z.object({ lead_id: uuid.optional(), customer_id: uuid.optional(), include_done: z.boolean().optional() }),
    run: (a) => readCommitments({ leadId: a.lead_id, contactId: a.customer_id }, { includeDone: a.include_done }),
    leadOf: ids,
  }),
  tool({ name: "crm_get_quotes", access: "read", capability: "read_leads", description: "Quotes as the customer sees them (number, title, status, total inc GST). No costs or margins.", input: scope, run: (a) => readQuotes({ leadId: a.lead_id, contactId: a.customer_id }), leadOf: ids }),
  tool({ name: "crm_get_visits_and_jobs", access: "read", capability: "read_leads", description: "Site visits and jobs.", input: scope, run: (a) => readVisitsAndJobs({ leadId: a.lead_id, contactId: a.customer_id }), leadOf: ids }),
  tool({ name: "crm_get_facts", access: "read", capability: "read_leads", description: "Facts on record for a lead or customer, with their source and evidence (applied, proposed, conflicting).", input: scope, run: (a) => readFacts({ leadId: a.lead_id, contactId: a.customer_id }), leadOf: ids }),
  tool({ name: "crm_get_business_brain_outcome", access: "read", capability: "read_assessments", description: "The latest Business Brain run for a lead: cameras, site visit needed, fully priced or not, what is unpriced. No costs.", input: z.object({ lead_id: uuid }), run: (a) => readBrainOutcome(a.lead_id), leadOf: ids }),
  tool({ name: "crm_get_email_thread", access: "read", capability: "read_timeline", description: "The emails in a thread (newest first).", input: z.object({ thread_id: uuid }), run: (a) => readEmailThread(a.thread_id) }),
  tool({ name: "crm_get_recording", access: "read", capability: "read_timeline", description: "A Plaud recording's transcript.", input: z.object({ recording_id: uuid }), run: (a) => readRecording(a.recording_id) }),
  tool({ name: "crm_get_inspection", access: "read", capability: "read_timeline", description: "An Inspector result: what Hermes said, and what the validator did with it.", input: z.object({ inspection_id: uuid }), run: (a) => readInspection(a.inspection_id) }),
  tool({
    name: "crm_list_review_queue",
    access: "read",
    capability: "read_leads",
    description: "What is waiting for Chris in the Inspector: items to review and proposals to accept.",
    input: z.object({}),
    run: async () => {
      const review = await db.query.inspections.findMany({ where: eq(inspections.status, "needs_review"), orderBy: [desc(inspections.createdAt)], limit: 30, columns: { id: true, sourceType: true, sourceId: true, reviewKind: true, summary: true, leadId: true, createdAt: true } });
      const waiting = await db.query.inspectorActions.findMany({ where: and(eq(inspectorActions.status, "awaiting_approval"), notInArray(inspectorActions.type, ["NEEDS_REVIEW", "LINK_RECORDING"])), orderBy: [desc(inspectorActions.createdAt)], limit: 30, columns: { id: true, type: true, reason: true, leadId: true, createdAt: true } });
      return { review, waiting };
    },
  }),

  // ---------------- controlled actions (prepare / propose only) ----------------
  tool({
    name: "crm_add_internal_note",
    access: "write",
    capability: "add_internal_note",
    description: "Add an internal note to a lead's or customer's timeline. Never seen by the customer.",
    input: z.object({ lead_id: uuid.optional(), customer_id: uuid.optional(), text: z.string().min(1).max(4000) }).refine((v) => v.lead_id || v.customer_id, "lead_id or customer_id is required"),
    run: async (a) => {
      await logActivity({ entity: a.lead_id ? "lead" : "contact", entityId: (a.lead_id ?? a.customer_id)!, actorId: null, action: "note", detail: { body: a.text, by: "Hermes" } });
      return { ok: true };
    },
    leadOf: ids,
  }),
  tool({
    name: "crm_create_internal_task",
    access: "write",
    capability: "create_internal_task",
    description: "Create a task for Chris on a lead or customer (internal; nothing is sent).",
    input: z.object({ lead_id: uuid.optional(), customer_id: uuid.optional(), title: z.string().min(1).max(200), due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), detail: z.string().max(2000).optional() }).refine((v) => v.lead_id || v.customer_id, "lead_id or customer_id is required"),
    run: async (a) => {
      const today = dateInAppTz(new Date());
      const [t] = await db.insert(tasks).values({ title: a.title, detail: a.detail ? `${a.detail}\n(From Hermes)` : "From Hermes", dueAt: a.due && a.due >= today ? a.due : today, kind: "task", leadId: a.lead_id ?? null, contactId: a.customer_id ?? null, assignedToId: await chrisId() }).returning({ id: tasks.id });
      return { taskId: t.id };
    },
    leadOf: ids,
  }),
  tool({
    name: "crm_run_business_brain",
    access: "write",
    capability: "run_assessment",
    description: "Run the CCTV Business Brain on a lead from the facts on record. Returns its outcome (site visit needed, priced or not). The Brain decides design and pricing.",
    input: z.object({ lead_id: uuid }),
    run: async (a) => {
      await requireLead(a.lead_id);
      const input = await enquiryWithFacts(a.lead_id);
      if (!input) throw new Error("Lead not found.");
      const r = await runAssessment(a.lead_id, input, HERMES_ACTOR);
      await logActivity({ entity: "lead", entityId: a.lead_id, actorId: null, action: "brain_run_by_inspector", detail: { assessmentId: r.id, by: "Hermes", complete: r.packet.costing.complete, siteVisit: !!r.packet.siteVisit?.required } });
      return readBrainOutcome(a.lead_id);
    },
    leadOf: ids,
  }),
  tool({
    name: "crm_prepare_quote",
    access: "write",
    capability: "create_quote_draft",
    description: "Run the Business Brain and prepare the quote (and a reply, if none is waiting) for Chris's approval in Approvals. Never sends. Refused for commercial CCTV (site visit first); blocked if the Brain needs a visit or nothing has an approved price.",
    input: z.object({ lead_id: uuid }),
    run: async (a) => {
      const lead = await requireLead(a.lead_id);
      const known = await crmKnown(a.lead_id, lead.contactId);
      if (serviceKey(String(known.service ?? "")) === "cctv" && known.property_type === "commercial") return { blocked: true, reason: "Commercial CCTV is always designed from a site visit. Use crm_propose_action with PROPOSE_SITE_VISIT." };
      assertAgentMay(HERMES_ACTOR, "run_assessment");
      const input = await enquiryWithFacts(a.lead_id);
      if (!input) throw new Error("Lead not found.");
      const run = await runAssessment(a.lead_id, input, HERMES_ACTOR);
      if (run.packet.siteVisit?.required) return { blocked: true, reason: "The Business Brain requires a site visit first.", reasons: run.packet.siteVisit.reasons };
      const priced = run.packet.costing.lines.filter((l) => l.priced && l.unitSellExGst != null && !l.internalOnly).length;
      if (!priced) {
        const [t] = await db.insert(tasks).values({ title: `Price the quote for ${lead.name}`, detail: "Hermes asked for a quote; nothing in the Business Brain's design has an approved price yet.", dueAt: dateInAppTz(new Date()), kind: "quote", leadId: lead.id, contactId: lead.contactId, assignedToId: await chrisId() }).returning({ id: tasks.id });
        return { blocked: true, reason: "Nothing in the design has an approved price yet, so no quote was prepared.", taskId: t.id };
      }
      const waiting = await db.query.drafts.findFirst({ where: and(eq(drafts.leadId, lead.id), eq(drafts.kind, "email"), inArray(drafts.status, ["draft", "ready_for_review", "approved"])), columns: { id: true } });
      const r = await prepareFromAssessment(run.id, { quote: true, email: !waiting }, HERMES_ACTOR);
      await logActivity({ entity: "lead", entityId: lead.id, actorId: null, action: "quote_prepared_by_inspector", detail: { quoteId: r.quoteId, quoteNumber: r.quoteNumber, draftId: r.draftId ?? null, by: "Hermes" } });
      return { prepared: true, quoteNumber: r.quoteNumber ? `Q-${r.quoteNumber}` : null, waitsFor: "Chris's approval in Approvals" };
    },
    leadOf: ids,
  }),
  tool({
    name: "crm_prepare_draft_reply",
    access: "write",
    capability: "create_email_draft",
    description: "Prepare a reply to the customer for Chris to review and approve. Never sent by this. Refused if it quotes a price, offers a discount or promises a date.",
    input: z.object({ lead_id: uuid, subject: z.string().min(1).max(200), body: z.string().min(1).max(8000) }),
    run: async (a) => {
      const lead = await requireLead(a.lead_id);
      const problem = replyProblem(a.body);
      if (problem) throw new GuardrailError(`Draft refused: ${problem}.`);
      if (!lead.email) throw new Error("The lead has no email address.");
      const d = await createDraft({ kind: "email", leadId: lead.id, contactId: lead.contactId, to: [lead.email], subject: a.subject, body: a.body }, HERMES_ACTOR, { submit: true });
      return { draftId: d.id, status: d.status, waitsFor: "Chris's approval" };
    },
    leadOf: ids,
  }),
  tool({
    name: "crm_propose_fact_update",
    access: "write",
    capability: "propose_fact_update",
    description: "Propose a fact for a lead (e.g. camera_count, storeys, site_address) with the evidence. Chris applies it; a value that differs from the CRM is flagged as a conflict, never overwritten.",
    input: z.object({ lead_id: uuid, key: z.enum(FACT_KEYS), value: z.union([z.string().max(500), z.number(), z.boolean()]), evidence: z.string().min(3).max(500) }),
    run: async (a) => proposeFact(a.lead_id, a.key, a.value, a.evidence, false),
    leadOf: ids,
  }),
  tool({
    name: "crm_flag_conflict",
    access: "write",
    capability: "propose_fact_update",
    description: "Flag that something the customer said conflicts with the CRM (address, phone, email…), with the evidence, for Chris to decide.",
    input: z.object({ lead_id: uuid, key: z.enum(FACT_KEYS), value: z.union([z.string().max(500), z.number(), z.boolean()]), evidence: z.string().min(3).max(500) }),
    run: async (a) => proposeFact(a.lead_id, a.key, a.value, a.evidence, true),
    leadOf: ids,
  }),
  tool({
    name: "crm_propose_action",
    access: "write",
    capability: "propose_booking",
    description: "Propose a site visit, a booking or a revised quote for Chris to accept in the Inspector. Accepting never contacts the customer.",
    input: z.object({ lead_id: uuid, type: z.enum(["PROPOSE_SITE_VISIT", "PROPOSE_BOOKING", "PREPARE_REVISED_QUOTE"]), reason: z.string().min(3).max(600) }),
    run: async (a) => {
      const lead = await requireLead(a.lead_id);
      const ins = await db.query.inspections.findFirst({ where: eq(inspections.leadId, lead.id), orderBy: [desc(inspections.createdAt)], columns: { id: true } });
      if (!ins) throw new Error("This lead has no Inspector record to attach a proposal to; use crm_request_review or crm_create_internal_task.");
      const [row] = await db.insert(inspectorActions).values({ inspectionId: ins.id, type: a.type, mode: "approval", status: "awaiting_approval", rule: "hermes_mcp", reason: `Hermes: ${a.reason}`, payload: {}, leadId: lead.id, contactId: lead.contactId }).returning({ id: inspectorActions.id });
      return { proposalId: row.id, waitsFor: "Chris in the Inspector" };
    },
    leadOf: ids,
  }),
  tool({
    name: "crm_request_review",
    access: "write",
    capability: "request_review",
    description: "Ask Chris to look at something: an Inspector result, or a lead.",
    input: z.object({ inspection_id: uuid.optional(), lead_id: uuid.optional(), reason: z.string().min(3).max(600) }).refine((v) => v.inspection_id || v.lead_id, "inspection_id or lead_id is required"),
    run: async (a) => {
      if (a.inspection_id) {
        const ins = await db.query.inspections.findFirst({ where: eq(inspections.id, a.inspection_id), columns: { id: true, leadId: true, contactId: true } });
        if (!ins) throw new Error("Inspection not found.");
        await db.insert(inspectorActions).values({ inspectionId: ins.id, type: "NEEDS_REVIEW", mode: "approval", status: "awaiting_approval", rule: "hermes_mcp", reason: `Hermes: ${a.reason}`, payload: { kind: "hermes_flagged" }, leadId: ins.leadId, contactId: ins.contactId });
        await db.update(inspections).set({ status: "needs_review", reviewKind: "hermes_flagged", reviewedAt: null, updatedAt: new Date() }).where(eq(inspections.id, ins.id));
        return { queued: "Inspector review" };
      }
      const lead = await requireLead(a.lead_id!);
      const [t] = await db.insert(tasks).values({ title: `Hermes asks you to review ${lead.name}`, detail: a.reason, dueAt: dateInAppTz(new Date()), kind: "task", leadId: lead.id, contactId: lead.contactId, assignedToId: await chrisId() }).returning({ id: tasks.id });
      return { taskId: t.id };
    },
    leadOf: ids,
  }),
];

/** A fact from Hermes: proposed (or a conflict) for Chris; never written into the CRM directly. */
async function proposeFact(leadId: string, key: FactKey, raw: string | number | boolean, evidence: string, conflictOnly: boolean) {
  const lead = await requireLead(leadId);
  const n = normaliseFact(key, raw);
  if (!n) throw new Error(`"${String(raw)}" is not a usable ${key.replace(/_/g, " ")}.`);
  const known = await crmKnown(lead.id, lead.contactId);
  const current = known[key];
  const same = current !== undefined && String(current).toLowerCase().split(",")[0].trim() === String(n.value).toLowerCase().split(",")[0].trim();
  if (same) return { outcome: "same", note: "The CRM already holds this." };
  const state = current !== undefined && current !== null && current !== "" ? "conflict" : conflictOnly ? "conflict" : "proposed";
  await db.insert(facts).values({ key, value: n.value, display: n.display, evidence, leadId: lead.id, contactId: lead.contactId, sourceType: "hermes", sourceId: lead.id, sourceAt: new Date(), confidence: "0.800", state, currentValue: current ?? null });
  return { outcome: state, waitsFor: "Chris in the Inspector" };
}

// ---------------- the protocol ----------------

type RpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
type RpcResponse = { jsonrpc: "2.0"; id: string | number | null; result?: unknown; error?: { code: number; message: string } };

const redact = (args: Record<string, unknown>) => Object.fromEntries(Object.entries(args).map(([k, v]) => [k, typeof v === "string" && v.length > 300 ? `${v.slice(0, 300)}… (${v.length} chars)` : v]));

async function callTool(name: string, args: Record<string, unknown>, actor: Actor): Promise<{ content: { type: "text"; text: string }[]; structuredContent?: unknown; isError: boolean }> {
  const started = Date.now();
  const t = TOOLS.find((x) => x.name === name);
  const audit = async (status: "ok" | "denied" | "error", summary: string | null, error: string | null) => {
    const who = t?.leadOf?.(args) ?? {};
    const asId = (v: string | null | undefined) => (v && uuid.safeParse(v).success ? v : null);
    try {
      await db.insert(agentAudit).values({ agent: actor.kind === "agent" ? actor.agent : actor.kind, tool: name.slice(0, 100), access: t?.access ?? "unknown", status, args: redact(args), resultSummary: summary?.slice(0, 500) ?? null, error: error?.slice(0, 500) ?? null, leadId: asId(who.leadId), contactId: asId(who.contactId), durationMs: Date.now() - started });
    } catch (e) {
      // The audit must never be the reason a call fails; but it must not go unnoticed either.
      console.error(`[mcp] audit failed for ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  if (!t) {
    await audit("denied", null, "unknown tool");
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
  try {
    assertAgentMay(actor, t.capability);
    const parsed = t.input.safeParse(args);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join(".") || "(args)"}: ${i.message}`).join("; ");
      await audit("error", null, `invalid arguments: ${msg}`);
      return { content: [{ type: "text", text: `Invalid arguments: ${msg}` }], isError: true };
    }
    const result = await t.run(parsed.data as never);
    const text = JSON.stringify(result ?? null);
    await audit("ok", text.slice(0, 300), null);
    return { content: [{ type: "text", text }], structuredContent: result && typeof result === "object" && !Array.isArray(result) ? result : { result }, isError: false };
  } catch (err) {
    const denied = err instanceof GuardrailError;
    const message = err instanceof Error ? err.message : String(err);
    await audit(denied ? "denied" : "error", null, message);
    return { content: [{ type: "text", text: `${denied ? "Refused" : "Failed"}: ${message}` }], isError: true };
  }
}

async function handleOne(req: RpcRequest, actor: Actor): Promise<RpcResponse | null> {
  const id = req.id ?? null;
  const isNotification = req.id === undefined;
  const ok = (result: unknown): RpcResponse => ({ jsonrpc: "2.0", id, result });
  const err = (code: number, message: string): RpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } });
  if (req.jsonrpc !== "2.0" || typeof req.method !== "string") return err(-32600, "Invalid request");
  switch (req.method) {
    case "initialize": {
      const asked = String(req.params?.protocolVersion ?? "");
      return ok({
        protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "getsecure-crm", title: "Get Secure CRM", version: "1.0.0" },
        instructions:
          "Get Secure's CRM. Read leads, customers, timelines, quotes (as customers see them) and Business Brain outcomes. Actions only prepare or propose for Chris: nothing here sends, approves, confirms, discounts or overwrites CRM facts. Every call is audited.",
      });
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    case "ping":
      return ok({});
    case "tools/list":
      return ok({
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: `${t.description}${t.access === "write" ? " (Audited.)" : ""}`,
          inputSchema: z.toJSONSchema(t.input, { io: "input" }),
          annotations: { readOnlyHint: t.access === "read", destructiveHint: false, openWorldHint: false },
        })),
      });
    case "tools/call": {
      const name = String(req.params?.name ?? "");
      const args = (req.params?.arguments as Record<string, unknown> | undefined) ?? {};
      return ok(await callTool(name, args, actor));
    }
    default:
      return isNotification ? null : err(-32601, `Method not found: ${req.method}`);
  }
}

/** Handle one JSON-RPC message or a batch. Returns null when there is nothing to answer (notifications). */
export async function handleMcp(body: unknown, actor: Actor = HERMES_ACTOR): Promise<RpcResponse | RpcResponse[] | null> {
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((b) => handleOne(b as RpcRequest, actor)))).filter((r): r is RpcResponse => r !== null);
    return out.length ? out : null;
  }
  if (!body || typeof body !== "object") return { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };
  return handleOne(body as RpcRequest, actor);
}
