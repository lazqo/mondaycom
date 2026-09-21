import type { Metadata } from "next";
import { listEventsBetween, listActiveUsers, listJobs } from "@/queries";
import { CalendarView, type CalendarEvent, type UnassignedJob } from "@/components/calendar/calendar-view";
import { env } from "@/lib/env";
import { getAutomationSettings } from "@/lib/settings";

export const metadata: Metadata = { title: "Calendar" };

function todayInAppTimezone() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: env.APP_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

export default async function CalendarPage({ searchParams }: { searchParams: Promise<{ view?: string; date?: string; tech?: string }> }) {
  const sp = await searchParams;
  const view = sp.view === "week" ? "week" : sp.view === "month" ? "month" : sp.view === "day" ? "day" : "week";
  const date = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : todayInAppTimezone();
  const [y, m, d] = date.split("-").map(Number);
  const from = view === "month" ? new Date(Date.UTC(y, m - 1, 1 - 8)) : new Date(Date.UTC(y, m - 1, d - 8));
  const to = view === "month" ? new Date(Date.UTC(y, m, 8)) : new Date(Date.UTC(y, m - 1, d + 8));

  const [rows, users, jobs, settings] = await Promise.all([listEventsBetween(from, to), listActiveUsers(), listJobs(), getAutomationSettings()]);
  const events: CalendarEvent[] = rows.map((e) => ({
    id: e.id,
    title: e.title,
    description: e.description,
    location: e.location,
    startsAt: e.startsAt.toISOString(),
    endsAt: e.endsAt.toISOString(),
    allDay: e.allDay,
    kind: e.kind,
    assignedToId: e.assignedToId,
    assignedToName: e.assignedTo?.name ?? null,
    job: e.job ? { id: e.job.id, number: e.job.number, status: e.job.status, contactName: e.job.contact.name, siteAddress: e.job.siteAddress, title: e.job.title } : null,
    lead: e.lead ? { id: e.lead.id, name: e.lead.name, site: e.lead.site } : null,
  }));
  const unassigned: UnassignedJob[] = jobs
    .filter((j) => j.status === "unscheduled")
    .map((j) => ({ id: j.id, number: j.number, title: j.title, contactName: j.contact.name, siteAddress: j.siteAddress, service: j.service }));

  return (
    <CalendarView
      view={view}
      date={date}
      events={events}
      users={users}
      unassigned={unassigned}
      techFilter={sp.tech && users.some((u) => u.id === sp.tech) ? sp.tech : null}
      hours={{ start: settings.business_hours_start, end: settings.business_hours_end }}
    />
  );
}
