import type { Metadata } from "next";
import { listEventsBetween, listActiveUsers } from "@/queries";
import { CalendarView, type CalendarEvent } from "@/components/calendar/calendar-view";
import { env } from "@/lib/env";

export const metadata: Metadata = { title: "Calendar" };

function todayInAppTimezone() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: env.APP_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  return parts; // en-CA gives YYYY-MM-DD
}

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; date?: string }>;
}) {
  const sp = await searchParams;
  const view = sp.view === "week" ? "week" : "month";
  const date = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : todayInAppTimezone();
  const [y, m, d] = date.split("-").map(Number);

  // Over-fetch a padded UTC range; the client buckets by local time.
  const from = view === "month" ? new Date(Date.UTC(y, m - 1, 1 - 8)) : new Date(Date.UTC(y, m - 1, d - 8));
  const to = view === "month" ? new Date(Date.UTC(y, m, 8)) : new Date(Date.UTC(y, m - 1, d + 8));

  const [rows, users] = await Promise.all([listEventsBetween(from, to), listActiveUsers()]);
  const events: CalendarEvent[] = rows.map((e) => ({
    id: e.id,
    title: e.title,
    description: e.description,
    location: e.location,
    startsAt: e.startsAt.toISOString(),
    endsAt: e.endsAt.toISOString(),
    allDay: e.allDay,
    assignedToId: e.assignedToId,
    assignedToName: e.assignedTo?.name ?? null,
    job: e.job ? { id: e.job.id, number: e.job.number, status: e.job.status, contactName: e.job.contact.name } : null,
  }));

  return <CalendarView view={view} date={date} events={events} users={users} />;
}
