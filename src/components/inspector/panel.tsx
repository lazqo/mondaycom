import Link from "next/link";
import { Card, CardHeader } from "@/components/ui";
import { getInspectorPanel } from "@/queries/inspector";
import { formatDateTime } from "@/lib/utils";
import { AwaitingLine, CommitmentLine, ConflictLine, sourceLabel, UnderstandingView } from "./views";
import { ReinspectButton } from "./controls";
import { HermesView } from "./hermes-view";

/**
 * Hermes on a lead or job page: open commitments (ours and the customer's), anything
 * waiting for Chris, conflicting facts, and what the latest email or conversation said.
 */
export async function InspectorPanel({ leadId, jobId, contactId, canApprove }: { leadId?: string | null; jobId?: string | null; contactId?: string | null; canApprove: boolean }) {
  const p = await getInspectorPanel({ leadId, jobId, contactId });
  if (!p.latest && !p.commitments.length && !p.awaiting.length && !p.conflicts.length) return null;
  const ours = p.commitments.filter((c) => c.commitment.owner !== "customer");
  const theirs = p.commitments.filter((c) => c.commitment.owner === "customer");
  return (
    <Card data-testid="inspector-panel">
      <CardHeader
        title="Hermes"
        action={
          <Link href="/dashboard" className="text-sm text-brand-700 hover:underline">
            Review queue
          </Link>
        }
      />
      <div className="divide-y divide-gray-100">
        {ours.length ? (
          <div>
            <p className="px-4 pt-2 text-xs font-semibold uppercase tracking-wide text-gray-500">We said we would</p>
            {ours.map((c) => (
              <CommitmentLine key={c.commitment.id} item={c} showSubject={false} />
            ))}
          </div>
        ) : null}
        {theirs.length ? (
          <div>
            <p className="px-4 pt-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Waiting on the customer</p>
            {theirs.map((c) => (
              <CommitmentLine key={c.commitment.id} item={c} showSubject={false} />
            ))}
          </div>
        ) : null}
        {p.awaiting.map((a) => (
          <AwaitingLine key={a.action.id} item={a} canApprove={canApprove} showSubject={false} />
        ))}
        {p.conflicts.map((f) => (
          <ConflictLine key={f.fact.id} item={f} showSubject={false} />
        ))}
        {p.latest ? (
          <div className="space-y-2 px-4 py-3">
            <p className="flex items-center justify-between gap-2 text-xs text-gray-500">
              <span>
                Latest:{" "}
                {p.latest.source ? (
                  <Link href={p.latest.source.href} className="hover:underline">
                    {sourceLabel(p.latest.source.type)} “{p.latest.source.title}”
                  </Link>
                ) : (
                  sourceLabel(p.latest.inspection.sourceType)
                )}{" "}
                · {formatDateTime(p.latest.inspection.sourceAt)}
              </span>
              <ReinspectButton sourceType={p.latest.inspection.sourceType as "email" | "recording"} sourceId={p.latest.inspection.sourceId} />
            </p>
            <HermesView inspection={p.latest.inspection} actions={p.latest.actions} compact />
            <UnderstandingView u={p.latest.understanding} />
          </div>
        ) : null}
      </div>
    </Card>
  );
}
