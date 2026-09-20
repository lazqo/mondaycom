"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { setJobStatus } from "@/actions/jobs";
import { Button } from "@/components/ui";
import { JOB_STATUSES, JOB_STATUS_META, type JobStatus } from "@/lib/constants";

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

  const nextSteps: Partial<Record<JobStatus, JobStatus[]>> = {
    unscheduled: ["cancelled"],
    scheduled: ["in_progress", "cancelled"],
    in_progress: ["done", "cancelled"],
    done: ["in_progress"],
    cancelled: ["unscheduled"],
  };

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
        {(nextSteps[status] ?? []).map((s) => (
          <Button key={s} variant={s === "cancelled" ? "secondary" : "primary"} onClick={() => go(s)} disabled={pending}>
            {s === "in_progress" ? "Start job" : s === "done" ? "Mark done" : JOB_STATUS_META[s].label}
          </Button>
        ))}
      </div>
      {error ? <p className="text-xs text-red-600">{error}</p> : null}
    </div>
  );
}
