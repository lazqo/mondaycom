"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { Button, LinkButton } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { JobStatus } from "@/lib/constants";
import { EventDialog } from "./event-dialog";

export type CalendarEvent = {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  assignedToId: string | null;
  assignedToName: string | null;
  job: { id: string; number: number; status: JobStatus; contactName: string } | null;
};
type UserOption = { id: string; name: string };

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function parseDate(s: string) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function fmt(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function startOfWeek(d: Date) {
  const x = new Date(d);
  const day = (x.getDay() + 6) % 7; // Monday = 0
  x.setDate(x.getDate() - day);
  x.setHours(0, 0, 0, 0);
  return x;
}
function timeLabel(iso: string) {
  return new Date(iso).toLocaleTimeString("en-NZ", { hour: "numeric", minute: "2-digit" });
}

const AVATAR_COLORS = ["#579bfc", "#a25ddc", "#ff9900", "#00c875", "#e2445c", "#0086c0", "#ffcb00"];
function colorFor(id: string | null) {
  if (!id) return "#9ca3af";
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export function CalendarView({
  view,
  date,
  events,
  users,
}: {
  view: "month" | "week";
  date: string;
  events: CalendarEvent[];
  users: UserOption[];
}) {
  const router = useRouter();
  const current = parseDate(date);
  const [dialog, setDialog] = React.useState<{ mode: "create"; date: string } | { mode: "edit"; event: CalendarEvent } | null>(null);

  const todayStr = fmt(new Date());

  // Bucket events by local date (an event spanning days appears on each day).
  const byDay = React.useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const ev of events) {
      const s = new Date(ev.startsAt);
      const e = new Date(ev.endsAt);
      const cursor = new Date(s.getFullYear(), s.getMonth(), s.getDate());
      const last = new Date(e.getFullYear(), e.getMonth(), e.getDate());
      // An event ending exactly at midnight belongs to the previous day.
      if (e.getHours() === 0 && e.getMinutes() === 0 && last > cursor) last.setDate(last.getDate() - 1);
      while (cursor <= last) {
        const key = fmt(cursor);
        (map.get(key) ?? map.set(key, []).get(key)!).push(ev);
        cursor.setDate(cursor.getDate() + 1);
      }
    }
    for (const list of map.values()) list.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    return map;
  }, [events]);

  const prev = view === "month" ? new Date(current.getFullYear(), current.getMonth() - 1, 1) : addDays(current, -7);
  const next = view === "month" ? new Date(current.getFullYear(), current.getMonth() + 1, 1) : addDays(current, 7);
  const title =
    view === "month"
      ? current.toLocaleDateString("en-NZ", { month: "long", year: "numeric" })
      : `${startOfWeek(current).toLocaleDateString("en-NZ", { day: "numeric", month: "short" })} – ${addDays(startOfWeek(current), 6).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" })}`;

  const href = (v: "month" | "week", d: Date) => `/calendar?view=${v}&date=${fmt(d)}`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <LinkButton variant="secondary" size="sm" href={href(view, prev)} aria-label="Previous">
            <ChevronLeft className="h-4 w-4" />
          </LinkButton>
          <LinkButton variant="secondary" size="sm" href={href(view, new Date())}>
            Today
          </LinkButton>
          <LinkButton variant="secondary" size="sm" href={href(view, next)} aria-label="Next">
            <ChevronRight className="h-4 w-4" />
          </LinkButton>
          <h1 className="ml-2 text-xl font-semibold text-gray-900">{title}</h1>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md border border-gray-300 bg-white p-0.5">
            <Link
              href={href("month", current)}
              className={cn("rounded px-2.5 py-1 text-sm font-medium", view === "month" ? "bg-brand-600 text-white" : "text-gray-700 hover:bg-gray-100")}
            >
              Month
            </Link>
            <Link
              href={href("week", current)}
              className={cn("rounded px-2.5 py-1 text-sm font-medium", view === "week" ? "bg-brand-600 text-white" : "text-gray-700 hover:bg-gray-100")}
            >
              Week
            </Link>
          </div>
          <Button onClick={() => setDialog({ mode: "create", date })}>
            <Plus className="h-4 w-4" /> New event
          </Button>
        </div>
      </div>

      {view === "month" ? (
        <MonthGrid
          current={current}
          byDay={byDay}
          todayStr={todayStr}
          onNew={(d) => setDialog({ mode: "create", date: d })}
          onOpen={(ev) => setDialog({ mode: "edit", event: ev })}
        />
      ) : (
        <WeekView
          current={current}
          byDay={byDay}
          todayStr={todayStr}
          onNew={(d) => setDialog({ mode: "create", date: d })}
          onOpen={(ev) => setDialog({ mode: "edit", event: ev })}
        />
      )}

      <EventDialog
        state={dialog}
        users={users}
        onClose={() => setDialog(null)}
        onSaved={() => {
          setDialog(null);
          router.refresh();
        }}
      />
    </div>
  );
}

