import type { Metadata } from "next";
import Link from "next/link";
import { listJobs } from "@/queries";
import { Badge, EmptyState, LinkButton } from "@/components/ui";
import { JOB_STATUS_META } from "@/lib/constants";
import { formatDateTime } from "@/lib/utils";

export const metadata: Metadata = { title: "Jobs" };

export default async function JobsPage() {
  const jobs = await listJobs();
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Jobs</h1>
          <p className="text-sm text-gray-500">{jobs.length} jobs</p>
        </div>
        <LinkButton href="/jobs/new">New job</LinkButton>
      </div>
      {jobs.length === 0 ? (
        <EmptyState title="No jobs yet" hint="A job is created when you convert a lead or a customer accepts a quote. Then schedule it on the calendar." action={<LinkButton href="/jobs/new">Add a job</LinkButton>} />
      ) : (
        <div className="overflow-x-auto rounded-md border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs font-medium text-gray-500">
              <tr>
                <th className="px-3 py-2 text-left">Job</th>
                <th className="px-3 py-2 text-left">Customer</th>
                <th className="px-3 py-2 text-left">Site</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2 text-left">Assigned</th>
                <th className="px-3 py-2 text-left">Scheduled</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {jobs.map((j) => (
                <tr key={j.id} className="hover:bg-gray-50">
                  <td className="px-3 py-2">
                    <Link href={`/jobs/${j.id}`} className="font-medium text-gray-900 hover:text-brand-700 hover:underline">
                      J-{j.number} · {j.title}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-gray-700">
                    <Link href={`/contacts/${j.contact.id}`} className="hover:underline">
                      {j.contact.name}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-gray-700">{j.siteAddress ?? "—"}</td>
                  <td className="px-3 py-2">
                    <Badge className={`${JOB_STATUS_META[j.status].bg} ${JOB_STATUS_META[j.status].text}`}>{JOB_STATUS_META[j.status].label}</Badge>
                  </td>
                  <td className="px-3 py-2 text-gray-700">{j.assignedTo?.name ?? "—"}</td>
                  <td className="px-3 py-2 text-gray-700">{j.events[0] ? formatDateTime(j.events[0].startsAt) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
