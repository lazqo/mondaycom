"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { answerQuestionAction, dismissInspectorAction } from "@/actions/inspector";
import { Badge, Button, Input } from "@/components/ui";
import { sourceLabel } from "@/components/inspector/views";
import { ACTION_LABELS } from "@/lib/inspector/labels";
import type { ActionType } from "@/lib/inspector/types";
import type { AwaitingItem } from "@/queries/inspector";

type PricingItem = { productId: string; model: string; key: string; suppliers: { id: string; name: string }[]; supplierId: string | null };
type Payload = { key?: string; question?: string; kind?: "text" | "number" | "yes_no" | "choice" | "pricing"; options?: string[]; why?: string; unblocks?: string[]; learn?: boolean; items?: PricingItem[] };

/** Trade costs for the unpriced products in a design: entered and approved as Chris, then the quote follows. */
function PricingForm({ items, pending, onSend }: { items: PricingItem[]; pending: boolean; onSend: (json: string) => void }) {
  const [rows, setRows] = React.useState(items.map((i) => ({ productId: i.productId, supplierId: i.supplierId ?? i.suppliers[0]?.id ?? "", costExGst: "" })));
  const set = (n: number, patch: Partial<(typeof rows)[number]>) => setRows((r) => r.map((x, i) => (i === n ? { ...x, ...patch } : x)));
  const ready = rows.some((r) => r.supplierId && Number(r.costExGst) > 0);
  return (
    <div className="space-y-1.5" data-testid="pricing-form">
      {items.map((it, n) => (
        <div key={it.productId} className="flex flex-wrap items-center gap-2">
          <span className="w-56 truncate text-gray-900" title={it.model}>
            {it.model}
          </span>
          <select className="rounded-md border border-gray-300 px-2 py-1 text-sm" value={rows[n].supplierId} onChange={(e) => set(n, { supplierId: e.target.value })} aria-label={`Supplier for ${it.model}`}>
            {it.suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <Input type="number" min={0} step="0.01" className="w-32" placeholder="Cost ex GST" aria-label={`Cost ex GST for ${it.model}`} data-testid={`price-${it.productId}`} value={rows[n].costExGst} onChange={(e) => set(n, { costExGst: e.target.value })} />
        </div>
      ))}
      <Button size="sm" disabled={pending || !ready} data-testid="pricing-send" onClick={() => onSend(JSON.stringify({ items: rows.filter((r) => Number(r.costExGst) > 0) }))}>
        Approve costs and prepare the quote
      </Button>
    </div>
  );
}

/**
 * A question from Hermes, answered on Home. The answer is kept, and the email or conversation is
 * read again with it so Hermes carries on. Skipping leaves the question unanswered (Hermes may ask
 * again on a later reading).
 */
export function AskCard({ item, canApprove }: { item: AwaitingItem; canApprove: boolean }) {
  const router = useRouter();
  const a = item.action;
  const p = (a.payload ?? {}) as Payload;
  const kind = p.kind ?? "text";
  const [answer, setAnswer] = React.useState(kind === "yes_no" ? "" : "");
  const [pending, start] = React.useTransition();
  const [err, setErr] = React.useState<string | null>(null);
  const send = (value: string) =>
    start(async () => {
      setErr(null);
      const res = await answerQuestionAction(a.id, value);
      if (!res.ok) return setErr(res.error);
      router.refresh();
    });
  const skip = () =>
    start(async () => {
      setErr(null);
      const res = await dismissInspectorAction(a.id, "skipped");
      if (!res.ok) return setErr(res.error);
      router.refresh();
    });
  const unblocks = (p.unblocks ?? []).map((t) => ACTION_LABELS[t as ActionType] ?? t.replace(/_/g, " ").toLowerCase());
  return (
    <div className="space-y-2 px-4 py-3 text-sm" data-testid="hermes-question">
      <p className="font-medium text-gray-900">{p.question ?? a.reason}</p>
      <p className="text-xs text-gray-600">
        {p.why || (a.reason !== p.question ? a.reason : null)}
        {unblocks.length ? ` Unblocks: ${unblocks.join(", ")}.` : ""}
        {p.learn ? " Your answer will be remembered for every future reading." : ""}
      </p>
      <p className="text-xs text-gray-500">
        {item.subject ? (
          <Link href={item.subject.href} className="hover:underline">
            {item.subject.label}
          </Link>
        ) : (
          "No lead or customer linked"
        )}
        {item.source ? (
          <>
            {" · from "}
            <Link href={item.source.href} className="hover:underline">
              {sourceLabel(item.source.type)} “{item.source.title}”
            </Link>
          </>
        ) : null}
      </p>
      {canApprove ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {kind === "pricing" ? (
            <PricingForm items={p.items ?? []} pending={pending} onSend={send} />
          ) : kind === "yes_no" ? (
            <>
              <Button size="sm" disabled={pending} data-testid={`answer-yes-${a.id}`} onClick={() => send("Yes")}>
                Yes
              </Button>
              <Button size="sm" disabled={pending} data-testid={`answer-no-${a.id}`} onClick={() => send("No")}>
                No
              </Button>
            </>
          ) : kind === "choice" && (p.options ?? []).length ? (
            (p.options ?? []).map((o) => (
              <Button key={o} size="sm" disabled={pending} onClick={() => send(o)}>
                {o}
              </Button>
            ))
          ) : (
            <>
              <Input
                type={kind === "number" ? "number" : "text"}
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                placeholder={kind === "number" ? "Number" : "Your answer"}
                className="w-64"
                aria-label="Answer"
                data-testid={`answer-${a.id}`}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && answer.trim()) send(answer);
                }}
              />
              <Button size="sm" disabled={pending || !answer.trim()} data-testid={`answer-send-${a.id}`} onClick={() => send(answer)}>
                Answer
              </Button>
            </>
          )}
          <Button size="sm" variant="secondary" disabled={pending} onClick={skip}>
            Skip
          </Button>
          {err ? <span className="text-xs text-red-600">{err}</span> : null}
        </div>
      ) : (
        <Badge className="bg-gray-100 text-gray-600">Waiting for Chris</Badge>
      )}
    </div>
  );
}
