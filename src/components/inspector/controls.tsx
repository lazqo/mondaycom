"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { acceptInspectorAction, acceptProposedLeadAction, confirmIdentityAction, dismissInspectorAction, reinspectAction, resolveFactAction, resolveReviewAction, setCommitmentStatusAction } from "@/actions/inspector";
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

/**
 * A site visit or booking Hermes proposed, with free slots from the calendar. Choosing one and
 * pencilling it in creates the event and drafts the confirmation for Chris to send; the customer
 * learns the time only when he sends it.
 */
export function BookingDecision({ actionId, canApprove, slots, kind }: { actionId: string; canApprove: boolean; slots: { startsAt: string; endsAt: string; label: string; stated?: boolean; clash?: string | null }[]; kind: "PROPOSE_SITE_VISIT" | "PROPOSE_BOOKING" }) {
  const { pending, err, act } = useAct();
  const [slot, setSlot] = React.useState<number | null>(slots.length ? 0 : null);
  return (
    <div className="space-y-1.5" data-testid="booking-decision">
      {slots.length ? (
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Suggested times">
          {slots.map((s, i) => (
            <label key={s.startsAt} className={`cursor-pointer rounded-md border px-2 py-1 text-xs ${slot === i ? "border-brand-600 bg-brand-50 text-brand-800" : "border-gray-300 text-gray-700"}`}>
              <input type="radio" name={`slot-${actionId}`} className="mr-1" checked={slot === i} onChange={() => setSlot(i)} data-testid={`slot-${actionId}-${i}`} />
              {s.label}
              {s.stated ? <span className="ml-1 rounded bg-brand-100 px-1 text-[10px] text-brand-800">as said</span> : null}
              {s.clash ? <span className="ml-1 rounded bg-[#fdab3d] px-1 text-[10px] text-white" title={s.clash}>clashes: {s.clash}</span> : null}
            </label>
          ))}
        </div>
      ) : (
        <p className="text-xs text-gray-500">No free slot in the next fortnight: pick a time on the calendar.</p>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {canApprove ? (
          <>
            <Button size="sm" disabled={pending || slot == null} data-testid={`accept-action-${actionId}`} onClick={() => act(() => acceptInspectorAction(actionId, slot != null ? { slot } : undefined))}>
              {kind === "PROPOSE_SITE_VISIT" ? "Pencil in the visit" : "Pencil in the booking"}
            </Button>
            <Button size="sm" variant="secondary" disabled={pending} data-testid={`accept-task-${actionId}`} onClick={() => act(() => acceptInspectorAction(actionId))}>
              Just add a task
            </Button>
          </>
        ) : (
          <span className="text-xs text-gray-500">Waiting for Chris</span>
        )}
        <a href="/calendar" className="text-xs text-brand-700 hover:underline">
          Another time →
        </a>
        <Button size="sm" variant="secondary" disabled={pending} data-testid={`dismiss-action-${actionId}`} onClick={() => act(() => dismissInspectorAction(actionId, ""))}>
          Dismiss
        </Button>
        <ErrorText err={err} />
      </div>
    </div>
  );
}

/** A new value that conflicts with the CRM: use it, or keep what is there. */
export function FactDecision({ factId, proposed = false }: { factId: string; proposed?: boolean }) {
  const { pending, err, act } = useAct();
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button size="sm" disabled={pending} data-testid={`apply-fact-${factId}`} onClick={() => act(() => resolveFactAction(factId, "apply"))}>
        {proposed ? "Apply" : "Use new value"}
      </Button>
      <Button size="sm" variant="secondary" disabled={pending} data-testid={`reject-fact-${factId}`} onClick={() => act(() => resolveFactAction(factId, "reject"))}>
        {proposed ? "Reject" : "Keep current"}
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

/** Hermes marked a commitment kept: Chris can put it back to outstanding (recorded as a correction). */
export function ReopenCommitmentButton({ id }: { id: string }) {
  const { pending, err, act } = useAct();
  return (
    <span className="inline-flex items-center gap-1">
      <Button size="sm" variant="ghost" disabled={pending} data-testid={`commitment-reopen-${id}`} onClick={() => act(() => setCommitmentStatusAction(id, "outstanding"))}>
        Reopen
      </Button>
      <ErrorText err={err} />
    </span>
  );
}

/** The work went ahead in a known site or job: Chris may link the sender to that customer (never required). */
export function LinkSenderButton({ inspectionId, leadId, contactId, label }: { inspectionId: string; leadId: string | null; contactId: string | null; label: string }) {
  const { pending, err, act } = useAct();
  return (
    <span className="inline-flex items-center gap-1">
      <Button size="sm" variant="ghost" disabled={pending} data-testid={`link-sender-${inspectionId}`} title={`Confirm the sender belongs to ${label}`} onClick={() => act(() => confirmIdentityAction(inspectionId, { leadId, contactId }))}>
        Link sender to {label.length > 40 ? `${label.slice(0, 40)}…` : label}
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

/**
 * A review Hermes could not settle: accept what it recommended (when it was only unsure), read it
 * again (Hermes back, or after a correction), or mark it dealt with.
 */
export function HermesReviewControls({ inspectionId, reviewActionId, canAccept, sourceType, sourceId }: { inspectionId: string; reviewActionId: string | null; canAccept: boolean; sourceType: "email" | "recording"; sourceId: string }) {
  const { pending, err, act } = useAct();
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {canAccept && reviewActionId ? (
        <Button size="sm" disabled={pending} data-testid={`accept-recommendation-${inspectionId}`} onClick={() => act(() => acceptInspectorAction(reviewActionId))}>
          Accept recommendation
        </Button>
      ) : null}
      <Button size="sm" variant="secondary" disabled={pending} data-testid={`read-again-${inspectionId}`} onClick={() => act(() => reinspectAction(sourceType, sourceId))}>
        {pending ? "Working…" : "Read again"}
      </Button>
      <Button size="sm" variant="ghost" disabled={pending} data-testid={`mark-reviewed-${inspectionId}`} onClick={() => act(() => resolveReviewAction(inspectionId, ""))}>
        Mark reviewed
      </Button>
      <ErrorText err={err} />
    </div>
  );
}

/** An email the rules filed as "not a lead" that Hermes reads as an enquiry: Chris decides. */
export function ProposedLeadControls({ inspectionId, sourceId }: { inspectionId: string; sourceId: string }) {
  const { pending, err, act } = useAct();
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button size="sm" disabled={pending} data-testid={`make-lead-${inspectionId}`} onClick={() => act(() => acceptProposedLeadAction(inspectionId))}>
        {pending ? "Working…" : "Make it a lead"}
      </Button>
      <Button size="sm" variant="secondary" disabled={pending} data-testid={`not-lead-${inspectionId}`} onClick={() => act(() => resolveReviewAction(inspectionId, "not a lead"))}>
        Not a lead
      </Button>
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => act(() => reinspectAction("email", sourceId))}>
        Read again
      </Button>
      <ErrorText err={err} />
    </div>
  );
}
