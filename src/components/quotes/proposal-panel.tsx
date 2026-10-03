"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { attachProposalAction, detachProposalAction, generateProposalAction, setQuoteValidityAction } from "@/actions/proposals";
import { Badge, Button, Card, CardHeader, FormError, Input, Select } from "@/components/ui";

export type ProposalPanelProps = {
  quoteId: string;
  quoteNumber: number;
  approved: boolean;
  current: { id: string; filename: string; generatedAt: string; size: number } | null;
  emails: { id: string; subject: string; status: string; attachment: "current" | "void" | null }[];
  /** This quote's validity (null = standard, 0 = none) and the standard from Settings → Proposals. */
  validity: { quote: number | null; standard: number | null; editable: boolean };
  /** Products on the quote whose proposal wording or photo is missing or not reviewed. */
  contentGaps: { productId: string; name: string; gaps: string[] }[];
};

/**
 * The customer's branded PDF proposal. It is made from the approved quote when Chris approves it,
 * and attached to the prepared email; sending is still a separate approval.
 */
function ValidityControl({ quoteId, validity, approved, run, pending }: { quoteId: string; validity: ProposalPanelProps["validity"]; approved: boolean; run: (fn: () => Promise<{ ok: boolean; error?: string }>, done: string) => void; pending: boolean }) {
  const initial = validity.quote == null ? "standard" : validity.quote === 0 ? "none" : "custom";
  const [mode, setMode] = React.useState(initial);
  const [days, setDays] = React.useState(validity.quote && validity.quote > 0 ? String(validity.quote) : "");
  const value = mode === "standard" ? null : mode === "none" ? 0 : Number(days);
  const changed = value !== validity.quote && !(mode === "custom" && !(Number(days) > 0));
  const standard = validity.standard ? `${validity.standard} days` : "no validity date";
  return (
    <div className="space-y-1 border-t border-gray-100 pt-2" data-testid="proposal-validity">
      <p className="text-xs font-medium text-gray-700">Quote validity</p>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={mode} onChange={(e) => setMode(e.target.value)} className="h-8 w-48 text-xs" aria-label="Quote validity" disabled={!validity.editable}>
          <option value="standard">Standard ({standard})</option>
          <option value="custom">Custom</option>
          <option value="none">No validity date</option>
        </Select>
        {mode === "custom" ? <Input type="number" min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} className="h-8 w-20 text-xs" aria-label="Valid for (days)" /> : null}
        {mode === "custom" ? <span className="text-xs text-gray-500">days</span> : null}
        {changed && validity.editable ? (
          <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => setQuoteValidityAction(quoteId, value), approved ? "Validity changed. The quote needs approving again (a new PDF is made then)." : "Validity saved.")}>
            Save
          </Button>
        ) : null}
      </div>
      {changed && approved ? <p className="text-xs text-amber-700">The validity is printed on the proposal: changing it takes the approval away.</p> : null}
    </div>
  );
}

