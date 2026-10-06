/**
 * Runs a supplier's automated price connector (IT Plus, Clear Digital, SWL, Vesta Electrical: one
 * site module each, see sites.ts) and keeps its status.
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
import { getSupplierPricingSettings } from "@/lib/brain/supplier-settings";
import { getSupplierCredential, SUPPLIER_SYNC_PROCESS } from "./credentials";
import { brandWordsFor, matchListing, resolveBasis, searchTermFor, type CatalogueEntry, type ParsedProductPage, type PriceBasis } from "./html";
import { siteFor, type SupplierSite } from "./sites";
import { ConnectorError, redact, WebSession } from "./web-session";

export type SyncScope = { kind: "test" } | { kind: "product"; productId: string } | { kind: "selected"; productIds: string[] } | { kind: "catalogue" };

export type SyncOutcome = "recorded" | "updated" | "approved" | "held" | "confirmed" | "no_match" | "ambiguous" | "not_read" | "error";

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
  /** A sale's struck-through earlier price, when the page showed one. */
  wasAmount?: number | null;
  /** Close listings for a person to choose between (never chosen automatically). */
  candidates?: { sku: string; name: string; url: string; summary?: string | null; notes?: string | null; stock?: string | null }[];
};

export type SyncResult = { runId: string; status: "ok" | "partial" | "failed"; error: string | null; summary: Record<string, number>; items: SyncItem[]; message: string };

const SYSTEM: Actor = { kind: "system", process: SUPPLIER_SYNC_PROCESS };
const AUTH_CODES = new Set(["auth_failed", "locked", "account_inactive"]);
const BLOCK_CODES = new Set(["captcha", "mfa", "blocked", "rate_limited"]);
const MAX_PRODUCTS = 60;

const num = (v: string | null | undefined) => (v != null ? Number(v) : null);

/**
 * Where the connector logs in. Each site's environment override exists only so tests can point it
 * at a local stand-in; anything other than the supplier's own host or this machine is refused, so
 * the stored login can never be sent to another site by configuration.
 */
export function baseUrlFor(connector: string): string {
  const site = siteFor(connector);
  const override = process.env[site.envVar];
  if (!override) return site.baseUrl;
  const u = new URL(override);
  const ok = (u.protocol === "https:" && u.hostname === new URL(site.baseUrl).hostname) || ["127.0.0.1", "localhost", "::1"].includes(u.hostname);
  if (!ok) throw new ConnectorError("config", `${site.envVar} may only point at ${new URL(site.baseUrl).hostname} or a local test server.`);
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
 * price) or refresh prices for one product, a selection, or every product with a listing at the supplier.
 */
