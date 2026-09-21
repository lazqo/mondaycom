import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { globalSearch } from "@/queries/search";
import { Badge, Card, CardHeader, EmptyState } from "@/components/ui";
import { StatusPill } from "@/components/leads/cells";
import { EMAIL_CLASSIFICATION_META, JOB_STATUS_META, QUOTE_STATUS_META } from "@/lib/constants";
import { formatDateTime, formatMoney } from "@/lib/utils";

export const metadata: Metadata = { title: "Search" };

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const user = await requireUser();
  const { q = "" } = await searchParams;
  const r = await globalSearch(q);
  const office = user.role !== "field";
  const total = r.contacts.length + r.jobs.length + (office ? r.leads.length + r.quotes.length + r.emails.length : 0);
  const row = "flex items-center justify-between gap-3 px-4 py-2.5 text-sm hover:bg-gray-50";

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Search</h1>
        <p className="text-sm text-gray-500">{q ? `${total} results for “${q}”` : "Type a name, phone number, email or address in the search box."}</p>
      </div>
      {q && total === 0 ? <EmptyState title="No matches" hint="Try part of the name, the phone digits only, or the street name." /> : null}

      {r.contacts.length ? (
        <Card>
          <CardHeader title={`Customers (${r.contacts.length})`} />
          <div className="divide-y divide-gray-100">
            {r.contacts.map((c) => (
              <Link key={c.id} href={`/contacts/${c.id}`} className={row}>
                <span className="min-w-0">
                  <span className="block truncate font-medium text-gray-900">
                    {c.name}
                    {c.company ? <span className="font-normal text-gray-500"> · {c.company}</span> : null}
                  </span>
                  <span className="block truncate text-xs text-gray-500">{[c.phone, c.email, c.address].filter(Boolean).join(" · ")}</span>
                </span>
              </Link>
            ))}
          </div>
        </Card>
      ) : null}

      {office && r.leads.length ? (
        <Card>
          <CardHeader title={`Leads (${r.leads.length})`} />
          <div className="divide-y divide-gray-100">
            {r.leads.map((l) => (
              <Link key={l.id} href={`/leads/${l.id}`} className={row}>
                <span className="min-w-0">
                  <span className="block truncate font-medium text-gray-900">
                    {l.name}
                    {l.company ? <span className="font-normal text-gray-500"> · {l.company}</span> : null}
                  </span>
                  <span className="block truncate text-xs text-gray-500">{[l.service, l.phone, l.email, l.site].filter(Boolean).join(" · ")}</span>
                </span>
                <StatusPill value={l.status} />
              </Link>
            ))}
          </div>
        </Card>
      ) : null}

      {r.jobs.length ? (
        <Card>
          <CardHeader title={`Jobs (${r.jobs.length})`} />
          <div className="divide-y divide-gray-100">
            {r.jobs.map((j) => (
              <Link key={j.id} href={`/jobs/${j.id}`} className={row}>
                <span className="min-w-0">
                  <span className="block truncate font-medium text-gray-900">
                    J-{j.number} {j.title}
                  </span>
                  <span className="block truncate text-xs text-gray-500">{[j.contact.name, j.siteAddress].filter(Boolean).join(" · ")}</span>
                </span>
                <Badge className={`${JOB_STATUS_META[j.status].bg} ${JOB_STATUS_META[j.status].text}`}>{JOB_STATUS_META[j.status].label}</Badge>
              </Link>
            ))}
          </div>
        </Card>
      ) : null}

      {office && r.quotes.length ? (
        <Card>
          <CardHeader title={`Quotes (${r.quotes.length})`} />
          <div className="divide-y divide-gray-100">
            {r.quotes.map((qt) => (
              <Link key={qt.id} href={`/quotes/${qt.id}`} className={row}>
                <span className="truncate">
                  <span className="font-medium text-gray-900">Q-{qt.number}</span> {qt.title} · <span className="text-gray-500">{qt.contact.name}</span>
                </span>
                <span className="flex items-center gap-2 text-xs">
                  {formatMoney(qt.total)}
                  <Badge className={`${QUOTE_STATUS_META[qt.status].bg} ${QUOTE_STATUS_META[qt.status].text}`}>{QUOTE_STATUS_META[qt.status].label}</Badge>
                </span>
              </Link>
            ))}
          </div>
        </Card>
      ) : null}

      {office && r.emails.length ? (
        <Card>
          <CardHeader title={`Emails (${r.emails.length})`} />
          <div className="divide-y divide-gray-100">
            {r.emails.map((e) => (
              <Link key={e.id} href={`/inbox/${e.threadId}`} className={row}>
                <span className="min-w-0">
                  <span className="block truncate font-medium text-gray-900">{e.subject || "(no subject)"}</span>
                  <span className="block truncate text-xs text-gray-500">
                    {e.fromName || e.fromAddress} · {formatDateTime(e.receivedAt)}
                  </span>
                </span>
                <Badge className={`${EMAIL_CLASSIFICATION_META[e.classification].bg} ${EMAIL_CLASSIFICATION_META[e.classification].text}`}>{EMAIL_CLASSIFICATION_META[e.classification].label}</Badge>
              </Link>
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
