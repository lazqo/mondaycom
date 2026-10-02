/**
 * The Business Brain's database side: policies, catalogue and packages loaded for the engine;
 * assessments stored; drafts and quotes prepared; supplier prices recorded with history.
 *
 * Supplier credentials are never read here: they stay in supplier_credentials, encrypted, and are
 * only for a future price-sync job.
 */
import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  brainPolicies,
  cctvAssessments,
  emails,
  installationPackages,
  leads,
  productPriceHistory,
  products,
  supplierProducts,
  suppliers,
  users,
} from "@/db/schema";
import { type Actor, GuardrailError, actorLabel, assertAgentMay, assertApprover } from "@/lib/guard/actor";
import { parseWebsiteLead } from "@/lib/email/website-lead";
import { createDraft } from "@/lib/drafts/workflow";
import { createPreparedQuote } from "@/lib/quotes/workflow";
import { composeEmail, composeQuote } from "./compose";
import { assessCctv, ENGINE_VERSION } from "./engine";
import { DEFAULT_POLICIES, POLICY_KEYS, mergePolicies } from "./policy";
import type { Catalogue, DecisionPacket, EnquiryInput, InstallationPackage, KnowledgeStatus, Policies, PolicyValue, Product, ProductPrice } from "./types";
import { TRUSTED_STATUSES } from "./types";

const actorId = (a: Actor) => (a.kind === "human" ? a.userId : null);
const num = (v: string | number | null | undefined) => (v == null ? null : Number(v));

// ---------- policies ----------

/** Store any default policy not yet in the database, so every rule has an editable, auditable row. */
export async function ensurePolicies(): Promise<void> {
  const have = new Set((await db.select({ key: brainPolicies.key }).from(brainPolicies)).map((r) => r.key));
  const missing = POLICY_KEYS.filter((k) => !have.has(k));
  if (!missing.length) return;
  await db
    .insert(brainPolicies)
    .values(
      missing.map((k) => {
        const d = DEFAULT_POLICIES[k] as PolicyValue<unknown>;
        return { key: k, value: d.value as object, status: d.status, source: d.source, sourceUrl: d.sourceUrl ?? null, notes: d.notes ?? null };
      }),
    )
    .onConflictDoNothing();
}

export async function loadPolicies(): Promise<Policies> {
  await ensurePolicies();
  const rows = await db
    .select({ p: brainPolicies, approver: users.name })
    .from(brainPolicies)
    .leftJoin(users, eq(brainPolicies.approvedById, users.id));
  const stored: Record<string, PolicyValue<unknown>> = {};
  for (const { p, approver } of rows) {
    stored[p.key] = {
      value: p.value,
      status: p.status,
      source: p.source,
      sourceUrl: p.sourceUrl,
      createdAt: p.createdAt,
      reviewedAt: p.reviewedAt,
      approvedBy: approver ?? (p.status === "getsecure_approved" ? "Chris" : null),
      confidence: num(p.confidence),
      notes: p.notes,
    };
  }
  return mergePolicies(stored as Partial<Record<keyof Policies, PolicyValue<unknown>>>);
}

/**
 * Change a policy. Marking anything Get Secure approved needs an approver; agents cannot change
 * policies at all.
 */
