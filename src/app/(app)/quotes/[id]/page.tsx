import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getQuote, listContacts, getActivity } from "@/queries";
import { Badge, Card, CardHeader } from "@/components/ui";
import { QuoteEditor } from "@/components/quotes/quote-editor";
import { QuoteStatusActions } from "@/components/quotes/quote-status-actions";
import { ActivityFeed } from "@/components/activity-feed";
import { QUOTE_STATUS_META } from "@/lib/constants";

export const metadata: Metadata = { title: "Quote" };

export default async function QuoteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [quote, contacts, activity] = await Promise.all([getQuote(id), listContacts(), getActivity("quote", id)]);
  if (!quote) notFound();
  const meta = QUOTE_STATUS_META[quote.status];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/quotes" className="text-xs text-gray-500 hover:text-brand-700">
            ← Quotes
          </Link>
          <h1 className="mt-1 flex items-center gap-3 text-xl font-semibold text-gray-900">
            Q-{quote.number} · {quote.title}
            <Badge className={`${meta.bg} ${meta.text}`}>{meta.label}</Badge>
          </h1>
          <p className="text-sm text-gray-500">
            <Link href={`/contacts/${quote.contact.id}`} className="hover:underline">
              {quote.contact.name}
            </Link>
            {quote.lead ? (
              <>
                {" · from lead "}
                <Link href={`/leads/${quote.lead.id}`} className="hover:underline">
                  {quote.lead.name}
                </Link>
              </>
            ) : null}
            {quote.jobs[0] ? (
              <>
                {" · job "}
                <Link href={`/jobs/${quote.jobs[0].id}`} className="hover:underline">
                  J-{quote.jobs[0].number}
                </Link>
              </>
            ) : null}
          </p>
        </div>
        <QuoteStatusActions quoteId={quote.id} status={quote.status} hasJob={quote.jobs.length > 0} />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <QuoteEditor mode="edit" quote={quote} contacts={contacts} />
        </div>
        <Card>
          <CardHeader title="Activity" />
          <div className="p-4">
            <ActivityFeed items={activity} />
          </div>
        </Card>
      </div>
    </div>
  );
}
