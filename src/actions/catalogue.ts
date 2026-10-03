"use server";

import { revalidatePath } from "next/cache";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { cctvKits, installationPackages, materialsPackages, productCompatibility, products, supplierBrandRoutes, supplierCredentials, suppliers } from "@/db/schema";
import { requireAdmin } from "@/lib/auth";
import { encryptSecret } from "@/lib/crypto";
import { assertApprover, humanFromUser, type Actor } from "@/lib/guard/actor";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { approveSupplierPrice, recordSupplierPrice, savePolicy } from "@/lib/brain/store";
import { POLICY_KEYS } from "@/lib/brain/policy";
import { COMPATIBILITY_KINDS, KNOWLEDGE_STATUSES, TIERS, type Policies } from "@/lib/brain/types";
import { importListings, parseSupplierCsv, PRICE_SOURCE_TYPES } from "@/lib/brain/suppliers/adapters";

const status = z.enum(KNOWLEDGE_STATUSES);
const optNum = z.coerce.number().nullable().optional();
const strList = z.array(z.string().trim().min(1)).default([]);

/** What each category must describe. A product that does not fit its category is not saved. */
const SPEC_SCHEMAS: Record<string, z.ZodTypeAny> = {
  camera: z.object({
    resolutionMp: z.coerce.number().positive(),
    horizontalPixels: z.coerce.number().int().positive(),
    hfovDeg: z.coerce.number().positive().max(360),
    lensMm: optNum,
    irRangeM: optNum,
    colourNight: z.boolean().optional(),
    wdrDb: optNum,
    codecs: strList,
    expectedBitrateMbps: optNum,
    maxBitrateMbps: optNum,
    poeWatts: optNum,
    analytics: strList,
    audio: z.boolean().optional(),
    onvifProfiles: strList,
  }).passthrough(),
  nvr: z.object({
    channels: z.coerce.number().int().positive(),
    incomingMbps: z.coerce.number().positive(),
    poePorts: z.coerce.number().int().min(0),
    poePerPortW: optNum,
    poeBudgetW: optNum,
    hddBays: z.coerce.number().int().positive(),
    maxHddTb: z.coerce.number().positive(),
    maxTotalTb: z.coerce.number().positive(),
    features: strList,
    audio: z.boolean().optional(),
    alarmIo: z.boolean().optional(),
    onvifProfiles: strList,
    recordingResolutionMaxMp: optNum,
    decoding: z.record(z.string(), z.coerce.number()).nullable().optional(),
    compatibleFamilies: strList,
  }).passthrough(),
  hdd: z.object({ capacityTb: z.coerce.number().positive(), surveillanceRated: z.boolean() }).passthrough(),
  poe_switch: z.object({ poePorts: z.coerce.number().int().positive(), poePerPortW: optNum, poeBudgetW: optNum }).passthrough(),
};
const CATEGORIES = ["camera", "nvr", "hdd", "poe_switch", "network", "router_4g", "ups", "monitor", "cable", "junction_box", "wall_bracket", "pole_bracket", "conduit", "accessory", "kit", "other"] as const;

