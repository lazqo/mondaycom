import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { listDayJobs, listOpenTasks, appDay } from "@/queries/dashboard";
import { listActiveUsers } from "@/queries";
import { MyDayJobCard } from "@/components/my-day/job-card";
import { TaskList } from "@/components/dashboard/task-list";
import { Card, CardHeader } from "@/components/ui";

export const metadata: Metadata = { title: "My day" };

export default async function MyDayPage({ searchParams }: { searchParams: Promise<{ date?: string; tech?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const { today } = appDay();
  const date = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : today;
  const users = await listActiveUsers();
  const techId = user.role === "admin" && sp.tech !== undefined ? (sp.tech === "all" ? null : sp.tech) : user.id;
  const [jobs, tasks] = await Promise.all([listDayJobs(date, techId), listOpenTasks(techId ?? undefined)]);
  const [y, m, d] = date.split("-").map(Number);
  const shift = (n: number) => {
    const x = new Date(y, m - 1, d + n);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  };
  const q = (dt: string) => `/my-day?date=${dt}${user.role === "admin" && sp.tech !== undefined ? `&tech=${sp.tech}` : ""}`;
  const dueTasks = tasks.filter((t) => !t.dueAt || t.dueAt <= date);

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <div className="flex items-center justify-between gap-2">
        <Link href={q(shift(-1))} className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm">
          ←
        </Link>
        <div className="text-center">
          <h1 className="text-lg font-semibold text-gray-900">{new Date(y, m - 1, d).toLocaleDateString("en-NZ", { weekday: "long", day: "numeric", month: "long" })}</h1>
          <p className="text-xs text-gray-500">
            {date === today ? "Today · " : ""}
            {techId ? (users.find((u) => u.id === techId)?.name ?? user.name) : "All technicians"} · {jobs.length} {jobs.length === 1 ? "job" : "jobs"}
          </p>
        </div>
        <Link href={q(shift(1))} className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm">
          →
        </Link>
      </div>
      {user.role === "admin" ? (
        <form className="flex items-center gap-2 text-sm" method="get">
          <input type="hidden" name="date" value={date} />
          <label htmlFor="tech" className="text-gray-500">
            Technician
          </label>
          <select id="tech" name="tech" defaultValue={sp.tech ?? user.id} className="h-9 flex-1 rounded-md border border-gray-300 bg-white px-2" onChange={undefined}>
            <option value="all">All</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
          <button type="submit" className="h-9 rounded-md border border-gray-300 bg-white px-3">
            Go
          </button>
        </form>
      ) : null}

      {jobs.length === 0 ? <Card className="p-6 text-center text-sm text-gray-500">No jobs scheduled for this day.</Card> : null}
      {jobs.map((row) => (
        <MyDayJobCard key={row.id} row={row} />
      ))}

      {dueTasks.length ? (
        <Card>
          <CardHeader title={`Reminders (${dueTasks.length})`} />
          <div className="divide-y divide-gray-100">
            <TaskList tasks={dueTasks} showAssignee={false} />
          </div>
        </Card>
      ) : null}
    </div>
  );
}
