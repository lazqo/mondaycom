"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { approveQuoteAction, returnQuoteAction } from "@/actions/quotes";
import { repriceQuoteAction } from "@/actions/brain";
import { Badge, Button, Card, CardHeader, FormError, Input } from "@/components/ui";

const money = (n: unknown) => (typeof n === "number" ? `$${n.toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—");

type SnapLine = {
  key: string;
  kind: string;
  customerDescription: string;
  model: string | null;
  supplier: string | null;
  supplierSku: string | null;
  lastChecked: string | null;
  freshness: string | null;
  stock: string | null;
  quantity: number;
  unitCostExGst: number | null;
  markupPct: number | null;
  unitSellExGst: number | null;
  priced: boolean;
  internalOnly: boolean;
  alternatives?: { supplier: string; costExGst: number; approved: boolean; freshness: string; stock: string | null }[];
};
type SnapLabour = {
  packageKey: string | null;
  packageName: string | null;
  customInstallation: boolean;
  hours: number | null;
  rate: number | null;
  labourCost: number | null;
  materialCost: number | null;
  conduitAllowance: number | null;
  complexityAllowance: number | null;
  sellAllowance: number | null;
  missing: string[];
};

const FRESH: Record<string, string> = { current: "bg-green-100 text-green-800", aging: "bg-amber-100 text-amber-800", stale: "bg-red-100 text-red-800", unknown: "bg-gray-200 text-gray-700" };

/**
 * For quotes the Business Brain prepared: the internal commercial view Chris approves against
 * (costs, suppliers, freshness, labour, materials, allowances, markup, margin), reprice, and the
 * approve / send back buttons. None of this is ever shown to the customer.
 */
export function QuoteApprovalPanel({
  quote,
  canApprove,
}: {
  quote: {
    id: string;
    status: string;
    approvedBy: string | null;
    approvedAt: string | null;
    internalCosting: Record<string, unknown> | null;
    confidence: Record<string, unknown> | null;
  };
  canApprove: boolean;
}) {
  const router = useRouter();
  const [note, setNote] = React.useState("");
  const [markup, setMarkup] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();
  const c = quote.internalCosting ?? {};
  const conf = quote.confidence ?? {};
  const lines = (Array.isArray(c.lines) ? c.lines : []) as SnapLine[];
  const labour = (c.labour ?? null) as SnapLabour | null;
  const readiness = (c.readiness ?? null) as { ready: boolean; items: { key: string; label: string; ok: boolean; detail: string }[] } | null;
  const editable = ["ai_prepared", "needs_review", "approved"].includes(quote.status);

  function act(fn: () => Promise<{ ok: boolean; error?: string; data?: unknown }>, done?: string) {
    setError(null);
    setMsg(null);
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) return setError(res.error ?? "Failed");
      const proposalError = (res.data as { proposalError?: string | null } | undefined)?.proposalError;
      if (proposalError) setError(`Approved, but the proposal PDF could not be made: ${proposalError}`);
      if (done) setMsg(done);
      router.refresh();
    });
  }

  return (
    <Card data-testid="quote-approval">
      <CardHeader title="Approval (internal)" action={<Badge className="bg-gray-100 text-gray-700">Prepared by the Business Brain</Badge>} />
      <div className="space-y-3 p-4 text-sm">
        {quote.status === "approved" ? (
          <p className="text-green-700">
            Approved by {quote.approvedBy ?? "Chris"} {quote.approvedAt ? `on ${quote.approvedAt}` : ""}. Any change or reprice sends it back for review.
          </p>
        ) : quote.status === "needs_review" || quote.status === "ai_prepared" ? (
          <p className="text-amber-700">Waiting for Chris. It cannot be sent until it is approved.</p>
        ) : null}
        <p className={c.complete ? "text-green-700" : "font-medium text-red-600"} data-testid="quote-priced">
          {c.complete ? "Fully priced" : "Not fully priced: it cannot be approved until every input is entered."}
        </p>
        {readiness && !readiness.ready ? (
          <div className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-900" data-testid="quote-readiness">
            <p className="font-medium">Inputs not yet entered or approved:</p>
            <ul className="list-disc pl-4">
              {readiness.items
                .filter((i) => !i.ok)
                .map((i) => (
                  <li key={i.key}>
                    {i.label}: {i.detail}
                  </li>
                ))}
            </ul>
          </div>
        ) : null}

        {lines.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs" data-testid="quote-commercial-lines">
              <thead className="text-gray-500">
                <tr>
                  <th className="py-1">Item</th>
                  <th className="py-1">Supplier · price</th>
                  <th className="py-1 text-right">Qty</th>
                  <th className="py-1 text-right">Cost</th>
                  <th className="py-1 text-right">Markup</th>
                  <th className="py-1 text-right">Sell</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.key} className={`border-t border-gray-100 align-top ${l.priced ? "" : "text-red-600"}`}>
                    <td className="py-1">
                      {l.model ?? l.customerDescription}
                      {l.internalOnly ? <span className="text-gray-500"> (internal)</span> : null}
                      {l.alternatives?.length ? (
                        <p className="text-gray-500">
                          Alternatives: {l.alternatives.map((a) => `${a.supplier} ${money(a.costExGst)} (${a.freshness}${a.approved ? "" : ", not approved"}${a.stock ? `, stock ${a.stock}` : ""})`).join("; ")}
                        </p>
                      ) : null}
                    </td>
                    <td className="py-1">
                      {l.supplier ?? "—"}
                      {l.supplierSku ? ` ${l.supplierSku}` : ""}
                      {l.freshness ? <Badge className={`ml-1 ${FRESH[l.freshness] ?? ""}`}>{l.freshness}</Badge> : null}
                      {l.lastChecked ? <span className="block text-gray-500">checked {new Date(l.lastChecked).toLocaleDateString("en-NZ")}</span> : null}
                      {l.stock ? <span className="block text-gray-500">stock {l.stock}</span> : null}
                    </td>
                    <td className="py-1 text-right">{l.quantity}</td>
                    <td className="py-1 text-right">{money(l.unitCostExGst)}</td>
                    <td className="py-1 text-right">{l.markupPct != null ? `${l.markupPct}%` : "—"}</td>
                    <td className="py-1 text-right">{l.internalOnly ? "in installation" : money(l.unitSellExGst)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {labour ? (
          <p className="text-xs text-gray-700" data-testid="quote-labour">
            Installation {labour.packageKey ?? labour.packageName ?? (labour.customInstallation ? "(custom)" : "—")}: {labour.hours ?? "?"} h × ${labour.rate ?? "?"}/h = {money(labour.labourCost)} labour; materials{" "}
            {money(labour.materialCost)}; conduit {labour.conduitAllowance === 0 ? "n/a" : money(labour.conduitAllowance)}; complexity {money(labour.complexityAllowance)}; sell allowance{" "}
            {money(labour.sellAllowance)}.
          </p>
        ) : null}

        <dl className="grid grid-cols-2 gap-x-4 gap-y-0.5" data-testid="quote-commercial-totals">
          <dt className="text-gray-500">Hardware cost</dt>
          <dd>{money(c.equipmentCost)}</dd>
          <dt className="text-gray-500">Labour cost</dt>
          <dd>{money(c.labourCost)}</dd>
          <dt className="text-gray-500">Material cost</dt>
          <dd>{money(c.materialsCost)}</dd>
          <dt className="text-gray-500">Conduit / complexity</dt>
          <dd>{money(c.allowancesCost)}</dd>
          <dt className="text-gray-500">Other cost</dt>
          <dd>{money(c.otherCost)}</dd>
          <dt className="text-gray-500">Total internal cost</dt>
          <dd data-testid="quote-total-internal-cost">{money(c.totalInternalCost)}</dd>
          <dt className="text-gray-500">Markup</dt>
          <dd>{typeof c.markupPct === "number" ? `${c.markupPct}%${c.markupSource === "override" ? " (Chris override)" : " (provisional suggestion)"}` : "—"}</dd>
          <dt className="text-gray-500">Sell ex GST</dt>
          <dd>{money(c.sellExGst)}</dd>
          <dt className="text-gray-500">GST</dt>
          <dd>{money(c.gst)}</dd>
          <dt className="text-gray-500">Total inc GST</dt>
          <dd className="font-medium">{money(c.totalIncGst)}</dd>
          <dt className="text-gray-500">Gross profit</dt>
          <dd>{c.complete ? money(c.grossProfit) : "— until fully priced"}</dd>
          <dt className="text-gray-500">Gross margin</dt>
          <dd>{c.complete && typeof c.grossMarginPct === "number" ? `${c.grossMarginPct}%` : "— until fully priced"}</dd>
        </dl>
        {typeof c.markupLogic === "string" ? <p className="text-xs text-gray-600">{c.markupLogic}</p> : null}
        {Array.isArray(c.unpriced) && c.unpriced.length ? <p className="text-xs text-red-600">Missing / unpriced: {(c.unpriced as string[]).join("; ")}</p> : null}
        {Array.isArray(c.refreshRequired) && c.refreshRequired.length ? (
          <p className="rounded bg-red-50 px-2 py-1 text-xs text-red-800" data-testid="quote-refresh">
            Refresh supplier price before final quote approval:{" "}
            {(c.refreshRequired as { model: string; supplier: string | null; freshness: string }[]).map((r) => `${r.model}${r.supplier ? ` (${r.supplier}, ${r.freshness})` : ""}`).join("; ")}.
          </p>
        ) : null}
        {Array.isArray(c.assumptions) && c.assumptions.length ? <p className="text-xs text-gray-600">Assumptions: {(c.assumptions as string[]).join("; ")}</p> : null}
        {typeof c.snapshotAt === "string" ? (
          <p className="text-xs text-gray-500">Prices frozen with this quote on {new Date(c.snapshotAt).toLocaleString("en-NZ")}; later supplier changes do not alter it. Reprice to use current prices.</p>
        ) : null}
        {conf.overall ? (
          <p className="text-xs text-gray-600">
            Confidence: technical {String(conf.technical)}, pricing {String(conf.pricing)}, site {String(conf.site)}, overall <strong>{String(conf.overall)}</strong>
          </p>
        ) : null}

        {editable ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 pt-2">
            {canApprove ? (
              <Input value={markup} onChange={(e) => setMarkup(e.target.value)} placeholder="Markup % (blank = keep)" type="number" className="h-8 w-40 text-xs" aria-label="Markup override" />
            ) : null}
            <Button
              size="sm"
              variant="secondary"
              disabled={pending}
              data-testid="reprice-quote"
              onClick={() => act(() => repriceQuoteAction(quote.id, canApprove && markup.trim() ? Number(markup) : undefined), "Repriced with current prices. It needs approving again.")}
            >
              Reprice with current prices
            </Button>
          </div>
        ) : null}
        {canApprove && (quote.status === "needs_review" || quote.status === "ai_prepared") ? (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button size="sm" onClick={() => act(() => approveQuoteAction(quote.id), "Approved. The proposal PDF is ready below; nothing has been sent.")} disabled={pending} data-testid="approve-quote">
              Approve quote
            </Button>
          </div>
        ) : null}
        {canApprove && quote.status === "approved" ? (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why it needs another look" className="h-8 max-w-xs flex-1 text-xs" />
            <Button size="sm" variant="secondary" onClick={() => act(() => returnQuoteAction(quote.id, note))} disabled={pending}>
              Send back for review
            </Button>
          </div>
        ) : null}
        {!canApprove && quote.status !== "approved" ? <p className="text-xs text-gray-500">Only Chris can approve quotes.</p> : null}
        {msg ? <p className="text-xs text-green-700">{msg}</p> : null}
        <FormError message={error} />
      </div>
    </Card>
  );
}
