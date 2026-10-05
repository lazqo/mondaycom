import type { Metadata } from "next";
import Link from "next/link";
import { requireOffice } from "@/lib/auth";
import { Badge, Card, CardHeader } from "@/components/ui";
import {
  getInspectorQueue,
  getRecentInspections,
} from "@/queries/inspector";
import {
  ACTION_LABELS,
  AwaitingLine,
  ConflictLine,
  sourceLabel,
} from "@/components/inspector/views";
import { ReinspectButton } from "@/components/inspector/controls";
import { ReviewCard } from "@/components/inspector/review-card";
import { EngineBadge, HermesView } from "@/components/inspector/hermes-view";
import { REVIEW_KIND_LABELS } from "@/lib/inspector/labels";
import { formatDateTime } from "@/lib/utils";
import type { ActionType } from "@/lib/inspector/types";

export const metadata: Metadata = { title: "Hermes" };

const count = (n: number, tone = "bg-[#ffcb00] text-gray-900") => (
  <Badge className={n ? tone : "bg-gray-100 text-gray-500"}>{n}</Badge>
);

export default async function InspectorPage() {
  const user = await requireOffice();
  const [q, recent] = await Promise.all([getInspectorQueue(), getRecentInspections(30)]);
  const canApprove = !!user.canApprove;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Hermes</h1>
        <p className="text-sm text-gray-500">
          Every email and Plaud conversation Hermes has read, with what it
          decided, the guardrail checks and what the CRM did. Decisions that
          wait on {canApprove ? "you" : "Chris"} are on{" "}
          <Link href="/dashboard" className="text-brand-700 hover:underline">
            Home
          </Link>
          ; this page is the full record. Nothing is sent from here.
        </p>
      </div>

      <Card data-testid="inspector-identity">
        <CardHeader
          title={
            <span className="inline-flex items-center gap-2">
              Needs your review {count(q.review.length)}
            </span>
          }
        />
        {q.review.length === 0 ? (
          <p className="px-4 py-3 text-sm text-gray-500">
            Nothing waiting. Anything uncertain (who it is, what Hermes could
            not read or was unsure about) waits here, with nothing
            customer-facing done until you decide.
          </p>
        ) : null}
        <div className="divide-y divide-gray-100">
          {q.review.map((r) => (
            <ReviewCard key={r.inspection.id} item={r} canApprove={canApprove} />
          ))}
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card data-testid="inspector-awaiting">
          <CardHeader
            title={
              <span className="inline-flex items-center gap-2">
                Waiting for {canApprove ? "you" : "Chris"}{" "}
                {count(q.awaiting.length)}
              </span>
            }
          />
          {q.awaiting.length === 0 ? (
            <p className="px-4 py-3 text-sm text-gray-500">
              No site visits, bookings or revised quotes waiting.
            </p>
          ) : null}
          <div className="divide-y divide-gray-100">
            {q.awaiting.map((a) => (
              <AwaitingLine
                key={a.action.id}
                item={a}
                canApprove={canApprove}
              />
            ))}
          </div>
        </Card>
        <Card data-testid="inspector-conflicts">
          <CardHeader
            title={
              <span className="inline-flex items-center gap-2">
                Facts to check {count(q.conflicts.length)}
              </span>
            }
          />
          {q.conflicts.length === 0 ? (
            <p className="px-4 py-3 text-sm text-gray-500">
              Nothing new disagrees with the CRM. When it does, the CRM keeps
              its value until you choose.
            </p>
          ) : null}
          <div className="divide-y divide-gray-100">
            {q.conflicts.map((f) => (
              <ConflictLine key={f.fact.id} item={f} />
            ))}
          </div>
        </Card>
      </div>

      <Card data-testid="inspector-recent">
        <CardHeader title="Recently read" />
        {recent.length === 0 ? (
          <p className="px-4 py-3 text-sm text-gray-500">
            Nothing read yet. New emails and Plaud conversations appear here as
            they arrive.
          </p>
        ) : null}
        <div className="divide-y divide-gray-100">
          {recent.map((r) => (
            <details
              key={r.inspection.id}
              className="group px-4 py-2.5 text-sm"
            >
              <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2">
                <span className="min-w-0">
                  <span className="font-medium text-gray-900">
                    {r.source?.title ?? sourceLabel(r.inspection.sourceType)}
                  </span>
                  <span className="text-gray-500">
                    {" "}
                    · {sourceLabel(r.inspection.sourceType)} ·{" "}
                    {formatDateTime(r.inspection.sourceAt)}
                    {r.subject ? ` · ${r.subject.label}` : ""}
                  </span>
                  <span className="block truncate text-xs text-gray-500">
                    {r.inspection.summary}
                  </span>
                </span>
                <span className="flex flex-wrap gap-1">
                  <EngineBadge engine={r.inspection.engine} />
                  {r.inspection.status === "needs_review" ? (
                    <Badge className="bg-[#ffcb00] text-gray-900">
                      {REVIEW_KIND_LABELS[
                        r.inspection.reviewKind ?? "identity"
                      ] ?? "Needs review"}
                    </Badge>
                  ) : null}
                  {r.actions
                    .filter(
                      (a) =>
                        a.type !== "ADD_INTERNAL_NOTE" &&
                        a.type !== "PROPOSE_LEAD_FACT_UPDATE",
                    )
                    .map((a) => (
                      <Badge
                        key={a.id}
                        className="bg-gray-100 text-gray-700"
                        title={a.reason}
                      >
                        {ACTION_LABELS[a.type as ActionType] ?? a.type}
                      </Badge>
                    ))}
                </span>
              </summary>
              <div className="mt-3 space-y-3 border-l-2 border-gray-100 pl-3">
                <HermesView inspection={r.inspection} actions={r.actions} />
                <div className="flex items-center gap-3 text-xs">
                  {r.source ? (
                    <Link
                      href={r.source.href}
                      className="text-brand-700 hover:underline"
                    >
                      Open {sourceLabel(r.inspection.sourceType)}
                    </Link>
                  ) : null}
                  {r.subject ? (
                    <Link
                      href={r.subject.href}
                      className="text-brand-700 hover:underline"
                    >
                      {r.subject.label}
                    </Link>
                  ) : null}
                  <ReinspectButton
                    sourceType={
                      r.inspection.sourceType as "email" | "recording"
                    }
                    sourceId={r.inspection.sourceId}
                  />
                </div>
              </div>
            </details>
          ))}
        </div>
      </Card>

    </div>
  );
}
