"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Activity,
  ArrowDownUp,
  BellRing,
  Briefcase,
  CalendarDays,
  Camera,
  FileText,
  Flag,
  Inbox,
  MapPin,
  Mic,
  Paperclip,
  Phone,
  Send,
  Sparkles,
  StickyNote,
} from "lucide-react";
import { addTimelineEntry } from "@/actions/timeline";
import { Badge, Button, Card, CardHeader, FormError, Input, Select, Textarea } from "@/components/ui";
import type { TimelineKind } from "@/queries/timeline";
import { cn } from "@/lib/utils";

/** A timeline item as sent to the browser: dates as strings, already formatted in the business's zone. */
export type TimelineEntry = {
  id: string;
  at: string;
  when: string;
  kind: TimelineKind;
  title: string;
  meta?: string | null;
  body?: string | null;
  fullBody?: string | null;
  actor?: string | null;
  href?: string | null;
  source?: string | null;
  upcoming?: boolean;
  email?: { from: string; to: string; cc: string; subject: string; via: "inbox" | "crm" | "sent_folder"; threadId: string };
  attachments?: { id: string; name: string; href: string; size: number; image: boolean }[];
};

const ICON: Record<TimelineKind, React.ComponentType<{ className?: string }>> = {
  enquiry: Sparkles,
  email_in: Inbox,
  email_out: Send,
  note: StickyNote,
  call: Phone,
  status: Flag,
  follow_up: BellRing,
  site_visit: MapPin,
  appointment: CalendarDays,
  quote: FileText,
  job: Briefcase,
  photo: Camera,
  recording: Mic,
  activity: Activity,
};

const COLOR: Record<TimelineKind, string> = {
  enquiry: "bg-[#00c875] text-white",
  email_in: "bg-[#a25ddc] text-white",
  email_out: "bg-[#579bfc] text-white",
  note: "bg-[#ffcb00] text-gray-900",
  call: "bg-[#ff642e] text-white",
  status: "bg-gray-700 text-white",
  follow_up: "bg-[#fdab3d] text-white",
  site_visit: "bg-[#ff9900] text-white",
  appointment: "bg-[#0086c0] text-white",
  quote: "bg-[#0086c0] text-white",
  job: "bg-[#00c875] text-white",
  photo: "bg-[#784bd1] text-white",
  recording: "bg-[#e2445c] text-white",
  activity: "bg-gray-300 text-gray-800",
};

type Filter = "all" | "email" | "talk" | "visits" | "work" | "status";
const FILTERS: { key: Filter; label: string; kinds: TimelineKind[] }[] = [
  { key: "all", label: "Everything", kinds: [] },
  { key: "email", label: "Emails", kinds: ["enquiry", "email_in", "email_out"] },
  { key: "talk", label: "Notes & calls", kinds: ["note", "call", "recording"] },
  { key: "visits", label: "Visits & appointments", kinds: ["site_visit", "appointment"] },
  { key: "work", label: "Quotes & jobs", kinds: ["quote", "job", "photo"] },
  { key: "status", label: "Status & reminders", kinds: ["enquiry", "status", "follow_up", "activity"] },
];

const VIA: Record<"inbox" | "crm" | "sent_folder", string> = { inbox: "Received", crm: "Sent from the CRM", sent_folder: "Sent from Titan" };