function EventChip({ ev, onOpen, compact }: { ev: CalendarEvent; onOpen: (ev: CalendarEvent) => void; compact?: boolean }) {
  const color = colorFor(ev.assignedToId);
  const content = (
    <>
      <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
      {!ev.allDay ? <span className="shrink-0 text-gray-500">{timeLabel(ev.startsAt)}</span> : null}
      <span className="truncate font-medium text-gray-900">{ev.title}</span>
    </>
  );
  const cls = cn(
    "flex w-full items-center gap-1.5 rounded px-1.5 text-left text-xs leading-6 hover:bg-gray-100",
    compact ? "" : "border border-gray-200 bg-white leading-7",
  );
  if (ev.job) {
    return (
      <Link href={`/jobs/${ev.job.id}`} className={cls} title={`Open job J-${ev.job.number}`} data-testid={`event-${ev.id}`}>
        {content}
      </Link>
    );
  }
  return (
    <button type="button" onClick={() => onOpen(ev)} className={cls} data-testid={`event-${ev.id}`}>
      {content}
    </button>
  );
}

function MonthGrid({
  current,
  byDay,
  todayStr,
  onNew,
  onOpen,
}: {
  current: Date;
  byDay: Map<string, CalendarEvent[]>;
  todayStr: string;
  onNew: (d: string) => void;
  onOpen: (ev: CalendarEvent) => void;
}) {
  const first = new Date(current.getFullYear(), current.getMonth(), 1);
  const gridStart = startOfWeek(first);
  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) cells.push(addDays(gridStart, i));
  // Drop trailing week if entirely next month.
  const rows = cells[35].getMonth() !== current.getMonth() ? cells.slice(0, 35) : cells;

  return (
    <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
      <div className="grid grid-cols-7 border-b border-gray-200 bg-gray-50 text-xs font-medium text-gray-500">
        {DAY_NAMES.map((d) => (
          <div key={d} className="px-2 py-1.5">
            {d}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {rows.map((day) => {
          const key = fmt(day);
          const inMonth = day.getMonth() === current.getMonth();
          const list = byDay.get(key) ?? [];
          return (
            <div
              key={key}
              className={cn("min-h-28 border-b border-r border-gray-100 p-1", !inMonth && "bg-gray-50/70")}
              data-testid={`day-${key}`}
            >
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => onNew(key)}
                  className={cn(
                    "flex h-6 w-6 items-center justify-center rounded-full text-xs hover:bg-gray-200",
                    key === todayStr ? "bg-brand-600 font-semibold text-white hover:bg-brand-700" : inMonth ? "text-gray-800" : "text-gray-400",
                  )}
                  title="Add event"
                >
                  {day.getDate()}
                </button>
              </div>
              <div className="mt-1 space-y-0.5">
                {list.slice(0, 4).map((ev) => (
                  <EventChip key={ev.id} ev={ev} onOpen={onOpen} compact />
                ))}
                {list.length > 4 ? (
                  <Link href={`/calendar?view=week&date=${key}`} className="block px-1.5 text-xs text-gray-500 hover:underline">
                    +{list.length - 4} more
                  </Link>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WeekView({
  current,
  byDay,
  todayStr,
  onNew,
  onOpen,
}: {
  current: Date;
  byDay: Map<string, CalendarEvent[]>;
  todayStr: string;
  onNew: (d: string) => void;
  onOpen: (ev: CalendarEvent) => void;
}) {
  const start = startOfWeek(current);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-7">
      {days.map((day) => {
        const key = fmt(day);
        const list = byDay.get(key) ?? [];
        return (
          <div key={key} className="rounded-lg border border-gray-200 bg-white" data-testid={`day-${key}`}>
            <div className={cn("flex items-center justify-between border-b border-gray-200 px-2 py-1.5", key === todayStr && "bg-brand-50")}>
              <span className="text-sm font-medium text-gray-900">
                {DAY_NAMES[(day.getDay() + 6) % 7]} {day.getDate()}
              </span>
              <button type="button" onClick={() => onNew(key)} className="rounded p-0.5 text-gray-500 hover:bg-gray-100" title="Add event" aria-label={`Add event on ${key}`}>
                <Plus className="h-4 w-4" />
              </button>
            </div>
            <div className="min-h-32 space-y-1.5 p-2">
              {list.length === 0 ? <p className="text-xs text-gray-400">—</p> : null}
              {list.map((ev) => (
                <div key={ev.id}>
                  <EventChip ev={ev} onOpen={onOpen} />
                  <p className="truncate px-1.5 text-[11px] text-gray-500">
                    {timeLabel(ev.startsAt)}–{timeLabel(ev.endsAt)}
                    {ev.assignedToName ? ` · ${ev.assignedToName}` : ""}
                    {ev.location ? ` · ${ev.location}` : ""}
                  </p>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
