import type { Metadata } from "next";
import Link from "next/link";
import { listContacts, listActiveUsers } from "@/queries";
import { JobForm } from "@/components/jobs/job-form";

export const metadata: Metadata = { title: "New job" };

export default async function NewJobPage({ searchParams }: { searchParams: Promise<{ contactId?: string }> }) {
  const [{ contactId }, contacts, users] = await Promise.all([searchParams, listContacts(), listActiveUsers()]);
  return (
    <div className="space-y-4">
      <div>
        <Link href="/jobs" className="text-xs text-gray-500 hover:text-brand-700">
          ← Jobs
        </Link>
        <h1 className="mt-1 text-xl font-semibold text-gray-900">New job</h1>
      </div>
      <JobForm mode="create" contacts={contacts} users={users} defaultContactId={contactId} />
    </div>
  );
}
