/**
 * Runs a supplier's automated price connector (today: IT Plus) and keeps its status.
 *
 * Flow per run: stored encrypted login → authenticated session → for each product, the supplier's
 * logged-in product page → trade price (normalised to ex GST), SKU, stock → recordSupplierPrice,
 * which keeps price history and holds every change to an approved cost for Chris. Nothing here
 * approves a price, and nothing touches a prepared quote: quotes keep their own price snapshot.
 *
 * Credentials are read only through getSupplierCredential as the price-sync process, live only in
 * this function's memory for the run, and are redacted out of anything that is stored or shown.
 */
import { and, desc, eq, gt, inArray, isNotNull, or } from "drizzle-orm";
import { db } from "@/db";
import { products, supplierConnectors, supplierCredentials, supplierProducts, supplierSyncRuns, suppliers } from "@/db/schema";
import { type Actor, GuardrailError } from "@/lib/guard/actor";
import { recordSupplierPrice } from "../store";
import { getSupplierCredential, SUPPLIER_SYNC_PROCESS } from "./credentials";
import {
  brandWordsFor,
  findInCatalogue,
  ITPLUS_BASE_URL,
  ITPLUS_CONNECTOR,
  login,
  matchListing,
  parseProductPage,
  type CatalogueEntry,
  type ParsedProductPage,
  type PriceBasis,
  resolveBasis,
  searchTermFor,
  blockOf,
} from "./itplus";
import { ConnectorError, redact, WebSession } from "./web-session";

export type SyncScope = { kind: "test" } | { kind: "product"; productId: string } | { kind: "selected"; productIds: string[] } | { kind: "catalogue" };

export type SyncOutcome = "recorded" | "updated" | "held" | "confirmed" | "no_match" | "ambiguous" | "not_read" | "error";

export type SyncItem = {
  productId: string;
  product: string;
  sku: string | null;
  url: string | null;
  outcome: SyncOutcome;
  costExGst?: number | null;
  previousCostExGst?: number | null;
  shownAmount?: number | null;
  shownBasis?: PriceBasis | null;
  basisFrom?: string | null;
  stock?: string | null;
  priceText?: string | null;
  reason?: string | null;
  candidates?: { sku: string; name: string; url: string }[];
};

export type SyncResult = { runId: string; status: "ok" | "partial" | "failed"; error: string | null; summary: Record<string, number>; items: SyncItem[]; message: string };

const SYSTEM: Actor = { kind: "system", process: SUPPLIER_SYNC_PROCESS };
const SOURCE_LABEL = "IT Plus trade login sync";
const AUTH_CODES = new Set(["auth_failed", "locked", "account_inactive"]);
const BLOCK_CODES = new Set(["captcha", "mfa", "blocked", "rate_limited"]);
const MAX_PRODUCTS = 60;

const num = (v: string | null | undefined) => (v != null ? Number(v) : null);

/**
 * Where the connector logs in. ITPLUS_BASE_URL exists only so tests can point it at a local
 * stand-in; anything other than IT Plus itself or this machine is refused, so the stored login can
 * never be sent to another site by configuration.
 */
export function baseUrlFor(connector: string): string {
  if (connector !== ITPLUS_CONNECTOR) throw new Error(`No connector called ${connector}.`);
  const override = process.env.ITPLUS_BASE_URL;
  if (!override) return ITPLUS_BASE_URL;
  const u = new URL(override);
  const ok = (u.protocol === "https:" && u.hostname === new URL(ITPLUS_BASE_URL).hostname) || ["127.0.0.1", "localhost", "::1"].includes(u.hostname);
  if (!ok) throw new ConnectorError("config", "ITPLUS_BASE_URL may only point at www.itplus.co.nz or a local test server.");
  return u.origin;
}

export async function connectorFor(supplierId: string) {
  return (await db.query.supplierConnectors.findFirst({ where: eq(supplierConnectors.supplierId, supplierId) })) ?? null;
}

function assertPerson(actor: Actor) {
  if (actor.kind !== "human") throw new GuardrailError("Only a signed-in Get Secure user can run a supplier connector.");
}

async function setStatus(supplierId: string, patch: Partial<typeof supplierConnectors.$inferInsert>) {
  await db
    .update(supplierConnectors)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(supplierConnectors.supplierId, supplierId));
}

