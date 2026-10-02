/**
 * Which supplier's price a quote uses, and how fresh it is.
 *
 * A product can be listed by several suppliers. The engine prefers, in order: an approved cost
 * (an unapproved or held one is never used), the brand's Get Secure supplier route for this kind
 * of job, the default supplier, fresher prices, then the lower cost. A price-on-application
 * listing has no cost to use. Freshness is worked out from when the price was last checked.
 */
import type { BrandRoute, Catalogue, Policies, PriceFreshness, Product, ProductOffer, ProductPrice, PropertyType } from "./types";

const DAY = 86_400_000;
const FRESH_ORDER: PriceFreshness[] = ["current", "aging", "stale", "unknown"];

export function familyOf(p: Pick<Product, "family" | "manufacturer">): string {
  return (p.family || p.manufacturer).trim();
}

export function priceFreshness(lastChecked: Date | string | null | undefined, policies: Policies, now: Date): { freshness: PriceFreshness; ageDays: number | null } {
  if (!lastChecked) return { freshness: "unknown", ageDays: null };
  const t = new Date(lastChecked).getTime();
  if (Number.isNaN(t)) return { freshness: "unknown", ageDays: null };
  const ageDays = Math.max(0, Math.floor((now.getTime() - t) / DAY));
  const freshness: PriceFreshness = ageDays <= policies.priceAgingDays.value ? "current" : ageDays <= policies.priceStaleDays.value ? "aging" : "stale";
  return { freshness, ageDays };
}

/** The routes that apply to this brand for this kind of job, best first. */
export function routesFor(routes: BrandRoute[], brand: string, propertyType: PropertyType | null): BrandRoute[] {
  const b = brand.toLowerCase();
  const market = propertyType ?? "residential";
  return routes
    .filter((r) => r.status !== "deprecated" && r.brand.toLowerCase() === b && (r.market === "both" || r.market === market))
    .sort((x, y) => x.rank - y.rank);
}

export function chooseOffer(
  product: Product,
  offers: ProductOffer[],
  routes: BrandRoute[],
  propertyType: PropertyType | null,
  policies: Policies,
  now: Date,
): ProductPrice | null {
  const usable = offers.filter((o) => o.costExGst != null && !o.priceOnApplication);
  if (!usable.length) return null;
  const brandRoutes = routesFor(routes, familyOf(product), propertyType);
  const rankOf = (o: ProductOffer) => brandRoutes.find((r) => r.supplierId === o.supplierId)?.rank ?? null;
  const fresh = (o: ProductOffer) => FRESH_ORDER.indexOf(priceFreshness(o.lastChecked, policies, now).freshness);
  const sorted = [...usable].sort(
    (a, b) =>
      Number(b.approved) - Number(a.approved) ||
      (rankOf(a) ?? 1000) - (rankOf(b) ?? 1000) ||
      Number(b.supplierIsDefault) - Number(a.supplierIsDefault) ||
      fresh(a) - fresh(b) ||
      a.supplierPriority - b.supplierPriority ||
      (a.costExGst ?? Infinity) - (b.costExGst ?? Infinity) ||
      a.supplier.localeCompare(b.supplier),
  );
  const best = sorted[0];
  const rank = rankOf(best);
  const preferred = brandRoutes[0];
  let routeNote: string;
  if (rank === 1) routeNote = `${best.supplier}: preferred supplier for ${familyOf(product)}.`;
  else if (rank != null) routeNote = `${best.supplier}: route ${rank} for ${familyOf(product)}${preferred ? ` (preferred ${preferred.supplier} has no approved price)` : ""}.`;
  else if (preferred) routeNote = `${best.supplier}: not a ${familyOf(product)} route; ${preferred.supplier} has no approved price.`;
  else routeNote = best.supplierIsDefault ? `${best.supplier}: default supplier (no route for ${familyOf(product)}).` : `${best.supplier}: no route for ${familyOf(product)}.`;
  const f = priceFreshness(best.lastChecked, policies, now);
  const alternatives = sorted.slice(1).map((o) => ({
    supplier: o.supplier,
    costExGst: o.costExGst!,
    approved: o.approved,
    freshness: priceFreshness(o.lastChecked, policies, now).freshness,
    stock: o.stock,
    routeRank: rankOf(o),
  }));
  return {
    supplier: best.supplier,
    supplierSku: best.supplierSku,
    costExGst: best.costExGst!,
    lastChecked: best.lastChecked,
    confidence: best.confidence,
    approved: best.approved,
    freshness: f.freshness,
    ageDays: f.ageDays,
    routeRank: rank,
    routeNote,
    stock: best.stock,
    alternatives,
  };
}

/**
 * Give every product the price to quote from for this job. A product built without offers (as in
 * tests) keeps the price it was given, with its freshness filled in.
 */
export function priceCatalogue(catalogue: Catalogue, propertyType: PropertyType | null, policies: Policies, now: Date): Catalogue {
  const routes = catalogue.routes ?? [];
  return {
    ...catalogue,
    products: catalogue.products.map((p) => {
      if (p.offers) return { ...p, price: chooseOffer(p, p.offers, routes, propertyType, policies, now) } as Product;
      if (p.price) return { ...p, price: { ...p.price, ...priceFreshness(p.price.lastChecked, policies, now) } } as Product;
      return p;
    }),
  };
}
