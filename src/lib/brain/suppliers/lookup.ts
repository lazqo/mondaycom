/**
 * Read-only views of the catalogue and suppliers for Hermes's tools. No credentials ever appear
 * (only whether a login is stored). Costs appear only in the trade views, for the research profile,
 * labelled with whether Chris has approved them; the Inspector profile gets the catalogue without
 * costs.
 */
import { and, desc, eq, ilike, inArray, or } from "drizzle-orm";
import { db } from "@/db";
import { products, supplierConnectors, supplierCredentials, supplierProducts, suppliers } from "@/db/schema";

const n = (v: string | null | undefined) => (v != null ? Number(v) : null);
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export async function listSuppliers() {
  const rows = await db.select().from(suppliers).orderBy(suppliers.priority);
  const conns = await db.select({ supplierId: supplierConnectors.supplierId, connector: supplierConnectors.connector, status: supplierConnectors.status }).from(supplierConnectors);
  const creds = await db.select({ supplierId: supplierCredentials.supplierId }).from(supplierCredentials);
  return rows.map((s) => {
    const c = conns.find((x) => x.supplierId === s.id);
    return {
      id: s.id,
      name: s.name,
      website: s.website,
      brands: s.brands,
      priceSource: s.priceSourceType,
      liveLookup: c ? { connector: c.connector, status: c.status } : null,
      loginStored: creds.some((x) => x.supplierId === s.id),
      lastPriceSyncAt: iso(s.lastPriceSyncAt),
    };
  });
}

/** Catalogue products matching a query, with each supplier's listing. Costs only when asked (research). */
export async function searchCatalogue(query: string, opts: { withCosts: boolean; limit?: number }) {
  const term = `%${query.trim()}%`;
  const rows = await db
    .select()
    .from(products)
    .where(or(ilike(products.model, term), ilike(products.manufacturer, term), ilike(products.family, term), ilike(products.category, term)))
    .limit(opts.limit ?? 15);
  if (!rows.length) return [];
  const listings = await db
    .select({ l: supplierProducts, supplier: suppliers.name })
    .from(supplierProducts)
    .innerJoin(suppliers, eq(suppliers.id, supplierProducts.supplierId))
    .where(inArray(supplierProducts.productId, rows.map((r) => r.id)));
  return rows.map((p) => ({
    ref: `crm:product:${p.id}`,
    id: p.id,
    manufacturer: p.manufacturer,
    family: p.family,
    model: p.model,
    category: p.category,
    market: p.market,
    knowledgeStatus: p.tierStatus,
    unverifiedFields: p.unverifiedFields,
    lastVerifiedAt: iso(p.lastVerifiedAt),
    specs: p.specs,
    alternatives: p.alternatives,
    suppliers: listings
      .filter((x) => x.l.productId === p.id)
      .map((x) => ({
        supplier: x.supplier,
        sku: x.l.supplierSku,
        url: x.l.sourceUrl,
        stock: x.l.stock,
        lastCheckedAt: iso(x.l.lastCheckedAt),
        ...(opts.withCosts
          ? { tradeCostExGst: n(x.l.costExGst), approvedByChris: x.l.priceApproved, pendingCostExGst: n(x.l.pendingCostExGst), priceSource: x.l.priceSource, priceBasis: x.l.priceBasis, priceOnApplication: x.l.priceOnApplication }
          : {}),
      })),
  }));
}

/** Every supplier's stored trade price and stock for one product, side by side (research only). */
export async function compareSuppliers(productId: string) {
  const p = await db.query.products.findFirst({ where: eq(products.id, productId), columns: { id: true, manufacturer: true, model: true } });
  if (!p) return null;
  const rows = await db
    .select({ l: supplierProducts, supplier: suppliers.name, priority: suppliers.priority })
    .from(supplierProducts)
    .innerJoin(suppliers, eq(suppliers.id, supplierProducts.supplierId))
    .where(and(eq(supplierProducts.productId, productId)))
    .orderBy(suppliers.priority, desc(supplierProducts.lastCheckedAt));
  return {
    product: `${p.manufacturer} ${p.model}`,
    ref: `crm:product:${p.id}`,
    offers: rows.map((r) => ({
      supplier: r.supplier,
      supplierId: r.l.supplierId,
      sku: r.l.supplierSku,
      tradeCostExGst: n(r.l.costExGst),
      approvedByChris: r.l.priceApproved,
      pendingCostExGst: n(r.l.pendingCostExGst),
      stock: r.l.stock,
      lastCheckedAt: iso(r.l.lastCheckedAt),
      priceSource: r.l.priceSource,
      priceOnApplication: r.l.priceOnApplication,
    })),
    note: "Stored prices. Only those approved by Chris are used by the Business Brain; a public or RRP price is never a trade cost.",
  };
}