export function Timeline({
  items,
  target,
  title = "Timeline",
  emptyHint,
  canWrite = true,
}: {
  items: TimelineEntry[];
  target: { type: "lead" | "contact"; id: string };
  title?: string;
  emptyHint?: string;
  /** Field technicians can read a customer's history but not add to it here. */
  canWrite?: boolean;
}) {
  const [filter, setFilter] = React.useState<Filter>("all");
  const [newestFirst, setNewestFirst] = React.useState(false);
  const matches = (f: (typeof FILTERS)[number], i: TimelineEntry) =>
    f.key === "all" || (f.kinds.includes(i.kind) && (i.kind !== "enquiry" || (f.key === "email" ? !!i.email : !i.email)));
  const current = FILTERS.find((f) => f.key === filter)!;
  const shown = items.filter((i) => matches(current, i));
  const ordered = newestFirst ? [...shown].reverse() : shown;
  // Where "now" falls, so upcoming visits read as upcoming rather than as history.
  const nowIndex = ordered.findIndex((i) => (newestFirst ? !i.upcoming : i.upcoming));

  return (
    <Card data-testid="timeline">
      <CardHeader
        title={`${title} · ${items.length}`}
        action={
          <button type="button" onClick={() => setNewestFirst((v) => !v)} className="inline-flex items-center gap-1 text-xs text-gray-600 hover:text-brand-700" data-testid="timeline-order">
            <ArrowDownUp className="h-3.5 w-3.5" /> {newestFirst ? "Newest first" : "Oldest first"}
          </button>
        }
      />
      {canWrite ? <Composer target={target} /> : null}
      <div className="flex flex-wrap gap-1 border-b border-gray-100 px-4 py-2 text-xs">
        {FILTERS.map((f) => {
          const n = items.filter((i) => matches(f, i)).length;
          return (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={cn("rounded px-2 py-0.5", filter === f.key ? "bg-gray-200 text-gray-900" : "text-gray-500 hover:bg-gray-100")}
            >
              {f.label} {n}
            </button>
          );
        })}
      </div>
      {ordered.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-gray-500">{emptyHint ?? "Nothing here yet."}</p>
      ) : (
        <ol className="relative px-4 py-3">
          <span aria-hidden className="absolute bottom-3 left-[29px] top-3 w-px bg-gray-200" />
          {ordered.map((it, i) => (
            <React.Fragment key={it.id}>
              {i === nowIndex && nowIndex > 0 ? (
                <li className="relative my-2 flex items-center gap-2 pl-9 text-[11px] font-semibold uppercase tracking-wide text-brand-700">
                  <span className="h-px flex-1 bg-brand-200" /> Now <span className="h-px flex-1 bg-brand-200" />
                </li>
              ) : null}
              <TimelineRow item={it} />
            </React.Fragment>
          ))}
        </ol>
      )}
    </Card>
  );
}

