import type { Metadata } from "next";
import Link from "next/link";
import { desc, inArray, ne } from "drizzle-orm";
import { db } from "@/db";
import { cctvKits, packageCandidates, products } from "@/db/schema";
import { requireAdmin } from "@/lib/auth";
import { Badge, Card, CardHeader, EmptyState } from "@/components/ui";
import { DetectPatternsButton, PackageDecision, type ProductOption } from "@/components/brain/package-panel";
import { formatDateTime } from "@/lib/utils";

export const metadata: Metadata = { title: "Proposed packages" };

type Route = { role: string; product: string; quantity: number; preferred: { supplier: string; sku: string | null; tradeCostExGst: number | null; priceDate: string | null; stock: string | null } | null; offers: { supplier: string; approved: boolean }[] };
type Costs = { hardwareTradeExGst: number | null; hardwareSellExGst?: number; hardwareMarginExGst?: number; markupPct: number; unknown: string[]; note: string };
type CompatCheck = { name: string; pass: boolean; detail: string; warning?: boolean };
type Evidence = { supplierRoute?: Route[]; costs?: Costs; compatibility?: CompatCheck[]; labour?: { key: string | null; name: string | null; status: string | null; estimatedHours: number | null; allowanceSet: boolean; note?: string }; quotes?: { number: number; status: string }[]; jobs?: { number: number; status: string }[]; sources?: { url: string; title?: string | null }[]; labourNote?: string | null; checkedAt?: string; edited?: boolean };

