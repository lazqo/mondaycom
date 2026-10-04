"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { acceptInspectorAction, confirmIdentityAction, dismissInspectorAction, reinspectAction, resolveFactAction, setCommitmentStatusAction } from "@/actions/inspector";
import { searchLinkTargets } from "@/actions/inbox";
import { Button, Input } from "@/components/ui";
import type { ActionResult } from "@/lib/action-result";

function useAct() {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [err, setErr] = React.useState<string | null>(null);
  const act = (fn: () => Promise<ActionResult<unknown>>) =>
    startTransition(async () => {
      setErr(null);
      const res = await fn();
      if (!res.ok) return setErr(res.error);
      router.refresh();
    });
  return { pending, err, act };
}

const ErrorText = ({ err }: { err: string | null }) => (err ? <span className="text-xs text-red-600">{err}</span> : null);

/** Accept or dismiss a recommendation that waits for Chris. */
export function ActionDecision({ actionId, canApprove, acceptLabel = "Accept" }: { actionId: string; canApprove: boolean; acceptLabel?: string }) {
  const { pending, err, act } = useAct();
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {canApprove ? (
        <Button size="sm" disabled={pending} data-testid={`accept-action-${actionId}`} onClick={() => act(() => acceptInspectorAction(actionId))}>
          {acceptLabel}
        </Button>
      ) : (
        <span className="text-xs text-gray-500">Waiting for Chris</span>
      )}
      <Button size="sm" variant="secondary" disabled={pending} data-testid={`dismiss-action-${actionId}`} onClick={() => act(() => dismissInspectorAction(actionId, ""))}>
        Dismiss
      </Button>
      <ErrorText err={err} />
    </div>
  );
}

/** A new value that conflicts with the CRM: use it, or keep what is there. */
export function FactDecision({ factId }: { factId: string }) {
  const { pending, err, act } = useAct();
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button size="sm" disabled={pending} data-testid={`apply-fact-${factId}`} onClick={() => act(() => resolveFactAction(factId, "apply"))}>
        Use new value
      </Button>
      <Button size="sm" variant="secondary" disabled={pending} data-testid={`reject-fact-${factId}`} onClick={() => act(() => resolveFactAction(factId, "reject"))}>
        Keep current
      </Button>
      <ErrorText err={err} />
    </div>
  );
}

export function CommitmentButtons({ id }: { id: string }) {
  const { pending, err, act } = useAct();
  return (
    <span className="flex shrink-0 items-center gap-1">
      <Button size="sm" variant="secondary" disabled={pending} data-testid={`commitment-done-${id}`} onClick={() => act(() => setCommitmentStatusAction(id, "done"))}>
        Done
      </Button>
      <Button size="sm" variant="ghost" disabled={pending} title="No longer needed" onClick={() => act(() => setCommitmentStatusAction(id, "cancelled"))}>
        ✕
      </Button>
      <ErrorText err={err} />
    </span>
  );
}

export function ReinspectButton({ sourceType, sourceId }: { sourceType: "email" | "recording"; sourceId: string }) {
  const { pending, err, act } = useAct();
  return (
    <span className="inline-flex items-center gap-1">
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => act(() => reinspectAction(sourceType, sourceId))}>
        {pending ? "Reading…" : "Read again"}
      </Button>
      <ErrorText err={err} />
    </span>
  );
}

type Candidate = { leadId: string | null; contactId: string | null; label: string; score: number; signals: { kind: string; detail: string }[]; subject: { label: string; href: string } | null };

/**
 * Who is this? The possible matches with the evidence for each, a search for anyone else, and
 * "not a customer". Nothing customer-specific is written until Chris chooses.
 */
export function IdentityReview({ inspectionId, candidates }: { inspectionId: string; candidates: Candidate[] }) {
  const { pending, err, act } = useAct();
  const [q, setQ] = React.useState("");
  const [found, setFound] = React.useState<{ leads: { id: string; name: string; company: string | null }[]; contacts: { id: string; name: string; company: string | null }[] } | null>(null);
  React.useEffect(() => {
    if (q.trim().length < 2) return setFound(null);
    const t = setTimeout(async () => setFound(await searchLinkTargets(q)), 250);
    return () => clearTimeout(t);
  }, [q]);
  const choose = (c: { leadId?: string | null; contactId?: string | null } | "not_a_customer") => act(() => confirmIdentityAction(inspectionId, c));
  return (
    <div className="space-y-2">
      {candidates.length ? (
        <ul className="space-y-1.5">
          {candidates.map((c) => (
            <li key={`${c.leadId}-${c.contactId}`} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-gray-200 px-3 py-2 text-sm" data-testid="identity-candidate">
              <span className="min-w-0">
                <span className="font-medium text-gray-900">{c.subject?.label ?? c.label}</span>
                <span className="ml-2 text-xs text-gray-500">{Math.round(c.score * 100)}%</span>
                <span className="block text-xs text-gray-500">{c.signals.map((s) => s.detail).join(" · ")}</span>
              </span>
              <Button size="sm" disabled={pending} data-testid="identity-confirm" onClick={() => choose({ leadId: c.leadId, contactId: c.contactId })}>
                It&apos;s them
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-gray-500">No lead or customer matched.</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Someone else? Search leads and customers" className="h-8 max-w-xs text-sm" />
        <Button size="sm" variant="secondary" disabled={pending} data-testid="identity-not-customer" onClick={() => choose("not_a_customer")}>
          Not a customer
        </Button>
        <ErrorText err={err} />
      </div>
      {found ? (
        <ul className="divide-y divide-gray-100 rounded-md border border-gray-200 text-sm">
          {found.leads.map((l) => (
            <li key={`l-${l.id}`} className="flex items-center justify-between px-3 py-1.5">
              <span>
                Lead: {l.name}
                {l.company ? <span className="text-gray-500"> · {l.company}</span> : null}
              </span>
              <Button size="sm" variant="secondary" disabled={pending} onClick={() => choose({ leadId: l.id })}>
                Choose
              </Button>
            </li>
          ))}
          {found.contacts.map((c) => (
            <li key={`c-${c.id}`} className="flex items-center justify-between px-3 py-1.5">
              <span>
                Customer: {c.name}
                {c.company ? <span className="text-gray-500"> · {c.company}</span> : null}
              </span>
              <Button size="sm" variant="secondary" disabled={pending} onClick={() => choose({ contactId: c.id })}>
                Choose
              </Button>
            </li>
          ))}
          {!found.leads.length && !found.contacts.length ? <li className="px-3 py-1.5 text-gray-500">Nobody found.</li> : null}
        </ul>
      ) : null}
    </div>
  );
}
