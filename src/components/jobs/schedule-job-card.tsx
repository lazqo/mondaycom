"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Event, Job } from "@/db/schema";
import { scheduleJob, unscheduleJob } from "@/actions/jobs";
import { Button, Card, CardHeader, Field, FormError, Input, Select } from "@/components/ui";
import { formatDateTime } from "@/lib/utils";

type UserOption = { id: string; name: string };

function toLocalDate(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function toLocalTime(d: Date) {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function ScheduleJobCard({ job, users }: { job: Job & { events: Event[] }; users: UserOption[] }) {
  const router = useRouter();
  const existing = job.events[0];
  const start = existing ? new Date(existing.startsAt) : null;
  const end = existing ? new Date(existing.endsAt) : null;

  const [date, setDate] = React.useState(start ? toLocalDate(start) : "");
  const [startTime, setStartTime] = React.useState(start ? toLocalTime(start) : "09:00");
  const [endTime, setEndTime] = React.useState(end ? toLocalTime(end) : "11:00");
  const [assignedToId, setAssignedToId] = React.useState(job.assignedToId ?? "");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  React.useEffect(() => {
    setAssignedToId(job.assignedToId ?? "");
  }, [job.assignedToId]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!date) return setError("Choose a date");
    // Build ISO strings in the browser's local timezone.
    const startsAt = new Date(`${date}T${startTime}:00`);
    const endsAt = new Date(`${date}T${endTime}:00`);
    startTransition(async () => {
      const res = await scheduleJob(job.id, {
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        assignedToId: assignedToId || null,
      });
      if (!res.ok) return setError(res.error);
      router.refresh();
    });
  }

  function remove() {
    if (!confirm("Remove this job from the calendar?")) return;
    startTransition(async () => {
      const res = await unscheduleJob(job.id);
      if (!res.ok) return setError(res.error);
      router.refresh();
    });
  }

  return (
    <Card id="schedule">
      <CardHeader
        title="Schedule"
        action={
          existing ? (
            <Link href={`/calendar?date=${toLocalDate(new Date(existing.startsAt))}&view=week`} className="text-sm text-brand-700 hover:underline">
              View in calendar
            </Link>
          ) : null
        }
      />
      <form onSubmit={submit} className="space-y-3 p-4">
        {existing ? (
          <p className="rounded-md bg-brand-50 px-3 py-2 text-sm text-brand-800" data-testid="scheduled-summary" suppressHydrationWarning>
            Scheduled {formatDateTime(existing.startsAt)} – {toLocalTime(new Date(existing.endsAt))}
          </p>
        ) : (
          <p className="text-sm text-gray-500">Not scheduled yet.</p>
        )}
        <Field label="Date" htmlFor="s-date">
          <Input id="s-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Start" htmlFor="s-start">
            <Input id="s-start" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} required />
          </Field>
          <Field label="End" htmlFor="s-end">
            <Input id="s-end" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} required />
          </Field>
        </div>
        <Field label="Technician" htmlFor="s-assigned">
          <Select id="s-assigned" value={assignedToId} onChange={(e) => setAssignedToId(e.target.value)}>
            <option value="">Unassigned</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </Select>
        </Field>
        <FormError message={error} />
        <div className="flex items-center justify-between">
          {existing ? (
            <Button type="button" variant="ghost" size="sm" className="text-red-600 hover:bg-red-50" onClick={remove} disabled={pending}>
              Unschedule
            </Button>
          ) : (
            <span />
          )}
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : existing ? "Reschedule" : "Schedule job"}
          </Button>
        </div>
      </form>
    </Card>
  );
}
