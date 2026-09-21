import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLead, getActivity, listActiveUsers } from "@/queries";
import { requireOffice } from "@/lib/auth";
import { getThreadForLead } from "@/queries/email";
import { LeadEmailCard } from "@/components/leads/lead-email-card";
import { SiteVisitCard } from "@/components/leads/site-visit-card";
import { JourneyBar } from "@/components/journey/journey-bar";
import { buildJourney } from "@/lib/journey";
import { LEAD_URGENCY_META } from "@/lib/constants";
import { Badge, Card, CardHeader } from "@/components/ui";
import { LeadForm } from "@/components/leads/lead-form";
import { ConvertLeadButton } from "@/components/leads/convert-lead-dialog";
import { ActivityFeed } from "@/components/activity-feed";
import { StatusPill } from "@/components/leads/cells";
import { JOB_STATUS_META, QUOTE_STATUS_META } from "@/lib/constants";
import { formatDateTime, formatMoney } from "@/lib/utils";

export const metadata: Metadata = { title: "Lead" };

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOffice();
  const { id } = await params;
  const [lead, users] = await Promise.all([getLead(id), listActiveUsers()]);
  if (!lead) notFound();
  const [activity, thread] = await Promise.all([getActivity("lead", id), getThreadForLead(id)]);
  const journey = buildJourney(
    {
      lead: { id: lead.id, status: lead.status, contactId: lead.contactId },
      siteVisits: lead.events.filter((e) => e.kind === "site_visit"),
      quotes: lead.quotes.map((q) => ({ id: q.id, status: q.status, number: q.number })),
      jobs: lead.jobs.map((j) => ({ id: j.id, status: j.status, number: j.number, scheduled: j.events.length > 0 })),
      contactId: lead.contactId,
    },
    "lead",
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/leads" className="text-xs text-gray-500 hover:text-brand-700">
            ← Leads
          </Link>
          <h1 className="mt-1 flex flex-wrap items-center gap-3 text-xl font-semibold text-gray-900">
            {lead.name}
            <StatusPill value={lead.status} />
            {lead.urgency ? <Badge className={`${LEAD_URGENCY_META[lead.urgency].bg} ${LEAD_URGENCY_META[lead.urgency].text}`}>{LEAD_URGENCY_META[lead.urgency].label}</Badge> : null}
            {lead.aiConfidence ? <span className="text-xs font-normal text-gray-500">AI {Math.round(Number(lead.aiConfidence) * 100)}%</span> : null}
          </h1>
          <p className="text-sm text-gray-500">
            {lead.company ? `${lead.company} · ` : ""}Created {formatDateTime(lead.createdAt)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {lead.contact ? (
            <Link
              href={`/contacts/${lead.contact.id}`}
              className="rounded-md border border-green-200 bg-green-50 px-3 py-1.5 text-sm text-green-800 hover:bg-green-100"
            >
              Customer: {lead.contact.name}
            </Link>
          ) : null}
          <ConvertLeadButton lead={lead} users={users} />
        </div>
      </div>

      <JourneyBar steps={journey.steps} cta={journey.cta?.href.endsWith("#convert") ? null : journey.cta} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {lead.summary ? (
            <Card className="p-4 text-sm">
              <p className="text-gray-900">{lead.summary}</p>
              {lead.nextAction ? <p className="mt-1 text-xs text-gray-600">Next: {lead.nextAction}</p> : null}
            </Card>
          ) : null}
          <LeadEmailCard thread={thread} />
          <Card>
            <CardHeader title="Details" />
            <div className="p-4">
              <LeadForm lead={lead} users={users} />
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Quotes"
              action={
                lead.contact ? (
                  <Link href={`/quotes/new?contactId=${lead.contact.id}&leadId=${lead.id}`} className="text-sm text-brand-700 hover:underline">
                    + New quote
                  </Link>
                ) : null
              }
            />
            <div className="divide-y divide-gray-100">
              {lead.quotes.length === 0 ? (
                <p className="px-4 py-3 text-sm text-gray-500">
                  {lead.contact ? "No quotes yet." : "Convert this lead to a customer to create a quote."}
                </p>
              ) : (
                lead.quotes.map((q) => (
                  <Link key={q.id} href={`/quotes/${q.id}`} className="flex items-center justify-between px-4 py-2.5 text-sm hover:bg-gray-50">
                    <span>
                      <span className="font-medium text-gray-900">Q-{q.number}</span> {q.title}
                    </span>
                    <span className="flex items-center gap-3">
                      <span className="text-gray-700">{formatMoney(q.total)}</span>
                      <Badge className={`${QUOTE_STATUS_META[q.status].bg} ${QUOTE_STATUS_META[q.status].text}`}>
                        {QUOTE_STATUS_META[q.status].label}
                      </Badge>
                    </span>
                  </Link>
                ))
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="Jobs" />
            <div className="divide-y divide-gray-100">
              {lead.jobs.length === 0 ? (
                <p className="px-4 py-3 text-sm text-gray-500">No jobs yet.</p>
              ) : (
                lead.jobs.map((j) => (
                  <Link key={j.id} href={`/jobs/${j.id}`} className="flex items-center justify-between px-4 py-2.5 text-sm hover:bg-gray-50">
                    <span>
                      <span className="font-medium text-gray-900">J-{j.number}</span> {j.title}
                    </span>
                    <span className="flex items-center gap-3">
                      {j.events[0] ? <span className="text-gray-600">{formatDateTime(j.events[0].startsAt)}</span> : null}
                      <Badge className={`${JOB_STATUS_META[j.status].bg} ${JOB_STATUS_META[j.status].text}`}>
                        {JOB_STATUS_META[j.status].label}
                      </Badge>
                    </span>
                  </Link>
                ))
              )}
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          <SiteVisitCard lead={{ id: lead.id, name: lead.name, site: lead.site }} events={lead.events} users={users} />
          <Card>
            <CardHeader title="Activity" />
            <div className="p-4">
              <ActivityFeed items={activity} />
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
