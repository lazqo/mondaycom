import Link from "next/link";
import { Badge, Card, CardHeader } from "@/components/ui";
import { ACTION_LABELS } from "@/lib/inspector/labels";
import type { ActionType } from "@/lib/inspector/types";
import { formatDateTime } from "@/lib/utils";
import type { FeedItem } from "@/queries/decisions";

const TONE: Record<string, string> = { done: "bg-[#00c875] text-white", accepted: "bg-[#0086c0] text-white", already_in_hand: "bg-gray-200 text-gray-700", blocked: "bg-[#fdab3d] text-white" };

function line(f: FeedItem): string {
  const r = f.result ?? {};
  if (f.status === "already_in_hand" && typeof r.inHand === "string") return r.inHand;
  if (f.status === "blocked" && typeof r.reason === "string") return `Not done: ${r.reason}`;
  if (f.type === "CREATE_INTERNAL_TASK" || f.type === "CALL_CUSTOMER" || f.type === "PREPARE_FOLLOW_UP") return typeof r.inHand === "string" ? r.inHand : f.reason;
  if (f.type === "RUN_BUSINESS_BRAIN") return r.siteVisitRequired ? "Business Brain ran: a site visit is needed first." : r.complete ? "Business Brain ran: fully priced." : "Business Brain ran: not fully priced yet.";
  if (f.type === "PREPARE_QUOTE") return r.quoteNumber ? `Quote Q-${r.quoteNumber} prepared; waits for your approval.` : f.reason;
  if (f.type === "DRAFT_EMAIL") return r.note ? String(r.note) : "Reply drafted; waits for your approval.";
  if (f.type === "ASK_CHRIS") return typeof r.answer === "string" ? `Asked: ${String(f.reason)} — you answered: ${r.answer}` : f.reason;
  if (f.type === "RESOLVE_COMMITMENT") return `Commitment kept: “${String(r.action ?? "")}”.`;
  if (f.type === "REQUEST_RESEARCH") return r.summary ? `Research: ${String(r.summary).slice(0, 160)}` : f.reason;
  return f.reason;
}

/** What Hermes did since Chris last looked: one line each, newest first. */
export function HermesFeed({ items, subjects }: { items: FeedItem[]; subjects: Map<string, { label: string; href: string }> }) {
  return (
    <Card data-testid="hermes-feed">
      <CardHeader
        title="What Hermes did"
        action={
          <Link href="/inspector" className="text-sm text-brand-700 hover:underline">
            Every reading →
          </Link>
        }
      />
      {items.length === 0 ? <p className="px-4 py-3 text-sm text-gray-500">Nothing yet. As emails and conversations come in, what Hermes does with them shows here.</p> : null}
      <ul className="divide-y divide-gray-100">
        {items.map((f) => {
          const subject = subjects.get(f.jobId ?? f.leadId ?? f.contactId ?? "");
          return (
            <li key={f.id} className="flex flex-wrap items-center gap-2 px-4 py-2 text-xs">
              <Badge className={TONE[f.status] ?? "bg-gray-200 text-gray-700"}>{ACTION_LABELS[f.type as ActionType] ?? f.type}</Badge>
              <span className="min-w-0 flex-1 text-gray-800">{line(f)}</span>
              {subject ? (
                <Link href={subject.href} className="text-brand-700 hover:underline">
                  {subject.label}
                </Link>
              ) : null}
              <span className="text-gray-400">{formatDateTime(f.at)}</span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
