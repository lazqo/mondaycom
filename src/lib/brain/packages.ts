/**
 * Candidate Business Brain packages (CCTV kits first).
 *
 * Hermes may design a package, or propose a change to an approved one (replace a discontinued
 * camera, a new HDD, a supplier route, a variant, retirement), and the CRM finds configurations it
 * keeps quoting. Either way the result is a CANDIDATE: internal planning, never quoted. The CRM, not
 * Hermes, works out the evidence: each product's supplier offers and approved trade cost with its
 * date, what the hardware costs at the Brain's current markup, compatibility checks, the labour
 * basis, and the quotes and jobs it came from. An unknown cost stays unknown (never $0).
 *
 * Only Chris approves (as is, or edited) or rejects. Approving creates or changes an approved kit;
 * only approved kits are ever selected by the Business Brain (engine.ts kitFor). Nothing here
 * changes a price, a markup, a labour rule or a policy.
 */
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { cctvAssessments, cctvKits, installationPackages, jobs, packageCandidates, productCompatibility, products, quotes, supplierProducts, suppliers } from "@/db/schema";
import { type Actor, assertApprover } from "@/lib/guard/actor";
import { loadPolicies } from "./store";
import { TIERS, TRUSTED_STATUSES } from "./types";

export const PACKAGE_KINDS = ["new", "variant", "update", "retire"] as const;
export const PACKAGE_ROLES = ["camera", "nvr", "hdd", "accessory"] as const;
const ROLE_CATEGORY: Record<(typeof PACKAGE_ROLES)[number], string | null> = { camera: "camera", nvr: "nvr", hdd: "hdd", accessory: null };

const uuid = z.string().uuid();
export const packageProposalSchema = z.object({
  kind: z.enum(PACKAGE_KINDS).default("new"),
  target_kit_id: uuid.nullish(),
  name: z.string().trim().min(3).max(200),
  key: z.string().trim().max(80).nullish(),
  property_type: z.enum(["residential", "commercial", "both"]).default("residential"),
  tier: z.enum(TIERS).nullish(),
  camera_count: z.coerce.number().int().min(1).max(64).nullish(),
  storey_type: z.enum(["single", "double"]).nullish(),
  segment: z.string().trim().max(300).nullish(),
  components: z.array(z.object({ role: z.enum(PACKAGE_ROLES), product_id: uuid, quantity: z.coerce.number().int().min(1).max(64).default(1), per_camera: z.boolean().default(false) })).max(30).default([]),
  installation_package_key: z.string().trim().max(80).nullish(),
  proposed_markup_pct: z.coerce.number().min(0).max(500).nullish(),
  assumptions: z.array(z.string().trim().max(300)).max(15).default([]),
  missing: z.array(z.string().trim().max(300)).max(15).default([]),
  reasoning: z.string().trim().max(2000).default(""),
  quote_ids: z.array(uuid).max(30).default([]),
  job_ids: z.array(uuid).max(30).default([]),
  sources: z.array(z.object({ url: z.string().trim().min(5).max(1000), title: z.string().trim().max(300).nullish() })).max(10).default([]),
  labour_note: z.string().trim().max(600).nullish(),
  confidence: z.coerce.number().min(0).max(1).default(0.5),
});
export type PackageProposal = z.input<typeof packageProposalSchema>;

type Component = { role: string; productId: string; quantity: number; perCamera: boolean };
type Check = { name: string; pass: boolean; detail: string; warning?: boolean };

const n = (v: string | null | undefined) => (v != null ? Number(v) : null);
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const qty = (c: Component, cameras: number | null) => (c.perCamera ? c.quantity * (cameras ?? 1) : c.quantity);

/**
 * The evidence the CRM attaches to a candidate: worked out from its own records, so nothing Hermes
 * says about a cost, a stock level or a compatibility is taken on trust.
 */
