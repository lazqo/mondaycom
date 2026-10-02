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
  materialsPackages,
  productCompatibility,
  productPriceHistory,
  products,
  quotes,
  recordingProfiles,
  supplierBrandRoutes,
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
import type {
  BrandRoute,
  Catalogue,
  CompatibilityKind,
  DecisionPacket,
  EnquiryInput,
  InstallationPackage,
  KnowledgeStatus,
  MaterialsPackage,
  Policies,
  PolicyValue,
  Product,
  ProductOffer,
  RecordingProfile,
} from "./types";
import { applyReferenceCatalogue } from "./reference/apply";
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
  await applyReferenceCatalogue();
  const [rows, offers, pkgs, mats, links, routes, profiles] = await Promise.all([
    db.select().from(products),
    db
      .select({ o: supplierProducts, supplier: suppliers.name, priority: suppliers.priority, isDefault: suppliers.isDefault, supplierStatus: suppliers.status })
      .from(supplierProducts)
      .innerJoin(suppliers, eq(supplierProducts.supplierId, suppliers.id)),
    db.select().from(installationPackages),
    db.select().from(materialsPackages),
    db.select().from(productCompatibility),
    db.select({ r: supplierBrandRoutes, supplier: suppliers.name }).from(supplierBrandRoutes).innerJoin(suppliers, eq(supplierBrandRoutes.supplierId, suppliers.id)),
    db.select({ p: recordingProfiles, approver: users.name }).from(recordingProfiles).leftJoin(users, eq(recordingProfiles.approvedById, users.id)),
  ]);
  const byProduct = new Map<string, ProductOffer[]>();
  for (const o of offers) {
    if (o.supplierStatus === "deprecated") continue;
    if (o.o.priceBasis !== "trade") continue; // only Get Secure trade pricing is a cost
    const offer: ProductOffer = {
      supplierId: o.o.supplierId,
      supplier: o.supplier,
      supplierIsDefault: o.isDefault,
      supplierPriority: o.priority,
      supplierSku: o.o.supplierSku,
      costExGst: num(o.o.costExGst),
      approved: o.o.priceApproved,
      pendingCostExGst: num(o.o.pendingCostExGst),
      priceOnApplication: o.o.priceOnApplication,
      stock: o.o.stock,
      lastChecked: o.o.lastCheckedAt,
      confidence: num(o.o.priceConfidence),
    };
    byProduct.set(o.o.productId, [...(byProduct.get(o.o.productId) ?? []), offer]);
  }

  const list: Product[] = rows.map(
    (r) =>
      ({
        ...(r.specs as Record<string, unknown>),
        id: r.id,
        manufacturer: r.manufacturer,
        family: r.family ?? r.manufacturer,
        model: r.model,
        category: r.category,
        formFactor: r.formFactor,
        residentialAllowed: r.residentialAllowed,
        commercialAllowed: r.commercialAllowed,
        tier: r.tier,
        tierStatus: r.tierStatus,
        status: r.status,
        ecosystem: r.ecosystem,
        sourceUrl: r.sourceUrl,
        lastVerifiedAt: r.lastVerifiedAt,
        warranty: r.warranty,
        alternatives: r.alternatives,
        offers: byProduct.get(r.id) ?? [],
        price: null,
      }) as unknown as Product,
  );
  const packages: InstallationPackage[] = pkgs.map((p) => ({
    id: p.id,
    key: p.key,
    name: p.name,
    propertyType: p.propertyType as InstallationPackage["propertyType"],
    cameraCount: p.cameraCount,
    storeyType: p.storeyType as InstallationPackage["storeyType"],
    materialCostExGst: num(p.materialCostExGst),
    complexityAllowanceExGst: num(p.complexityAllowanceExGst),
    minCameras: p.minCameras,
    maxCameras: p.maxCameras,
    storeys: p.storeys,
    estimatedHours: num(p.estimatedHours),
    labourRate: num(p.labourRate),
    allowanceExGst: num(p.allowanceExGst),
    materialsPackageId: p.materialsPackageId,
    conduitIncluded: p.conduitIncluded,
    conduitAllowanceExGst: num(p.conduitAllowanceExGst),
    includedMaterials: p.includedMaterials,
    assumptions: p.assumptions,
    exclusions: p.exclusions,
    version: p.version,
    status: p.status,
  }));
  const materials: MaterialsPackage[] = mats.map((m) => ({
    id: m.id,
    name: m.name,
    propertyType: m.propertyType as MaterialsPackage["propertyType"],
    customerDescription: m.customerDescription,
    items: m.items,
    costExGst: num(m.costExGst),
    sellExGst: num(m.sellExGst),
    isDefault: m.isDefault,
    version: m.version,
    status: m.status,
  }));
  return {
    products: list,
    packages,
    materialsPackages: materials,
    compatibility: links.map((l) => ({ kind: l.kind as CompatibilityKind, fromId: l.fromProductId, toId: l.toProductId, quantity: l.quantity, status: l.status })),
    routes: routes.map(({ r, supplier }) => ({ brand: r.brand, supplierId: r.supplierId, supplier, rank: r.rank, market: r.market as BrandRoute["market"], status: r.status })),
    recordingProfiles: profiles.map(({ p, approver }) => toProfile(p, approver)),
  };
}

