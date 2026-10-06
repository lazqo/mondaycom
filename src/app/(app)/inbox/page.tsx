import type { Metadata } from "next";
import Link from "next/link";
import { Paperclip } from "lucide-react";
import { listMailboxes } from "@/queries/email";
import { listTriagedInbox } from "@/queries/inbox-triage";
import { requireOffice } from "@/lib/auth";
import { EmptyState, LinkButton } from "@/components/ui";
import { SyncNowButton } from "@/components/inbox/sync-now-button";
import { InboxSearch } from "@/components/inbox/inbox-search";
import { TriageAction, TriageCell } from "@/components/inbox/triage-cell";
import { CATEGORY_META, INBOX_TABS, LEGACY_TABS, type InboxTab } from "@/lib/inbox/triage";
import { LEAD_STATUS_META } from "@/lib/constants";
import { cn, formatDateTime } from "@/lib/utils";

export const metadata: Metadata = { title: "Inbox" };

/**
 * The inbox says what each email is (Hermes's category) and what to do about it (the state of
 * play and the one click it waits on). Tabs are the categories, plus what needs Chris.
 */
export default async function InboxPage({ searchParams }: { searchParams: Promise<{ filter?: string; q?: string }> }) {
  await requireOffice();
  const sp = await searchParams;
  const wanted = sp.filter ? (LEGACY_TABS[sp.filter] ?? sp.filter) : "all";
  const tab = (INBOX_TABS.some((t) => t.key === wanted) ? wanted : "all") as InboxTab;
  const q = sp.q ?? "";
  const [{ rows, counts, capped }, boxes] = await Promise.all([listTriagedInbox({ tab, q }), listMailboxes()]);
  const total = counts.all ?? 0;
  const active = boxes.filter((b) => b.active);
  const hint = tab === "all" || tab === "attention" ? null : CATEGORY_META[tab].hint;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Inbox</h1>
          <p className="text-sm text-gray-500">
            {total}
            {capped ? "+" : ""} emails · {active.length ? active.map((b) => b.emailAddress).join(", ") : "no email account connected"}
            {tab === "attention" && rows.length ? " · each line says what it waits on; decide with the buttons on the right, or open it" : ""}
            {tab === "accounting" ? " · statements, invoices and remittances: this list will feed Money" : hint ? ` · ${hint}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {active.length ? <SyncNowButton mailboxes={active.map((b) => ({ id: b.id, emailAddress: b.emailAddress }))} /> : null}
          <LinkButton variant="secondary" href="/settings/mailboxes">
            Email accounts
          </LinkButton>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav className="flex flex-wrap gap-1 rounded-md border border-gray-300 bg-white p-0.5">
          {INBOX_TABS.map((t) => {
            const n = counts[t.key] ?? 0;
            if (n === 0 && t.key !== "all" && t.key !== "attention" && tab !== t.key) return null;
            return (
              <Link
                key={t.key}
                href={`/inbox?filter=${t.key}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
                className={cn("flex items-center gap-1.5 rounded px-2.5 py-1 text-sm font-medium", tab === t.key ? "bg-brand-600 text-white" : "text-gray-700 hover:bg-gray-100")}
                data-testid={`inbox-tab-${t.key}`}
              >
                {t.label}
                <span className={cn("rounded px-1 text-xs", tab === t.key ? "bg-white/25" : t.key === "attention" && n ? "bg-[#ffcb00] text-gray-900" : "bg-gray-100 text-gray-600")}>{n}</span>
              </Link>
            );
          })}
        </nav>
        <InboxSearch filter={tab} q={q} />
      </div>

      {active.length === 0 && total === 0 ? (
        <EmptyState title="No mailbox connected yet" hint="Connect your Titan mailbox to start receiving enquiries here." action={<LinkButton href="/settings/mailboxes">Connect mailbox</LinkButton>} />
      ) : rows.length === 0 ? (
        <EmptyState
          title={q ? "No emails match" : tab === "attention" ? "Nothing needs you" : "No emails here yet"}
          hint={q ? "Try a different word, or search by the sender's address." : tab === "attention" ? "When Hermes is not sure, or has a proposal for you, it lands here with the reason." : tab === "all" ? "New enquiries appear here within a minute of arriving in the mailbox." : "Nothing in this view right now."}
        />
      ) : (
        <div className="overflow-x-auto rounded-md border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs font-medium text-gray-500">
              <tr>
                <th className="px-3 py-2 text-left">Sender</th>
                <th className="px-3 py-2 text-left">Subject</th>
                <th className="px-3 py-2 text-left">Received</th>
                <th className="px-3 py-2 text-left">What it is · what to do</th>
                <th className="px-3 py-2 text-left">Linked to</th>
                <th className="px-3 py-2 text-left"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((e) => (
                <tr key={e.id} className={cn("hover:bg-gray-50", e.triage.tone === "attention" && "bg-[#fffbe6]/60")} data-testid={`inbox-row-${e.id}`}>
                  <td className="max-w-[180px] px-3 py-2">
                    <div className="truncate font-medium text-gray-900">{e.fromName || e.fromAddress}</div>
                    {e.fromName ? <div className="truncate text-xs text-gray-500">{e.fromAddress}</div> : null}
                  </td>
                  <td className="max-w-[360px] px-3 py-2">
                    <Link href={`/inbox/${e.threadId}`} className="block truncate font-medium text-gray-900 hover:text-brand-700 hover:underline">
                      {e.subject || "(no subject)"}
                      {e.hasAttachments ? <Paperclip className="ml-1 inline h-3.5 w-3.5 text-gray-400" /> : null}
                      {e.thread.messageCount > 1 ? <span className="ml-1 text-xs text-gray-500">({e.thread.messageCount})</span> : null}
                    </Link>
                    <div className="truncate text-xs text-gray-500">{e.snippet}</div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-gray-600">{formatDateTime(e.receivedAt)}</td>
                  <td className="max-w-[360px] px-3 py-2">
                    <TriageCell triage={e.triage} />
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
                    ) : e.thread.job ? (
                      <Link href={`/jobs/${e.thread.job.id}`} className="hover:underline">
                        J-{e.thread.job.number}
                      </Link>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <TriageAction emailId={e.id} triage={e.triage} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