export async function packageEvidence(p: { components: Component[]; cameraCount: number | null; storeyType: string | null; propertyType: string; installationPackageKey?: string | null; quoteIds?: string[]; jobIds?: string[] }) {
  const ids = [...new Set(p.components.map((c) => c.productId))];
  const rows = ids.length ? await db.select().from(products).where(inArray(products.id, ids)) : [];
  const offers = ids.length
    ? await db
        .select({ o: supplierProducts, supplier: suppliers.name, priority: suppliers.priority })
        .from(supplierProducts)
        .innerJoin(suppliers, eq(suppliers.id, supplierProducts.supplierId))
        .where(inArray(supplierProducts.productId, ids))
    : [];
  const errors: string[] = [];
  const checks: Check[] = [];
  const route: Record<string, unknown>[] = [];
  const unknownCost: string[] = [];
  let hardware = 0;
  for (const c of p.components) {
    const prod = rows.find((r) => r.id === c.productId);
    if (!prod) {
      errors.push(`Product ${c.productId} is not in the catalogue.`);
      continue;
    }
    const want = ROLE_CATEGORY[c.role as keyof typeof ROLE_CATEGORY];
    if (want && prod.category !== want) errors.push(`${prod.manufacturer} ${prod.model} is a ${prod.category}, not a ${c.role}.`);
    if (prod.status === "deprecated") checks.push({ name: `${prod.model} current`, pass: false, detail: `${prod.manufacturer} ${prod.model} is marked deprecated in the catalogue.` });
    if (p.propertyType === "residential" && !prod.residentialAllowed) checks.push({ name: `${prod.model} residential`, pass: false, detail: `${prod.model} is not approved for residential.` });
    const mine = offers
      .filter((o) => o.o.productId === c.productId)
      .sort((a, b) => Number(b.o.priceApproved) - Number(a.o.priceApproved) || a.priority - b.priority || (n(a.o.costExGst) ?? 1e9) - (n(b.o.costExGst) ?? 1e9));
    const best = mine.find((o) => o.o.priceApproved && o.o.costExGst != null && o.o.priceBasis === "trade" && !o.o.priceOnApplication) ?? null;
    const count = qty(c, p.cameraCount);
    route.push({
      role: c.role,
      productId: prod.id,
      product: `${prod.manufacturer} ${prod.model}`,
      quantity: count,
      preferred: best ? { supplier: best.supplier, sku: best.o.supplierSku, tradeCostExGst: n(best.o.costExGst), priceDate: iso(best.o.lastCheckedAt ?? best.o.updatedAt), stock: best.o.stock } : null,
      offers: mine.map((o) => ({ supplier: o.supplier, sku: o.o.supplierSku, tradeCostExGst: o.o.priceApproved ? n(o.o.costExGst) : null, approved: o.o.priceApproved, pendingCostExGst: n(o.o.pendingCostExGst), priceDate: iso(o.o.lastCheckedAt), stock: o.o.stock })),
    });
    if (best) hardware += count * Number(best.o.costExGst);
    else unknownCost.push(`${prod.manufacturer} ${prod.model}: no approved trade price`);
  }

  // Compatibility, from the catalogue's own data.
  const cams = p.components.filter((c) => c.role === "camera");
  const nvrs = p.components.filter((c) => c.role === "nvr");
  const cameraTotal = cams.reduce((s, c) => s + qty(c, p.cameraCount), 0);
  if (p.cameraCount && cams.length && cameraTotal !== p.cameraCount) checks.push({ name: "camera count", pass: false, detail: `${cameraTotal} cameras in the components for a ${p.cameraCount}-camera package.` });
  for (const nv of nvrs) {
    const prod = rows.find((r) => r.id === nv.productId);
    const specs = (prod?.specs ?? {}) as { channels?: number; poePorts?: number };
    if (prod && specs.channels != null) checks.push({ name: "recorder channels", pass: specs.channels >= cameraTotal, detail: `${prod.model}: ${specs.channels} channels for ${cameraTotal} cameras.` });
    else if (prod) checks.push({ name: "recorder channels", pass: true, warning: true, detail: `${prod.model}: channel count not in the catalogue (to verify).` });
    if (prod && specs.poePorts != null && specs.poePorts < cameraTotal) checks.push({ name: "PoE ports", pass: true, warning: true, detail: `${prod.model} has ${specs.poePorts} PoE ports for ${cameraTotal} cameras: a PoE switch is needed.` });
  }
  if (cams.length && nvrs.length) {
    const documented = await db
      .select({ from: productCompatibility.fromProductId, to: productCompatibility.toProductId })
      .from(productCompatibility)
      .where(and(eq(productCompatibility.kind, "camera_nvr"), inArray(productCompatibility.fromProductId, cams.map((c) => c.productId)), inArray(productCompatibility.toProductId, nvrs.map((c) => c.productId))));
    const eco = (id: string) => (rows.find((r) => r.id === id)?.ecosystem ?? []).map((e) => e.toLowerCase());
    for (const c of cams)
      for (const v of nvrs) {
        const doc = documented.some((d) => d.from === c.productId && d.to === v.productId);
        const shared = eco(c.productId).some((e) => eco(v.productId).includes(e));
        const cm = rows.find((r) => r.id === c.productId)?.model ?? c.productId;
        const vm = rows.find((r) => r.id === v.productId)?.model ?? v.productId;
        checks.push({ name: `${cm} with ${vm}`, pass: doc || shared, warning: !doc, detail: doc ? "Documented as compatible in the catalogue." : shared ? "Same ecosystem/app; compatibility not documented (verify)." : "No documented compatibility and no shared ecosystem: verify before approving." });
      }
  }
  if (!nvrs.length && cams.length) errors.push("A CCTV package needs a recorder.");

  // Labour basis: the matching exact installation package (Get Secure's own hours and allowance).
  const key = p.installationPackageKey ?? (p.cameraCount && p.storeyType && p.propertyType === "residential" ? `RES_CCTV_${p.storeyType.toUpperCase()}_${p.cameraCount}` : null);
  const inst = key ? await db.query.installationPackages.findFirst({ where: eq(installationPackages.key, key) }) : null;
  const labour = inst
    ? { key, name: inst.name, status: inst.status, estimatedHours: n(inst.estimatedHours), allowanceSet: inst.allowanceExGst != null, materialsSet: inst.materialCostExGst != null }
    : { key, name: null, status: null, estimatedHours: null, allowanceSet: false, materialsSet: false, note: key ? `No installation package ${key} yet: labour must be set by Chris.` : "Custom installation: no exact package." };

  // What it would come to at the Brain's current markup policy (shown, never applied by this).
  const policies = await loadPolicies();
  const markupPct = policies.suggestedMarkupPct.value;
  const costs = unknownCost.length
    ? { hardwareTradeExGst: null, unknown: unknownCost, markupPct, note: "Not every product has an approved trade price, so no total is given (an unknown cost is never $0)." }
    : { hardwareTradeExGst: Math.round(hardware * 100) / 100, hardwareSellExGst: Math.round(hardware * (1 + markupPct / 100) * 100) / 100, hardwareMarginExGst: Math.round(hardware * (markupPct / 100) * 100) / 100, markupPct, unknown: [] as string[], note: "Hardware only, at the Business Brain's current suggested markup; labour and materials come from the installation package." };

  const quoteRows = p.quoteIds?.length ? await db.select({ id: quotes.id, number: quotes.number, status: quotes.status, createdAt: quotes.createdAt }).from(quotes).where(inArray(quotes.id, p.quoteIds)) : [];
  const jobRows = p.jobIds?.length ? await db.select({ id: jobs.id, number: jobs.number, status: jobs.status }).from(jobs).where(inArray(jobs.id, p.jobIds)) : [];
  return {
    errors,
    evidence: {
      supplierRoute: route,
      costs,
      compatibility: checks,
      labour,
      quotes: quoteRows.map((q) => ({ ref: `quote:${q.id}`, number: q.number, status: q.status, at: iso(q.createdAt) })),
      jobs: jobRows.map((j) => ({ ref: `job:${j.id}`, number: j.number, status: j.status })),
      checkedAt: new Date().toISOString(),
    },
  };
}