export function toProfile(p: typeof recordingProfiles.$inferSelect, approver: string | null = null): RecordingProfile {
  return {
    id: p.id,
    key: p.key,
    name: p.name,
    propertyType: p.propertyType as RecordingProfile["propertyType"],
    isDefault: p.isDefault,
    codec: p.codec,
    frameRate: p.frameRate,
    bitrateControl: p.bitrateControl as RecordingProfile["bitrateControl"],
    recordingMode: p.recordingMode as RecordingProfile["recordingMode"],
    retentionTargetDays: p.retentionTargetDays,
    retentionMinimumDays: p.retentionMinimumDays,
    rules: p.rules,
    version: p.version,
    status: p.status,
    approvedBy: approver,
    reviewedAt: p.reviewedAt,
  };
}

/**
 * Record a supplier price. History is always kept. A first price, or one entered by an approver,
 * becomes active; a later change bigger than the review threshold is held as pending rather than
 * silently changing quote pricing.
 */
export async function recordSupplierPrice(
  input: {
    productId: string;
    supplierId: string;
    costExGst?: number | null;
    costIncGst?: number | null;
    supplierSku?: string | null;
    sourceUrl?: string | null;
    stock?: string | null;
    source: string;
    /** manual | csv | authenticated_web | public_plus_trade | api */
    priceSource?: string;
    /** The supplier quotes this on application: record the listing without a cost. */
    priceOnApplication?: boolean;
  },
  actor: Actor,
  opts: { bulk?: boolean } = {},
): Promise<{ offerId: string; held: boolean; changedPct: number | null }> {
  if (actor.kind === "agent") throw new GuardrailError("Agents cannot enter supplier prices.");
  const policies = await loadPolicies();
  const gst = policies.gstRate.value;
  if (input.priceOnApplication) {
    const [offer] = await db
      .insert(supplierProducts)
      .values({ productId: input.productId, supplierId: input.supplierId, priceOnApplication: true, supplierSku: input.supplierSku ?? null, sourceUrl: input.sourceUrl ?? null, stock: input.stock ?? null, lastCheckedAt: new Date(), priceSource: input.priceSource ?? "manual" })
      .onConflictDoUpdate({
        target: [supplierProducts.productId, supplierProducts.supplierId],
        set: { priceOnApplication: true, supplierSku: input.supplierSku ?? null, stock: input.stock ?? null, lastCheckedAt: new Date(), priceSource: input.priceSource ?? "manual", updatedAt: new Date() },
      })
      .returning({ id: supplierProducts.id });
    return { offerId: offer.id, held: false, changedPct: null };
  }
  const ex = input.costExGst ?? (input.costIncGst != null ? Math.round((input.costIncGst / (1 + gst)) * 100) / 100 : null);
  if (ex == null || !(ex > 0)) throw new Error("Enter a cost (ex GST or inc GST).");
  // A bulk import or sync is never its own review, even when an approver starts it.
  const approver = actor.kind === "human" && actor.canApprove && !opts.bulk;

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
      priceOnApplication: false,
      updatedAt: new Date(),
      // A held change leaves the quoted cost, and the date it was confirmed, as they were.
      ...(hold
        ? { pendingCostExGst: ex.toFixed(2) }
        : {
            costExGst: ex.toFixed(2),
            pendingCostExGst: null,
            lastCheckedAt: new Date(),
            priceSource: input.priceSource ?? "manual",
            priceApproved: approver ? true : old == null ? false : offer.priceApproved,
          }),
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
    .set({ ...(offer.pendingCostExGst != null ? { costExGst: offer.pendingCostExGst, pendingCostExGst: null, lastCheckedAt: new Date() } : {}), priceApproved: true, updatedAt: new Date() })
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
    const created = await createPreparedQuote(
      {
        leadId: lead.id,
        contactId: lead.contactId,
        assessmentId,
        title: q.title,
        lineItems: q.lineItems,
        taxRatePct: q.taxRatePct,
        notes: q.notes,
        internalCosting: commercialSnapshot(packet),
        confidence: packet.confidence as unknown as Record<string, unknown>,
      },
      actor,
    );
    out.quoteId = created.id;
    out.quoteNumber = created.number;
  }
  return out;
}