/**
 * A rejected login is not retried automatically while the stored login is the one that was
 * rejected (repeated failures can lock the trade account). Test connection always tries.
 */
async function loginBlockedReason(supplierId: string, conn: NonNullable<Awaited<ReturnType<typeof connectorFor>>>): Promise<string | null> {
  if (!conn.lastLoginFailedAt || !conn.lastLoginFailureCode || !AUTH_CODES.has(conn.lastLoginFailureCode)) return null;
  if (conn.lastLoginOkAt && conn.lastLoginOkAt > conn.lastLoginFailedAt) return null;
  const cred = await db.query.supplierCredentials.findFirst({ where: eq(supplierCredentials.supplierId, supplierId), columns: { updatedAt: true } });
  if (cred && cred.updatedAt > conn.lastLoginFailedAt) return null;
  return `Not retried: the last login was rejected (${conn.lastLoginFailure ?? "login failed"}) and the stored login has not changed since. Update the login, or use Test connection to try again.`;
}

type Target = { productId: string; label: string; manufacturer: string; family: string | null; model: string; offerId: string | null; sku: string | null; url: string | null; oldCost: number | null };

async function targetsFor(supplierId: string, scope: SyncScope): Promise<Target[]> {
  const offerRows = await db.select().from(supplierProducts).where(eq(supplierProducts.supplierId, supplierId));
  let productIds: string[];
  if (scope.kind === "catalogue") productIds = offerRows.filter((o) => !o.priceOnApplication && (o.supplierSku || o.sourceUrl)).map((o) => o.productId);
  else if (scope.kind === "product") productIds = [scope.productId];
  else if (scope.kind === "selected") productIds = [...new Set(scope.productIds)];
  else productIds = [];
  if (!productIds.length) return [];
  if (productIds.length > MAX_PRODUCTS) throw new ConnectorError("too_many", `At most ${MAX_PRODUCTS} products per run; ${productIds.length} were asked for.`);
  const rows = await db.select().from(products).where(inArray(products.id, productIds));
  return rows.map((p) => {
    const o = offerRows.find((x) => x.productId === p.id) ?? null;
    return {
      productId: p.id,
      label: `${p.manufacturer} ${p.model}`,
      manufacturer: p.manufacturer,
      family: p.family,
      model: p.model,
      offerId: o?.id ?? null,
      sku: o?.supplierSku ?? null,
      url: o?.sourceUrl ?? null,
      oldCost: num(o?.costExGst),
    };
  });
}

async function startRun(supplierId: string, kind: SyncScope["kind"], actor: Actor): Promise<string> {
  const running = await db.query.supplierSyncRuns.findFirst({
    where: and(eq(supplierSyncRuns.supplierId, supplierId), eq(supplierSyncRuns.status, "running"), gt(supplierSyncRuns.startedAt, new Date(Date.now() - 15 * 60_000))),
  });
  if (running) throw new ConnectorError("busy", "A price sync for this supplier is already running. Wait for it to finish.");
  const [run] = await db
    .insert(supplierSyncRuns)
    .values({ supplierId, kind, startedById: actor.kind === "human" ? actor.userId : null })
    .returning({ id: supplierSyncRuns.id });
  return run.id;
}

function summarise(items: SyncItem[]): Record<string, number> {
  const s: Record<string, number> = { checked: items.length };
  for (const i of items) s[i.outcome] = (s[i.outcome] ?? 0) + 1;
  return s;
}

/**
 * Test the stored login (and, when a mapped product exists, that a logged-in product page shows a
 * price) or refresh prices for one product, a selection, or every product with an IT Plus listing.
 */