/** Hermes (or the CRM) proposes a package or a change. It starts as a candidate; nothing is approved here. */
export async function proposePackage(raw: unknown, proposedBy: string, opts: { patternKey?: string | null } = {}) {
  const p = packageProposalSchema.parse(raw);
  if (p.kind !== "new" && !p.target_kit_id) throw new Error(`A ${p.kind} needs target_kit_id (the approved kit it changes).`);
  const target = p.target_kit_id ? await db.query.cctvKits.findFirst({ where: eq(cctvKits.id, p.target_kit_id) }) : null;
  if (p.target_kit_id && !target) throw new Error("That kit does not exist.");
  if (p.kind !== "retire" && !p.components.length) throw new Error("List the components (cameras, recorder, HDD, accessories).");
  const components: Component[] = p.components.map((c) => ({ role: c.role, productId: c.product_id, quantity: c.quantity, perCamera: c.per_camera }));
  const cameraCount = p.camera_count ?? target?.cameraCount ?? null;
  const { errors, evidence } = await packageEvidence({ components, cameraCount, storeyType: p.storey_type ?? null, propertyType: p.property_type, installationPackageKey: p.installation_package_key, quoteIds: p.quote_ids, jobIds: p.job_ids });
  if (errors.length) throw new Error(errors.join(" "));
  const missing = [...p.missing, ...((evidence.costs.unknown as string[]) ?? [])];
  const [row] = await db
    .insert(packageCandidates)
    .values({
      kind: p.kind,
      targetKitId: p.target_kit_id ?? null,
      name: p.name,
      key: p.key ?? null,
      propertyType: p.property_type,
      tier: p.tier ?? null,
      cameraCount,
      storeyType: p.storey_type ?? null,
      segment: p.segment ?? null,
      components,
      installationPackageKey: (evidence.labour as { key: string | null }).key,
      evidence: { ...evidence, sources: p.sources, labourNote: p.labour_note ?? null },
      proposedMarkupPct: p.proposed_markup_pct != null ? p.proposed_markup_pct.toFixed(2) : null,
      assumptions: p.assumptions,
      missing,
      reasoning: p.reasoning || null,
      confidence: p.confidence.toFixed(3),
      proposedBy,
      patternKey: opts.patternKey ?? null,
    })
    .returning({ id: packageCandidates.id });
  return { candidateId: row.id, status: "candidate", compatibility: evidence.compatibility, costs: evidence.costs, missing, waitsFor: "Chris (Settings → Business Brain → Packages)" };
}

