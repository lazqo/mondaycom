/**
 * Supplier price sources. Each supplier has one way its trade prices arrive; every way ends in the
 * same place, recordSupplierPrice, so history, ex-GST normalisation and the review hold apply to
 * all of them. Imports and syncs never approve a price themselves and never touch a prepared
 * quote (quotes keep their own price snapshot).
 *
 * Available now: manual entry, CSV import, price on application. Authenticated web catalogues,
 * public-catalogue-plus-trade-login and supplier APIs have their place here for later connectors;
 * until one is written for a supplier, a sync says so instead of scraping.
 */
import { and, eq, ilike } from "drizzle-orm";
import { db } from "@/db";
import { products, supplierProducts, suppliers } from "@/db/schema";
import type { Actor } from "@/lib/guard/actor";
import { GuardrailError } from "@/lib/guard/actor";
import { recordSupplierPrice } from "../store";
import { getSupplierCredential, SUPPLIER_SYNC_PROCESS } from "./credentials";

export const PRICE_SOURCE_TYPES = ["manual", "csv", "authenticated_web", "public_plus_trade", "api", "poa"] as const;
export type PriceSourceType = (typeof PRICE_SOURCE_TYPES)[number];

export type SupplierListing = {
  supplierSku: string | null;
  manufacturer: string | null;
  model: string | null;
  costExGst: number | null;
  costIncGst: number | null;
  stock: string | null;
  sourceUrl: string | null;
  priceOnApplication: boolean;
};

export type SupplierAdapter = {
  type: PriceSourceType;
  label: string;
  description: string;
  needsCredential: boolean;
  /** A connector that can fetch listings without a person. None are written yet. */
  fetchListings?: (ctx: { supplierId: string; credential: { username: string | null; secret: string } | null; skus: string[] }) => Promise<SupplierListing[]>;
};

export const ADAPTERS: Record<PriceSourceType, SupplierAdapter> = {
  manual: { type: "manual", label: "Manual entry", description: "Prices typed in from the supplier's trade portal or price list.", needsCredential: false },
  csv: { type: "csv", label: "CSV / price-list import", description: "A price list exported from the supplier, imported in Settings.", needsCredential: false },
  authenticated_web: { type: "authenticated_web", label: "Authenticated web catalogue", description: "Trade prices behind a supplier login. Connector not written yet.", needsCredential: true },
  public_plus_trade: {
    type: "public_plus_trade",
    label: "Public catalogue + trade price",
    description: "Public product pages, trade price after login. Connector not written yet.",
    needsCredential: true,
  },
  api: { type: "api", label: "Supplier API", description: "A supplier-provided API. Connector not written yet.", needsCredential: true },
  poa: { type: "poa", label: "POA / manual enquiry", description: "Price on application: quoted by the supplier on request.", needsCredential: false },
};

// ---------- CSV ----------

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

// Retail/RRP columns are never read as cost, even if their header also says "ex GST".
const notRetail = (re: RegExp) => ({ test: (h: string) => !/\b(rrp|retail|msrp|list price)\b/i.test(h) && re.test(h) });
const HEADERS: Record<keyof SupplierListing, { test: (h: string) => boolean }> = {
  supplierSku: /^(supplier[ _-]?)?(sku|part|code|item[ _-]?code|stock[ _-]?code)$/i,
  manufacturer: /^(manufacturer|brand|make|vendor)$/i,
  model: /^(model|model[ _-]?(no|number)|part[ _-]?number|mpn)$/i,
  costExGst: notRetail(/^(cost|trade|price|buy|nett?|dealer)?[ _-]?(price[ _-]?)?(ex|excl?)[ _.-]?gst$|^cost[ _-]?ex$|^trade[ _-]?ex$/i),
  costIncGst: notRetail(/^(cost|trade|price|buy|nett?|dealer)?[ _-]?(price[ _-]?)?(inc|incl?)[ _.-]?gst$|^cost[ _-]?inc$/i),
  stock: /^(stock|availability|soh|qty|quantity)$/i,
  sourceUrl: /^(url|link|source[ _-]?url|product[ _-]?url)$/i,
  priceOnApplication: /^(poa|price[ _-]?on[ _-]?application)$/i,
};

