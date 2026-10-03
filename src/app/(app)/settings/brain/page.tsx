import type { Metadata } from "next";
import { asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  brainPolicies,
  installationPackages,
  materialsPackages,
  productCompatibility,
  products,
  cctvKits,
  productPriceHistory,
  supplierBrandRoutes,
  supplierConnectors,
  supplierCredentials,
  supplierProducts,
  supplierSyncRuns,
  suppliers,
  users,
} from "@/db/schema";
import { requireAdmin } from "@/lib/auth";
import { ensurePolicies, loadPolicies } from "@/lib/brain/store";
import { applyReferenceCatalogue } from "@/lib/brain/reference/apply";
import { POLICY_DESCRIPTIONS, POLICY_KEYS } from "@/lib/brain/policy";
import { applyStarterContent } from "@/lib/proposals/content";
import { priceFreshness } from "@/lib/brain/pricing";
import { BrainSettings } from "@/components/brain/brain-settings";
import type { ConnectorView } from "@/components/brain/supplier-pricing";
import type { SyncItem } from "@/lib/brain/suppliers/connector";
import { formatDate, formatDateTime } from "@/lib/utils";

export const metadata: Metadata = { title: "Business Brain" };

const num = (v: string | null) => (v != null ? Number(v) : null);

export default async function BrainSettingsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const user = await requireAdmin();
  const { tab = "policies" } = await searchParams;
  await ensurePolicies();
  await applyReferenceCatalogue();
  await applyStarterContent().catch(() => {});
  const [policies, policyRows, productRows, offers, supplierRows, creds, packageRows, materialRows, linkRows, routeRows, kitRows] = await Promise.all([
    loadPolicies(),
    db.select({ p: brainPolicies, approver: users.name }).from(brainPolicies).leftJoin(users, eq(brainPolicies.approvedById, users.id)),
    db.select().from(products).orderBy(asc(products.category), asc(products.manufacturer), asc(products.model)),
    db.select({ o: supplierProducts, supplier: suppliers.name }).from(supplierProducts).innerJoin(suppliers, eq(supplierProducts.supplierId, suppliers.id)),
    db.select().from(suppliers).orderBy(asc(suppliers.priority), asc(suppliers.name)),
    db.select({ supplierId: supplierCredentials.supplierId }).from(supplierCredentials),
    db.select().from(installationPackages).orderBy(asc(installationPackages.propertyType), asc(installationPackages.storeys), asc(installationPackages.cameraCount), asc(installationPackages.minCameras)),
    db.select().from(materialsPackages).orderBy(asc(materialsPackages.name)),
    db.select().from(productCompatibility),
    db.select({ r: supplierBrandRoutes, supplier: suppliers.name }).from(supplierBrandRoutes).innerJoin(suppliers, eq(supplierBrandRoutes.supplierId, suppliers.id)).orderBy(asc(supplierBrandRoutes.brand), asc(supplierBrandRoutes.rank)),
    db.select({ k: cctvKits, approver: users.name }).from(cctvKits).leftJoin(users, eq(cctvKits.approvedById, users.id)).orderBy(asc(cctvKits.propertyType), asc(cctvKits.cameraCount), asc(cctvKits.name)),
  ]);
  const order = new Map(POLICY_KEYS.map((k, i) => [k as string, i]));
  const withCred = new Set(creds.map((c) => c.supplierId));
  const label = new Map(productRows.map((p) => [p.id, `${p.manufacturer} ${p.model}`]));
  const now = new Date();
  const connectors = tab === "pricing" ? await loadConnectors(productRows, offers, policies, now) : [];

  return (
    <BrainSettings
      tab={tab}
      connectors={connectors}
      canApprove={!!user.canApprove}
      policies={policyRows
        .filter(({ p }) => order.has(p.key))
        .sort((a, b) => (order.get(a.p.key) ?? 99) - (order.get(b.p.key) ?? 99))
        .map(({ p, approver }) => ({
          key: p.key,
          description: POLICY_DESCRIPTIONS[p.key as keyof typeof POLICY_DESCRIPTIONS] ?? p.key,
          value: p.value,
          status: p.status,
          source: p.source,
          notes: p.notes,
          approvedBy: approver,
          approvedAt: p.approvedAt ? formatDate(p.approvedAt) : null,
        }))}
      products={productRows.map((r) => ({
        id: r.id,
        manufacturer: r.manufacturer,
        family: r.family,
        model: r.model,
        category: r.category,
        formFactor: r.formFactor,
        residentialAllowed: r.residentialAllowed,
        commercialAllowed: r.commercialAllowed,
        tier: r.tier,
        tierStatus: r.tierStatus,
        ecosystem: r.ecosystem,
        specs: r.specs,
        unverifiedFields: r.unverifiedFields,
        lastVerified: r.lastVerifiedAt ? formatDate(r.lastVerifiedAt) : null,
        warranty: r.warranty,
        status: r.status,
        source: r.source,
        sourceUrl: r.sourceUrl,
        notes: r.notes,
        quote: {
          displayName: r.quoteDisplayName,
          description: r.quoteDescription,
          highlights: r.quoteHighlights,
          featureNotes: r.quoteFeatureNotes,
          imageId: r.quoteImageId,
          showCard: r.quoteShowCard,
          status: r.quoteContentStatus,
        },
        offers: offers
          .filter((o) => o.o.productId === r.id)
          .map(({ o, supplier }) => ({
            id: o.id,
            supplier,
            sku: o.supplierSku,
            costExGst: num(o.costExGst),
            pendingCostExGst: num(o.pendingCostExGst),
            approved: o.priceApproved,
            poa: o.priceOnApplication,
            stock: o.stock,
            priceSource: o.priceSource,
            lastChecked: o.lastCheckedAt ? formatDate(o.lastCheckedAt) : null,
            freshness: o.priceOnApplication || o.costExGst == null ? ("unknown" as const) : priceFreshness(o.lastCheckedAt, policies, now).freshness,
          })),
        links: linkRows
          .filter((l) => l.fromProductId === r.id || l.toProductId === r.id)
          .map((l) => {
            const from = l.fromProductId === r.id;
            const otherId = from ? l.toProductId : l.fromProductId;
            return { id: l.id, kind: l.kind, direction: from ? ("from" as const) : ("to" as const), other: label.get(otherId) ?? "?", otherId, quantity: l.quantity, status: l.status };
          }),
      }))}
      suppliers={supplierRows.map((s) => ({
        id: s.id,
        name: s.name,
        website: s.website,
        accountStatus: s.accountStatus,
        priceSourceType: s.priceSourceType,
        integrationMethod: s.integrationMethod,
        priority: s.priority,
        brands: s.brands,
        status: s.status,
        notes: s.notes,
        lastPriceSyncAt: s.lastPriceSyncAt ? formatDate(s.lastPriceSyncAt) : null,
        hasCredential: withCred.has(s.id),
        isDefault: s.isDefault,
        listings: offers.filter((o) => o.o.supplierId === s.id).length,
      }))}
      routes={routeRows.map(({ r, supplier }) => ({ id: r.id, brand: r.brand, supplierId: r.supplierId, supplier, rank: r.rank, market: r.market, status: r.status, notes: r.notes }))}
      packages={packageRows.map((p) => ({
        id: p.id,
        key: p.key,
        name: p.name,
        propertyType: p.propertyType,
        installType: p.installType === "upgrade_ip" ? ("upgrade_ip" as const) : ("new" as const),
        cameraCount: p.cameraCount ?? (p.minCameras === p.maxCameras ? p.minCameras : null),
        storeyType: p.storeyType ?? (p.storeys == null ? null : p.storeys >= 2 ? "double" : "single"),
        materialCostExGst: num(p.materialCostExGst),
        complexityAllowanceExGst: num(p.complexityAllowanceExGst),
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
        notes: p.notes,
      }))}
      kits={kitRows.map(({ k, approver }) => ({
        id: k.id,
        key: k.key,
        name: k.name,
        propertyType: (k.propertyType === "commercial" || k.propertyType === "both" ? k.propertyType : "residential") as "residential" | "commercial" | "both",
        tier: k.tier,
        cameraCount: k.cameraCount,
        cameraProductId: k.cameraProductId,
        nvrProductId: k.nvrProductId,
        defaultHddTb: num(k.defaultHddTb),
        defaultHddProductId: k.defaultHddProductId,
        accessories: k.accessories,
        status: k.status,
        version: k.version,
        notes: k.notes,
        approvedBy: approver,
      }))}
      kitProducts={productRows
        .filter((p) => p.status !== "deprecated")
        .map((p) => ({ id: p.id, label: `${p.manufacturer} ${p.model}`, category: p.category, capacityTb: p.category === "hdd" ? Number((p.specs as { capacityTb?: number }).capacityTb ?? 0) || null : null }))}
      materials={materialRows.map((m) => ({
        id: m.id,
        name: m.name,
        customerDescription: m.customerDescription,
        items: m.items,
        costExGst: num(m.costExGst),
        sellExGst: num(m.sellExGst),
        version: m.version,
        status: m.status,
        notes: m.notes,
      }))}
    />
  );
}