export async function runSupplierConnector(supplierId: string, scope: SyncScope, actor: Actor): Promise<SyncResult> {
  assertPerson(actor);
  const supplier = await db.query.suppliers.findFirst({ where: eq(suppliers.id, supplierId) });
  if (!supplier) throw new Error("Supplier not found");
  const conn = await connectorFor(supplierId);
  if (!conn) throw new Error(`${supplier.name} has no automated price connector yet. Enter or import prices instead.`);
  if (scope.kind !== "test") {
    const why = await loginBlockedReason(supplierId, conn);
    if (why) throw new ConnectorError("not_retried", why);
  }
  const runId = await startRun(supplierId, scope.kind, actor);
  const items: SyncItem[] = [];
  let secrets: string[] = [];
  let session: WebSession | null = null;
  const finish = async (status: SyncResult["status"], error: string | null, message: string): Promise<SyncResult> => {
    const safeError = error ? redact(error, [...secrets, ...(session?.secrets() ?? [])]) : null;
    const safeItems = items.map((i) => (i.reason ? { ...i, reason: redact(i.reason, [...secrets, ...(session?.secrets() ?? [])]) } : i));
    const summary = summarise(safeItems);
    await db
      .update(supplierSyncRuns)
      .set({ status, error: safeError, summary, items: safeItems as unknown as Record<string, unknown>[], finishedAt: new Date() })
      .where(eq(supplierSyncRuns.id, runId));
    return { runId, status, error: safeError, summary, items: safeItems, message: redact(message, secrets) };
  };

  try {
    const credential = await getSupplierCredential(supplierId, SYSTEM);
    if (!credential) {
      await setStatus(supplierId, { status: "not_tested", statusDetail: "No trade login stored." });
      return await finish("failed", "No IT Plus trade login is stored. Store it under Suppliers first.", "No login stored.");
    }
    secrets = [credential.username ?? "", credential.secret];
    session = new WebSession(baseUrlFor(conn.connector), { delayMs: Number(process.env.SUPPLIER_SYNC_DELAY_MS ?? 800) });

    // 1. Log in.
    try {
      await login(session, credential);
    } catch (e) {
      const err = e instanceof ConnectorError ? e : new ConnectorError("error", "The IT Plus login could not be completed.");
      const reason = redact(err.message, [...secrets, ...session.secrets()]);
      await setStatus(supplierId, {
        status: BLOCK_CODES.has(err.code) ? "blocked" : AUTH_CODES.has(err.code) ? "auth_failed" : "error",
        statusDetail: reason,
        lastLoginFailedAt: new Date(),
        lastLoginFailure: reason,
        lastLoginFailureCode: err.code,
        ...(scope.kind !== "test" ? { lastSyncFailedAt: new Date(), lastSyncFailure: reason } : {}),
      });
      return await finish("failed", reason, `Login failed: ${reason}`);
    }
    await setStatus(supplierId, { status: "connected", statusDetail: "Logged in to the IT Plus trade account.", lastLoginOkAt: new Date(), lastLoginFailureCode: null });

    // 2. Work out which supplier pages to read.
    const targets = await targetsFor(supplierId, scope.kind === "test" ? { kind: "catalogue" } : scope);
    const work = scope.kind === "test" ? targets.filter((t) => t.sku || t.url).slice(0, 1) : targets;
    if (scope.kind !== "test" && !work.length) return await finish("ok", null, "Logged in. No products to refresh: none has an IT Plus listing yet. Refresh a product to find its listing.");
    const resolved = await resolveListings(session, work);

    // 3. Read each logged-in product page.
    const pages: { t: Target; entry: CatalogueEntry; page: ParsedProductPage }[] = [];
    for (const r of resolved) {
      if (!r.entry) {
        items.push({ productId: r.t.productId, product: r.t.label, sku: r.t.sku, url: r.t.url, outcome: r.candidates.length ? "ambiguous" : "no_match", reason: r.reason, candidates: r.candidates.map((c) => ({ sku: c.sku, name: c.name, url: c.url })) });
        continue;
      }
      const res = await session.request(new URL(r.entry.url).pathname + new URL(r.entry.url).search);
      const blocked = blockOf(res);
      if (blocked) throw blocked;
      const page = parseProductPage(res.html);
      if (page.loggedIn === false) throw new ConnectorError("session_lost", "IT Plus stopped treating the session as logged in part-way through (prices hidden again). Stopped; nothing more recorded.");
      if (res.status !== 200) {
        items.push({ productId: r.t.productId, product: r.t.label, sku: r.entry.sku, url: r.entry.url, outcome: "not_read", reason: `IT Plus returned HTTP ${res.status} for the product page.` });
        continue;
      }
      if (!page.sku || page.sku.trim().toLowerCase() !== r.entry.sku.trim().toLowerCase()) {
        items.push({ productId: r.t.productId, product: r.t.label, sku: r.entry.sku, url: r.entry.url, outcome: "not_read", priceText: page.priceText, reason: `The page's SKU (${page.sku ?? "none"}) is not ${r.entry.sku}; not recorded.` });
        continue;
      }
      pages.push({ t: r.t, entry: r.entry, page });
    }

    // The shop's tax display setting, if any logged-in page in this run showed it (all must agree).
    const seen = [...new Set(pages.map((p) => p.page.siteBasis).filter((b): b is PriceBasis => !!b))];
    const runBasis: PriceBasis | null = seen.length === 1 ? seen[0] : seen.length > 1 ? null : ((conn.priceBasisSeen as PriceBasis | null) ?? null);
    if (seen.length === 1 && seen[0] !== conn.priceBasisSeen) await setStatus(supplierId, { priceBasisSeen: seen[0] });

    if (scope.kind === "test") {
      const sample = pages[0];
      const basis = sample ? resolveBasis(sample.page, runBasis) : null;
      const priceNote = sample
        ? sample.page.amount != null && basis?.basis
          ? ` Prices are visible: ${sample.t.label} shows ${sample.page.priceText} (read as $${sample.page.amount.toFixed(2)} ${basis.basis} GST). Nothing was recorded.`
          : ` Logged in, but the sample product's price could not be read (${sample.page.reason ?? (basis && !basis.basis ? basis.reason : "unknown")}).`
        : " No product is mapped to IT Plus yet, so no price page was checked.";
      return await finish("ok", null, `Connection OK: logged in to the IT Plus trade account.${priceNote}`);
    }

    // 4. Record what could be read with confidence.
    for (const { t, entry, page } of pages) {
      const base = { productId: t.productId, product: t.label, sku: entry.sku, url: entry.url, stock: page.stock, priceText: page.priceText };
      if (page.amount == null) {
        items.push({ ...base, outcome: "not_read", reason: page.reason });
        continue;
      }
      const basis = resolveBasis(page, runBasis);
      if (!basis.basis) {
        items.push({ ...base, outcome: "not_read", reason: basis.reason });
        continue;
      }
      try {
        const r = await recordSupplierPrice(
          {
            productId: t.productId,
            supplierId,
            costExGst: basis.basis === "ex" ? page.amount : null,
            costIncGst: basis.basis === "inc" ? page.amount : null,
            supplierSku: entry.sku,
            sourceUrl: entry.url,
            stock: page.stock,
            source: SOURCE_LABEL,
            priceSource: "authenticated_web",
            syncRunId: runId,
          },
          SYSTEM,
          { bulk: true },
        );
        const offer = await db.query.supplierProducts.findFirst({ where: eq(supplierProducts.id, r.offerId), columns: { costExGst: true, pendingCostExGst: true } });
        const recordedEx = r.held ? num(offer?.pendingCostExGst) : num(offer?.costExGst);
        items.push({
          ...base,
          outcome: r.unchanged ? "confirmed" : r.held ? "held" : t.oldCost == null ? "recorded" : "updated",
          costExGst: recordedEx,
          previousCostExGst: t.oldCost,
          shownAmount: page.amount,
          shownBasis: basis.basis,
          basisFrom: basis.from,
        });
      } catch (e) {
        items.push({ ...base, outcome: "error", reason: e instanceof Error ? e.message : "Could not record the price." });
      }
    }

    const failed = items.filter((i) => i.outcome === "error" || i.outcome === "not_read" || i.outcome === "no_match" || i.outcome === "ambiguous").length;
    const ok = items.length - failed;
    await db.update(suppliers).set({ lastPriceSyncAt: new Date() }).where(eq(suppliers.id, supplierId));
    await setStatus(supplierId, ok ? { lastSyncOkAt: new Date() } : { lastSyncFailedAt: new Date(), lastSyncFailure: "No price could be read in the last run; see its results." });
    return await finish(failed ? (ok ? "partial" : "failed") : "ok", null, `Logged in and checked ${items.length} product(s): ${ok} priced, ${failed} need attention. New and changed prices wait for Chris's approval.`);
  } catch (e) {
    const err = e instanceof ConnectorError ? e : null;
    const reason = err ? err.message : `Unexpected error in the IT Plus connector${e instanceof Error ? `: ${e.message}` : ""}.`;
    const safe = redact(reason, [...secrets, ...(session?.secrets() ?? [])]);
    await setStatus(supplierId, {
      ...(err && BLOCK_CODES.has(err.code) ? { status: "blocked", statusDetail: safe } : { status: "error", statusDetail: safe }),
      ...(scope.kind !== "test" ? { lastSyncFailedAt: new Date(), lastSyncFailure: safe } : {}),
    });
    return await finish("failed", safe, `Stopped: ${safe}`);
  }
}