export async function runSupplierConnector(supplierId: string, scope: SyncScope, actor: Actor): Promise<SyncResult> {
  assertPerson(actor);
  const supplier = await db.query.suppliers.findFirst({ where: eq(suppliers.id, supplierId) });
  if (!supplier) throw new Error("Supplier not found");
  const conn = await connectorFor(supplierId);
  if (!conn) throw new Error(`${supplier.name} has no automated price connector yet. Enter or import prices instead.`);
  const site = siteFor(conn.connector);
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
      return await finish("failed", `No ${site.name} trade login is stored. Store it under Suppliers first.`, "No login stored.");
    }
    secrets = [credential.username ?? "", credential.secret];
    session = new WebSession(baseUrlFor(conn.connector), { delayMs: Number(process.env.SUPPLIER_SYNC_DELAY_MS ?? 800) });

    // 1. Log in.
    try {
      await site.login(session, credential);
    } catch (e) {
      const err = e instanceof ConnectorError ? e : new ConnectorError("error", `The ${site.name} login could not be completed.`);
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
    await setStatus(supplierId, { status: "connected", statusDetail: `Logged in to the ${site.name} trade account.`, lastLoginOkAt: new Date(), lastLoginFailureCode: null });

    // 2. Work out which supplier pages to read.
    const targets = await targetsFor(supplierId, scope.kind === "test" ? { kind: "catalogue" } : scope);
    const work = scope.kind === "test" ? targets.filter((t) => t.sku || t.url).slice(0, 1) : targets;
    if (scope.kind !== "test" && !work.length) return await finish("ok", null, `Logged in. No products to refresh: none has a ${site.name} listing yet. Refresh a product to find its listing.`);
    const resolved = await resolveListings(site, session, work);

    // 3. Read each logged-in product page.
    const pages: { t: Target; entry: CatalogueEntry; page: ParsedProductPage }[] = [];
    for (const r of resolved) {
      if (!r.entry) {
        items.push({ productId: r.t.productId, product: r.t.label, sku: r.t.sku, url: r.t.url, outcome: r.candidates.length ? "ambiguous" : "no_match", reason: r.reason, candidates: r.candidates.map((c) => ({ sku: c.sku, name: c.name, url: c.url, summary: c.summary ?? null, notes: c.notes ?? null, stock: c.stock ?? null })) });
        continue;
      }
      const res = await session.request(new URL(r.entry.url).pathname + new URL(r.entry.url).search);
      const blocked = site.blockOf(res);
      if (blocked) throw blocked;
      const page = site.parseProductPage(res.html);
      if (page.loggedIn === false) throw new ConnectorError("session_lost", `${site.name} stopped treating the session as logged in part-way through (prices hidden again). Stopped; nothing more recorded.`);
      if (res.status !== 200) {
        items.push({ productId: r.t.productId, product: r.t.label, sku: r.entry.sku, url: r.entry.url, outcome: "not_read", reason: `${site.name} returned HTTP ${res.status} for the product page.` });
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
        : ` No product is mapped to ${site.name} yet, so no price page was checked.`;
      return await finish("ok", null, `Connection OK: logged in to the ${site.name} trade account.${priceNote}`);
    }

    // 4. Record what could be read with confidence.
    const pricing = await getSupplierPricingSettings();
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
            source: `${site.name} trade login sync`,
            priceSource: "authenticated_web",
            syncRunId: runId,
          },
          SYSTEM,
          { bulk: true, autoApprove: pricing.autoApprove, jumpPct: pricing.jumpPct },
        );
        const offer = await db.query.supplierProducts.findFirst({ where: eq(supplierProducts.id, r.offerId), columns: { costExGst: true, pendingCostExGst: true } });
        const recordedEx = r.held ? num(offer?.pendingCostExGst) : num(offer?.costExGst);
        items.push({
          ...base,
          outcome: r.unchanged ? "confirmed" : r.held ? "held" : t.oldCost == null ? "recorded" : r.autoApproved ? "approved" : "updated",
          costExGst: recordedEx,
          previousCostExGst: t.oldCost,
          shownAmount: page.amount,
          shownBasis: basis.basis,
          basisFrom: basis.from,
          wasAmount: page.wasAmount,
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
    const reason = err ? err.message : `Unexpected error in the ${conn ? siteFor(conn.connector).name : "supplier"} connector${e instanceof Error ? `: ${e.message}` : ""}.`;
    const safe = redact(reason, [...secrets, ...(session?.secrets() ?? [])]);
    await setStatus(supplierId, {
      ...(err && BLOCK_CODES.has(err.code) ? { status: "blocked", statusDetail: safe } : { status: "error", statusDetail: safe }),
      ...(scope.kind !== "test" ? { lastSyncFailedAt: new Date(), lastSyncFailure: safe } : {}),
    });
    return await finish("failed", safe, `Stopped: ${safe}`);
  }
}

/** Find each target's listing at the supplier: by its stored SKU, else by an exact model match in the catalogue. */
async function resolveListings(site: SupplierSite, session: WebSession, targets: Target[]): Promise<{ t: Target; entry: CatalogueEntry | null; candidates: CatalogueEntry[]; reason: string | null }[]> {
  const known = targets.filter((t) => t.sku).map((t) => t.sku!);
  const bySku = known.length ? await site.findInCatalogue(session, { skus: known }) : [];
  const out: { t: Target; entry: CatalogueEntry | null; candidates: CatalogueEntry[]; reason: string | null }[] = [];
  for (const t of targets) {
    if (t.sku) {
      const entry = bySku.find((e) => e.sku.toLowerCase() === t.sku!.toLowerCase()) ?? null;
      if (entry) out.push({ t, entry, candidates: [], reason: null });
      else out.push({ t, entry: null, candidates: [], reason: `${site.name} no longer lists SKU ${t.sku}.` });
      continue;
    }
    const words = brandWordsFor(t.manufacturer, t.family);
    const term = searchTermFor(t.model, words);
    const found = term ? await site.findInCatalogue(session, { search: term }) : [];
    const m = matchListing(t.model, words, found);
    if (m.match) out.push({ t, entry: m.match, candidates: [], reason: null });
    else
      out.push({
        t,
        entry: null,
        candidates: m.candidates,
        reason: m.candidates.length
          ? `${site.name} has ${m.candidates.length} listing(s) close to ${t.model} but none exactly (${m.candidates.map((c) => c.sku).join(", ")}). Nothing is chosen automatically: choose the listing Get Secure buys.`
          : `${site.name} does not list ${t.model} (searched "${term}").`,
      });
  }
  return out;
}