type ProductRow = typeof products.$inferSelect;
type OfferRow = { o: typeof supplierProducts.$inferSelect; supplier: string };

/** The supplier pricing tab: connector status, runs, listings and their price history. Never credentials. */
async function loadConnectors(productRows: ProductRow[], offers: OfferRow[], policies: Awaited<ReturnType<typeof loadPolicies>>, now: Date): Promise<ConnectorView[]> {
  const rows = await db.select({ c: supplierConnectors, supplier: suppliers.name }).from(supplierConnectors).innerJoin(suppliers, eq(supplierConnectors.supplierId, suppliers.id));
  const out: ConnectorView[] = [];
  for (const { c, supplier } of rows) {
    const [cred, runs] = await Promise.all([
      db.query.supplierCredentials.findFirst({ where: eq(supplierCredentials.supplierId, c.supplierId), columns: { updatedAt: true } }),
      db.select({ r: supplierSyncRuns, by: users.name }).from(supplierSyncRuns).leftJoin(users, eq(supplierSyncRuns.startedById, users.id)).where(eq(supplierSyncRuns.supplierId, c.supplierId)).orderBy(desc(supplierSyncRuns.startedAt)).limit(6),
    ]);
    const mine = offers.filter((o) => o.o.supplierId === c.supplierId && !o.o.priceOnApplication);
    const history = mine.length
      ? await db
          .select({ h: productPriceHistory, by: users.name })
          .from(productPriceHistory)
          .leftJoin(users, eq(productPriceHistory.reviewedById, users.id))
          .where(inArray(productPriceHistory.supplierProductId, mine.map((o) => o.o.id)))
          .orderBy(desc(productPriceHistory.recordedAt))
      : [];
    const byId = new Map(productRows.map((p) => [p.id, p]));
    const listed = new Set(mine.map((o) => o.o.productId));
    out.push({
      supplierId: c.supplierId,
      supplier,
      connector: c.connector,
      status: c.status,
      statusDetail: c.statusDetail,
      hasLogin: !!cred,
      loginUpdatedAt: cred ? formatDateTime(cred.updatedAt) : null,
      lastLoginOkAt: c.lastLoginOkAt ? formatDateTime(c.lastLoginOkAt) : null,
      lastLoginFailedAt: c.lastLoginFailedAt ? formatDateTime(c.lastLoginFailedAt) : null,
      lastLoginFailure: c.lastLoginFailure,
      lastSyncOkAt: c.lastSyncOkAt ? formatDateTime(c.lastSyncOkAt) : null,
      lastSyncFailedAt: c.lastSyncFailedAt ? formatDateTime(c.lastSyncFailedAt) : null,
      lastSyncFailure: c.lastSyncFailure,
      priceBasisSeen: c.priceBasisSeen,
      runs: runs.map(({ r, by }) => ({ id: r.id, kind: r.kind, status: r.status, startedAt: formatDateTime(r.startedAt), startedBy: by, summary: r.summary, error: r.error, items: r.items as unknown as SyncItem[] })),
      listings: mine
        .map(({ o }) => {
          const p = byId.get(o.productId);
          return {
            offerId: o.id,
            productId: o.productId,
            product: p ? `${p.manufacturer} ${p.model}` : "?",
            category: p?.category ?? "",
            sku: o.supplierSku,
            url: o.sourceUrl,
            costExGst: num(o.costExGst),
            pendingCostExGst: num(o.pendingCostExGst),
            approved: o.priceApproved,
            freshness: o.costExGst == null ? ("unknown" as const) : priceFreshness(o.lastCheckedAt, policies, now).freshness,
            lastChecked: o.lastCheckedAt ? formatDateTime(o.lastCheckedAt) : null,
            stock: o.stock,
            priceSource: o.priceSource,
            history: history
              .filter(({ h }) => h.supplierProductId === o.id)
              .map(({ h, by }) => ({
                at: formatDateTime(h.recordedAt),
                oldCostExGst: num(h.oldCostExGst),
                newCostExGst: Number(h.newCostExGst),
                changedPct: num(h.changedPct),
                source: h.source,
                priceSource: h.priceSource,
                stock: h.stock,
                review: h.reviewStatus,
                reviewedBy: by,
              })),
          };
        })
        .sort((a, b) => a.category.localeCompare(b.category) || a.product.localeCompare(b.product)),
      unlisted: productRows
        .filter((p) => !listed.has(p.id) && p.status !== "deprecated")
        .map((p) => ({ id: p.id, label: `${p.manufacturer} ${p.model}`, category: p.category })),
    });
  }
  return out;
}
