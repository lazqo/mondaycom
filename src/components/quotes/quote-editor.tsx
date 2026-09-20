"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Trash2, Plus } from "lucide-react";
import type { Contact, Quote, QuoteLineItem } from "@/db/schema";
import { createQuote, updateQuote } from "@/actions/quotes";
import { Button, Card, CardHeader, Field, FormError, Input, Select, Textarea } from "@/components/ui";
import { computeTotals } from "@/lib/quotes";
import { formatMoney } from "@/lib/utils";
import { DEFAULT_TAX_RATE } from "@/lib/constants";

type Props =
  | { mode: "create"; contacts: Contact[]; defaultContactId?: string; leadId?: string }
  | { mode: "edit"; contacts: Contact[]; quote: Quote };

const emptyLine = (): QuoteLineItem => ({ description: "", quantity: 1, unitPrice: 0 });

export function QuoteEditor(props: Props) {
  const router = useRouter();
  const quote = props.mode === "edit" ? props.quote : null;
  const locked = quote ? quote.status === "accepted" : false;
  const [title, setTitle] = React.useState(quote?.title ?? "");
  const [contactId, setContactId] = React.useState(quote?.contactId ?? (props.mode === "create" ? (props.defaultContactId ?? "") : ""));
  const [taxRate, setTaxRate] = React.useState<number>(quote ? Number(quote.taxRate) : DEFAULT_TAX_RATE);
  const [lines, setLines] = React.useState<QuoteLineItem[]>(quote?.lineItems.length ? quote.lineItems : [emptyLine()]);
  const [notes, setNotes] = React.useState(quote?.notes ?? "");
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  const totals = computeTotals(lines, taxRate);

  function updateLine(i: number, patch: Partial<QuoteLineItem>) {
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    const payload = {
      title,
      contactId,
      leadId: props.mode === "create" ? (props.leadId ?? null) : undefined,
      taxRate,
      lineItems: lines.filter((l) => l.description.trim() !== ""),
      notes,
    };
    startTransition(async () => {
      if (props.mode === "create") {
        const res = await createQuote(payload);
        if (!res.ok) return setError(res.error);
        router.push(`/quotes/${res.data.id}`);
        router.refresh();
      } else {
        const res = await updateQuote(props.quote.id, payload);
        if (!res.ok) return setError(res.error);
        setSaved(true);
        router.refresh();
      }
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <Card>
        <CardHeader title="Quote details" />
        <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2">
          <Field label="Title *" htmlFor="q-title" className="sm:col-span-2">
            <Input id="q-title" value={title} onChange={(e) => setTitle(e.target.value)} required disabled={locked} />
          </Field>
          <Field label="Customer *" htmlFor="q-contact">
            <Select id="q-contact" value={contactId} onChange={(e) => setContactId(e.target.value)} required disabled={locked}>
              <option value="">Choose a customer…</option>
              {props.contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.company ? ` (${c.company})` : ""}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="GST %" htmlFor="q-tax">
            <Input
              id="q-tax"
              type="number"
              step="0.01"
              min={0}
              max={100}
              value={taxRate}
              onChange={(e) => setTaxRate(Number(e.target.value))}
              disabled={locked}
            />
          </Field>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Line items"
          action={
            !locked ? (
              <Button type="button" size="sm" variant="secondary" onClick={() => setLines((ls) => [...ls, emptyLine()])}>
                <Plus className="h-4 w-4" /> Add line
              </Button>
            ) : null
          }
        />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs font-medium text-gray-500">
              <tr>
                <th className="px-3 py-2 text-left">Description</th>
                <th className="w-24 px-3 py-2 text-right">Qty</th>
                <th className="w-36 px-3 py-2 text-right">Unit price</th>
                <th className="w-32 px-3 py-2 text-right">Amount</th>
                {!locked ? <th className="w-10" /> : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {lines.map((l, i) => (
                <tr key={i}>
                  <td className="px-3 py-1.5">
                    <Input
                      aria-label={`Line ${i + 1} description`}
                      value={l.description}
                      onChange={(e) => updateLine(i, { description: e.target.value })}
                      placeholder="e.g. 4x 4MP dome cameras supplied and installed"
                      disabled={locked}
                    />
                  </td>
                  <td className="px-3 py-1.5">
                    <Input
                      aria-label={`Line ${i + 1} quantity`}
                      type="number"
                      step="0.01"
                      min={0}
                      className="text-right"
                      value={l.quantity}
                      onChange={(e) => updateLine(i, { quantity: Number(e.target.value) })}
                      disabled={locked}
                    />
                  </td>
                  <td className="px-3 py-1.5">
                    <Input
                      aria-label={`Line ${i + 1} unit price`}
                      type="number"
                      step="0.01"
                      className="text-right"
                      value={l.unitPrice}
                      onChange={(e) => updateLine(i, { unitPrice: Number(e.target.value) })}
                      disabled={locked}
                    />
                  </td>
                  <td className="px-3 py-1.5 text-right text-gray-900">{formatMoney(l.quantity * l.unitPrice)}</td>
                  {!locked ? (
                    <td className="px-1 py-1.5">
                      <button
                        type="button"
                        aria-label={`Remove line ${i + 1}`}
                        onClick={() => setLines((ls) => (ls.length === 1 ? [emptyLine()] : ls.filter((_, idx) => idx !== i)))}
                        className="rounded p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex justify-end border-t border-gray-200 px-4 py-3">
          <dl className="w-64 space-y-1 text-sm">
            <div className="flex justify-between">
              <dt className="text-gray-500">Subtotal</dt>
              <dd>{formatMoney(totals.subtotal)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">GST ({taxRate}%)</dt>
              <dd>{formatMoney(totals.tax)}</dd>
            </div>
            <div className="flex justify-between border-t border-gray-200 pt-1 font-semibold text-gray-900">
              <dt>Total</dt>
              <dd data-testid="quote-total">{formatMoney(totals.total)}</dd>
            </div>
          </dl>
        </div>
      </Card>

      <Card>
        <CardHeader title="Notes / terms" />
        <div className="p-4">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} disabled={locked} placeholder="Payment terms, exclusions, validity…" />
        </div>
      </Card>

      <FormError message={error} />
      {!locked ? (
        <div className="flex items-center justify-end gap-3">
          {saved ? <span className="text-sm text-green-700">Saved</span> : null}
          <Button type="submit" disabled={pending || !contactId}>
            {pending ? "Saving…" : props.mode === "create" ? "Create quote" : "Save quote"}
          </Button>
        </div>
      ) : (
        <p className="text-right text-sm text-gray-500">Accepted quotes are locked.</p>
      )}
    </form>
  );
}
