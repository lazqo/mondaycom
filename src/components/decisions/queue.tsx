import Link from "next/link";
import { Badge, Card, CardHeader } from "@/components/ui";
import { DraftCard } from "@/components/brain/draft-card";
import { CandidateDecision } from "@/components/brain/research-panel";
import { PackageDecision } from "@/components/brain/package-panel";
import { ReviewCard } from "@/components/inspector/review-card";
import { AwaitingLine, ConflictLine } from "@/components/inspector/views";
import { QUOTE_STATUS_META, type QuoteStatus } from "@/lib/constants";
import { formatDateTime, formatMoney } from "@/lib/utils";
import type { DecisionKind, Decisions } from "@/queries/decisions";

const ALL: DecisionKind[] = ["review", "proposal", "quote", "reply", "fact", "package", "knowledge"];
const TITLES: Record<DecisionKind, string> = {
  review: "Hermes needs you to decide",
  proposal: "Proposed: site visits, bookings, revised quotes, links",
  quote: "Quotes ready for your approval",
  reply: "Replies ready for your approval",
  fact: "Facts to check",
  package: "Proposed packages",
  knowledge: "Proposed Business Brain updates",
};
const EMPTY: Record<DecisionKind, string> = {
  review: "Nothing Hermes could not settle.",
  proposal: "No site visits, bookings or revised quotes waiting.",
  quote: "No quotes waiting.",
  reply: "No replies waiting.",
  fact: "Nothing new disagrees with the CRM.",
  package: "No proposed packages.",
  knowledge: "No proposed updates.",
};
const count = (n: number) => <Badge className={n ? "bg-[#ffcb00] text-gray-900" : "bg-gray-100 text-gray-500"}>{n}</Badge>;

/**
 * The one place Chris approves, changes or rejects what Hermes did or wants to do. Each card is the
 * thing itself (the quote, the reply, the slot, the question) with its buttons; the guardrail detail
 * stays behind "details" on the Hermes page.
 */
export function DecisionsQueue({ d, canApprove, kinds = ALL, showEmpty = true }: { d: Decisions; canApprove: boolean; kinds?: DecisionKind[]; showEmpty?: boolean }) {
  const n = (k: DecisionKind) => (k === "review" ? d.review.length : k === "proposal" ? d.proposal.length : k === "quote" ? d.quote.length : k === "reply" ? d.reply.length : k === "fact" ? d.fact.length : k === "package" ? d.package.length : d.knowledge.length);
  const shown = kinds.filter((k) => showEmpty || n(k) > 0);
  if (!shown.length) return null;
  return (
    <div className="space-y-4" data-testid="decisions">
      {shown.map((k) => (
        <Card key={k} data-testid={`decisions-${k}`}>
          <CardHeader
            title={
              <span className="inline-flex items-center gap-2">
                {TITLES[k]} {count(n(k))}
              </span>
            }
          />
          {n(k) === 0 ? <p className="px-4 py-3 text-sm text-gray-500">{EMPTY[k]}</p> : null}
          <div className="divide-y divide-gray-100">
            {k === "review" ? d.review.map((r) => <ReviewCard key={r.inspection.id} item={r} canApprove={canApprove} />) : null}
            {k === "proposal" ? d.proposal.map((a) => <AwaitingLine key={a.action.id} item={a} canApprove={canApprove} />) : null}
            {k === "quote"
              ? d.quote.map((q) => (
                  <Link key={q.id} href={`/quotes/${q.id}`} className="flex items-center justify-between px-4 py-2.5 text-sm hover:bg-gray-50" data-testid="approval-quote">
                    <span>
                      <span className="font-medium text-gray-900">Q-{q.number}</span> {q.title}
                      <span className="text-gray-500"> · {q.who ?? "—"}</span>
                      {q.origin === "brain" ? <span className="text-gray-500"> · prepared by the Business Brain</span> : null}
                    </span>
                    <span className="flex items-center gap-3">
                      <span>{formatMoney(q.total)}</span>
                      <Badge className={`${QUOTE_STATUS_META[q.status as QuoteStatus].bg} ${QUOTE_STATUS_META[q.status as QuoteStatus].text}`}>{QUOTE_STATUS_META[q.status as QuoteStatus].label}</Badge>
                      <span className="text-xs text-brand-700">Review and approve →</span>
                    </span>
                  </Link>
                ))
              : null}
            {k === "reply"
              ? d.reply.map((r) => (
                  <div key={r.id} className="p-3">
                    <DraftCard draft={r} canApprove={canApprove} />
                  </div>
                ))
              : null}
            {k === "fact" ? d.fact.map((f) => <ConflictLine key={f.fact.id} item={f} />) : null}
            {k === "package"
              ? d.package.map((c) => (
                  <div key={c.id} className="space-y-2 px-4 py-3 text-sm" data-testid="package-candidate">
                    <p className="flex flex-wrap items-center gap-2">
                      <Badge className="bg-brand-100 text-brand-800">{c.kind === "new" ? "New package" : c.kind}</Badge>
                      <span className="font-medium text-gray-900">{c.name}</span>
                      <span className="text-xs text-gray-500">
                        {[c.propertyType, c.tier, c.cameraCount ? `${c.cameraCount} cameras` : null].filter(Boolean).join(" · ")} · {c.proposedBy === "crm:pattern" ? "repeated configuration" : "Hermes"} · {formatDateTime(c.createdAt)}
                      </span>
                      <Link href="/settings/brain/packages" className="text-xs text-brand-700 hover:underline">
                        Evidence →
                      </Link>
                    </p>
                    {c.reasoning ? <p className="text-gray-700">{c.reasoning}</p> : null}
                    {c.missing.length ? <p className="text-xs text-red-700">Missing: {c.missing.join("; ")}</p> : null}
                    <PackageDecision id={c.id} canApprove={canApprove} products={d.products} initial={{ name: c.name, key: c.key, tier: c.tier, cameraCount: c.cameraCount, components: c.components }} />
                  </div>
                ))
              : null}
            {k === "knowledge"
              ? d.knowledge.map((c) => (
                  <div key={c.id} className="space-y-1 px-4 py-3 text-sm" data-testid="brain-candidate">
                    <p className="flex flex-wrap items-center gap-2">
                      <Badge className="bg-brain-100 bg-brand-100 text-brand-800">{c.kind.replace(/_/g, " ")}</Badge>
                      <span className="font-medium text-gray-900">{c.title}</span>
                      <span className="text-xs text-gray-500">
                        {c.proposedBy} · {formatDateTime(c.createdAt)}
                        {c.confidence ? ` · ${Math.round(Number(c.confidence) * 100)}%` : ""}
                      </span>
                      <Link href="/settings/brain/research" className="text-xs text-brand-700 hover:underline">
                        Sources →
                      </Link>
                    </p>
                    {c.detail ? <p className="text-gray-700">{c.detail}</p> : null}
                    <CandidateDecision id={c.id} canApprove={canApprove} />
                  </div>
                ))
              : null}
          </div>
        </Card>
      ))}
    </div>
  );
}