/** Find each target's IT Plus listing: by its stored SKU, else by an exact model match in the catalogue. */
async function resolveListings(session: WebSession, targets: Target[]): Promise<{ t: Target; entry: CatalogueEntry | null; candidates: CatalogueEntry[]; reason: string | null }[]> {
  const known = targets.filter((t) => t.sku).map((t) => t.sku!);
  const bySku = known.length ? await findInCatalogue(session, { skus: known }) : [];
  const out: { t: Target; entry: CatalogueEntry | null; candidates: CatalogueEntry[]; reason: string | null }[] = [];
  for (const t of targets) {
    if (t.sku) {
      const entry = bySku.find((e) => e.sku.toLowerCase() === t.sku!.toLowerCase()) ?? null;
      if (entry) out.push({ t, entry, candidates: [], reason: null });
      else out.push({ t, entry: null, candidates: [], reason: `IT Plus no longer lists SKU ${t.sku}.` });
      continue;
    }
    const words = brandWordsFor(t.manufacturer, t.family);
    const term = searchTermFor(t.model, words);
    const found = term ? await findInCatalogue(session, { search: term }) : [];
    const m = matchListing(t.model, words, found);
    if (m.match) out.push({ t, entry: m.match, candidates: [], reason: null });
    else
      out.push({
        t,
        entry: null,
        candidates: m.candidates,
        reason: m.candidates.length
          ? `IT Plus has ${m.candidates.length} listing(s) close to ${t.model} but none exactly (${m.candidates.map((c) => c.sku).join(", ")}). Choose the right one.`
          : `IT Plus does not list ${t.model} (searched "${term}").`,
      });
  }
  return out;
}