export const packageEditSchema = z.object({
  name: z.string().trim().min(3).max(200).optional(),
  key: z.string().trim().max(80).nullish(),
  tier: z.enum(TIERS).nullish(),
  camera_count: z.coerce.number().int().min(1).max(64).optional(),
  components: z.array(z.object({ role: z.enum(PACKAGE_ROLES), product_id: uuid, quantity: z.coerce.number().int().min(1).max(64), per_camera: z.boolean().default(false) })).max(30).optional(),
});

/**
 * Chris decides a candidate. Approve (as proposed or edited) creates the approved kit (new or
 * variant), changes the target kit with a new version (update, keeping what it was), or retires it;
 * reject records why. Only a person who can approve can do this.
 */
export async function decidePackage(id: string, decision: "approve" | "reject", actor: Actor, opts: { edits?: z.input<typeof packageEditSchema> | null; note?: string | null } = {}) {
  assertApprover(actor);
  const c = await db.query.packageCandidates.findFirst({ where: eq(packageCandidates.id, id) });
  if (!c) throw new Error("Candidate not found.");
  if (c.status !== "candidate") throw new Error(`Already ${c.status}.`);
  const decided = { decidedById: actor.userId, decidedAt: new Date(), updatedAt: new Date(), decisionNote: opts.note?.slice(0, 1000) ?? null };
  if (decision === "reject") {
    await db.update(packageCandidates).set({ status: "rejected", ...decided }).where(eq(packageCandidates.id, id));
    return { status: "rejected" as const, kitId: null };
  }
  const e = opts.edits ? packageEditSchema.parse(opts.edits) : null;
  const edited = !!e && Object.values(e).some((v) => v !== undefined);
  const components: Component[] = e?.components ? e.components.map((x) => ({ role: x.role, productId: x.product_id, quantity: x.quantity, perCamera: x.per_camera })) : c.components;
  const cameraCount = e?.camera_count ?? c.cameraCount;
  const name = e?.name ?? c.name;
  const key = e?.key !== undefined ? e.key || null : c.key;
  const tier = e?.tier !== undefined ? (e.tier ?? null) : c.tier;
  const approval = { status: "getsecure_approved" as const, approvedById: actor.userId, approvedAt: new Date(), reviewedAt: new Date(), updatedAt: new Date() };

  if (c.kind === "retire") {
    if (!c.targetKitId) throw new Error("This retirement has no kit.");
    await db.update(cctvKits).set({ status: "deprecated", reviewedAt: new Date(), updatedAt: new Date(), notes: `Retired by ${actor.name}: ${c.reasoning ?? "candidate approved"}`.slice(0, 2000) }).where(eq(cctvKits.id, c.targetKitId));
    await db.update(packageCandidates).set({ status: "approved", createdKitId: c.targetKitId, ...decided }).where(eq(packageCandidates.id, id));
    return { status: "approved" as const, kitId: c.targetKitId };
  }

  // A kit is one camera model, one recorder, optionally a default HDD, and accessories.
  const cams = components.filter((x) => x.role === "camera");
  const nvrs = components.filter((x) => x.role === "nvr");
  const hdds = components.filter((x) => x.role === "hdd");
  if (cams.length !== 1) throw new Error("A kit has exactly one camera model: edit the components first.");
  if (nvrs.length !== 1) throw new Error("A kit has exactly one recorder: edit the components first.");
  if (hdds.length > 1) throw new Error("A kit has one default HDD.");
  if (!cameraCount) throw new Error("Set the camera count.");
  const { errors, evidence } = await packageEvidence({ components, cameraCount, storeyType: c.storeyType, propertyType: c.propertyType, installationPackageKey: c.installationPackageKey });
  if (errors.length) throw new Error(errors.join(" "));
  const hdd = hdds[0] ? await db.query.products.findFirst({ where: eq(products.id, hdds[0].productId), columns: { specs: true } }) : null;
  const hddTb = hdd ? Number((hdd.specs as { capacityTb?: number }).capacityTb ?? 0) || null : null;
  const kit = {
    name,
    key,
    propertyType: c.propertyType,
    tier,
    cameraCount,
    cameraProductId: cams[0].productId,
    nvrProductId: nvrs[0].productId,
    defaultHddProductId: hdds[0]?.productId ?? null,
    defaultHddTb: hddTb != null ? hddTb.toFixed(2) : null,
    accessories: components.filter((x) => x.role === "accessory").map((x) => ({ productId: x.productId, quantity: x.quantity, perCamera: x.perCamera })),
    notes: (c.reasoning ?? "").slice(0, 2000) || null,
    ...approval,
  };
  let kitId: string;
  try {
    if (c.kind === "update") {
      if (!c.targetKitId) throw new Error("This update has no kit.");
      const before = await db.query.cctvKits.findFirst({ where: eq(cctvKits.id, c.targetKitId) });
      if (!before) throw new Error("The kit no longer exists.");
      await db.update(cctvKits).set({ ...kit, version: before.version + 1, source: `Updated from a Hermes candidate, approved by ${actor.name}` }).where(eq(cctvKits.id, c.targetKitId));
      kitId = c.targetKitId;
      await db.update(packageCandidates).set({ evidence: { ...c.evidence, before } }).where(eq(packageCandidates.id, id));
    } else {
      [{ id: kitId }] = await db.insert(cctvKits).values({ ...kit, version: 1, source: `${c.proposedBy === "crm:pattern" ? "Repeated configuration" : "Hermes candidate"}, approved by ${actor.name}` }).returning({ id: cctvKits.id });
    }
  } catch (err) {
    throw new Error(err instanceof Error && /cctv_kits_key_unique/.test(err.message) ? "A kit with that key already exists: change the key." : err instanceof Error ? err.message : String(err));
  }
  await db
    .update(packageCandidates)
    .set({ status: "approved", createdKitId: kitId, ...(edited ? { name, key, tier, cameraCount, components, evidence: { ...c.evidence, ...evidence, edited: true } } : {}), ...decided, decisionNote: edited ? `Edited and approved${opts.note ? `: ${opts.note}` : ""}`.slice(0, 1000) : decided.decisionNote })
    .where(eq(packageCandidates.id, id));
  return { status: "approved" as const, kitId };
}