/**
 * The internal commercial record frozen with a prepared quote: every line's exact model, supplier,
 * SKU, cost and price date, the markup, labour, materials, allowances and sell prices. Later
 * supplier price changes never touch it; only an explicit reprice replaces it (and voids approval).
 */
export function commercialSnapshot(packet: DecisionPacket): Record<string, unknown> {
  const c = packet.costing;
  const L = packet.labour;
  return {
    snapshotAt: new Date().toISOString(),
    engineVersion: packet.engineVersion,
    equipmentCost: c.equipmentCost,
    labourCost: c.labourCost,
    materialsCost: c.materialsCost,
    allowancesCost: c.allowancesCost ?? 0,
    otherCost: c.otherCost,
    sellExGst: c.sellExGst,
    gst: c.gst,
    totalIncGst: c.totalIncGst,
    grossProfit: c.grossProfit,
    grossMarginPct: c.grossMarginPct,
    markupPct: c.markupPct,
    markupSource: c.markupSource,
    markupLogic: c.markupLogic,
    complete: c.complete,
    unpriced: c.unpriced,
    refreshRequired: c.refreshRequired ?? [],
    kit: c.kit ?? null,
    lines: c.lines.map((l) => ({
      key: l.key,
      kind: l.kind,
      customerDescription: l.customerDescription,
      productId: l.productId ?? null,
      model: l.model ?? null,
      supplier: l.supplier ?? null,
      supplierSku: l.supplierSku ?? null,
      lastChecked: l.lastChecked ?? null,
      freshness: l.freshness ?? null,
      stock: l.stock ?? null,
      quantity: l.quantity,
      unitCostExGst: l.unitCostExGst,
      markupPct: l.markupPct,
      unitSellExGst: l.unitSellExGst,
      priced: l.priced,
      internalOnly: l.internalOnly ?? false,
      detail: l.detail ?? [],
      alternatives: l.alternatives ?? [],
    })),
    labour: {
      packageKey: L.package?.key ?? null,
      packageName: L.package?.name ?? null,
      packageVersion: L.package?.version ?? null,
      packageStatus: L.package?.status ?? null,
      customInstallation: L.customInstallation,
      hours: L.estimatedHours,
      rate: L.internalRate,
      labourCost: L.labourCostExGst,
      materialCost: L.materialCostExGst,
      conduitAllowance: L.conduitCostExGst,
      complexityAllowance: L.complexityCostExGst,
      sellAllowance: L.allowanceExGst,
      missing: L.missing,
    },
    recordingProfile: packet.recording.profile ?? null,
    designs: packet.recording.designs ?? [],
    designBandwidthMbps: packet.recording.designBandwidthMbps ?? null,
    maxPossibleBandwidthMbps: packet.recording.maxPossibleBandwidthMbps ?? null,
    assumptions: packet.assumptions,
    exclusions: packet.exclusions,
  };
}

