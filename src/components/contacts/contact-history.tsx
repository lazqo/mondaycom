"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Mail, Kanban, FileText, Briefcase, MapPin, CalendarDays, StickyNote, Activity } from "lucide-react";
import { addContactNote } from "@/actions/contacts";
import { Button, Card, CardHeader, FormError, Textarea } from "@/components/ui";
import type { HistoryItem } from "@/queries/contact-history";
import { cn, formatDate } from "@/lib/utils";

const ICONS = { email: Mail, lead: Kanban, quote: FileText, job: Briefcase, site_visit: MapPin, appointment: CalendarDays, note: StickyNote, activity: Activity } as const;
const COLORS = { email: "text-[#a25ddc]", lead: "text-[#579bfc]", quote: "text-[#0086c0]", job: "text-[#00c875]", site_visit: "text-[#ff9900]", appointment: "text-gray-500", note: "text-[#ffcb00]", activity: "text-gray-400" } as const;
type Filter = "all" | "email" | "lead" | "quote" | "job" | "site_visit" | "note";

export function ContactHistory({ contactId, items }: { contactId: string; items: HistoryItem[] }) {
  const router = useRouter();
  const [filter, setFilter] = React.useState<Filter>("all");
  const [note, setNote] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();
  const shown = items.filter((i) => filter === "all" || i.kind === filter || (filter === "job" && i.kind === "appointment"));
  const counts = (k: Filter) => (k === "all" ? items.length : items.filter((i) => i.kind === k).length);

  return (
    <Card>
      <CardHeader
        title="History"
        action={
          <div className="flex flex-wrap gap-1 text-xs">
            {(["all", "email", "lead", "site_visit", "quote", "job", "note"] as Filter[]).map((f) => (
              <button key={f} type="button" onClick={() => setFilter(f)} className={cn("rounded px-2 py-0.5", filter === f ? "bg-gray-200 text-gray-900" : "text-gray-500 hover:bg-gray-100")}>
                {f === "all" ? "All" : f === "site_visit" ? "Site visits" : f === "email" ? "Emails" : f === "lead" ? "Leads" : f === "quote" ? "Quotes" : f === "job" ? "Jobs" : "Notes"} {counts(f)}
              </button>
            ))}
          </div>
        }
      />
      <div className="space-y-2 border-b border-gray-100 p-4">
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Log a call, a conversation, or anything worth remembering about this customer" className="min-h-16" aria-label="New note" />
        <div className="flex items-center justify-between">
          <FormError message={error} />
          <Button
            size="sm"
            disabled={pending || !note.trim()}
            onClick={() =>
              startTransition(async () => {
                const res = await addContactNote(contactId, note);
                if (!res.ok) return setError(res.error);
                setNote("");
                router.refresh();
              })
            }
          >
            Add note
          </Button>
        </div>
      </div>
      {shown.length === 0 ? <p className="px-4 py-6 text-center text-sm text-gray-500">Nothing here yet. Emails, leads, quotes, jobs and site visits for this customer will appear as they happen.</p> : null}
      <ol className="divide-y divide-gray-100">
        {shown.map((it) => {
          const Icon = ICONS[it.kind];
          const inner = (
            <div className="flex items-start gap-3 px-4 py-2.5 text-sm">
              <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", COLORS[it.kind])} />
              <div className="min-w-0 flex-1">
                <p className={cn("text-gray-900", it.kind === "note" ? "whitespace-pre-wrap" : "truncate font-medium")}>{it.title}</p>
                {it.detail ? <p className="truncate text-xs text-gray-500">{it.detail}</p> : null}
              </div>
              <span className="shrink-0 text-xs text-gray-400">
                {formatDate(it.at)}
                {it.meta ? ` · ${it.meta.replace(/_/g, " ")}` : ""}
              </span>
            </div>
          );
          return (
            <li key={it.id} data-testid={`history-${it.kind}`}>
              {it.href ? (
                <Link href={it.href} className="block hover:bg-gray-50">
                  {inner}
                </Link>
              ) : (
                inner
              )}
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
