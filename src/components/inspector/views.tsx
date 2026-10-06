import Link from "next/link";
import { BookingDecision } from "@/components/inspector/controls";
import { AskCard } from "@/components/decisions/ask-card";
import { Badge } from "@/components/ui";
import { formatDateTime } from "@/lib/utils";
import type { CommitmentItem, ConflictItem, AwaitingItem } from "@/queries/inspector";
import type { ActionType, FactKey, Understanding } from "@/lib/inspector/types";
import { ACCEPT_LABELS, ACTION_LABELS, FACT_LABELS } from "@/lib/inspector/labels";
import { confidenceWord } from "@/lib/hermes/dial";

export { ACCEPT_LABELS, ACTION_LABELS, FACT_LABELS };
import { ActionDecision, CommitmentButtons, FactDecision } from "./controls";

const STATUS_TONE: Record<string, string> = {
  done: "bg-[#00c875] text-white",
  awaiting_approval: "bg-[#ffcb00] text-gray-900",
  accepted: "bg-[#0086c0] text-white",
  dismissed: "bg-gray-200 text-gray-600",
  blocked: "bg-[#fdab3d] text-white",
  failed: "bg-[#e2445c] text-white",
  outstanding: "bg-[#ff9900] text-white",
  already_in_hand: "bg-gray-200 text-gray-700",
};
export function ActionStatus({ status }: { status: string }) {
  return <Badge className={STATUS_TONE[status] ?? "bg-gray-200 text-gray-700"}>{status === "awaiting_approval" ? "Waiting for Chris" : status.replace(/_/g, " ")}</Badge>;
}

const fmt = (v: unknown) => (typeof v === "boolean" ? (v ? "yes" : "no") : v == null ? "—" : String(v));

export function sourceLabel(type: string | undefined) {
  return type === "recording" ? "Plaud conversation" : "email";
}

/** One commitment: who promised what, by when, and where it was said. */
export function CommitmentLine({ item, now = new Date(), showSubject = true }: { item: CommitmentItem; now?: Date; showSubject?: boolean }) {
  const c = item.commitment;
  const overdue = c.dueAt && c.dueAt < now;
  const customer = item.subject && !item.subject.href.startsWith("/jobs/") ? item.subject.label.split(" ")[0] : null;
  const who = c.owner === "get_secure" ? (c.ownerName ?? "Get Secure") : c.owner === "customer" ? (c.ownerName ?? customer ?? "Customer") : "Someone";
  return (
    <div className="flex items-start justify-between gap-3 px-4 py-2.5 text-sm" data-testid="commitment">
      <span className="min-w-0">
        <span className="block text-gray-900">
          <span className="font-medium">{who}</span>: {c.action}
          {c.dueText ? <span className="text-gray-500"> · {c.dueText}</span> : null}
        </span>
        <span className="block truncate text-xs text-gray-500">
          {c.dueAt ? <span className={overdue ? "font-medium text-red-600" : undefined}>{overdue ? "Overdue · was due " : "Due "}{formatDateTime(c.dueAt)} · </span> : null}
          {showSubject && item.subject ? (
            <Link href={item.subject.href} className="hover:underline">
              {item.subject.label}
            </Link>
          ) : null}
          {item.source ? (
            <>
              {showSubject && item.subject ? " · " : ""}
              said in{" "}
              <Link href={item.source.href} className="hover:underline">
                {sourceLabel(item.source.type)} “{item.source.title}”
              </Link>
            </>
          ) : null}
        </span>
      </span>
      <CommitmentButtons id={c.id} />
    </div>
  );
}

export function ConflictLine({ item, showSubject = true }: { item: ConflictItem; showSubject?: boolean }) {
  const f = item.fact;
  return (
    <div className="space-y-1.5 px-4 py-3 text-sm" data-testid="fact-conflict">
      <p className="text-gray-900">
        <span className="font-medium">{FACT_LABELS[f.key as FactKey] ?? f.key}</span>:{" "}
        {f.state === "proposed" ? (
          <>
            {f.sourceType === "hermes" ? "Hermes proposes" : `the ${sourceLabel(f.sourceType)} suggests`} <span className="font-medium">{f.display || fmt(f.value)}</span> (not filled in until you apply it)
          </>
        ) : (
          <>
            CRM has <span className="font-medium">{fmt(f.currentValue)}</span>, {f.sourceType === "hermes" ? "Hermes says" : `the new ${sourceLabel(f.sourceType)} says`} <span className="font-medium">{f.display || fmt(f.value)}</span>
          </>
        )}
        {showSubject && item.subject ? (
          <>
            {" · "}
            <Link href={item.subject.href} className="text-brand-700 hover:underline">
              {item.subject.label}
            </Link>
          </>
        ) : null}
      </p>
      {f.evidence ? <p className="text-xs italic text-gray-500">“{f.evidence}”</p> : null}
      <FactDecision factId={f.id} proposed={f.state === "proposed"} />
    </div>
  );
}