export async function savePolicy(key: keyof Policies, value: unknown, status: KnowledgeStatus, notes: string | null, actor: Actor): Promise<void> {
  if (actor.kind !== "human") throw new GuardrailError("Only a person can change Business Brain policies.");
  if (status === "getsecure_approved") assertApprover(actor);
  if (!POLICY_KEYS.includes(key)) throw new Error("Unknown policy");
  await ensurePolicies();
  await db
    .update(brainPolicies)
    .set({
      value: value as object,
      status,
      notes,
      source: `Edited in the CRM by ${actor.name}`,
      reviewedAt: new Date(),
      approvedById: status === "getsecure_approved" ? actor.userId : null,
      approvedAt: status === "getsecure_approved" ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(brainPolicies.key, key));
}

// ---------- catalogue ----------

export async function loadCatalogue(): Promise<Catalogue> {
  const [rows, offers, pkgs] = await Promise.all([
    db.select().from(products),
    db
      .select({ o: supplierProducts, supplier: suppliers.name, priority: suppliers.priority })
      .from(supplierProducts)
      .innerJoin(suppliers, eq(supplierProducts.supplierId, suppliers.id)),
    db.select().from(installationPackages),
  ]);
  const byProduct = new Map<string, typeof offers>();
  for (const o of offers) byProduct.set(o.o.productId, [...(byProduct.get(o.o.productId) ?? []), o]);

  const list: Product[] = rows.map((r) => {
    const candidates = (byProduct.get(r.id) ?? []).filter((x) => x.o.costExGst != null);
    candidates.sort(
      (a, b) => Number(b.o.priceApproved) - Number(a.o.priceApproved) || a.priority - b.priority || Number(a.o.costExGst) - Number(b.o.costExGst),
    );
    const best = candidates[0];
    const price: ProductPrice | null = best
      ? { supplier: best.supplier, supplierSku: best.o.supplierSku, costExGst: Number(best.o.costExGst), lastChecked: best.o.lastCheckedAt, confidence: num(best.o.priceConfidence), approved: best.o.priceApproved }
      : null;
    return {
      ...(r.specs as Record<string, unknown>),
      id: r.id,
      manufacturer: r.manufacturer,
      model: r.model,
      category: r.category,
      market: r.market,
      tier: r.tier,
      status: r.status,
      warranty: r.warranty,
      alternatives: r.alternatives,
      price,
    } as Product;
  });
  const packages: InstallationPackage[] = pkgs.map((p) => ({
    id: p.id,
    name: p.name,
    propertyType: p.propertyType as InstallationPackage["propertyType"],
    minCameras: p.minCameras,
    maxCameras: p.maxCameras,
    storeys: p.storeys,
    estimatedHours: Number(p.estimatedHours),
    allowanceExGst: Number(p.allowanceExGst),
    includedMaterials: p.includedMaterials,
    assumptions: p.assumptions,
    exclusions: p.exclusions,
    version: p.version,
    status: p.status,
  }));
  return { products: list, packages };
}

/**
 * Record a supplier price. History is always kept. A first price, or one entered by an approver,
 * becomes active; a later change bigger than the review threshold is held as pending rather than
 * silently changing quote pricing.
 */
export async function recordSupplierPrice(
  input: { productId: string; supplierId: string; costExGst?: number | null; costIncGst?: number | null; supplierSku?: string | null; sourceUrl?: string | null; stock?: string | null; source: string },
  actor: Actor,
): Promise<{ offerId: string; held: boolean; changedPct: number | null }> {
  if (actor.kind === "agent") throw new GuardrailError("Agents cannot enter supplier prices.");
  const policies = await loadPolicies();
  const gst = policies.gstRate.value;
  const ex = input.costExGst ?? (input.costIncGst != null ? Math.round((input.costIncGst / (1 + gst)) * 100) / 100 : null);
  if (ex == null || !(ex > 0)) throw new Error("Enter a cost (ex GST or inc GST).");
  const approver = actor.kind === "human" && actor.canApprove;

  return db.transaction(async (tx) => {
    let offer = await tx.query.supplierProducts.findFirst({ where: and(eq(supplierProducts.productId, input.productId), eq(supplierProducts.supplierId, input.supplierId)) });
    if (!offer) {
      [offer] = await tx.insert(supplierProducts).values({ productId: input.productId, supplierId: input.supplierId }).returning();
    }
    const old = num(offer.costExGst);
    const changedPct = old ? Math.round(((ex - old) / old) * 10000) / 100 : null;
    const significant = changedPct != null && Math.abs(changedPct) > policies.priceChangeReviewPct.value;
    // An approver typing a price is the review. Anyone/anything else: first price waits for approval,
    // a big move is held as pending, a small one applies but keeps its approval only if it had one.
    const hold = !approver && significant;
    const patch = {
      supplierSku: input.supplierSku ?? offer.supplierSku,
      sourceUrl: input.sourceUrl ?? offer.sourceUrl,
      stock: input.stock ?? offer.stock,
      costIncGst: input.costIncGst != null ? input.costIncGst.toFixed(2) : offer.costIncGst,
      lastCheckedAt: new Date(),
      updatedAt: new Date(),
      ...(hold
        ? { pendingCostExGst: ex.toFixed(2) }
        : { costExGst: ex.toFixed(2), pendingCostExGst: null, priceApproved: approver ? true : old == null ? false : offer.priceApproved }),
    };
    await tx.update(supplierProducts).set(patch).where(eq(supplierProducts.id, offer.id));
    await tx.insert(productPriceHistory).values({
      supplierProductId: offer.id,
      oldCostExGst: old != null ? old.toFixed(2) : null,
      newCostExGst: ex.toFixed(2),
      changedPct: changedPct != null ? changedPct.toFixed(2) : null,
      source: input.source,
      reviewStatus: approver ? "approved" : "not_reviewed",
      reviewedById: approver ? actorId(actor) : null,
      reviewedAt: approver ? new Date() : null,
    });
    return { offerId: offer.id, held: hold, changedPct };
  });
}

/** Approve a supplier offer's price (and any pending change) for quoting. */
export async function approveSupplierPrice(offerId: string, actor: Actor): Promise<void> {
  assertApprover(actor);
  const offer = await db.query.supplierProducts.findFirst({ where: eq(supplierProducts.id, offerId) });
  if (!offer) throw new Error("Price not found");
  await db
    .update(supplierProducts)
    .set({ ...(offer.pendingCostExGst != null ? { costExGst: offer.pendingCostExGst, pendingCostExGst: null } : {}), priceApproved: true, updatedAt: new Date() })
    .where(eq(supplierProducts.id, offerId));
  const latest = await db.query.productPriceHistory.findFirst({ where: eq(productPriceHistory.supplierProductId, offerId), orderBy: [desc(productPriceHistory.recordedAt)] });
  if (latest) await db.update(productPriceHistory).set({ reviewStatus: "approved", reviewedById: actor.userId, reviewedAt: new Date() }).where(eq(productPriceHistory.id, latest.id));
}

// ---------- assessments ----------

/** A starting point for the assessment form, from what the lead and its enquiry already say. */
export async function enquiryFromLead(leadId: string): Promise<EnquiryInput | null> {
  const lead = await db.query.leads.findFirst({ where: eq(leads.id, leadId), with: { contact: { columns: { id: true } } } });
  if (!lead) return null;
  const src = lead.sourceEmailId ? await db.query.emails.findFirst({ where: eq(emails.id, lead.sourceEmailId), columns: { subject: true, textBody: true, fromAddress: true } }) : null;
  const form = src ? parseWebsiteLead({ subject: src.subject, text: src.textBody ?? "", fromAddress: src.fromAddress }) : null;
  const f = form?.fields ?? {};
  const property = (f["Property"] ?? "").toLowerCase();
  const storeys = (f["Storeys"] ?? "").toLowerCase();
  const setup = (f["Current Setup"] ?? "").toLowerCase();
  const cams = Number((f["Cameras"] ?? "").match(/\d+/)?.[0] ?? NaN);
  const message = src?.textBody ?? lead.summary ?? lead.notes ?? null;
  const text = `${lead.service ?? ""} ${message ?? ""}`.toLowerCase();
  return {
    propertyType: /commercial|business|office|shop|warehouse|retail/.test(property) ? "commercial" : /residential|home|house/.test(property) ? "residential" : null,
    jobType: /upgrade|replace|existing/.test(setup) ? "upgrade" : /repair|fault|not working/.test(setup) ? "repair" : /new/.test(setup) ? "new" : null,
    cameraCount: Number.isFinite(cams) && cams > 0 ? cams : null,
    areas: [],
    storeys: /double|two|2/.test(storeys) ? 2 : /single|one|1/.test(storeys) ? 1 : null,
    address: lead.site ?? f["Address"] ?? f["Location"] ?? null,
    recordingMode: null,
    retentionDays: null,
    remoteViewing: /phone|app|remote|view.*(away|anywhere)/.test(text) ? true : null,
    internet: "unknown",
    recorderNearRouter: "unknown",
    wiredRoutePossible: "unknown",
    requestedBrand: null,
    budget: null,
    siteVisitRequested: /site visit|come (out|and) (have a )?look|come round|inspect/.test(text),
    urgency: lead.urgency ?? null,
    remoteAssessable: "unknown",
    construction: "unknown",
    accessUnclear: false,
    customSystem: false,
    mountingSurface: "unknown",
    analytics: [],
    audioRequested: /audio|sound|microphone/.test(text),
    message,
    leadStatus: lead.status,
    existingCustomer: !!lead.contact,
    customerName: lead.name,
  };
}

export async function runAssessment(leadId: string, input: EnquiryInput, actor: Actor, opts: { markupOverride?: number | null } = {}) {
  assertAgentMay(actor, "run_assessment");
  if (opts.markupOverride != null) assertApprover(actor);
  const lead = await db.query.leads.findFirst({ where: eq(leads.id, leadId), columns: { id: true, status: true, contactId: true, name: true } });
  if (!lead) throw new Error("Lead not found");
  const [policies, catalogue] = await Promise.all([loadPolicies(), loadCatalogue()]);
  const packet = assessCctv({ ...input, leadStatus: input.leadStatus ?? lead.status, customerName: input.customerName ?? lead.name }, catalogue, policies, { markupOverride: opts.markupOverride });
  const [row] = await db
    .insert(cctvAssessments)
    .values({
      leadId,
      input: input as unknown as Record<string, unknown>,
      packet: packet as unknown as Record<string, unknown>,
      engineVersion: ENGINE_VERSION,
      markupOverride: opts.markupOverride != null ? opts.markupOverride.toFixed(2) : null,
      actor: actorLabel(actor),
      createdById: actorId(actor),
    })
    .returning({ id: cctvAssessments.id, createdAt: cctvAssessments.createdAt });
  return { id: row.id, createdAt: row.createdAt, packet };
}

export async function latestAssessment(leadId: string) {
  return db.query.cctvAssessments.findFirst({ where: eq(cctvAssessments.leadId, leadId), orderBy: [desc(cctvAssessments.createdAt)] });
}

/**
 * From an assessment, prepare the reply email and/or the quote for Chris. Both land in the
 * approval queue. Nothing is sent, and the lead's status does not change.
 */
export async function prepareFromAssessment(assessmentId: string, what: { email?: boolean; quote?: boolean }, actor: Actor) {
  const a = await db.query.cctvAssessments.findFirst({ where: eq(cctvAssessments.id, assessmentId), with: { lead: true } });
  if (!a) throw new Error("Assessment not found");
  const packet = a.packet as unknown as DecisionPacket;
  const input = a.input as unknown as EnquiryInput;
  const lead = a.lead;
  const out: { draftId?: string; quoteId?: string; quoteNumber?: number } = {};

  if (what.email) {
    assertAgentMay(actor, "create_email_draft");
    const thread = lead.emailThreadId ? await db.query.emailThreads.findFirst({ where: (t, { eq }) => eq(t.id, lead.emailThreadId!) }) : null;
    const draft = composeEmail(packet, { firstName: lead.name, subject: thread?.subject ?? null, address: input.address, areas: input.areas });
    const to = lead.email ? [lead.email] : [];
    const d = await createDraft(
      { kind: "email", leadId: lead.id, contactId: lead.contactId, threadId: thread?.id ?? null, assessmentId, to, subject: draft.subject, body: draft.body },
      actor,
      { submit: true },
    );
    out.draftId = d.id;
  }
  if (what.quote) {
    assertAgentMay(actor, "create_quote_draft");
    const policies = await loadPolicies();
    const q = composeQuote(packet, { customerName: lead.name, gstPct: Math.round(policies.gstRate.value * 10000) / 100 });
    if (!q.lineItems.length) throw new Error("Nothing in this assessment is priced yet, so there is no quote to prepare.");
    const c = packet.costing;
    const created = await createPreparedQuote(
      {
        leadId: lead.id,
        contactId: lead.contactId,
        assessmentId,
        title: q.title,
        lineItems: q.lineItems,
        taxRatePct: q.taxRatePct,
        notes: q.notes,
        internalCosting: {
          equipmentCost: c.equipmentCost,
          labourCost: c.labourCost,
          materialsCost: c.materialsCost,
          otherCost: c.otherCost,
          sellExGst: c.sellExGst,
          grossProfit: c.grossProfit,
          grossMarginPct: c.grossMarginPct,
          markupPct: c.markupPct,
          markupLogic: c.markupLogic,
          complete: c.complete,
          unpriced: c.unpriced,
          lines: c.lines,
        },
        confidence: packet.confidence as unknown as Record<string, unknown>,
      },
      actor,
    );
    out.quoteId = created.id;
    out.quoteNumber = created.number;
  }
  return out;
}

export function isTrusted(status: KnowledgeStatus) {
  return TRUSTED_STATUSES.includes(status);
}

export async function listSuppliers() {
  return db.query.suppliers.findMany({ orderBy: [asc(suppliers.priority), asc(suppliers.name)] });
}