export function ProposalPanel({ quoteId, quoteNumber, approved, current, emails, contentGaps, validity }: ProposalPanelProps) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, done: string) {
    setError(null);
    setMsg(null);
    start(async () => {
      const r = await fn();
      if (!r.ok) return setError(r.error ?? "Failed");
      setMsg(done);
      router.refresh();
    });
  }

  return (
    <Card data-testid="proposal-panel">
      <CardHeader
        title="Customer proposal (PDF)"
        action={current ? <Badge className="bg-green-100 text-green-800">Ready</Badge> : <Badge className="bg-gray-100 text-gray-700">{approved ? "Not made yet" : "After approval"}</Badge>}
      />
      <div className="space-y-3 p-4 text-sm">
        {current ? (
          <div className="space-y-1" data-testid="proposal-current">
            <p>
              <a href={`/api/quotes/${quoteId}/proposal`} target="_blank" rel="noreferrer" className="font-medium text-brand-700 hover:underline">
                {current.filename}
              </a>{" "}
              <span className="text-xs text-gray-500">({Math.round(current.size / 1024)} KB)</span>
            </p>
            <p className="text-xs text-gray-500">Made from the approved quote on {current.generatedAt}. Repricing or changing the quote voids it.</p>
            <div className="flex flex-wrap gap-2">
              <a href={`/api/quotes/${quoteId}/proposal?download=1`} className="text-xs text-brand-700 hover:underline">
                Download
              </a>
              <button type="button" className="text-xs text-gray-600 hover:underline" disabled={pending} onClick={() => run(() => generateProposalAction(quoteId), "Proposal remade from the approved quote.")} data-testid="regenerate-proposal">
                Remake PDF
              </button>
            </div>
          </div>
        ) : approved ? (
          <div className="space-y-2">
            <p className="text-xs text-gray-600">The quote is approved but has no current PDF.</p>
            <Button size="sm" disabled={pending} onClick={() => run(() => generateProposalAction(quoteId), "Proposal made from the approved quote.")} data-testid="generate-proposal">
              Make proposal PDF
            </Button>
          </div>
        ) : (
          <p className="text-xs text-gray-600">The PDF is made from the quote when Chris approves it. Until then you can preview it (marked DRAFT).</p>
        )}
        <a href={`/api/quotes/${quoteId}/proposal?preview=1`} target="_blank" rel="noreferrer" className="inline-block text-xs text-gray-600 hover:underline" data-testid="preview-proposal">
          Preview Q-{quoteNumber} as a PDF
        </a>

        <ValidityControl quoteId={quoteId} validity={validity} approved={approved} run={run} pending={pending} />

        {emails.length ? (
          <div className="space-y-1 border-t border-gray-100 pt-2">
            <p className="text-xs font-medium text-gray-700">Prepared emails to the customer</p>
            {emails.map((e) => (
              <div key={e.id} className="flex flex-wrap items-center gap-2 text-xs" data-testid="proposal-email">
                <Link href="/approvals" className="text-gray-800 hover:underline">
                  {e.subject || "(no subject)"}
                </Link>
                <span className="text-gray-500">{e.status.replace(/_/g, " ")}</span>
                {e.attachment === "current" ? (
                  <Badge className="bg-green-100 text-green-800">PDF attached</Badge>
                ) : e.attachment === "void" ? (
                  <Badge className="bg-red-100 text-red-800">Attached PDF no longer valid</Badge>
                ) : (
                  <Badge className="bg-gray-100 text-gray-700">No attachment</Badge>
                )}
                {current && e.attachment !== "current" && e.status !== "sent" ? (
                  <button type="button" className="text-brand-700 hover:underline" disabled={pending} onClick={() => run(() => attachProposalAction(e.id, quoteId), "Proposal attached. The email needs approving before it can be sent.")}>
                    Attach PDF
                  </button>
                ) : null}
                {e.attachment && e.status !== "sent" ? (
                  <button type="button" className="text-gray-500 hover:underline" disabled={pending} onClick={() => run(() => detachProposalAction(e.id), "Attachment removed.")}>
                    Remove
                  </button>
                ) : null}
              </div>
            ))}
            <p className="text-xs text-gray-500">
              Attaching adds &ldquo;Please find the quotation attached for your review.&rdquo; to the email&apos;s wording and never sends anything: the email still needs Chris&apos;s approval to send.
            </p>
          </div>
        ) : null}

        {contentGaps.length ? (
          <div className="space-y-1 border-t border-gray-100 pt-2" data-testid="proposal-content-gaps">
            <p className="text-xs font-medium text-amber-800">Product wording to check</p>
            <ul className="list-disc pl-5 text-xs text-gray-600">
              {contentGaps.map((g) => (
                <li key={g.productId}>
                  {g.name}: {g.gaps.join(", ")}
                </li>
              ))}
            </ul>
            <Link href="/settings/brain?tab=products" className="text-xs text-brand-700 hover:underline">
              Settings → Business Brain → Products: Proposal content
            </Link>
          </div>
        ) : null}
        {msg ? <p className="text-xs text-green-700">{msg}</p> : null}
        <FormError message={error} />
      </div>
    </Card>
  );
}
