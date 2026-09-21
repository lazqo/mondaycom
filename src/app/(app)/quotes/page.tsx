import type { Metadata } from "next";
import { requireOffice } from "@/lib/auth";
import Link from "next/link";
import { listQuotes } from "@/queries";
import { Badge, EmptyState, LinkButton } from "@/components/ui";
import { QUOTE_STATUS_META } from "@/lib/constants";
import { formatDateTime, formatMoney } from "@/lib/utils";

export const metadata: Metadata = { title: "Quotes" };

export default async function QuotesPage() {
  await requireOffice();
  const quotes = await listQuotes();
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Quotes</h1>
          <p className="text-sm text-gray-500">{quotes.length} quotes</p>
        </div>
        <LinkButton href="/quotes/new">New quote</LinkButton>
      </div>
      {quotes.length === 0 ? (
        <EmptyState title="No quotes yet" hint="Quotes are created from a lead (after converting it) or from a customer page." action={<LinkButton href="/quotes/new">Create a quote</LinkButton>} />
      ) : (
        <div className="overflow-x-auto rounded-md border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs font-medium text-gray-500">
              <tr>
                <th className="px-3 py-2 text-left">Quote</th>
                <th className="px-3 py-2 text-left">Customer</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2 text-right">Total (incl. GST)</th>
                <th className="px-3 py-2 text-left">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {quotes.map((q) => (
                <tr key={q.id} className="hover:bg-gray-50">
                  <td className="px-3 py-2">
                    <Link href={`/quotes/${q.id}`} className="font-medium text-gray-900 hover:text-brand-700 hover:underline">
                      Q-{q.number} · {q.title}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-gray-700">
                    <Link href={`/contacts/${q.contact.id}`} className="hover:underline">
                      {q.contact.name}
                    </Link>
                    {q.contact.company ? <span className="text-gray-500"> · {q.contact.company}</span> : null}
                  </td>
                  <td className="px-3 py-2">
                    <Badge className={`${QUOTE_STATUS_META[q.status].bg} ${QUOTE_STATUS_META[q.status].text}`}>{QUOTE_STATUS_META[q.status].label}</Badge>
                  </td>
                  <td className="px-3 py-2 text-right text-gray-900">{formatMoney(q.total)}</td>
                  <td className="px-3 py-2 text-gray-500">{formatDateTime(q.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