/**
 * Reprice a prepared quote with current catalogue prices and rules: re-runs the assessment on the
 * same enquiry, replaces the quote's lines and snapshot, and sends it back to Needs Review.
 * Approval never survives a reprice.
 */
export async function repriceQuote(quoteId: string, actor: Actor, opts: { markupOverride?: number | null } = {}): Promise<{ changed: boolean; complete: boolean }> {
  assertAgentMay(actor, "create_quote_draft");
  const q = await db.query.quotes.findFirst({ where: eq(quotes.id, quoteId) });
  if (!q) throw new Error("Quote not found");
  if (q.origin !== "brain" || !q.assessmentId || !q.leadId) throw new Error("Only a quote prepared by the Business Brain can be repriced.");
  if (!["ai_prepared", "needs_review", "approved"].includes(q.status)) throw new Error(`A quote that is ${q.status.replace(/_/g, " ")} cannot be repriced; prepare a new one.`);
  const prev = await db.query.cctvAssessments.findFirst({ where: eq(cctvAssessments.id, q.assessmentId) });
  if (!prev) throw new Error("The assessment behind this quote no longer exists.");
  const markup = opts.markupOverride !== undefined ? opts.markupOverride : prev.markupOverride != null ? Number(prev.markupOverride) : null;
  const run = await runAssessment(q.leadId, prev.input as unknown as EnquiryInput, actor, { markupOverride: markup });
  const policies = await loadPolicies();
  const lead = await db.query.leads.findFirst({ where: eq(leads.id, q.leadId), columns: { name: true } });
  const draft = composeQuote(run.packet, { customerName: lead?.name ?? null, gstPct: Math.round(policies.gstRate.value * 10000) / 100 });
  if (!draft.lineItems.length) throw new Error("Nothing is priced in the current catalogue, so the quote cannot be repriced.");
  const before = JSON.stringify(q.lineItems);
  const { computeTotals } = await import("@/lib/quotes");
  const totals = computeTotals(draft.lineItems, draft.taxRatePct);
  await db
    .update(quotes)
    .set({
      lineItems: draft.lineItems,
      notes: draft.notes,
      subtotal: totals.subtotal,
      total: totals.total,
      assessmentId: run.id,
      internalCosting: commercialSnapshot(run.packet),
      confidence: run.packet.confidence as unknown as Record<string, unknown>,
      status: "needs_review",
      approvedById: null,
      approvedAt: null,
      approvalHash: null,
      updatedAt: new Date(),
    })
    .where(eq(quotes.id, quoteId));
  const { logActivity } = await import("@/lib/activity");
  await logActivity({ entity: "quote", entityId: quoteId, actorId: actorId(actor), action: "repriced", detail: { from: q.status, assessmentId: run.id } });
  return { changed: before !== JSON.stringify(draft.lineItems), complete: run.packet.costing.complete };
}

export function isTrusted(status: KnowledgeStatus) {
  return TRUSTED_STATUSES.includes(status);
}

export async function listSuppliers() {
  return db.query.suppliers.findMany({ orderBy: [asc(suppliers.priority), asc(suppliers.name)] });
}
