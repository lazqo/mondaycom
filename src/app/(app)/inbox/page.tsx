import type { Metadata } from "next";
import Link from "next/link";
import { Paperclip } from "lucide-react";
import { listInbox, inboxCounts, listMailboxes, type InboxFilter } from "@/queries/email";
import { Badge, EmptyState, LinkButton } from "@/components/ui";
import { SyncNowButton } from "@/components/inbox/sync-now-button";
import { InboxSearch } from "@/components/inbox/inbox-search";
import { EMAIL_CLASSIFICATION_META, LEAD_STATUS_META } from "@/lib/constants";
import { cn, formatDateTime } from "@/lib/utils";

export const metadata: Metadata = { title: "Inbox" };

const TABS: { key: InboxFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "needs_review", label: "Needs review" },
  { key: "lead", label: "Leads" },
  { key: "existing", label: "Existing" },
  { key: "not_lead", label: "Not leads" },
  { key: "error", label: "Errors" },
];

export default async function InboxPage({ searchParams }: { searchParams: Promise<{ filter?: string; q?: string }> }) {
  const sp = await searchParams;
  const filter = (TABS.some((t) => t.key === sp.filter) ? sp.filter : "all") as InboxFilter;
  const q = sp.q ?? "";
  const [rows, counts, boxes] = await Promise.all([listInbox({ filter, q }), inboxCounts(), listMailboxes()]);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const active = boxes.filter((b) => b.active);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Inbox</h1>
          <p className="text-sm text-gray-500">
            {total} emails · {active.length ? active.map((b) => b.emailAddress).join(", ") : "no mailbox connected"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {active.length ? <SyncNowButton mailboxes={active.map((b) => ({ id: b.id, emailAddress: b.emailAddress }))} /> : null}
          <LinkButton variant="secondary" href="/settings/mailboxes">
            Mailboxes
          </LinkButton>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav className="flex flex-wrap gap-1 rounded-md border border-gray-300 bg-white p-0.5">
          {TABS.map((t) => {
            const n = t.key === "all" ? total : (counts[t.key] ?? 0);
            return (
              <Link
                key={t.key}
                href={`/inbox?filter=${t.key}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
                className={cn(
                  "flex items-center gap-1.5 rounded px-2.5 py-1 text-sm font-medium",
                  filter === t.key ? "bg-brand-600 text-white" : "text-gray-700 hover:bg-gray-100",
                )}
              >
                {t.label}
                <span className={cn("rounded px-1 text-xs", filter === t.key ? "bg-white/25" : "bg-gray-100 text-gray-600")}>{n}</span>
              </Link>
            );
          })}
        </nav>
        <InboxSearch filter={filter} q={q} />
      </div>

      {active.length === 0 && total === 0 ? (
        <EmptyState
          title="No mailbox connected yet"
          hint="Connect your Titan mailbox to start receiving enquiries here."
          action={<LinkButton href="/settings/mailboxes">Connect mailbox</LinkButton>}
        />
      ) : rows.length === 0 ? (
        <EmptyState title="Nothing here" hint={q ? "No emails match your search." : "No emails in this view."} />
      ) : (
        <div className="overflow-x-auto rounded-md border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs font-medium text-gray-500">
              <tr>
                <th className="px-3 py-2 text-left">Sender</th>
                <th className="px-3 py-2 text-left">Subject</th>
                <th className="px-3 py-2 text-left">Received</th>
                <th className="px-3 py-2 text-left">Classification</th>
                <th className="px-3 py-2 text-left">Linked to</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((e) => {
                const meta = EMAIL_CLASSIFICATION_META[e.classification];
                return (
                  <tr key={e.id} className="hover:bg-gray-50" data-testid={`inbox-row-${e.id}`}>
                    <td className="max-w-[220px] px-3 py-2">
                      <div className="truncate font-medium text-gray-900">{e.fromName || e.fromAddress}</div>
                      {e.fromName ? <div className="truncate text-xs text-gray-500">{e.fromAddress}</div> : null}
                    </td>
                    <td className="max-w-[420px] px-3 py-2">
                      <Link href={`/inbox/${e.threadId}`} className="block truncate font-medium text-gray-900 hover:text-brand-700 hover:underline">
                        {e.subject || "(no subject)"}
                        {e.hasAttachments ? <Paperclip className="ml-1 inline h-3.5 w-3.5 text-gray-400" /> : null}
                        {e.thread.messageCount > 1 ? <span className="ml-1 text-xs text-gray-500">({e.thread.messageCount})</span> : null}
                      </Link>
                      <div className="truncate text-xs text-gray-500">{e.snippet}</div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-gray-600">{formatDateTime(e.receivedAt)}</td>
                    <td className="px-3 py-2">
                      <Badge className={`${meta.bg} ${meta.text}`}>{meta.label}</Badge>
                    </td>
                    <td className="px-3 py-2 text-gray-700">
                      {e.lead ? (
                        <Link href={`/leads/${e.lead.id}`} className="inline-flex items-center gap-1.5 hover:underline">
                          <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: LEAD_STATUS_META[e.lead.status].color }} />
                          {e.lead.name}
                        </Link>
                      ) : e.contact ? (
                        <Link href={`/contacts/${e.contact.id}`} className="hover:underline">
                          {e.contact.name}
                        </Link>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