/**
 * Point a product at a specific IT Plus listing (when the match was ambiguous). Changing an
 * existing listing's SKU withdraws the approval of its old cost, which belonged to the old listing.
 */
export async function mapSupplierListing(supplierId: string, productId: string, listing: { sku: string; url: string }, actor: Actor): Promise<void> {
  assertPerson(actor);
  const conn = await connectorFor(supplierId);
  if (!conn) throw new Error("This supplier has no connector.");
  const base = new URL(baseUrlFor(conn.connector));
  const url = new URL(listing.url);
  if (url.origin !== base.origin) throw new Error("That address is not on the supplier's website.");
  const sku = listing.sku.trim();
  if (!sku || sku.length > 80) throw new Error("Enter the supplier SKU.");
  const offer = await db.query.supplierProducts.findFirst({ where: and(eq(supplierProducts.productId, productId), eq(supplierProducts.supplierId, supplierId)) });
  if (!offer) {
    await db.insert(supplierProducts).values({ productId, supplierId, supplierSku: sku, sourceUrl: url.toString(), priceSource: "authenticated_web" });
    return;
  }
  const changed = (offer.supplierSku ?? "").toLowerCase() !== sku.toLowerCase();
  await db
    .update(supplierProducts)
    .set({ supplierSku: sku, sourceUrl: url.toString(), updatedAt: new Date(), ...(changed && offer.costExGst != null ? { priceApproved: false, pendingCostExGst: null } : {}) })
    .where(eq(supplierProducts.id, offer.id));
}

/** Recent runs for the status panel (newest first). */
export async function recentRuns(supplierId: string, limit = 5) {
  return db.query.supplierSyncRuns.findMany({ where: eq(supplierSyncRuns.supplierId, supplierId), orderBy: [desc(supplierSyncRuns.startedAt)], limit });
}

/** Products that have a listing with this supplier (the "priced catalogue"). */
export async function listedProductIds(supplierId: string): Promise<string[]> {
  const rows = await db
    .select({ id: supplierProducts.productId })
    .from(supplierProducts)
    .where(and(eq(supplierProducts.supplierId, supplierId), eq(supplierProducts.priceOnApplication, false), or(isNotNull(supplierProducts.supplierSku), isNotNull(supplierProducts.sourceUrl))));
  return rows.map((r) => r.id);
}

