"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { decideCandidateAction, requestResearchAction } from "@/actions/research";
import { Button, Input, Select } from "@/components/ui";
import type { ActionResult } from "@/lib/action-result";

function useAct() {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [err, setErr] = React.useState<string | null>(null);
  const act = (fn: () => Promise<ActionResult<unknown>>, after?: (r: ActionResult<unknown>) => void) =>
    startTransition(async () => {
      setErr(null);
      const res = await fn();
      if (!res.ok) return setErr(res.error);
      after?.(res);
      router.refresh();
    });
  return { pending, err, act };
}

const KINDS = [
  ["product", "Product / current model"],
  ["compatibility", "Compatibility"],
  ["manual", "Manual / specification"],
  ["firmware", "Firmware / product change"],
  ["supplier", "Supplier / alternative"],
  ["availability", "Stock / availability"],
  ["standard", "Standard / regulation"],
  ["other", "Other"],
] as const;

/** Ask Hermes's research profile a question. */
export function AskResearch({ connected }: { connected: boolean }) {
  const { pending, err, act } = useAct();
  const [q, setQ] = React.useState("");
  const [kind, setKind] = React.useState("product");
  const [note, setNote] = React.useState<string | null>(null);
  return (
    <form
      className="flex flex-wrap items-center gap-2 px-4 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        act(
          () => requestResearchAction(q, kind),
          (r) => {
            const d = (r as { data?: { status: string; error: string | null } }).data;
            setNote(d?.status === "ok" ? "Done: see the newest finding below." : (d?.error ?? null));
            if (d?.status === "ok") setQ("");
          },
        );
      }}
    >
      <Input className="min-w-64 flex-1" placeholder="e.g. Is the VIGI C540 still current, and what replaced the C440?" value={q} onChange={(e) => setQ(e.target.value)} data-testid="research-question" />
      <Select className="w-56" value={kind} onChange={(e) => setKind(e.target.value)}>
        {KINDS.map(([k, label]) => (
          <option key={k} value={k}>
            {label}
          </option>
        ))}
      </Select>
      <Button type="submit" disabled={pending || q.trim().length < 5}>
        {pending ? "Researching…" : "Ask Hermes"}
      </Button>
      {!connected ? <span className="w-full text-xs text-gray-500">The research profile is not connected yet (HERMES_RESEARCH_API_URL / HERMES_RESEARCH_API_KEY): questions are recorded but not answered.</span> : null}
      {note ? <span className="w-full text-xs text-gray-700">{note}</span> : null}
      {err ? <span className="w-full text-xs text-red-600">{err}</span> : null}
    </form>
  );
}

/** Chris accepts or rejects a candidate update. Accepting changes nothing in the Brain by itself. */
export function CandidateDecision({ id, canApprove }: { id: string; canApprove: boolean }) {
  const { pending, err, act } = useAct();
  const [note, setNote] = React.useState("");
  if (!canApprove) return <span className="text-xs text-gray-500">Waiting for Chris</span>;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Input className="h-8 w-56 text-xs" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      <Button size="sm" disabled={pending} data-testid={`candidate-accept-${id}`} onClick={() => act(() => decideCandidateAction(id, "accepted", note))}>
        Accept
      </Button>
      <Button size="sm" variant="secondary" disabled={pending} data-testid={`candidate-reject-${id}`} onClick={() => act(() => decideCandidateAction(id, "rejected", note))}>
        Reject
      </Button>
      {err ? <span className="text-xs text-red-600">{err}</span> : null}
    </div>
  );
}