const TONE: Record<string, string> = { candidate: "bg-[#ffcb00] text-gray-900", approved: "bg-[#00c875] text-white", rejected: "bg-gray-200 text-gray-600", superseded: "bg-gray-200 text-gray-600" };
const KIND: Record<string, string> = { new: "New package", variant: "Variant", update: "Change to an approved kit", retire: "Retire a kit" };
const money = (n: number | null | undefined) => (n == null ? "unknown" : `$${n.toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

/**
 * Packages Hermes designed (or the CRM found Get Secure keeps quoting), waiting for Chris. A
 * candidate is never used for quoting: only an approved kit is selected by the Business Brain.
 */
export default async function PackagesPage() {
  const user = await requireAdmin();
  const rows = await db.select().from(packageCandidates).where(ne(packageCandidates.status, "superseded")).orderBy(desc(packageCandidates.createdAt)).limit(60);
  const open = rows.filter((r) => r.status === "candidate");
  const decided = rows.filter((r) => r.status !== "candidate").slice(0, 20);
  const kitIds = [...new Set(rows.map((r) => r.targetKitId).filter((x): x is string => !!x))];
  const kits = kitIds.length ? await db.select({ id: cctvKits.id, name: cctvKits.name }).from(cctvKits).where(inArray(cctvKits.id, kitIds)) : [];
  const catalogue = await db.select({ id: products.id, manufacturer: products.manufacturer, model: products.model, category: products.category, status: products.status }).from(products).where(ne(products.status, "deprecated")).orderBy(products.category, products.manufacturer, products.model);
  const options: ProductOption[] = catalogue.map((p) => ({ id: p.id, label: `${p.manufacturer} ${p.model} (${p.category})`, category: p.category }));

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm">
          <Link href="/settings/brain" className="text-brand-700 hover:underline">
            ← Business Brain
          </Link>
        </p>
        <h1 className="text-xl font-semibold text-gray-900">Proposed packages</h1>
        <p className="text-sm text-gray-600">
          CCTV packages Hermes designed, changes it proposes to approved kits, and configurations the CRM noticed Get Secure keeps quoting. The CRM attaches the evidence itself: supplier route, approved trade costs with their dates,
          compatibility, the labour basis, and the quotes and jobs behind it. A candidate is never used for quoting. Only when {user.canApprove ? "you approve it" : "Chris approves it"} does it become an approved kit the Business Brain can select.
          Markup, labour rules and prices are not changed here.
        </p>
      </div>

      <Card data-testid="package-candidates">
        <CardHeader title={`Waiting for a decision (${open.length})`} action={<DetectPatternsButton />} />
        {open.length === 0 ? <EmptyState title="Nothing waiting" hint="When Hermes designs a package, or the same configuration keeps being quoted with no approved kit, it is proposed here." /> : null}
        <div className="divide-y divide-gray-100">
          {[...open, ...decided].map((c) => {
            const ev = (c.evidence ?? {}) as Evidence;
            const target = kits.find((k) => k.id === c.targetKitId);
            return (
              <div key={c.id} className="space-y-2 px-4 py-3 text-sm" data-testid="package-candidate">
                <p className="flex flex-wrap items-center gap-2">
                  <Badge className={TONE[c.status] ?? "bg-gray-200 text-gray-700"}>{c.status}</Badge>
                  <Badge className="bg-brand-100 text-brand-800">{KIND[c.kind] ?? c.kind}</Badge>
                  <span className="font-medium text-gray-900">{c.name}</span>
                  {target ? <span className="text-gray-500">→ {target.name}</span> : null}
                  <span className="text-xs text-gray-500">
                    {[c.propertyType, c.tier, c.cameraCount ? `${c.cameraCount} cameras` : null, c.storeyType ? `${c.storeyType} storey` : null].filter(Boolean).join(" · ")} · proposed by {c.proposedBy === "crm:pattern" ? "the CRM (repeated configuration)" : "Hermes"} ·{" "}
                    {formatDateTime(c.createdAt)}
                    {c.confidence ? ` · confidence ${Math.round(Number(c.confidence) * 100)}%` : ""}
                  </span>
                </p>
                {c.segment ? <p className="text-xs text-gray-600">For: {c.segment}</p> : null}
                {c.reasoning ? <p className="text-gray-700">{c.reasoning}</p> : null}
                {ev.supplierRoute?.length ? (
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-gray-500">
                        <th className="py-0.5 pr-2 font-medium">Item</th>
                        <th className="py-0.5 pr-2 font-medium">Qty</th>
                        <th className="py-0.5 pr-2 font-medium">Preferred supplier</th>
                        <th className="py-0.5 pr-2 font-medium">Trade ex GST</th>
                        <th className="py-0.5 font-medium">Price date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ev.supplierRoute.map((r, i) => (
                        <tr key={i} className="border-t border-gray-100">
                          <td className="py-0.5 pr-2">
                            <span className="text-gray-500">{r.role}:</span> {r.product}
                          </td>
                          <td className="py-0.5 pr-2">{r.quantity}</td>
                          <td className="py-0.5 pr-2">{r.preferred ? `${r.preferred.supplier}${r.preferred.sku ? ` ${r.preferred.sku}` : ""}${r.preferred.stock ? ` (${r.preferred.stock})` : ""}` : <span className="text-red-700">no approved trade price</span>}</td>
                          <td className="py-0.5 pr-2">{money(r.preferred?.tradeCostExGst)}</td>
                          <td className="py-0.5">{r.preferred?.priceDate ? r.preferred.priceDate.slice(0, 10) : "–"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : null}
                {ev.costs ? (
                  <p className="text-xs text-gray-700" data-testid="package-costs">
                    {ev.costs.hardwareTradeExGst != null
                      ? `Hardware trade ${money(ev.costs.hardwareTradeExGst)} ex GST; at the Brain's current ${ev.costs.markupPct}% markup, sell ${money(ev.costs.hardwareSellExGst)} and margin ${money(ev.costs.hardwareMarginExGst)}.`
                      : `No hardware total: ${ev.costs.unknown.join("; ")}.`}{" "}
                    {c.proposedMarkupPct ? <span className="text-gray-500">Hermes suggests {Number(c.proposedMarkupPct)}% markup (not applied: markup is Business Brain policy).</span> : null}
                  </p>
                ) : null}
                {ev.compatibility?.length ? (
                  <ul className="space-y-0.5 text-xs">
                    {ev.compatibility.map((x, i) => (
                      <li key={i} className={x.pass ? (x.warning ? "text-[#a25b00]" : "text-gray-700") : "text-red-700"}>
                        {x.pass ? (x.warning ? "⚠" : "✓") : "✕"} {x.name}: {x.detail}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {ev.labour ? (
                  <p className="text-xs text-gray-700">
                    Labour basis: {ev.labour.name ? `${ev.labour.name} (${ev.labour.key}), ${ev.labour.estimatedHours != null ? `${ev.labour.estimatedHours} h` : "hours not set"}${ev.labour.allowanceSet ? "" : ", allowance not set"}` : (ev.labour.note ?? "none")}
                    {ev.labourNote ? ` · Hermes: ${ev.labourNote}` : ""}
                  </p>
                ) : null}
                {ev.quotes?.length || ev.jobs?.length ? (
                  <p className="text-xs text-gray-600">
                    Based on: {[...(ev.quotes ?? []).map((q) => `Q-${q.number} (${q.status})`), ...(ev.jobs ?? []).map((j) => `J-${j.number} (${j.status})`)].join(", ")}
                  </p>
                ) : null}
                {ev.sources?.length ? (
                  <p className="text-xs text-gray-600">
                    Sources:{" "}
                    {ev.sources.map((s, i) => (
                      <a key={i} href={s.url} target="_blank" rel="noreferrer noopener" className="mr-2 text-brand-700 hover:underline">
                        {s.title || s.url}
                      </a>
                    ))}
                  </p>
                ) : null}
                {c.assumptions.length ? <p className="text-xs text-gray-600">Assumptions: {c.assumptions.join("; ")}</p> : null}
                {c.missing.length ? <p className="text-xs text-red-700">Missing: {c.missing.join("; ")}</p> : null}
                {c.status === "candidate" ? (
                  <PackageDecision id={c.id} canApprove={user.canApprove} products={options} initial={{ name: c.name, key: c.key, tier: c.tier, cameraCount: c.cameraCount, components: c.components }} />
                ) : (
                  <p className="text-xs text-gray-500">
                    {c.status === "approved" ? "Approved" : "Rejected"}
                    {c.decidedAt ? ` ${formatDateTime(c.decidedAt)}` : ""}
                    {c.decisionNote ? `: ${c.decisionNote}` : ""}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}