/**
 * Point a product at a specific supplier listing (when the match was ambiguous). Changing an
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


export type LiveLookup =
  | { ok: true; supplier: string; entries: { sku: string; name: string; url: string; summary: string | null; stock: string | null }[]; page?: { sku: string | null; title: string | null; stock: string | null; priceText: string | null; amount: number | null; basis: PriceBasis | null; wasAmount: number | null } | null; note: string }
  | { ok: false; supplier: string; stopped: boolean; reason: string };

/**
 * A live, read-only look at a supplier's logged-in catalogue (search, or one product page with its
 * trade price and stock) for Hermes's research. The stored login is used here, server-side only;
 * nothing returned contains it. Nothing is recorded: no price, no listing, no cost. A CAPTCHA, MFA
 * or block stops it and is reported; a rejected login is not retried.
 */
export async function liveSupplierLookup(supplierId: string, q: { search?: string; sku?: string }): Promise<LiveLookup> {
  const supplier = await db.query.suppliers.findFirst({ where: eq(suppliers.id, supplierId) });
  if (!supplier) return { ok: false, supplier: "unknown", stopped: false, reason: "Supplier not found." };
  const conn = await connectorFor(supplierId);
  if (!conn) return { ok: false, supplier: supplier.name, stopped: false, reason: `${supplier.name} has no logged-in connector: only the CRM's stored catalogue and prices are available.` };
  const why = await loginBlockedReason(supplierId, conn);
  if (why) return { ok: false, supplier: supplier.name, stopped: true, reason: why };
  let secrets: string[] = [];
  let session: WebSession | null = null;
  try {
    const credential = await getSupplierCredential(supplierId, SYSTEM);
    if (!credential) return { ok: false, supplier: supplier.name, stopped: false, reason: "No trade login is stored for this supplier." };
    secrets = [credential.username ?? "", credential.secret];
    const site = siteFor(conn.connector);
    session = new WebSession(baseUrlFor(conn.connector), { delayMs: Number(process.env.SUPPLIER_SYNC_DELAY_MS ?? 800) });
    try {
      await site.login(session, credential);
    } catch (e) {
      const err = e instanceof ConnectorError ? e : new ConnectorError("error", "The login could not be completed.");
      const reason = redact(err.message, [...secrets, ...session.secrets()]);
      await setStatus(supplierId, { status: BLOCK_CODES.has(err.code) ? "blocked" : AUTH_CODES.has(err.code) ? "auth_failed" : "error", statusDetail: reason, lastLoginFailedAt: new Date(), lastLoginFailure: reason, lastLoginFailureCode: err.code });
      return { ok: false, supplier: supplier.name, stopped: BLOCK_CODES.has(err.code), reason };
    }
    const entries = await site.findInCatalogue(session, q.sku ? { skus: [q.sku] } : { search: q.search ?? "" });
    const list = entries.slice(0, 15).map((e) => ({ sku: e.sku, name: e.name, url: e.url, summary: e.summary ?? null, stock: e.stock ?? null }));
    if (!q.sku) return { ok: true, supplier: supplier.name, entries: list, note: "Live search of the logged-in catalogue. Nothing was recorded." };
    const entry = entries.find((e) => e.sku.toLowerCase() === q.sku!.toLowerCase());
    if (!entry) return { ok: true, supplier: supplier.name, entries: list, page: null, note: `No listing with SKU ${q.sku}.` };
    const res = await session.request(new URL(entry.url).pathname + new URL(entry.url).search);
    const blocked = site.blockOf(res);
    if (blocked) throw blocked;
    const page = site.parseProductPage(res.html);
    const basis = resolveBasis(page, null);
    return {
      ok: true,
      supplier: supplier.name,
      entries: list,
      page: { sku: page.sku, title: page.title, stock: page.stock, priceText: page.priceText, amount: page.amount, basis: basis.basis, wasAmount: page.wasAmount },
      note: "Live logged-in trade price, as evidence only: it is not recorded as a cost. To record it, refresh the product under Suppliers (changes wait for Chris's approval).",
    };
  } catch (e) {
    const err = e instanceof ConnectorError ? e : null;
    const reason = redact(err ? err.message : `The lookup failed${e instanceof Error ? `: ${e.message}` : ""}.`, [...secrets, ...(session?.secrets() ?? [])]);
    if (err && BLOCK_CODES.has(err.code)) await setStatus(supplierId, { status: "blocked", statusDetail: reason });
    return { ok: false, supplier: supplier.name, stopped: !!err && BLOCK_CODES.has(err.code), reason };
  }
}
