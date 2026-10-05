import Link from "next/link";
import { Badge } from "@/components/ui";
import { HermesView } from "@/components/inspector/hermes-view";
import { HermesReviewControls, IdentityReview, ProposedLeadControls } from "@/components/inspector/controls";
import { UnderstandingView, sourceLabel } from "@/components/inspector/views";
import { REVIEW_KIND_LABELS } from "@/lib/inspector/labels";
import { formatDateTime } from "@/lib/utils";
import type { ReviewItem } from "@/queries/inspector";

/**
 * One review Hermes could not settle: who it is, a proposed lead, Hermes unsure, Hermes asking
 * Chris to look, or Hermes unable to read it. The same card on Home and on the Hermes page.
 */
export function ReviewCard({ item: r, canApprove }: { item: ReviewItem; canApprove: boolean }) {
  const kind = r.inspection.reviewKind ?? "identity";
  const payload = (r.reviewAction?.payload ?? {}) as { hermesSuggestion?: { key: string; reason: string } | null; plan?: unknown[]; question?: string | null; waitingFor?: string[] };
  const suggested = payload.hermesSuggestion
    ? payload.hermesSuggestion.key === "new"
      ? "a new customer"
      : (r.candidates.find((c) => (c.leadId ? `lead:${c.leadId}` : `customer:${c.contactId}`) === payload.hermesSuggestion!.key)?.subject?.label ?? payload.hermesSuggestion.key)
    : null;
  return (
    <div className="space-y-2 px-4 py-3" data-testid={kind === "identity" ? "identity-review" : "hermes-review"}>
      <p className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="flex flex-wrap items-center gap-2">
          <Badge className="bg-[#ffcb00] text-gray-900">{REVIEW_KIND_LABELS[kind] ?? kind}</Badge>
          <span className="font-medium text-gray-900">{r.source?.title ?? sourceLabel(r.inspection.sourceType)}</span>
          <span className="text-gray-500">
            {r.source?.from ?? sourceLabel(r.inspection.sourceType)} · {formatDateTime(r.inspection.sourceAt)}
          </span>
        </span>
        {r.source ? (
          <Link href={r.source.href} className="text-xs text-brand-700 hover:underline">
            Open {sourceLabel(r.inspection.sourceType)}
          </Link>
        ) : null}
      </p>
      {kind === "identity" ? (
        <>
          <p className="text-sm text-gray-900">{r.inspection.summary}</p>
          <p className="text-xs text-gray-600">
            {r.identity.reason}
            {payload.waitingFor?.length ? ` Waiting on this: ${payload.waitingFor.map((t) => t.replace(/_/g, " ").toLowerCase()).join(", ")}.` : " Nothing is held up; say whose it is so it is filed."}
          </p>
          {suggested ? (
            <p className="text-xs text-gray-600" data-testid="hermes-identity-suggestion">
              Hermes suggests {suggested}
              {payload.hermesSuggestion?.reason ? ` (${payload.hermesSuggestion.reason})` : ""}. That alone never files it: you choose.
            </p>
          ) : null}
          {r.understanding.facts.length || r.understanding.commitments.length ? (
            <details className="text-sm">
              <summary className="cursor-pointer text-xs text-gray-500">What it says (not written to anyone yet)</summary>
              <div className="mt-2">
                <UnderstandingView u={r.understanding} />
              </div>
            </details>
          ) : null}
          <IdentityReview inspectionId={r.inspection.id} candidates={r.candidates} />
        </>
      ) : (
        <>
          <HermesView inspection={r.inspection} actions={r.reviewAction ? [r.reviewAction] : []} compact={false} />
          {kind === "hermes_proposed_lead" ? (
            <ProposedLeadControls inspectionId={r.inspection.id} sourceId={r.inspection.sourceId} />
          ) : (
            <HermesReviewControls inspectionId={r.inspection.id} reviewActionId={r.reviewAction?.id ?? null} canAccept={canApprove && kind === "hermes_low_confidence" && Array.isArray(payload.plan)} sourceType={r.inspection.sourceType as "email" | "recording"} sourceId={r.inspection.sourceId} />
          )}
        </>
      )}
    </div>
  );
}
