import "server-only";
import { and, asc, count, desc, eq, gte, inArray, isNull, lt, lte, or } from "drizzle-orm";
import { db } from "@/db";
import { emails, events, jobs, leads, notifications, quotes, tasks } from "@/db/schema";
import { env } from "@/lib/env";
import { OPEN_JOB_STATUSES } from "@/lib/constants";

export function appDay(date = new Date()): { today: string; start: Date; end: Date } {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: env.APP_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  return { today, ...dayBounds(today) };
}

/** UTC instants for local midnight → next local midnight in the app timezone. */
export function dayBounds(ymd: string): { start: Date; end: Date } {
  const [y, m, d] = ymd.split("-").map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  const offsetMin = tzOffsetMinutes(guess);
  const start = new Date(guess.getTime() - offsetMin * 60_000);
  const nextGuess = new Date(Date.UTC(y, m - 1, d + 1, 0, 0, 0));
  const end = new Date(nextGuess.getTime() - tzOffsetMinutes(nextGuess) * 60_000);
  return { start, end };
}

function tzOffsetMinutes(at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: env.APP_TIMEZONE, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"));
  return Math.round((asUtc - at.getTime()) / 60_000);
}

export async function getDashboard(userId: string) {
  const { today, start, end } = appDay();
  const [newLeads, followUps, todayEvents, quotesDraft, quotesSent, openTasks, needsReview, unassignedJobs, activeJobs, myNotifications] = await Promise.all([
    db.query.leads.findMany({
      where: and(eq(leads.status, "new"), isNull(leads.archivedAt)),
      with: { assignedTo: { columns: { id: true, name: true } } },
      orderBy: [desc(leads.createdAt)],
      limit: 20,
    }),
    db.query.leads.findMany({
      where: and(lte(leads.followUpAt, today), inArray(leads.status, ["new", "contacted", "site_visit", "quote_required", "quote_sent"]), isNull(leads.archivedAt)),
      with: { assignedTo: { columns: { id: true, name: true } } },
      orderBy: [asc(leads.followUpAt)],
      limit: 30,
    }),
    db.query.events.findMany({
      where: and(lt(events.startsAt, end), gte(events.endsAt, start)),
      with: {
        assignedTo: { columns: { id: true, name: true } },
        job: { columns: { id: true, number: true, status: true, siteAddress: true, title: true }, with: { contact: { columns: { name: true, phone: true } } } },
        lead: { columns: { id: true, name: true, site: true, phone: true } },
      },
      orderBy: [asc(events.startsAt)],
    }),
    db.query.quotes.findMany({
      where: eq(quotes.status, "draft"),
      with: { contact: { columns: { id: true, name: true } } },
      orderBy: [asc(quotes.createdAt)],
      limit: 20,
    }),
    db.query.quotes.findMany({
      where: eq(quotes.status, "sent"),
      with: { contact: { columns: { id: true, name: true } } },
      orderBy: [asc(quotes.sentAt)],
      limit: 20,
    }),
    db.query.tasks.findMany({
      where: and(eq(tasks.status, "open"), or(lte(tasks.dueAt, today), isNull(tasks.dueAt))),
      with: { assignedTo: { columns: { id: true, name: true } } },
      orderBy: [asc(tasks.dueAt), asc(tasks.createdAt)],
      limit: 50,
    }),
    db.query.emails.findMany({
      where: and(eq(emails.direction, "inbound"), inArray(emails.classification, ["needs_review", "error"])),
      columns: { id: true, threadId: true, fromName: true, fromAddress: true, subject: true, receivedAt: true, classification: true, snippet: true },
      orderBy: [desc(emails.receivedAt)],
      limit: 20,
    }),
    db.query.jobs.findMany({
      where: eq(jobs.status, "unscheduled"),
      with: { contact: { columns: { id: true, name: true } } },
      orderBy: [asc(jobs.createdAt)],
      limit: 20,
    }),
    db.select({ n: count() }).from(jobs).where(inArray(jobs.status, OPEN_JOB_STATUSES)),
    db.query.notifications.findMany({
      where: and(eq(notifications.userId, userId), isNull(notifications.readAt)),
      orderBy: [desc(notifications.createdAt)],
      limit: 10,
    }),
  ]);
  const overdue = openTasks.filter((t) => t.dueAt && t.dueAt < today);
  const dueToday = openTasks.filter((t) => !t.dueAt || t.dueAt === today);
  return {
    today,
    newLeads,
    followUps,
    todayEvents,
    quotesDraft,
    quotesSent,
    overdueTasks: overdue,
    tasksToday: dueToday,
    needsReview,
    unassignedJobs,
    activeJobCount: Number(activeJobs[0]?.n ?? 0),
    myNotifications,
  };
}
export type Dashboard = Awaited<ReturnType<typeof getDashboard>>;

export async function unreadNotificationCount(userId: string) {
  const [{ n }] = await db.select({ n: count() }).from(notifications).where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
  return Number(n);
}

export async function listNotifications(userId: string, limit = 30) {
  return db.query.notifications.findMany({ where: eq(notifications.userId, userId), orderBy: [desc(notifications.createdAt)], limit });
}

/** Jobs on the calendar for a given local day, optionally for one technician. */
export async function listDayJobs(ymd: string, assignedToId?: string | null) {
  const { start, end } = dayBounds(ymd);
  const rows = await db.query.events.findMany({
    where: and(eq(events.kind, "job"), lt(events.startsAt, end), gte(events.endsAt, start), assignedToId ? eq(events.assignedToId, assignedToId) : undefined),
    with: {
      assignedTo: { columns: { id: true, name: true } },
      job: {
        with: {
          contact: { columns: { id: true, name: true, phone: true, email: true } },
          noteEntries: { orderBy: (n, { desc: d }) => [d(n.createdAt)], with: { author: { columns: { name: true } } } },
          photos: { columns: { id: true, filename: true, caption: true, createdAt: true, contentType: true } },
        },
      },
    },
    orderBy: [asc(events.startsAt)],
  });
  return rows.filter((r) => r.job);
}
export type DayJob = Awaited<ReturnType<typeof listDayJobs>>[number];

export async function listOpenTasks(assignedToId?: string | null) {
  return db.query.tasks.findMany({
    where: and(eq(tasks.status, "open"), assignedToId ? eq(tasks.assignedToId, assignedToId) : undefined),
    with: { assignedTo: { columns: { id: true, name: true } } },
    orderBy: [asc(tasks.dueAt), asc(tasks.createdAt)],
    limit: 200,
  });
}
