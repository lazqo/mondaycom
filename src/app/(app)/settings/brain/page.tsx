import type { Metadata } from "next";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  brainPolicies,
  installationPackages,
  materialsPackages,
  productCompatibility,
  products,
  supplierBrandRoutes,
  supplierCredentials,
  supplierProducts,
  suppliers,
  users,
} from "@/db/schema";
import { requireAdmin } from "@/lib/auth";
import { ensurePolicies, loadPolicies } from "@/lib/brain/store";
import { applyReferenceCatalogue } from "@/lib/brain/reference/apply";
import { POLICY_DESCRIPTIONS, POLICY_KEYS } from "@/lib/brain/policy";
import { priceFreshness } from "@/lib/brain/pricing";
import { BrainSettings } from "@/components/brain/brain-settings";
import { formatDate } from "@/lib/utils";

export const metadata: Metadata = { title: "Business Brain" };

const num = (v: string | null) => (v != null ? Number(v) : null);

export default async function BrainSettingsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const user = await requireAdmin();
  const { tab = "policies" } = await searchParams;
  await ensurePolicies();
  await applyReferenceCatalogue();
  const [policies, policyRows, productRows, offers, supplierRows, creds, packageRows, materialRows, linkRows, routeRows] = await Promise.all([
    loadPolicies(),
    db.select({ p: brainPolicies, approver: users.name }).from(brainPolicies).leftJoin(users, eq(brainPolicies.approvedById, users.id)),
    db.select().from(products).orderBy(asc(products.category), asc(products.manufacturer), asc(products.model)),
    db.select({ o: supplierProducts, supplier: suppliers.name }).from(supplierProducts).innerJoin(suppliers, eq(supplierProducts.supplierId, suppliers.id)),
    db.select().from(suppliers).orderBy(asc(suppliers.priority), asc(suppliers.name)),
    db.select({ supplierId: supplierCredentials.supplierId }).from(supplierCredentials),
    db.select().from(installationPackages).orderBy(asc(installationPackages.propertyType), asc(installationPackages.storeys), asc(installationPackages.minCameras)),
    db.select().from(materialsPackages).orderBy(asc(materialsPackages.name)),
    db.select().from(productCompatibility),
    db.select({ r: supplierBrandRoutes, supplier: suppliers.name }).from(supplierBrandRoutes).innerJoin(suppliers, eq(supplierBrandRoutes.supplierId, suppliers.id)).orderBy(asc(supplierBrandRoutes.brand), asc(supplierBrandRoutes.rank)),
  ]);
  const order = new Map(POLICY_KEYS.map((k, i) => [k as string, i]));
  const withCred = new Set(creds.map((c) => c.supplierId));
  const label = new Map(productRows.map((p) => [p.id, `${p.manufacturer} ${p.model}`]));
  const now = new Date();

  return (
    <BrainSettings
      tab={tab}
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
        name: p.name,
        propertyType: p.propertyType,
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
        notes: p.notes,
      }))}
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
