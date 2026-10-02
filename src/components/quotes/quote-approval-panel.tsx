"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { approveQuoteAction, returnQuoteAction } from "@/actions/quotes";
import { Badge, Button, Card, CardHeader, FormError, Input } from "@/components/ui";

const money = (n: unknown) => (typeof n === "number" ? `$${n.toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—");

/**
 * For quotes the Business Brain prepared: the internal costing Chris approves against, and the
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
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();
  const c = quote.internalCosting ?? {};
  const conf = quote.confidence ?? {};

  function act(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) return setError(res.error ?? "Failed");
      router.refresh();
    });
  }

  return (
    <Card data-testid="quote-approval">
      <CardHeader title="Approval (internal)" action={<Badge className="bg-gray-100 text-gray-700">Prepared by the Business Brain</Badge>} />
      <div className="space-y-3 p-4 text-sm">
        {quote.status === "approved" ? (
          <p className="text-green-700">
            Approved by {quote.approvedBy ?? "Chris"} {quote.approvedAt ? `on ${quote.approvedAt}` : ""}. Any change sends it back for review.
          </p>
        ) : quote.status === "needs_review" || quote.status === "ai_prepared" ? (
          <p className="text-amber-700">Waiting for Chris. It cannot be sent until it is approved.</p>
        ) : null}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-0.5">
          <dt className="text-gray-500">Equipment cost</dt>
          <dd>{money(c.equipmentCost)}</dd>
          <dt className="text-gray-500">Materials cost</dt>
          <dd>{money(c.materialsCost)}</dd>
          <dt className="text-gray-500">Labour cost</dt>
          <dd>{money(c.labourCost)}</dd>
          <dt className="text-gray-500">Other cost</dt>
          <dd>{money(c.otherCost)}</dd>
          <dt className="text-gray-500">Sell ex GST</dt>
          <dd>{money(c.sellExGst)}</dd>
          <dt className="text-gray-500">Gross profit</dt>
          <dd>
            {money(c.grossProfit)}
            {typeof c.grossMarginPct === "number" ? ` (${c.grossMarginPct}%)` : ""}
          </dd>
        </dl>
        {typeof c.markupLogic === "string" ? <p className="text-xs text-gray-600">{c.markupLogic}</p> : null}
        {Array.isArray(c.unpriced) && c.unpriced.length ? <p className="text-xs text-red-600">Not priced: {(c.unpriced as string[]).join("; ")}</p> : null}
        {Array.isArray(c.refreshRequired) && c.refreshRequired.length ? (
          <p className="rounded bg-red-50 px-2 py-1 text-xs text-red-800" data-testid="quote-refresh">
            Refresh supplier price before final quote approval:{" "}
            {(c.refreshRequired as { model: string; supplier: string | null; freshness: string }[]).map((r) => `${r.model}${r.supplier ? ` (${r.supplier}, ${r.freshness})` : ""}`).join("; ")}.
          </p>
        ) : null}
        {typeof c.snapshotAt === "string" ? <p className="text-xs text-gray-500">Prices frozen with this quote on {new Date(c.snapshotAt).toLocaleDateString("en-NZ")}; later supplier changes do not alter it.</p> : null}
        {conf.overall ? (
          <p className="text-xs text-gray-600">
            Confidence: technical {String(conf.technical)}, pricing {String(conf.pricing)}, site {String(conf.site)}, overall <strong>{String(conf.overall)}</strong>
          </p>
        ) : null}
        {canApprove && (quote.status === "needs_review" || quote.status === "ai_prepared") ? (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button size="sm" onClick={() => act(() => approveQuoteAction(quote.id))} disabled={pending} data-testid="approve-quote">
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
        <FormError message={error} />
      </div>
    </Card>
  );
}