function TimelineRow({ item }: { item: TimelineEntry }) {
  const Icon = ICON[item.kind];
  const [open, setOpen] = React.useState(false);
  const long = (item.body?.length ?? 0) > 320 || (item.body?.split("\n").length ?? 0) > 6;
  const expandable = long || !!item.fullBody;
  const text = open && item.fullBody ? item.fullBody : item.body;

  return (
    <li className="relative flex gap-3 py-2.5" data-testid="timeline-item" data-kind={item.kind}>
      <span className={cn("relative z-10 mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ring-4 ring-white", COLOR[item.kind])}>
        <Icon className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <p className="text-sm font-medium text-gray-900">
            {item.href ? (
              <Link href={item.href} className="hover:text-brand-700 hover:underline">
                {item.title}
              </Link>
            ) : (
              item.title
            )}
            {item.upcoming ? <Badge className="ml-2 bg-brand-100 text-brand-800">Upcoming</Badge> : null}
          </p>
          <time dateTime={item.at} className="shrink-0 text-xs text-gray-500">
            {item.when}
          </time>
        </div>
        <p className="text-xs text-gray-500">
          {[item.actor ? `by ${item.actor}` : null, item.meta].filter(Boolean).join(" · ")}
          {item.source ? <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600">{item.source}</span> : null}
        </p>

        {item.email ? (
          <dl className="mt-1.5 grid grid-cols-[3.5rem_1fr] gap-x-2 rounded-md border border-gray-100 bg-gray-50 px-2.5 py-1.5 text-xs text-gray-700" data-testid="timeline-email">
            <dt className="text-gray-400">From</dt>
            <dd className="truncate">{item.email.from}</dd>
            <dt className="text-gray-400">To</dt>
            <dd className="truncate">{item.email.to || "—"}</dd>
            {item.email.cc ? (
              <>
                <dt className="text-gray-400">Cc</dt>
                <dd className="truncate">{item.email.cc}</dd>
              </>
            ) : null}
            <dt className="text-gray-400">Subject</dt>
            <dd className="truncate font-medium text-gray-900">{item.email.subject}</dd>
            <dt className="text-gray-400">{item.email.via === "inbox" ? "Received" : "Sent"}</dt>
            <dd>
              {item.when}{" "}
              <Badge className={item.email.via === "sent_folder" ? "bg-[#579bfc]/15 text-[#1f5fbf]" : item.email.via === "crm" ? "bg-brand-100 text-brand-800" : "bg-gray-200 text-gray-700"}>
                {VIA[item.email.via]}
              </Badge>
            </dd>
          </dl>
        ) : null}

        {text ? (
          <div className="mt-1.5">
            <p className={cn("whitespace-pre-wrap break-words text-sm text-gray-800", !open && long && "line-clamp-5")}>{text}</p>
            {expandable ? (
              <button type="button" onClick={() => setOpen((v) => !v)} className="mt-0.5 text-xs text-brand-700 hover:underline">
                {open ? "Show less" : item.fullBody ? "Show the whole email" : "Show more"}
              </button>
            ) : null}
          </div>
        ) : null}

        {item.attachments?.length ? (
          <ul className="mt-2 flex flex-wrap gap-2">
            {item.attachments.map((a) =>
              a.image && a.href.startsWith("/api/photos/") ? (
                <li key={a.id}>
                  <a href={a.href} target="_blank" rel="noreferrer" title={a.name}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={a.href} alt={a.name} className="h-16 w-16 rounded border border-gray-200 object-cover" loading="lazy" />
                  </a>
                </li>
              ) : (
                <li key={a.id}>
                  <a href={a.href} className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50">
                    <Paperclip className="h-3.5 w-3.5" />
                    {a.name} <span className="text-gray-400">({Math.max(1, Math.round(a.size / 1024))} KB)</span>
                  </a>
                </li>
              ),
            )}
          </ul>
        ) : null}
      </div>
    </li>
  );
}

function Composer({ target }: { target: { type: "lead" | "contact"; id: string } }) {
  const router = useRouter();
  const [type, setType] = React.useState<"note" | "call">("note");
  const [body, setBody] = React.useState("");
  const [direction, setDirection] = React.useState<"outgoing" | "incoming">("outgoing");
  const [outcome, setOutcome] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  function save() {
    setError(null);
    startTransition(async () => {
      const res = await addTimelineEntry({ target: target.type, id: target.id, type, body, direction: type === "call" ? direction : undefined, outcome: type === "call" ? outcome : undefined });
      if (!res.ok) return setError(res.error);
      setBody("");
      setOutcome("");
      router.refresh();
    });
  }

  return (
    <div className="space-y-2 border-b border-gray-100 p-4" data-testid="timeline-composer">
      <div className="flex gap-1 text-xs" role="tablist">
        {(["note", "call"] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={type === t}
            onClick={() => setType(t)}
            className={cn("inline-flex items-center gap-1 rounded px-2 py-1", type === t ? "bg-gray-200 font-medium text-gray-900" : "text-gray-500 hover:bg-gray-100")}
          >
            {t === "note" ? <StickyNote className="h-3.5 w-3.5" /> : <Phone className="h-3.5 w-3.5" />}
            {t === "note" ? "Note" : "Log a call"}
          </button>
        ))}
      </div>
      {type === "call" ? (
        <div className="flex flex-wrap gap-2">
          <Select value={direction} onChange={(e) => setDirection(e.target.value as "outgoing" | "incoming")} className="max-w-[12rem]" aria-label="Who called">
            <option value="outgoing">I called them</option>
            <option value="incoming">They called me</option>
          </Select>
          <Input value={outcome} onChange={(e) => setOutcome(e.target.value)} placeholder="Outcome, e.g. booked a site visit" className="max-w-xs flex-1" aria-label="Call outcome" />
        </div>
      ) : null}
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={type === "note" ? "Anything worth remembering" : "What was said"}
        className="min-h-16"
        aria-label={type === "note" ? "New note" : "Call details"}
      />
      <div className="flex items-center justify-between">
        <FormError message={error} />
        <Button size="sm" onClick={save} disabled={pending || (type === "note" ? !body.trim() : !body.trim() && !outcome.trim())} data-testid="timeline-save">
          {type === "note" ? "Add note" : "Log call"}
        </Button>
      </div>
    </div>
  );
}
