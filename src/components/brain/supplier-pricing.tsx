"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { approvePriceAction } from "@/actions/catalogue";
import {
  mapSupplierListingAction,
  refreshSupplierCatalogueAction,
  refreshSupplierProductAction,
  refreshSupplierSelectedAction,
  testSupplierConnectionAction,
} from "@/actions/supplier-connector";
import { Badge, Button, Card, CardHeader, FormError, Select } from "@/components/ui";
import type { PriceFreshness } from "@/lib/brain/types";
import type { SyncItem, SyncResult } from "@/lib/brain/suppliers/connector";

export type ConnectorView = {
  supplierId: string;
  supplier: string;
  connector: string;
  status: string;
  statusDetail: string | null;
  hasLogin: boolean;
  loginUpdatedAt: string | null;
  lastLoginOkAt: string | null;
  lastLoginFailedAt: string | null;
  lastLoginFailure: string | null;
  lastSyncOkAt: string | null;
  lastSyncFailedAt: string | null;
  lastSyncFailure: string | null;
  priceBasisSeen: string | null;
  runs: { id: string; kind: string; status: string; startedAt: string; startedBy: string | null; summary: Record<string, number>; error: string | null; items: SyncItem[] }[];
  listings: ListingView[];
  /** Catalogue products without a listing at this supplier, for "refresh one" to find. */
  unlisted: { id: string; label: string; category: string }[];
};

export type ListingView = {
  offerId: string;
  productId: string;
  product: string;
  category: string;
  sku: string | null;
  url: string | null;
  costExGst: number | null;
  pendingCostExGst: number | null;
  approved: boolean;
  freshness: PriceFreshness;
  lastChecked: string | null;
  stock: string | null;
  priceSource: string | null;
  history: { at: string; oldCostExGst: number | null; newCostExGst: number; changedPct: number | null; source: string; priceSource: string | null; stock: string | null; review: string; reviewedBy: string | null }[];
};

const STATUS: Record<string, [string, string]> = {
  connected: ["Connected", "bg-green-100 text-green-800"],
  not_tested: ["Not tested", "bg-gray-100 text-gray-700"],
  auth_failed: ["Login rejected", "bg-red-100 text-red-800"],
  blocked: ["Stopped: security check", "bg-red-100 text-red-800"],
  error: ["Error", "bg-red-100 text-red-800"],
};

const OUTCOME: Record<string, [string, string]> = {
  recorded: ["New price · awaiting approval", "bg-amber-100 text-amber-800"],
  updated: ["Price updated · awaiting approval", "bg-amber-100 text-amber-800"],
  held: ["Change held for review", "bg-amber-100 text-amber-800"],
  confirmed: ["Unchanged · re-checked", "bg-green-100 text-green-800"],
  no_match: ["Not listed at supplier", "bg-gray-200 text-gray-700"],
  ambiguous: ["Choose listing", "bg-sky-100 text-sky-800"],
  not_read: ["Not recorded", "bg-red-100 text-red-800"],
  error: ["Error", "bg-red-100 text-red-800"],
};

const FRESH: Record<PriceFreshness, string> = { current: "bg-green-100 text-green-800", aging: "bg-amber-100 text-amber-800", stale: "bg-red-100 text-red-800", unknown: "bg-gray-200 text-gray-700" };

