"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { setJobStatus } from "@/actions/jobs";
import { Button } from "@/components/ui";
import { JOB_STATUSES, JOB_STATUS_META, type JobStatus } from "@/lib/constants";

/** Forward steps a job can take from each status; the select allows any status for corrections. */
export const JOB_NEXT_STEPS: Partial<Record<JobStatus, JobStatus[]>> = {
  unscheduled: ["cancelled"],
  scheduled: ["en_route", "on_site", "cancelled"],
  en_route: ["on_site", "cancelled"],
  on_site: ["done"],
  done: ["invoiced"],
  invoiced: [],
  cancelled: ["unscheduled"],
};
export const JOB_STEP_LABELS: Partial<Record<JobStatus, string>> = {
  en_route: "En route",
  on_site: "On site",
  done: "Mark done",
  invoiced: "Mark invoiced",
  cancelled: "Cancel",
  unscheduled: "Reopen",
};

export function JobStatusActions({ jobId, status }: { jobId: string; status: JobStatus }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  function go(next: JobStatus) {
    setError(null);
    startTransition(async () => {
      const res = await setJobStatus(jobId, next);
      if (!res.ok) return setError(res.error);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap gap-2">
        <label className="sr-only" htmlFor="job-status-select">
          Job status
        </label>
        <select
          id="job-status-select"
          className="h-10 rounded-md border border-gray-300 bg-white px-3 text-sm"
          value={status}
          onChange={(e) => go(e.target.value as JobStatus)}
          disabled={pending}
        >
          {JOB_STATUSES.map((s) => (
            <option key={s} value={s}>
              {JOB_STATUS_META[s].label}
            </option>
          ))}
        </select>
        {(JOB_NEXT_STEPS[status] ?? []).map((s) => (
          <Button key={s} variant={s === "cancelled" ? "secondary" : "primary"} onClick={() => go(s)} disabled={pending}>
            {JOB_STEP_LABELS[s] ?? JOB_STATUS_META[s].label}
          </Button>
        ))}
      </div>
      {error ? <p className="text-xs text-red-600">{error}</p> : null}
    </div>
  );
}
