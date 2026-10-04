import type { Metadata } from "next";
import Link from "next/link";
import { requireOffice } from "@/lib/auth";
import { Badge, Card, CardHeader } from "@/components/ui";
import { getInspectorQueue, getJevComparison, getRecentInspections } from "@/queries/inspector";
import { ACTION_LABELS, ActionStatus, AwaitingLine, ConflictLine, sourceLabel, UnderstandingView } from "@/components/inspector/views";
import { IdentityReview, ReinspectButton } from "@/components/inspector/controls";
import { formatDateTime } from "@/lib/utils";
import type { ActionType } from "@/lib/inspector/types";

export const metadata: Metadata = { title: "Inspector" };

const count = (n: number, tone = "bg-[#ffcb00] text-gray-900") => <Badge className={n ? tone : "bg-gray-100 text-gray-500"}>{n}</Badge>;

export default async function InspectorPage() {
  const user = await requireOffice();
  const [q, recent, jev] = await Promise.all([getInspectorQueue(), getRecentInspections(30), getJevComparison(50)]);
  const canApprove = !!user.canApprove;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Inspector</h1>
        <p className="text-sm text-gray-500">
          Every email and Plaud conversation is read here. Internal work (notes, tasks, the Business Brain, prepared quotes and drafts) is done for you; anything that reaches a customer waits for{" "}
          {canApprove ? "you" : "Chris"}. Nothing is sent from this page.
        </p>
      </div>

      <Card data-testid="inspector-identity">
        <CardHeader title={<span className="inline-flex items-center gap-2">Who is this? {count(q.review.length)}</span>} />
        {q.review.length === 0 ? <p className="px-4 py-3 text-sm text-gray-500">Every email and conversation is matched. Anything uncertain waits here, with nothing written to a customer until you choose.</p> : null}
        <div className="divide-y divide-gray-100">
          {q.review.map((r) => (
            <div key={r.inspection.id} className="space-y-2 px-4 py-3" data-testid="identity-review">
              <p className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span>
                  <span className="font-medium text-gray-900">{r.source?.title ?? sourceLabel(r.inspection.sourceType)}</span>
                  <span className="text-gray-500">
                    {" "}
                    · {r.source?.from ?? sourceLabel(r.inspection.sourceType)} · {formatDateTime(r.inspection.sourceAt)}
                  </span>
                </span>
                {r.source ? (
                  <Link href={r.source.href} className="text-xs text-brand-700 hover:underline">
                    Open {sourceLabel(r.inspection.sourceType)}
                  </Link>
                ) : null}
              </p>
              <p className="text-sm text-gray-900">{r.inspection.summary}</p>
              <p className="text-xs text-gray-600">{r.identity.reason}</p>
              <details className="text-sm">
                <summary className="cursor-pointer text-xs text-gray-500">What it says (not written to anyone yet)</summary>
                <div className="mt-2">
                  <UnderstandingView u={r.understanding} />
                </div>
              </details>
              <IdentityReview inspectionId={r.inspection.id} candidates={r.candidates} />
            </div>
          ))}
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card data-testid="inspector-awaiting">
          <CardHeader title={<span className="inline-flex items-center gap-2">Waiting for {canApprove ? "you" : "Chris"} {count(q.awaiting.length)}</span>} />
          {q.awaiting.length === 0 ? <p className="px-4 py-3 text-sm text-gray-500">No site visits, bookings or revised quotes waiting.</p> : null}
          <div className="divide-y divide-gray-100">
            {q.awaiting.map((a) => (
              <AwaitingLine key={a.action.id} item={a} canApprove={canApprove} />
            ))}
          </div>
        </Card>
        <Card data-testid="inspector-conflicts">
          <CardHeader title={<span className="inline-flex items-center gap-2">Conflicting facts {count(q.conflicts.length)}</span>} />
          {q.conflicts.length === 0 ? <p className="px-4 py-3 text-sm text-gray-500">Nothing new disagrees with the CRM. When it does, the CRM keeps its value until you choose.</p> : null}
          <div className="divide-y divide-gray-100">
            {q.conflicts.map((f) => (
              <ConflictLine key={f.fact.id} item={f} />
            ))}
          </div>
        </Card>
      </div>

      <Card data-testid="inspector-recent">
        <CardHeader title="Recently read" />
        {recent.length === 0 ? <p className="px-4 py-3 text-sm text-gray-500">Nothing read yet. New emails and Plaud conversations appear here as they arrive.</p> : null}
        <div className="divide-y divide-gray-100">
          {recent.map((r) => (
            <details key={r.inspection.id} className="group px-4 py-2.5 text-sm">
              <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2">
                <span className="min-w-0">
                  <span className="font-medium text-gray-900">{r.source?.title ?? sourceLabel(r.inspection.sourceType)}</span>
                  <span className="text-gray-500">
                    {" "}
                    · {sourceLabel(r.inspection.sourceType)} · {formatDateTime(r.inspection.sourceAt)}
                    {r.subject ? ` · ${r.subject.label}` : ""}
                  </span>
                  <span className="block truncate text-xs text-gray-500">{r.inspection.summary}</span>
                </span>
                <span className="flex flex-wrap gap-1">
                  {r.inspection.status === "needs_review" ? <Badge className="bg-[#ffcb00] text-gray-900">Who is this?</Badge> : null}
                  {r.actions
                    .filter((a) => a.type !== "ADD_INTERNAL_NOTE" && a.type !== "PROPOSE_LEAD_FACT_UPDATE")
                    .map((a) => (
                      <Badge key={a.id} className="bg-gray-100 text-gray-700" title={a.reason}>
                        {ACTION_LABELS[a.type as ActionType] ?? a.type}
                      </Badge>
                    ))}
                </span>
              </summary>
              <div className="mt-3 space-y-3 border-l-2 border-gray-100 pl-3">
                <UnderstandingView u={r.understanding} />
                <ul className="space-y-1">
                  {r.actions.map((a) => (
                    <li key={a.id} className="flex flex-wrap items-center gap-2 text-xs">
                      <ActionStatus status={a.status} />
                      <span className="font-medium text-gray-900">{ACTION_LABELS[a.type as ActionType] ?? a.type}</span>
                      <span className="text-gray-600">{a.reason}</span>
                      {a.result && typeof a.result.reason === "string" ? <span className="text-gray-500">({a.result.reason})</span> : null}
                      {a.result && typeof a.result.error === "string" ? <span className="text-red-600">({a.result.error})</span> : null}
                      {a.result && typeof a.result.quoteId === "string" ? (
                        <Link href={`/quotes/${a.result.quoteId}`} className="text-brand-700 hover:underline">
                          open quote
                        </Link>
                      ) : null}
                      {a.result && typeof a.result.draftId === "string" ? (
                        <Link href="/approvals" className="text-brand-700 hover:underline">
                          draft in Approvals
                        </Link>
                      ) : null}
                    </li>
                  ))}
                </ul>
                <div className="flex items-center gap-3 text-xs">
                  {r.source ? (
                    <Link href={r.source.href} className="text-brand-700 hover:underline">
                      Open {sourceLabel(r.inspection.sourceType)}
                    </Link>
                  ) : null}
                  {r.subject ? (
                    <Link href={r.subject.href} className="text-brand-700 hover:underline">
                      {r.subject.label}
                    </Link>
                  ) : null}
                  <ReinspectButton sourceType={r.inspection.sourceType as "email" | "recording"} sourceId={r.inspection.sourceId} />
                </div>
              </div>
            </details>
          ))}
        </div>
      </Card>

      <Card data-testid="inspector-jev">
        <CardHeader title="Jev (shadow mode)" />
        {jev.rows.length === 0 ? (
          <p className="px-4 py-3 text-sm text-gray-500">Jev is not switched on, so there is nothing to compare yet. In shadow mode it only classifies; the rules above decide everything.</p>
        ) : (
          <div className="space-y-3 p-4 text-sm">
            <p className="text-gray-600">
              Jev&apos;s answers beside the rules&apos; and what you actually did. It never drives an action, a price or a design.
            </p>
            <p className="flex flex-wrap gap-2 text-xs">
              {jev.fields.map((f) => (
                <span key={f} className="rounded-md bg-gray-100 px-2 py-1">
                  {f.replace(/_/g, " ")}: agrees {jev.agreement[f].same}/{jev.agreement[f].of}
                </span>
              ))}
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-gray-500">
                  <tr>
                    <th className="py-1 pr-3 font-medium">Source</th>
                    <th className="py-1 pr-3 font-medium">Rules</th>
                    <th className="py-1 pr-3 font-medium">Jev</th>
                    <th className="py-1 pr-3 font-medium">Chris</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 align-top">
                  {jev.rows.map((r) => (
                    <tr key={r.id}>
                      <td className="py-1.5 pr-3">
                        <span className="block font-medium text-gray-900">{r.source?.title ?? "—"}</span>
                        <span className="text-gray-500">{formatDateTime(r.createdAt)}</span>
                      </td>
                      <td className="py-1.5 pr-3">{String(r.deterministic.intent)} · {String(r.deterministic.next_move)} · {String(r.deterministic.quote_readiness)}</td>
                      <td className="py-1.5 pr-3">
                        {r.output ? (
                          <>
                            {String(r.output.intent)} · {String(r.output.next_move)} · {String(r.output.quote_readiness)}
                            <span className="block text-gray-500">{Math.round(Number(r.output.confidence ?? 0) * 100)}% · {String(r.output.reason ?? "")}</span>
                          </>
                        ) : (
                          <span className="text-red-600">{r.error ?? "no answer"}</span>
                        )}
                      </td>
                      <td className="py-1.5 pr-3 text-gray-700">{r.chrisDecision ? Object.entries(r.chrisDecision).map(([k, v]) => `${k.replace(/^action:/, "")}: ${typeof v === "string" ? v : "chosen"}`).join(", ") : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