const money = (n: number | null | undefined) => (n == null ? "—" : `$${n.toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

function RunResult({ supplierId, result, canMap }: { supplierId: string; result: { status: string; message?: string; error: string | null; items: SyncItem[] }; canMap: boolean }) {
  const router = useRouter();
  const [pending, start] = React.useTransition();
  const [err, setErr] = React.useState<string | null>(null);
  return (
    <div className="space-y-2" data-testid="sync-result">
      {result.message ? <p className={result.status === "failed" ? "text-sm text-red-700" : "text-sm text-gray-800"}>{result.message}</p> : null}
      {result.error && result.message !== `Stopped: ${result.error}` && !result.message?.includes(result.error) ? <p className="text-sm text-red-700">{result.error}</p> : null}
      {result.items.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-gray-500">
              <tr>
                <th className="py-1 pr-2">Product</th>
                <th className="py-1 pr-2">IT Plus SKU</th>
                <th className="py-1 pr-2">Result</th>
                <th className="py-1 pr-2">Shown (logged in)</th>
                <th className="py-1 pr-2 text-right">Cost ex GST</th>
                <th className="py-1 pr-2">Stock</th>
              </tr>
            </thead>
            <tbody>
              {result.items.map((i) => (
                <tr key={i.productId} className="border-t border-gray-100 align-top" data-testid="sync-item">
                  <td className="py-1 pr-2 font-medium">{i.product}</td>
                  <td className="py-1 pr-2">{i.url && i.sku ? <a className="text-brand-700 underline" href={i.url} target="_blank" rel="noreferrer">{i.sku}</a> : (i.sku ?? "—")}</td>
                  <td className="py-1 pr-2">
                    <Badge className={OUTCOME[i.outcome]?.[1]}>{OUTCOME[i.outcome]?.[0] ?? i.outcome}</Badge>
                    {i.reason ? <p className="mt-0.5 max-w-md text-gray-600">{i.reason}</p> : null}
                    {i.candidates?.length && canMap ? (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {i.candidates.map((c) => (
                          <Button
                            key={c.sku}
                            size="sm"
                            variant="secondary"
                            disabled={pending}
                            title={c.name}
                            onClick={() =>
                              start(async () => {
                                setErr(null);
                                const r = await mapSupplierListingAction(supplierId, i.productId, c.sku, c.url);
                                if (!r.ok) return setErr(r.error);
                                router.refresh();
                              })
                            }
                          >
                            Use {c.sku}
                          </Button>
                        ))}
                      </div>
                    ) : null}
                  </td>
                  <td className="py-1 pr-2 text-gray-700">
                    {i.priceText ?? "—"}
                    {i.shownBasis ? <span className="block text-gray-500">read as {i.shownBasis} GST ({i.basisFrom})</span> : null}
                  </td>
                  <td className="py-1 pr-2 text-right">
                    {i.costExGst != null ? money(i.costExGst) : "—"}
                    {i.previousCostExGst != null && i.outcome !== "confirmed" ? <span className="block text-gray-500">was {money(i.previousCostExGst)}</span> : null}
                  </td>
                  <td className="py-1 pr-2 text-gray-700">{i.stock ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <FormError message={err} />
    </div>
  );
}

function ConnectorCard({ c, canApprove }: { c: ConnectorView; canApprove: boolean }) {
  const router = useRouter();
  const [pending, start] = React.useTransition();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<SyncResult | null>(null);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [pick, setPick] = React.useState("");
  const [openHistory, setOpenHistory] = React.useState<string | null>(null);
  const [st, cls] = STATUS[c.status] ?? [c.status, "bg-gray-100 text-gray-700"];

  const go = (label: string, fn: () => Promise<{ ok: true; data: SyncResult } | { ok: false; error: string }>) =>
    start(async () => {
      setBusy(label);
      setError(null);
      setResult(null);
      const r = await fn();
      setBusy(null);
      if (!r.ok) return setError(r.error);
      setResult(r.data);
      setSelected(new Set());
      router.refresh();
    });
  const approve = (offerId: string) =>
    start(async () => {
      setError(null);
      const r = await approvePriceAction(offerId);
      if (!r.ok) return setError(r.error);
      router.refresh();
    });
  const toggle = (id: string) =>
    setSelected((cur) => {
      const n = new Set(cur);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const last = c.runs[0];

  return (
    <Card data-testid="supplier-connector">
      <CardHeader title={`${c.supplier} · trade login connector`} action={<Badge className={cls} data-testid="connector-status">{st}</Badge>} />
      <div className="space-y-4 p-4 text-sm">
        {c.statusDetail ? <p className="text-gray-700">{c.statusDetail}</p> : null}
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2" data-testid="connector-facts">
          <div className="flex gap-2">
            <dt className="w-44 text-gray-500">Trade login</dt>
            <dd>{c.hasLogin ? `Stored, encrypted${c.loginUpdatedAt ? ` (updated ${c.loginUpdatedAt})` : ""}` : "Not stored — add it under Suppliers & routing"}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-44 text-gray-500">Prices shown by supplier</dt>
            <dd>{c.priceBasisSeen ? `${c.priceBasisSeen} GST (seen on logged-in pages)` : "not seen yet"}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-44 text-gray-500">Last successful login</dt>
            <dd data-testid="last-login-ok">{c.lastLoginOkAt ?? "never"}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-44 text-gray-500">Last failed login</dt>
            <dd data-testid="last-login-failed">
              {c.lastLoginFailedAt ?? "never"}
              {c.lastLoginFailedAt && c.lastLoginFailure ? <span className="block text-red-700">{c.lastLoginFailure}</span> : null}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-44 text-gray-500">Last successful price sync</dt>
            <dd data-testid="last-sync-ok">{c.lastSyncOkAt ?? "never"}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-44 text-gray-500">Last failed price sync</dt>
            <dd>
              {c.lastSyncFailedAt ?? "never"}
              {c.lastSyncFailedAt && c.lastSyncFailure ? <span className="block text-red-700">{c.lastSyncFailure}</span> : null}
            </dd>
          </div>
        </dl>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" disabled={pending || !c.hasLogin} onClick={() => go("test", () => testSupplierConnectionAction(c.supplierId))} data-testid="test-connection">
            {busy === "test" ? "Testing…" : "Test connection"}
          </Button>
          <Button size="sm" variant="secondary" disabled={pending || !c.hasLogin || !c.listings.length} onClick={() => go("catalogue", () => refreshSupplierCatalogueAction(c.supplierId))} data-testid="refresh-catalogue">
            {busy === "catalogue" ? "Refreshing…" : `Refresh ${c.supplier} priced catalogue (${c.listings.length})`}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={pending || !c.hasLogin || selected.size === 0}
            onClick={() => go("selected", () => refreshSupplierSelectedAction(c.supplierId, [...selected]))}
            data-testid="refresh-selected"
          >
            {busy === "selected" ? "Refreshing…" : `Refresh selected (${selected.size})`}
          </Button>
          <span className="text-xs text-gray-500">Logs in with the stored login. New or changed prices wait for {canApprove ? "your" : "Chris's"} approval; prepared quotes are never changed.</span>
        </div>
        <FormError message={error} />
        {result ? <RunResult supplierId={c.supplierId} result={result} canMap /> : null}

        <div>
          <p className="mb-1 text-xs font-semibold text-gray-700">Products with an {c.supplier} listing</p>
          {c.listings.length === 0 ? <p className="text-xs text-gray-500">None yet. Refresh a product below to find its {c.supplier} listing.</p> : null}
          {c.listings.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs" data-testid="connector-listings">
                <thead className="text-gray-500">
                  <tr>
                    <th className="py-1 pr-2" />
                    <th className="py-1 pr-2">Product</th>
                    <th className="py-1 pr-2">SKU</th>
                    <th className="py-1 pr-2 text-right">Cost ex GST</th>
                    <th className="py-1 pr-2">Review</th>
                    <th className="py-1 pr-2">Freshness</th>
                    <th className="py-1 pr-2">Stock</th>
                    <th className="py-1 pr-2" />
                  </tr>
                </thead>
                <tbody>
                  {c.listings.map((l) => (
                    <React.Fragment key={l.offerId}>
                      <tr className="border-t border-gray-100 align-top" data-testid="connector-listing">
                        <td className="py-1 pr-2">
                          <input type="checkbox" aria-label={`Select ${l.product}`} checked={selected.has(l.productId)} onChange={() => toggle(l.productId)} />
                        </td>
                        <td className="py-1 pr-2 font-medium">
                          {l.product} <span className="font-normal text-gray-500">{l.category}</span>
                        </td>
                        <td className="py-1 pr-2">{l.url && l.sku ? <a className="text-brand-700 underline" href={l.url} target="_blank" rel="noreferrer">{l.sku}</a> : (l.sku ?? "—")}</td>
                        <td className="py-1 pr-2 text-right">
                          {money(l.costExGst)}
                          {l.pendingCostExGst != null ? <span className="block text-amber-700">pending {money(l.pendingCostExGst)}</span> : null}
                        </td>
                        <td className="py-1 pr-2">
                          {l.costExGst == null && l.pendingCostExGst == null ? (
                            <span className="text-gray-500">no price yet</span>
                          ) : (
                            <Badge className={l.approved && l.pendingCostExGst == null ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800"}>
                              {l.approved ? (l.pendingCostExGst != null ? "approved · change pending" : "approved") : "awaiting approval"}
                            </Badge>
                          )}
                        </td>
                        <td className="py-1 pr-2">
                          {l.costExGst != null ? <Badge className={FRESH[l.freshness]}>{l.freshness}</Badge> : null}
                          {l.lastChecked ? <span className="block text-gray-500">checked {l.lastChecked}</span> : null}
                        </td>
                        <td className="py-1 pr-2 text-gray-700">{l.stock ?? "—"}</td>
                        <td className="whitespace-nowrap py-1 pr-2 text-right">
                          <Button size="sm" variant="ghost" disabled={pending || !c.hasLogin} onClick={() => go(`p-${l.productId}`, () => refreshSupplierProductAction(c.supplierId, l.productId))}>
                            {busy === `p-${l.productId}` ? "Refreshing…" : "Refresh"}
                          </Button>
                          {canApprove && (l.pendingCostExGst != null || (!l.approved && l.costExGst != null)) ? (
                            <Button size="sm" variant="secondary" disabled={pending} onClick={() => approve(l.offerId)} data-testid="approve-listing-price">
                              Approve {money(l.pendingCostExGst ?? l.costExGst)}
                            </Button>
                          ) : null}
                          <Button size="sm" variant="ghost" onClick={() => setOpenHistory((x) => (x === l.offerId ? null : l.offerId))}>
                            History ({l.history.length})
                          </Button>
                        </td>
                      </tr>
                      {openHistory === l.offerId ? (
                        <tr>
                          <td />
                          <td colSpan={7} className="pb-2">
                            {l.history.length === 0 ? <p className="text-gray-500">No price recorded yet.</p> : null}
                            {l.history.map((h, n) => (
                              <p key={n} className="text-gray-700" data-testid="price-history-row">
                                {h.at}: {h.oldCostExGst != null ? `${money(h.oldCostExGst)} → ` : ""}
                                {money(h.newCostExGst)}
                                {h.changedPct != null ? ` (${h.changedPct > 0 ? "+" : ""}${h.changedPct}%)` : ""} · {h.source}
                                {h.stock ? ` · stock ${h.stock}` : ""} · {h.review === "approved" ? `approved${h.reviewedBy ? ` by ${h.reviewedBy}` : ""}` : h.review.replace("_", " ")}
                              </p>
                            ))}
                          </td>
                        </tr>
                      ) : null}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3">
          <span className="text-xs text-gray-600">Find and price another product at {c.supplier}:</span>
          <Select value={pick} onChange={(e) => setPick(e.target.value)} className="h-8 w-80 text-xs" aria-label="Product to refresh">
            <option value="">Choose product…</option>
            {c.unlisted.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label} ({p.category})
              </option>
            ))}
          </Select>
          <Button size="sm" variant="secondary" disabled={pending || !pick || !c.hasLogin} onClick={() => go("pick", () => refreshSupplierProductAction(c.supplierId, pick))} data-testid="refresh-one">
            {busy === "pick" ? "Refreshing…" : "Refresh one product"}
          </Button>
        </div>

        {c.runs.length ? (
          <div className="border-t border-gray-100 pt-3" data-testid="connector-runs">
            <p className="mb-1 text-xs font-semibold text-gray-700">Recent runs</p>
            {c.runs.map((r) => (
              <p key={r.id} className="text-xs text-gray-700">
                {r.startedAt} · {r.kind === "test" ? "test connection" : r.kind === "catalogue" ? "priced catalogue" : r.kind === "selected" ? "selected products" : "one product"} ·{" "}
                <span className={r.status === "failed" ? "text-red-700" : r.status === "partial" ? "text-amber-700" : "text-green-700"}>{r.status}</span>
                {r.startedBy ? ` · by ${r.startedBy}` : ""}
                {r.kind !== "test" && r.summary.checked != null
                  ? ` · ${Object.entries(r.summary)
                      .filter(([k]) => k !== "checked")
                      .map(([k, v]) => `${v} ${OUTCOME[k]?.[0].toLowerCase() ?? k}`)
                      .join(", ")}`
                  : ""}
                {r.error ? <span className="block text-red-700">{r.error}</span> : null}
              </p>
            ))}
            {!result && last && last.items.length ? (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-gray-600">Results of the last run</summary>
                <RunResult supplierId={c.supplierId} result={{ status: last.status, error: null, items: last.items }} canMap />
              </details>
            ) : null}
          </div>
        ) : null}
      </div>
    </Card>
  );
}

export function SupplierPricing({ connectors, canApprove }: { connectors: ConnectorView[]; canApprove: boolean }) {
  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-600">
        Trade prices read from suppliers&apos; logged-in websites using the encrypted login stored under Suppliers &amp; routing. The login, passwords and session cookies are
        never shown here, logged, or given to any agent. Only the price on a logged-in product page is used as cost — never a public or RRP price — and anything the connector
        can&apos;t read with confidence is reported, not recorded. Prices are stored ex GST.
      </p>
      {connectors.length === 0 ? <p className="text-sm text-gray-500">No supplier has an automated connector yet.</p> : null}
      {connectors.map((c) => (
        <ConnectorCard key={c.supplierId} c={c} canApprove={canApprove} />
      ))}
    </div>
  );
}
