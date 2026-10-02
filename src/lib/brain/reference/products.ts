/**
 * The reference catalogue as engine products, without a database (ids are "Manufacturer|Model").
 * Used by tests to run the engine on the real, verified products exactly as they are seeded.
 */
import type { CompatibilityKind, CompatibilityLink, Product } from "../types";
import type { ReferenceCatalogue } from "./apply";
import reference from "./catalogue.json";

export const REFERENCE_CATALOGUE = reference as ReferenceCatalogue;

export function referenceProducts(cat: ReferenceCatalogue = REFERENCE_CATALOGUE): Product[] {
  return cat.products.map(
    (p) =>
      ({
        ...p.specs,
        id: `${p.manufacturer}|${p.model}`,
        manufacturer: p.manufacturer,
        family: p.family,
        model: p.model,
        category: p.category,
        formFactor: p.formFactor,
        residentialAllowed: p.residentialAllowed,
        commercialAllowed: p.commercialAllowed,
        tier: p.tier,
        tierStatus: p.tier ? "getsecure_provisional" : "requires_review",
        status: "manufacturer_verified",
        ecosystem: p.ecosystem,
        sourceUrl: p.sourceUrl,
        lastVerifiedAt: p.verifiedAt,
        offers: [],
        price: null,
      }) as unknown as Product,
  );
}

export function referenceLinks(cat: ReferenceCatalogue = REFERENCE_CATALOGUE): CompatibilityLink[] {
  return cat.links.map((l) => ({ kind: l.kind as CompatibilityKind, fromId: l.from, toId: l.to, quantity: l.quantity, status: "manufacturer_verified" }));
}
