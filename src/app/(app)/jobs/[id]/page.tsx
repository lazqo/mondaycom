import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getJob, listContacts, listActiveUsers, getActivity } from "@/queries";
import { Badge, Card, CardHeader } from "@/components/ui";
import { JobForm } from "@/components/jobs/job-form";
import { ScheduleJobCard } from "@/components/jobs/schedule-job-card";
import { JobStatusActions } from "@/components/jobs/job-status-actions";
import { JobNotesPhotos } from "@/components/jobs/job-notes-photos";
import { ActivityFeed } from "@/components/activity-feed";
import { JOB_STATUS_META } from "@/lib/constants";
import { formatMoney } from "@/lib/utils";

export const metadata: Metadata = { title: "Job" };

export default async function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [job, contacts, users, activity] = await Promise.all([getJob(id), listContacts(), listActiveUsers(), getActivity("job", id)]);
  if (!job) notFound();
  const meta = JOB_STATUS_META[job.status];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/jobs" className="text-xs text-gray-500 hover:text-brand-700">
            ← Jobs
          </Link>
          <h1 className="mt-1 flex items-center gap-3 text-xl font-semibold text-gray-900">
            J-{job.number} · {job.title}
            <Badge className={`${meta.bg} ${meta.text}`}>{meta.label}</Badge>
          </h1>
          <p className="text-sm text-gray-500">
            <Link href={`/contacts/${job.contact.id}`} className="hover:underline">
              {job.contact.name}
            </Link>
            {job.lead ? (
              <>
                {" · from lead "}
                <Link href={`/leads/${job.lead.id}`} className="hover:underline">
                  {job.lead.name}
                </Link>
              </>
            ) : null}
            {job.quote ? (
              <>
                {" · quote "}
                <Link href={`/quotes/${job.quote.id}`} className="hover:underline">
                  Q-{job.quote.number} ({formatMoney(job.quote.total)})
                </Link>
              </>
            ) : null}
          </p>
        </div>
        <JobStatusActions jobId={job.id} status={job.status} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader title="Job details" />
            <div className="p-4">
              <JobForm mode="edit" job={job} contacts={contacts} users={users} />
            </div>
          </Card>
          <JobNotesPhotos jobId={job.id} notes={job.noteEntries} photos={job.photos} />
        </div>
        <div className="space-y-4">
          <ScheduleJobCard job={job} users={users} />
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