export function AwaitingLine({ item, canApprove, showSubject = true }: { item: AwaitingItem; canApprove: boolean; showSubject?: boolean }) {
  const a = item.action;
  if (a.type === "ASK_CHRIS") return <AskCard item={item} canApprove={canApprove} />;
  return (
    <div className="space-y-1.5 px-4 py-3 text-sm" data-testid="awaiting-action">
      <p className="text-gray-900">
        <Badge className="mr-2 bg-brand-100 text-brand-800">{ACTION_LABELS[a.type as ActionType] ?? a.type}</Badge>
        {a.reason}
      </p>
      <p className="text-xs text-gray-500">
        {confidenceWord(item.confidence) ? (
          <span data-testid="confidence-word" title={`Hermes's confidence: ${Math.round((item.confidence ?? 0) * 100)}%`}>
            Hermes is {confidenceWord(item.confidence)} ·{" "}
          </span>
        ) : null}
        Rule: {a.rule.replace(/_/g, " ")}
        {showSubject && item.subject ? (
          <>
            {" · "}
            <Link href={item.subject.href} className="hover:underline">
              {item.subject.label}
            </Link>
          </>
        ) : null}
        {item.source ? (
          <>
            {" · from "}
            <Link href={item.source.href} className="hover:underline">
              {sourceLabel(item.source.type)} “{item.source.title}”
            </Link>
          </>
        ) : null}
      </p>
      {(a.type === "PROPOSE_SITE_VISIT" || a.type === "PROPOSE_BOOKING") && Array.isArray((a.payload as { slots?: unknown }).slots) ? (
        <BookingDecision actionId={a.id} canApprove={canApprove} slots={(a.payload as { slots: { startsAt: string; endsAt: string; label: string }[] }).slots} kind={a.type} />
      ) : (
        <ActionDecision actionId={a.id} canApprove={canApprove} acceptLabel={ACCEPT_LABELS[a.type as ActionType]} />
      )}
    </div>
  );
}

/** What the Inspector understood, compactly: intent, facts with evidence, what is still missing. */
export function UnderstandingView({ u }: { u: Understanding }) {
  const blocking = u.missing.filter((m) => m.blocking);
  const other = u.missing.filter((m) => !m.blocking);
  return (
    <div className="space-y-2 text-sm">
      <p className="flex flex-wrap gap-1.5">
        {u.service ? <Badge className="bg-gray-100 text-gray-700">{u.service.replace(/_/g, " ")}</Badge> : null}
        {u.propertyType ? <Badge className="bg-gray-100 text-gray-700">{u.propertyType}</Badge> : null}
        <Badge className="bg-brand-100 text-brand-800">{u.primaryIntent.replace(/_/g, " ")}</Badge>
        {u.urgency !== "normal" ? <Badge className={u.urgency === "urgent" || u.urgency === "high" ? "bg-[#e2445c] text-white" : "bg-gray-100 text-gray-700"}>{u.urgency}</Badge> : null}
      </p>
      {u.facts.length ? (
        <ul className="grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-2">
          {u.facts.map((f, i) => (
            <li key={`${f.key}-${i}`} className="min-w-0 truncate" title={f.evidence}>
              <span className="text-gray-500">{FACT_LABELS[f.key] ?? f.key}:</span> {f.display}
            </li>
          ))}
        </ul>
      ) : null}
      {u.objections.length ? <p className="text-xs text-gray-600">Objection: {u.objections.map((o) => `${o.kind} (“${o.evidence}”)`).join("; ")}</p> : null}
      {blocking.length ? (
        <p className="text-xs text-red-700">
          Needed before {blocking[0].for}: {blocking.map((m) => m.label).join(", ")}
        </p>
      ) : null}
      {other.length ? <p className="text-xs text-gray-500">Nice to have (not asked for): {other.map((m) => m.label).join(", ")}</p> : null}
    </div>
  );
}
