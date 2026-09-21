import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getContact } from "@/queries";
import { getContactHistory } from "@/queries/contact-history";
import { ContactHistory } from "@/components/contacts/contact-history";
import { Badge, Card, CardHeader, LinkButton } from "@/components/ui";
import { ContactForm } from "@/components/contacts/contact-form";
import { StatusPill } from "@/components/leads/cells";
import { JOB_STATUS_META, QUOTE_STATUS_META } from "@/lib/constants";
import { formatDateTime, formatMoney } from "@/lib/utils";

export const metadata: Metadata = { title: "Customer" };

export default async function ContactDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const contact = await getContact(id);
  if (!contact) notFound();
  const history = await getContactHistory(id);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/contacts" className="text-xs text-gray-500 hover:text-brand-700">
            ← Customers
          </Link>
          <h1 className="mt-1 text-xl font-semibold text-gray-900">{contact.name}</h1>
          {contact.company ? <p className="text-sm text-gray-500">{contact.company}</p> : null}
        </div>
        <div className="flex gap-2">
          <LinkButton variant="secondary" href={`/quotes/new?contactId=${contact.id}`}>
            New quote
          </LinkButton>
          <LinkButton href={`/jobs/new?contactId=${contact.id}`}>New job</LinkButton>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader title="Details" />
            <div className="p-4">
              <ContactForm contact={contact} />
            </div>
          </Card>
          <ContactHistory contactId={contact.id} items={history} />
          <Card>
            <CardHeader title="Jobs" />
            <div className="divide-y divide-gray-100">
              {contact.jobs.length === 0 ? (
                <p className="px-4 py-3 text-sm text-gray-500">No jobs yet.</p>
              ) : (
                contact.jobs.map((j) => (
                  <Link key={j.id} href={`/jobs/${j.id}`} className="flex items-center justify-between px-4 py-2.5 text-sm hover:bg-gray-50">
                    <span>
                      <span className="font-medium text-gray-900">J-{j.number}</span> {j.title}
                      {j.assignedTo ? <span className="text-gray-500"> · {j.assignedTo.name}</span> : null}
                    </span>
                    <span className="flex items-center gap-3">
                      {j.events[0] ? <span className="text-gray-600">{formatDateTime(j.events[0].startsAt)}</span> : null}
                      <Badge className={`${JOB_STATUS_META[j.status].bg} ${JOB_STATUS_META[j.status].text}`}>{JOB_STATUS_META[j.status].label}</Badge>
                    </span>
                  </Link>
                ))
              )}
            </div>
          </Card>
          <Card>
            <CardHeader title="Quotes" />
            <div className="divide-y divide-gray-100">
              {contact.quotes.length === 0 ? (
                <p className="px-4 py-3 text-sm text-gray-500">No quotes yet.</p>
              ) : (
                contact.quotes.map((q) => (
                  <Link key={q.id} href={`/quotes/${q.id}`} className="flex items-center justify-between px-4 py-2.5 text-sm hover:bg-gray-50">
                    <span>
                      <span className="font-medium text-gray-900">Q-{q.number}</span> {q.title}
                    </span>
                    <span className="flex items-center gap-3">
                      <span className="text-gray-700">{formatMoney(q.total)}</span>
                      <Badge className={`${QUOTE_STATUS_META[q.status].bg} ${QUOTE_STATUS_META[q.status].text}`}>{QUOTE_STATUS_META[q.status].label}</Badge>
                    </span>
                  </Link>
                ))
              )}
            </div>
          </Card>
        </div>
        <div>
          <Card>
            <CardHeader title="Leads" />
            <div className="divide-y divide-gray-100">
              {contact.leads.length === 0 ? (
                <p className="px-4 py-3 text-sm text-gray-500">No linked leads.</p>
              ) : (
                contact.leads.map((l) => (
                  <Link key={l.id} href={`/leads/${l.id}`} className="flex items-center justify-between px-4 py-2.5 text-sm hover:bg-gray-50">
                    <span className="font-medium text-gray-900">{l.name}</span>
                    <StatusPill value={l.status} />
                  </Link>
                ))
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