/** Approved kits and open candidates, as Hermes sees them (models, counts, status: no costs). */
export async function listPackages() {
  const kits = await db.select().from(cctvKits).orderBy(cctvKits.cameraCount);
  const ids = [...new Set(kits.flatMap((k) => [k.cameraProductId, k.nvrProductId, ...(k.defaultHddProductId ? [k.defaultHddProductId] : []), ...k.accessories.map((a) => a.productId)]))];
  const prods = ids.length ? await db.select({ id: products.id, manufacturer: products.manufacturer, model: products.model, status: products.status }).from(products).where(inArray(products.id, ids)) : [];
  const name = (id: string | null) => {
    const p = prods.find((x) => x.id === id);
    return p ? `${p.manufacturer} ${p.model}${p.status === "deprecated" ? " (deprecated)" : ""}` : null;
  };
  const open = await db.select().from(packageCandidates).where(eq(packageCandidates.status, "candidate")).orderBy(desc(packageCandidates.createdAt)).limit(30);
  const inst = await db.select({ key: installationPackages.key, name: installationPackages.name, status: installationPackages.status, hours: installationPackages.estimatedHours }).from(installationPackages);
  return {
    approvedKits: kits.map((k) => ({ ref: `kit:${k.id}`, id: k.id, key: k.key, name: k.name, approved: TRUSTED_STATUSES.includes(k.status), status: k.status, propertyType: k.propertyType, tier: k.tier, cameraCount: k.cameraCount, camera: name(k.cameraProductId), nvr: name(k.nvrProductId), hdd: name(k.defaultHddProductId), accessories: k.accessories.map((a) => ({ product: name(a.productId), quantity: a.quantity, perCamera: a.perCamera })), version: k.version })),
    candidates: open.map((c) => ({ id: c.id, kind: c.kind, name: c.name, cameraCount: c.cameraCount, tier: c.tier, proposedBy: c.proposedBy, createdAt: c.createdAt.toISOString() })),
    installationPackages: inst.map((i) => ({ key: i.key, name: i.name, status: i.status, estimatedHours: n(i.hours) })),
  };
}