const productInput = z.object({
  id: z.string().uuid().nullable().optional(),
  manufacturer: z.string().trim().min(1).max(100),
  family: z.string().trim().max(100).nullable().optional(),
  model: z.string().trim().min(1).max(100),
  category: z.enum(CATEGORIES),
  formFactor: z.string().trim().max(50).nullable().optional(),
  residentialAllowed: z.boolean(),
  commercialAllowed: z.boolean(),
  tier: z.enum(TIERS).nullable(),
  tierStatus: status.default("requires_review"),
  ecosystem: z.array(z.string().trim().min(1)).default([]),
  specs: z.record(z.string(), z.unknown()).default({}),
  warranty: z.string().trim().max(200).nullable().optional(),
  status,
  source: z.string().trim().max(300).nullable().optional(),
  sourceUrl: z.string().trim().max(500).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

async function admin(): Promise<Extract<Actor, { kind: "human" }>> {
  const user = await requireAdmin();
  return humanFromUser(user) as Extract<Actor, { kind: "human" }>;
}

function approvalFields(actor: Extract<Actor, { kind: "human" }>, s: z.infer<typeof status>) {
  if (s === "getsecure_approved") assertApprover(actor);
  return s === "getsecure_approved" ? { approvedById: actor.userId, approvedAt: new Date(), reviewedAt: new Date() } : { approvedById: null, approvedAt: null };
}

export async function saveProductAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const actor = await admin();
    const parsed = productInput.safeParse(input);
    if (!parsed.success) return fail(`${parsed.error.issues[0]?.path.join(".")}: ${parsed.error.issues[0]?.message}`);
    const d = parsed.data;
    const specSchema = SPEC_SCHEMAS[d.category];
    const specs = specSchema ? specSchema.safeParse(d.specs) : { success: true as const, data: d.specs };
    if (!specs.success) return fail(`Specification: ${specs.error.issues[0]?.path.join(".")} ${specs.error.issues[0]?.message}`);
    if (d.tierStatus === "getsecure_approved") assertApprover(actor);
    const values = {
      manufacturer: d.manufacturer,
      family: d.family || d.manufacturer,
      model: d.model,
      category: d.category,
      formFactor: d.formFactor ?? null,
      market: d.residentialAllowed && d.commercialAllowed ? "both" : d.commercialAllowed ? "commercial" : "residential",
      residentialAllowed: d.residentialAllowed,
      commercialAllowed: d.commercialAllowed,
      tier: d.tier,
      tierStatus: d.tier ? d.tierStatus : ("requires_review" as const),
      ecosystem: d.ecosystem,
      specs: specs.data as Record<string, unknown>,
      warranty: d.warranty ?? null,
      status: d.status,
      source: d.source ?? `Entered in the CRM by ${actor.name}`,
      sourceUrl: d.sourceUrl ?? null,
      notes: d.notes ?? null,
      updatedAt: new Date(),
      ...approvalFields(actor, d.status),
    };
    let id = d.id ?? null;
    if (id) await db.update(products).set(values).where(eq(products.id, id));
    else [{ id }] = await db.insert(products).values(values).returning({ id: products.id });
    revalidatePath("/settings/brain");
    return ok({ id: id! });
  } catch (err) {
    return fail(err instanceof Error ? (/products_model_idx/.test(err.message) ? "That manufacturer and model already exist." : err.message) : String(err));
  }
}

