/**
 * The verified reference catalogue: real products whose specifications were read from the
 * manufacturer's own pages or datasheets (source URL and date on each record). No prices.
 *
 * Applied once per product: each record is added if it is not already in the catalogue, and is
 * remembered so that a product Chris deletes or edits is never re-added or overwritten. A new
 * catalogue version only adds what it has not added before.
 */
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { appSettings, productCompatibility, products } from "@/db/schema";
import reference from "./catalogue.json";

export type ReferenceProduct = {
  manufacturer: string;
  family: string;
  model: string;
  category: string;
  formFactor: string | null;
  residentialAllowed: boolean;
  commercialAllowed: boolean;
  tier: string | null;
  ecosystem: string[];
  specs: Record<string, unknown>;
  unverifiedFields: string[];
  sourceUrl: string;
  verifiedAt: string;
  notes: string | null;
};
export type ReferenceLink = { kind: string; from: string; to: string; quantity: number; sourceUrl: string | null; notes: string | null };
export type ReferenceCatalogue = { version: string; products: ReferenceProduct[]; links: ReferenceLink[] };

export const REFERENCE = reference as ReferenceCatalogue;
const KEY = "brain_reference_catalogue";
export const refKey = (p: { manufacturer: string; model: string }) => `${p.manufacturer}|${p.model}`;

let appliedVersion: string | null = null;

export async function applyReferenceCatalogue(catalogue: ReferenceCatalogue = REFERENCE): Promise<{ added: number; links: number }> {
  if (appliedVersion === catalogue.version) return { added: 0, links: 0 };
  const row = await db.query.appSettings.findFirst({ where: eq(appSettings.key, KEY) });
  const state = (row?.value as { version?: string; products?: string[]; links?: string[] } | undefined) ?? {};
  if (state.version === catalogue.version) {
    appliedVersion = catalogue.version;
    return { added: 0, links: 0 };
  }
  const doneProducts = new Set(state.products ?? []);
  const doneLinks = new Set(state.links ?? []);
  let added = 0;
  let linked = 0;

  await db.transaction(async (tx) => {
    for (const p of catalogue.products) {
      const k = refKey(p);
      if (doneProducts.has(k)) continue;
      const res = await tx
        .insert(products)
        .values({
          manufacturer: p.manufacturer,
          family: p.family,
          model: p.model,
          category: p.category,
          formFactor: p.formFactor,
          market: p.residentialAllowed && p.commercialAllowed ? "both" : p.commercialAllowed ? "commercial" : "residential",
          residentialAllowed: p.residentialAllowed,
          commercialAllowed: p.commercialAllowed,
          tier: p.tier,
          tierStatus: p.tier ? "getsecure_provisional" : "requires_review",
          ecosystem: p.ecosystem,
          specs: p.specs,
          unverifiedFields: p.unverifiedFields,
          lastVerifiedAt: new Date(p.verifiedAt),
          status: "manufacturer_verified",
          source: `Manufacturer specification, verified ${p.verifiedAt}`,
          sourceUrl: p.sourceUrl,
          notes: p.notes,
        })
        .onConflictDoNothing()
        .returning({ id: products.id });
      if (res.length) added++;
      doneProducts.add(k);
    }

    const wanted = catalogue.links.filter((l) => !doneLinks.has(`${l.kind}|${l.from}|${l.to}`));
    if (wanted.length) {
      const keys = [...new Set(wanted.flatMap((l) => [l.from, l.to]))];
      const models = [...new Set(keys.map((k) => k.split("|")[1]))];
      const rows = await tx.select({ id: products.id, manufacturer: products.manufacturer, model: products.model }).from(products).where(inArray(products.model, models));
      const idOf = new Map(rows.map((r) => [refKey(r), r.id]));
      for (const l of wanted) {
        const from = idOf.get(l.from);
        const to = idOf.get(l.to);
        // A side Chris has deleted: the relationship goes with it.
        if (from && to) {
          const res = await tx
            .insert(productCompatibility)
            .values({ kind: l.kind, fromProductId: from, toProductId: to, quantity: l.quantity, status: "manufacturer_verified", source: "Manufacturer documentation", sourceUrl: l.sourceUrl, notes: l.notes })
            .onConflictDoNothing()
            .returning({ id: productCompatibility.id });
          if (res.length) linked++;
        }
        doneLinks.add(`${l.kind}|${l.from}|${l.to}`);
      }
    }

    const value = { version: catalogue.version, products: [...doneProducts], links: [...doneLinks] };
    await tx.insert(appSettings).values({ key: KEY, value }).onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
  });
  appliedVersion = catalogue.version;
  return { added, links: linked };
}

/** For tests: forget the in-process "already applied" marker. */
export function resetReferenceMarker() {
  appliedVersion = null;
}