type Config = { quoteId: string; quoteNumber: number; quoteStatus: string; at: Date; propertyType: string; cameraCount: number; storeys: number | null; cameraId: string; nvrId: string; hddId: string | null; tier: string | null; jobDone: boolean };

/** The CCTV configurations Get Secure has actually quoted (sent, approved or accepted), newest first. No customer details. */
export async function quotedConfigurations(limit = 300): Promise<Config[]> {
  const rows = await db
    .select({ q: { id: quotes.id, number: quotes.number, status: quotes.status, createdAt: quotes.createdAt }, packet: cctvAssessments.packet })
    .from(quotes)
    .innerJoin(cctvAssessments, eq(cctvAssessments.id, quotes.assessmentId))
    .where(and(eq(quotes.origin, "brain"), inArray(quotes.status, ["sent", "approved", "accepted"])))
    .orderBy(desc(quotes.createdAt))
    .limit(limit);
  const done = rows.length ? await db.select({ quoteId: jobs.quoteId }).from(jobs).where(and(inArray(jobs.quoteId, rows.map((r) => r.q.id)), inArray(jobs.status, ["done", "invoiced"]))) : [];
  const out: Config[] = [];
  for (const r of rows) {
    const p = r.packet as { propertyType?: string | null; cameras?: { product?: { id?: string } | null }[]; nvr?: { selected?: { id?: string } | null }; recording?: { storage?: { drives?: { product?: { id?: string } } | null } }; installation?: { storeys?: number | null }; recommendedTier?: string | null };
    const camIds = [...new Set((p.cameras ?? []).map((c) => c.product?.id).filter((x): x is string => !!x))];
    const nvrId = p.nvr?.selected?.id ?? null;
    if (camIds.length !== 1 || !nvrId) continue; // a kit is one camera model and one recorder
    out.push({ quoteId: r.q.id, quoteNumber: r.q.number, quoteStatus: r.q.status, at: r.q.createdAt, propertyType: p.propertyType ?? "residential", cameraCount: (p.cameras ?? []).length, storeys: p.installation?.storeys ?? null, cameraId: camIds[0], nvrId, hddId: p.recording?.storage?.drives?.product?.id ?? null, tier: p.recommendedTier ?? null, jobDone: done.some((d) => d.quoteId === r.q.id) });
  }
  return out;
}

/** Group quoted configurations by situation (market, camera count, storeys) and count the most common setup in the latest `window` of each. */
export function findPatterns(configs: Config[], opts: { window?: number; minCount?: number; minShare?: number } = {}) {
  const window = opts.window ?? 10;
  const minCount = opts.minCount ?? 3;
  const minShare = opts.minShare ?? 0.6;
  const groups = new Map<string, Config[]>();
  for (const c of configs) {
    const g = `${c.propertyType}|${c.cameraCount}|${c.storeys ?? "?"}`;
    groups.set(g, [...(groups.get(g) ?? []), c]);
  }
  const found: { group: string; signature: string; count: number; of: number; sample: Config[] }[] = [];
  for (const [group, list] of groups) {
    const recent = [...list].sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, window);
    const bySig = new Map<string, Config[]>();
    for (const c of recent) {
      const sig = `${group}|${c.cameraId}|${c.nvrId}|${c.hddId ?? "-"}`;
      bySig.set(sig, [...(bySig.get(sig) ?? []), c]);
    }
    const [sig, same] = [...bySig.entries()].sort((a, b) => b[1].length - a[1].length)[0] ?? [];
    if (sig && same && same.length >= minCount && same.length / recent.length >= minShare) found.push({ group, signature: sig, count: same.length, of: recent.length, sample: same });
  }
  return found;
}