export async function recordPriceAction(input: {
  productId: string;
  supplierId: string;
  costExGst?: number | null;
  costIncGst?: number | null;
  supplierSku?: string | null;
  sourceUrl?: string | null;
  stock?: string | null;
  priceOnApplication?: boolean;
}): Promise<ActionResult<{ held: boolean; changedPct: number | null }>> {
  try {
    const actor = await admin();
    const r = await recordSupplierPrice({ ...input, source: `Entered by ${actor.name}` }, actor);
    revalidatePath("/settings/brain");
    return ok({ held: r.held, changedPct: r.changedPct });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export async function approvePriceAction(offerId: string): Promise<ActionResult<undefined>> {
  try {
    await approveSupplierPrice(offerId, await admin());
    revalidatePath("/settings/brain");
    return ok(undefined);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

const supplierInput = z.object({
  id: z.string().uuid().nullable().optional(),
  name: z.string().trim().min(1).max(100),
  website: z.string().trim().max(300).nullable().optional(),
  accountStatus: z.string().trim().max(100).nullable().optional(),
  priceSourceType: z.enum(PRICE_SOURCE_TYPES),
  isDefault: z.boolean().default(false),
  integrationMethod: z.string().trim().max(200).nullable().optional(),
  priority: z.coerce.number().int().min(1).max(1000),
  brands: z.array(z.string().trim().min(1)).default([]),
  status,
  notes: z.string().trim().max(2000).nullable().optional(),
});

export async function saveSupplierAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const actor = await admin();
    const parsed = supplierInput.safeParse(input);
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");
    const { id: given, ...d } = parsed.data;
    const values = { ...d, website: d.website ?? null, accountStatus: d.accountStatus ?? null, integrationMethod: d.integrationMethod ?? null, notes: d.notes ?? null, updatedAt: new Date(), ...approvalFields(actor, d.status) };
    let id = given ?? null;
    if (d.isDefault) await db.update(suppliers).set({ isDefault: false }).where(eq(suppliers.isDefault, true));
    if (id) await db.update(suppliers).set(values).where(eq(suppliers.id, id));
    else [{ id }] = await db.insert(suppliers).values({ ...values, source: `Entered by ${actor.name}` }).returning({ id: suppliers.id });
    revalidatePath("/settings/brain");
    return ok({ id: id! });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** Store a supplier login, encrypted. It is never read back to the screen or to any agent. */
export async function setSupplierCredentialAction(supplierId: string, username: string, secret: string): Promise<ActionResult<undefined>> {
  try {
    await admin();
    if (!secret) return fail("Enter the password or API key");
    await db
      .insert(supplierCredentials)
      .values({ supplierId, username: username.trim() || null, secretEncrypted: encryptSecret(secret) })
      .onConflictDoUpdate({ target: supplierCredentials.supplierId, set: { username: username.trim() || null, secretEncrypted: encryptSecret(secret), updatedAt: new Date() } });
    revalidatePath("/settings/brain");
    return ok(undefined);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

const optMoney = z.coerce.number().min(0).nullable();
const packageInput = z.object({
  id: z.string().uuid().nullable().optional(),
  key: z
    .string()
    .trim()
    .regex(/^[A-Z0-9_]+$/, "Key: capitals, digits and _ only (e.g. RES_CCTV_SINGLE_4)")
    .max(60)
    .nullable()
    .optional(),
  name: z.string().trim().min(1).max(200),
  propertyType: z.enum(["residential", "commercial"]),
  cameraCount: z.coerce.number().int().min(1).max(64),
  installType: z.enum(["new", "upgrade_ip"]).default("new"),
  /** New installations only; an IP upgrade package is by camera count. */
  storeyType: z.enum(["single", "double"]).nullable(),
  estimatedHours: z.coerce.number().positive().nullable(),
  labourRate: z.coerce.number().positive().nullable(),
  allowanceExGst: optMoney,
  materialCostExGst: optMoney,
  materialsPackageId: z.string().uuid().nullable(),
  conduitIncluded: z.boolean().default(false),
  conduitAllowanceExGst: optMoney,
  complexityAllowanceExGst: optMoney,
  includedMaterials: z.array(z.string().trim().min(1)).default([]),
  assumptions: z.array(z.string().trim().min(1)).default([]),
  exclusions: z.array(z.string().trim().min(1)).default([]),
  status,
  notes: z.string().trim().max(2000).nullable().optional(),
});

/** Save an installation package (exact camera count + storey type). Each save is a new version. */
export async function savePackageAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const actor = await admin();
    const parsed = packageInput.safeParse(input);
    if (!parsed.success) return fail(`${parsed.error.issues[0]?.path.join(".")}: ${parsed.error.issues[0]?.message}`);
    const { id: given, ...d } = parsed.data;
    const existing = given ? await db.query.installationPackages.findFirst({ where: eq(installationPackages.id, given) }) : null;
    if (d.installType === "new" && !d.storeyType) return fail("Choose single or double storey.");
    const storeyType = d.installType === "upgrade_ip" ? null : d.storeyType;
    const key =
      d.key ||
      (d.propertyType === "residential" ? (d.installType === "upgrade_ip" ? `RES_CCTV_UPGRADE_IP_${d.cameraCount}` : `RES_CCTV_${storeyType!.toUpperCase()}_${d.cameraCount}`) : null);
    const m = (v: number | null) => (v != null ? v.toFixed(2) : null);
    const values = {
      key,
      name: d.name,
      propertyType: d.propertyType,
      installType: d.installType,
      cameraCount: d.cameraCount,
      storeyType,
      minCameras: d.cameraCount,
      maxCameras: d.cameraCount,
      storeys: storeyType == null ? null : storeyType === "double" ? 2 : 1,
      estimatedHours: m(d.estimatedHours),
      labourRate: m(d.labourRate),
      allowanceExGst: m(d.allowanceExGst),
      materialCostExGst: m(d.materialCostExGst),
      materialsPackageId: d.materialsPackageId,
      conduitIncluded: d.conduitIncluded,
      conduitAllowanceExGst: d.conduitIncluded ? m(d.conduitAllowanceExGst) : null,
      complexityAllowanceExGst: m(d.complexityAllowanceExGst),
      includedMaterials: d.includedMaterials,
      assumptions: d.assumptions,
      exclusions: d.exclusions,
      status: d.status,
      notes: d.notes ?? null,
      version: existing ? existing.version + 1 : 1,
      updatedAt: new Date(),
      ...approvalFields(actor, d.status),
    };
    let id = given ?? null;
    if (id) await db.update(installationPackages).set(values).where(eq(installationPackages.id, id));
    else [{ id }] = await db.insert(installationPackages).values({ ...values, source: `Entered by ${actor.name}` }).returning({ id: installationPackages.id });
    revalidatePath("/settings/brain");
    return ok({ id: id! });
  } catch (err) {
    return fail(err instanceof Error ? (/installation_packages_key_unique/.test(err.message) ? "A package with that key already exists." : err.message) : String(err));
  }
}

// ---------- approved CCTV kits ----------

const kitInput = z.object({
  id: z.string().uuid().nullable().optional(),
  key: z.string().trim().regex(/^[A-Z0-9_]+$/, "Key: capitals, digits and _ only (e.g. VIGI_GOOD_4)").max(60).nullable().optional(),
  name: z.string().trim().min(1).max(200),
  propertyType: z.enum(["residential", "commercial", "both"]),
  tier: z.enum(TIERS).nullable(),
  cameraCount: z.coerce.number().int().min(1).max(64),
  cameraProductId: z.string().uuid(),
  nvrProductId: z.string().uuid(),
  defaultHddTb: z.coerce.number().positive().max(64).nullable(),
  defaultHddProductId: z.string().uuid().nullable(),
  accessories: z.array(z.object({ productId: z.string().uuid(), quantity: z.coerce.number().int().min(1).max(64), perCamera: z.boolean() })).max(20).default([]),
  status,
  notes: z.string().trim().max(2000).nullable().optional(),
});

/**
 * Save an approved CCTV kit: cameras + recorder + default HDD + accessories for an exact camera
 * count. Only an approver can mark a kit approved; only approved kits are used automatically.
 */
export async function saveKitAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const actor = await admin();
    const parsed = kitInput.safeParse(input);
    if (!parsed.success) return fail(`${parsed.error.issues[0]?.path.join(".")}: ${parsed.error.issues[0]?.message}`);
    const { id: given, ...d } = parsed.data;
    const ids = [d.cameraProductId, d.nvrProductId, ...(d.defaultHddProductId ? [d.defaultHddProductId] : []), ...d.accessories.map((a) => a.productId)];
    const rows = await db.select({ id: products.id, category: products.category, specs: products.specs }).from(products).where(inArray(products.id, ids));
    const cat = (id: string) => rows.find((r) => r.id === id)?.category;
    if (cat(d.cameraProductId) !== "camera") return fail("Choose a camera for the kit.");
    if (cat(d.nvrProductId) !== "nvr") return fail("Choose a recorder for the kit.");
    if (d.defaultHddProductId && cat(d.defaultHddProductId) !== "hdd") return fail("The default HDD must be a hard drive.");
    const hddTb = d.defaultHddProductId ? Number((rows.find((r) => r.id === d.defaultHddProductId)?.specs as { capacityTb?: number } | undefined)?.capacityTb ?? 0) || null : d.defaultHddTb;
    const existing = given ? await db.query.cctvKits.findFirst({ where: eq(cctvKits.id, given) }) : null;
    const values = {
      ...d,
      key: d.key || null,
      defaultHddTb: hddTb != null ? hddTb.toFixed(2) : null,
      notes: d.notes ?? null,
      version: existing ? existing.version + 1 : 1,
      reviewedAt: new Date(),
      updatedAt: new Date(),
      ...approvalFields(actor, d.status),
    };
    let id = given ?? null;
    if (id) await db.update(cctvKits).set(values).where(eq(cctvKits.id, id));
    else [{ id }] = await db.insert(cctvKits).values({ ...values, source: `Entered by ${actor.name}` }).returning({ id: cctvKits.id });
    revalidatePath("/settings/brain");
    return ok({ id: id! });
  } catch (err) {
    return fail(err instanceof Error ? (/cctv_kits_key_unique/.test(err.message) ? "A kit with that key already exists." : err.message) : String(err));
  }
}

export async function savePolicyAction(key: string, valueJson: string, newStatus: string, notes: string): Promise<ActionResult<undefined>> {
  try {
    const actor = await admin();
    if (!(POLICY_KEYS as string[]).includes(key)) return fail("Unknown policy");
    const s = status.safeParse(newStatus);
    if (!s.success) return fail("Invalid status");
    let value: unknown;
    try {
      value = JSON.parse(valueJson);
    } catch {
      return fail("Value must be valid JSON (numbers as 25, text in quotes, lists in [ ]).");
    }
    await savePolicy(key as keyof Policies, value, s.data, notes.trim() || null, actor);
    revalidatePath("/settings/brain");
    return ok(undefined);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

// ---------- compatibility ----------

export async function saveLinkAction(input: { kind: string; fromProductId: string; toProductId: string; quantity?: number; sourceUrl?: string | null; notes?: string | null }): Promise<ActionResult<undefined>> {
  try {
    const actor = await admin();
    const kind = z.enum(COMPATIBILITY_KINDS as [string, ...string[]]).parse(input.kind);
    if (input.fromProductId === input.toProductId) return fail("A product cannot be linked to itself.");
    await db
      .insert(productCompatibility)
      .values({
        kind,
        fromProductId: input.fromProductId,
        toProductId: input.toProductId,
        quantity: Math.max(1, Math.round(input.quantity ?? 1)),
        status: input.sourceUrl ? "manufacturer_verified" : "requires_review",
        source: `Entered by ${actor.name}`,
        sourceUrl: input.sourceUrl ?? null,
        notes: input.notes ?? null,
      })
      .onConflictDoUpdate({ target: [productCompatibility.kind, productCompatibility.fromProductId, productCompatibility.toProductId], set: { quantity: Math.max(1, Math.round(input.quantity ?? 1)), updatedAt: new Date() } });
    revalidatePath("/settings/brain");
    return ok(undefined);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export async function deleteLinkAction(id: string): Promise<ActionResult<undefined>> {
  try {
    await admin();
    await db.delete(productCompatibility).where(eq(productCompatibility.id, id));
    revalidatePath("/settings/brain");
    return ok(undefined);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

// ---------- supplier routing ----------

const routeInput = z.object({
  id: z.string().uuid().nullable().optional(),
  brand: z.string().trim().min(1).max(100),
  supplierId: z.string().uuid(),
  rank: z.coerce.number().int().min(1).max(99),
  market: z.enum(["residential", "commercial", "both"]),
  status,
  notes: z.string().trim().max(500).nullable().optional(),
});

export async function saveRouteAction(input: unknown): Promise<ActionResult<undefined>> {
  try {
    const actor = await admin();
    const parsed = routeInput.safeParse(input);
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");
    const { id, ...d } = parsed.data;
    const values = { ...d, notes: d.notes ?? null, updatedAt: new Date(), ...approvalFields(actor, d.status) };
    if (id) await db.update(supplierBrandRoutes).set(values).where(eq(supplierBrandRoutes.id, id));
    else await db.insert(supplierBrandRoutes).values({ ...values, source: `Entered by ${actor.name}` });
    revalidatePath("/settings/brain");
    return ok(undefined);
  } catch (err) {
    return fail(err instanceof Error ? (/supplier_brand_routes_idx/.test(err.message) ? "That brand already has a route to this supplier for this market." : err.message) : String(err));
  }
}

export async function deleteRouteAction(id: string): Promise<ActionResult<undefined>> {
  try {
    await admin();
    await db.delete(supplierBrandRoutes).where(eq(supplierBrandRoutes.id, id));
    revalidatePath("/settings/brain");
    return ok(undefined);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

// ---------- materials package ----------

const materialsInput = z.object({
  id: z.string().uuid().nullable().optional(),
  name: z.string().trim().min(1).max(200),
  customerDescription: z.string().trim().min(1).max(200),
  items: z.array(z.object({ description: z.string().trim().min(1).max(200), quantity: z.string().trim().max(50).nullable().optional(), costExGst: z.coerce.number().min(0).nullable().optional() })).default([]),
  costExGst: z.coerce.number().min(0).nullable(),
  sellExGst: z.coerce.number().min(0).nullable(),
  status,
  notes: z.string().trim().max(2000).nullable().optional(),
});

export async function saveMaterialsPackageAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const actor = await admin();
    const parsed = materialsInput.safeParse(input);
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");
    const { id: given, ...d } = parsed.data;
    const existing = given ? await db.query.materialsPackages.findFirst({ where: eq(materialsPackages.id, given) }) : null;
    const values = {
      name: d.name,
      customerDescription: d.customerDescription,
      items: d.items.map((i) => ({ description: i.description, quantity: i.quantity ?? null, costExGst: i.costExGst ?? null })),
      costExGst: d.costExGst != null ? d.costExGst.toFixed(2) : null,
      sellExGst: d.sellExGst != null ? d.sellExGst.toFixed(2) : null,
      status: d.status,
      notes: d.notes ?? null,
      version: existing ? existing.version + 1 : 1,
      updatedAt: new Date(),
      ...approvalFields(actor, d.status),
    };
    let id = given ?? null;
    if (id) await db.update(materialsPackages).set(values).where(eq(materialsPackages.id, id));
    else [{ id }] = await db.insert(materialsPackages).values({ ...values, source: `Entered by ${actor.name}` }).returning({ id: materialsPackages.id });
    revalidatePath("/settings/brain");
    return ok({ id: id! });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

// ---------- CSV import ----------

/** Import a supplier price list. Prices are recorded unapproved (or held if they moved a lot). */
export async function importSupplierCsvAction(supplierId: string, text: string, confirmedTrade: boolean): Promise<ActionResult<{ recorded: number; held: number; poa: number; unmatched: string[]; errors: string[] }>> {
  try {
    const actor = await admin();
    if (!confirmedTrade) return fail("Tick to confirm these are Get Secure trade (account) prices. Retail pricing is never imported as cost.");
    const { listings, errors } = parseSupplierCsv(text);
    if (!listings.length) return fail(errors[0] ?? "No rows found.");
    const r = await importListings(supplierId, listings, actor, { type: "csv", label: `CSV import by ${actor.name}`, confirmedTrade });
    revalidatePath("/settings/brain");
    return ok({ ...r, errors });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