const money = (v: string | undefined) => {
  if (!v) return null;
  if (/^poa$/i.test(v.trim())) return null;
  const n = Number(v.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Parse a supplier price list. Columns are found by header name; costs may be ex or inc GST. */
export function parseSupplierCsv(text: string): { listings: SupplierListing[]; errors: string[] } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim());
  if (lines.length < 2) return { listings: [], errors: ["The file needs a header row and at least one product row."] };
  const header = splitCsvLine(lines[0]);
  const col = Object.fromEntries((Object.keys(HEADERS) as (keyof SupplierListing)[]).map((k) => [k, header.findIndex((h) => HEADERS[k].test(h.trim()))])) as Record<keyof SupplierListing, number>;
  const errors: string[] = [];
  const retail = header.filter((h) => /\b(rrp|retail|recommended retail|list price|msrp)\b/i.test(h));
  if (retail.length && header.every((h) => !/trade|cost|buy|nett?\b|dealer|account/i.test(h)))
    errors.push(`Only trade (account) prices can be imported as cost; this file has ${retail.join(", ")} but no trade/cost column.`);
  if (col.supplierSku < 0 && col.model < 0) errors.push("No SKU or model column found.");
  if (col.costExGst < 0 && col.costIncGst < 0 && col.priceOnApplication < 0) errors.push("No cost column (ex GST or inc GST) found.");
  if (errors.length) return { listings: [], errors };
  const listings: SupplierListing[] = [];
  lines.slice(1).forEach((line, i) => {
    const c = splitCsvLine(line);
    const get = (k: keyof SupplierListing) => (col[k] >= 0 ? c[col[k]]?.trim() || null : null);
    const poaCell = get("priceOnApplication");
    const ex = money(get("costExGst") ?? undefined);
    const inc = money(get("costIncGst") ?? undefined);
    const poa = (poaCell != null && /^(y|yes|true|1|poa)$/i.test(poaCell)) || /^poa$/i.test(get("costExGst") ?? get("costIncGst") ?? "");
    if (!poa && ex == null && inc == null) {
      errors.push(`Row ${i + 2}: no cost.`);
      return;
    }
    listings.push({ supplierSku: get("supplierSku"), manufacturer: get("manufacturer"), model: get("model"), costExGst: ex, costIncGst: ex == null ? inc : null, stock: get("stock"), sourceUrl: get("sourceUrl"), priceOnApplication: poa });
  });
  return { listings, errors };
}

// ---------- import ----------

async function matchProduct(supplierId: string, l: SupplierListing): Promise<string | null> {
  if (l.supplierSku) {
    const known = await db.query.supplierProducts.findFirst({ where: and(eq(supplierProducts.supplierId, supplierId), eq(supplierProducts.supplierSku, l.supplierSku)), columns: { productId: true } });
    if (known) return known.productId;
  }
  const model = l.model ?? l.supplierSku;
  if (!model) return null;
  const rows = await db
    .select({ id: products.id, manufacturer: products.manufacturer, family: products.family })
    .from(products)
    .where(ilike(products.model, model.replace(/[%_]/g, "\\$&")));
  const want = l.manufacturer?.toLowerCase();
  const hits = want ? rows.filter((r) => r.manufacturer.toLowerCase() === want || r.family?.toLowerCase() === want) : rows;
  return hits.length === 1 ? hits[0].id : null;
}

/**
 * Record listings against catalogue products. Only products already in the catalogue are priced;
 * anything else is returned as unmatched for a person to add (the import never creates products).
 */
export async function importListings(
  supplierId: string,
  listings: SupplierListing[],
  actor: Actor,
  source: { type: PriceSourceType; label: string; confirmedTrade: boolean },
): Promise<{ recorded: number; held: number; poa: number; unmatched: string[] }> {
  if (actor.kind === "agent") throw new GuardrailError("Agents cannot import supplier prices.");
  if (!source.confirmedTrade) throw new Error("Confirm these are Get Secure trade (account) prices. Public retail pricing is never imported as cost.");
  let recorded = 0;
  let held = 0;
  let poa = 0;
  const unmatched: string[] = [];
  for (const l of listings) {
    const productId = await matchProduct(supplierId, l);
    if (!productId) {
      unmatched.push([l.manufacturer, l.model ?? l.supplierSku].filter(Boolean).join(" "));
      continue;
    }
    const r = await recordSupplierPrice(
      {
        productId,
        supplierId,
        costExGst: l.costExGst,
        costIncGst: l.costIncGst,
        supplierSku: l.supplierSku,
        sourceUrl: l.sourceUrl,
        stock: l.stock,
        priceOnApplication: l.priceOnApplication,
        priceSource: source.type,
        source: source.label,
      },
      actor,
      { bulk: true },
    );
    if (l.priceOnApplication) poa++;
    else recorded++;
    if (r.held) held++;
  }
  await db.update(suppliers).set({ lastPriceSyncAt: new Date() }).where(eq(suppliers.id, supplierId));
  return { recorded, held, poa, unmatched };
}

/** Run a supplier's automated connector, if one exists. */
export async function syncSupplierPrices(supplierId: string): Promise<{ recorded: number; held: number; poa: number; unmatched: string[] }> {
  const supplier = await db.query.suppliers.findFirst({ where: eq(suppliers.id, supplierId) });
  if (!supplier) throw new Error("Supplier not found");
  const adapter = ADAPTERS[(supplier.priceSourceType as PriceSourceType) ?? "manual"] ?? ADAPTERS.manual;
  if (!adapter.fetchListings) throw new Error(`${supplier.name}: ${adapter.label} has no automated connector yet. Enter or import prices instead.`);
  const actor: Actor = { kind: "system", process: SUPPLIER_SYNC_PROCESS };
  const credential = adapter.needsCredential ? await getSupplierCredential(supplierId, actor) : null;
  if (adapter.needsCredential && !credential) throw new Error(`${supplier.name}: no trade login stored.`);
  const skus = (await db.select({ sku: supplierProducts.supplierSku }).from(supplierProducts).where(eq(supplierProducts.supplierId, supplierId))).map((r) => r.sku).filter((s): s is string => !!s);
  const listings = await adapter.fetchListings({ supplierId, credential, skus });
  // A connector authenticates with Get Secure's trade login, so what it returns is trade pricing.
  return importListings(supplierId, listings, actor, { type: adapter.type, label: `${adapter.label} sync`, confirmedTrade: true });
}