/**
 * Look for configurations Get Secure keeps quoting with no approved kit, and propose each one once
 * as a candidate package ("used in 8 of the last 10 similar quotes"). Run daily by the worker and on
 * demand from the Packages page. A rejected pattern is never proposed again.
 */
export async function detectPackagePatterns(opts: { window?: number; minCount?: number; minShare?: number } = {}) {
  const patterns = findPatterns(await quotedConfigurations(), opts);
  if (!patterns.length) return { proposed: [] as string[] };
  const kits = await db.select().from(cctvKits).where(inArray(cctvKits.status, TRUSTED_STATUSES));
  const proposed: string[] = [];
  for (const pt of patterns) {
    const s = pt.sample[0];
    if (kits.some((k) => k.cameraProductId === s.cameraId && k.nvrProductId === s.nvrId && k.cameraCount === s.cameraCount && (k.propertyType === s.propertyType || k.propertyType === "both"))) continue;
    const seen = await db.query.packageCandidates.findFirst({ where: and(eq(packageCandidates.patternKey, pt.signature), ne(packageCandidates.status, "superseded")), columns: { id: true } });
    if (seen) continue;
    const names = await db.select({ id: products.id, model: products.model, manufacturer: products.manufacturer }).from(products).where(inArray(products.id, [s.cameraId, s.nvrId, ...(s.hddId ? [s.hddId] : [])]));
    const label = (id: string) => names.find((x) => x.id === id)?.model ?? "?";
    const tiers = pt.sample.map((x) => x.tier).filter((x): x is string => !!x);
    const tier = tiers.sort((a, b) => tiers.filter((t) => t === b).length - tiers.filter((t) => t === a).length)[0] ?? null;
    const storey = s.storeys === 2 ? "double" : s.storeys === 1 ? "single" : null;
    const brand = names.find((x) => x.id === s.cameraId)?.manufacturer ?? "";
    try {
      const r = await proposePackage(
        {
          kind: "new",
          name: `${s.propertyType === "commercial" ? "Commercial" : "Residential"} CCTV: ${s.cameraCount} camera${storey ? ` ${storey} storey` : ""}${tier ? ` (${tier})` : ""}`,
          property_type: s.propertyType === "commercial" ? "commercial" : "residential",
          tier: (TIERS as readonly string[]).includes(tier ?? "") ? (tier as (typeof TIERS)[number]) : null,
          camera_count: s.cameraCount,
          storey_type: storey,
          components: [
            { role: "camera", product_id: s.cameraId, quantity: s.cameraCount },
            { role: "nvr", product_id: s.nvrId, quantity: 1 },
            ...(s.hddId ? [{ role: "hdd" as const, product_id: s.hddId, quantity: 1 }] : []),
          ],
          reasoning: `Get Secure used effectively the same ${s.cameraCount}-camera ${storey ? `${storey}-storey ` : ""}${brand} configuration (${label(s.cameraId)} with ${label(s.nvrId)}${s.hddId ? ` and ${label(s.hddId)}` : ""}) in ${pt.count} of the last ${pt.of} similar quotes, and there is no approved kit for it. Approving it would let the Business Brain use it automatically.`,
          assumptions: ["Accessories (junction boxes, brackets) are added by the Business Brain per camera as today."],
          quote_ids: pt.sample.map((x) => x.quoteId),
          confidence: Math.min(0.95, pt.count / pt.of),
        },
        "crm:pattern",
        { patternKey: pt.signature },
      );
      proposed.push(r.candidateId);
    } catch {
      // A product no longer in the catalogue: nothing to propose.
    }
  }
  return { proposed };
}

const g = globalThis as unknown as { __packagePatternsAt?: number };
/** Once a day from the worker loop. */
export async function runPackagePatternsIfDue(log: (m: string) => void = () => {}) {
  if (g.__packagePatternsAt && Date.now() - g.__packagePatternsAt < 24 * 3600_000) return;
  g.__packagePatternsAt = Date.now();
  const r = await detectPackagePatterns();
  if (r.proposed.length) log(`packages: ${r.proposed.length} repeated configuration(s) proposed as candidate packages`);
}
