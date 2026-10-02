import type { Metadata } from "next";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { brainPolicies, installationPackages, products, supplierCredentials, supplierProducts, suppliers, users } from "@/db/schema";
import { requireAdmin } from "@/lib/auth";
import { ensurePolicies } from "@/lib/brain/store";
import { POLICY_DESCRIPTIONS, POLICY_KEYS } from "@/lib/brain/policy";
import { BrainSettings } from "@/components/brain/brain-settings";
import { formatDate } from "@/lib/utils";

export const metadata: Metadata = { title: "Business Brain" };

export default async function BrainSettingsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const user = await requireAdmin();
  const { tab = "policies" } = await searchParams;
  await ensurePolicies();
  const [policyRows, productRows, offers, supplierRows, creds, packageRows] = await Promise.all([
    db.select({ p: brainPolicies, approver: users.name }).from(brainPolicies).leftJoin(users, eq(brainPolicies.approvedById, users.id)),
    db.select().from(products).orderBy(asc(products.category), asc(products.manufacturer), asc(products.model)),
    db.select({ o: supplierProducts, supplier: suppliers.name }).from(supplierProducts).innerJoin(suppliers, eq(supplierProducts.supplierId, suppliers.id)),
    db.select().from(suppliers).orderBy(asc(suppliers.priority), asc(suppliers.name)),
    db.select({ supplierId: supplierCredentials.supplierId }).from(supplierCredentials),
    db.select().from(installationPackages).orderBy(asc(installationPackages.propertyType), asc(installationPackages.minCameras)),
  ]);
  const order = new Map(POLICY_KEYS.map((k, i) => [k as string, i]));
  const withCred = new Set(creds.map((c) => c.supplierId));

  return (
    <BrainSettings
      tab={tab}
      canApprove={!!user.canApprove}
      policies={policyRows
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
        model: r.model,
        category: r.category,
        market: r.market,
        tier: r.tier,
        specs: r.specs,
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
            costExGst: o.costExGst != null ? Number(o.costExGst) : null,
            pendingCostExGst: o.pendingCostExGst != null ? Number(o.pendingCostExGst) : null,
            approved: o.priceApproved,
            lastChecked: o.lastCheckedAt ? formatDate(o.lastCheckedAt) : null,
          })),
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
      }))}
      packages={packageRows.map((p) => ({
        id: p.id,
        name: p.name,
        propertyType: p.propertyType,
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
        notes: p.notes,
      }))}
    />
  );
}
