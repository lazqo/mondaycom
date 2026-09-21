"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { Button, LinkButton, Badge } from "@/components/ui";
import { cn } from "@/lib/utils";
import { JOB_STATUS_META, type JobStatus } from "@/lib/constants";
import { moveEvent } from "@/actions/events";
import { scheduleJob } from "@/actions/jobs";
import { EventDialog } from "./event-dialog";

export type CalendarEvent = {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  kind: "job" | "site_visit" | "other";
  assignedToId: string | null;
  assignedToName: string | null;
  job: { id: string; number: number; status: JobStatus; contactName: string; siteAddress: string | null; title: string } | null;
  lead: { id: string; name: string; site: string | null } | null;
};
export type UnassignedJob = { id: string; number: number; title: string; contactName: string; siteAddress: string | null; service: string | null };
type UserOption = { id: string; name: string };
type View = "day" | "week" | "month";

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
/** After a drop, the browser still fires a click on the dragged element; links check this to stay put. */
const SuppressClick = React.createContext<React.MutableRefObject<number>>({ current: 0 });
function useNoClickAfterDrag() {
  const ref = React.useContext(SuppressClick);
  return (e: React.MouseEvent) => {
    if (Date.now() < ref.current) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
}
const SLOT_MIN = 30;
const SLOT_PX = 28; // height of a 30-minute slot
/** Grid hours come from Settings → Reminders (business hours) with an hour of margin each side. */
type Hours = { start: number; end: number; slots: number };
const HoursCtx = React.createContext<Hours>({ start: 6, end: 20, slots: 28 });
const DEFAULT_JOB_MIN = 120;
const MIN_CHIP_PX = 72;
const CASCADE_PX = 16;

function chipGeometry({ lane, lanes }: { lane: number; lanes: number }, colWidth: number): { left: number; width: number } {
  const inner = Math.max(colWidth - 8, MIN_CHIP_PX);
  if (lanes * MIN_CHIP_PX <= inner) {
    const w = inner / lanes;
    return { left: 4 + lane * w, width: Math.max(w - 2, MIN_CHIP_PX / 2) };
  }
  const maxLeft = inner - MIN_CHIP_PX;
  return { left: 4 + Math.min(lane * CASCADE_PX, maxLeft), width: MIN_CHIP_PX + Math.max(0, maxLeft - Math.min(lane * CASCADE_PX, maxLeft)) };
}

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
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  x.setHours(0, 0, 0, 0);
  return x;
}
function timeLabel(iso: string) {
  return new Date(iso).toLocaleTimeString("en-NZ", { hour: "numeric", minute: "2-digit" });
}
function minutesFromStart(d: Date, startHour: number) {
  return d.getHours() * 60 + d.getMinutes() - startHour * 60;
}
const PALETTE = ["#579bfc", "#a25ddc", "#ff9900", "#00c875", "#e2445c", "#0086c0", "#ffcb00", "#784bd1"];
function techColor(id: string | null, users: UserOption[]) {
  if (!id) return "#9ca3af";
  const i = users.findIndex((u) => u.id === id);
  return PALETTE[(i >= 0 ? i : 0) % PALETTE.length];
}

export function CalendarView({
  view,
  date,
  events,
  users,
  unassigned,
  techFilter,
  hours: hoursIn = { start: 7, end: 18 },
}: {
  view: View;
  date: string;
  events: CalendarEvent[];
  users: UserOption[];
  unassigned: UnassignedJob[];
  techFilter: string | null;
  hours?: { start: number; end: number };
}) {
  const router = useRouter();
  const hours = React.useMemo<Hours>(() => {
    const start = Math.max(0, Math.min(hoursIn.start, 22) - 1);
    const end = Math.min(24, Math.max(hoursIn.end, start + 2) + 1);
    return { start, end, slots: ((end - start) * 60) / SLOT_MIN };
  }, [hoursIn.start, hoursIn.end]);
  const current = parseDate(date);
  const [dialog, setDialog] = React.useState<{ mode: "create"; date: string; time?: string } | { mode: "edit"; event: CalendarEvent } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [active, setActive] = React.useState<{ type: "event"; event: CalendarEvent } | { type: "job"; job: UnassignedJob } | null>(null);
  const [, startTransition] = React.useTransition();
  const suppressUntil = React.useRef(0);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const todayStr = fmt(new Date());
  const lanes: UserOption[] = view === "day" ? [...users, { id: "", name: "Unassigned" }] : [];

  const href = (v: View, d: Date, tech = techFilter) => `/calendar?view=${v}&date=${fmt(d)}${tech ? `&tech=${tech}` : ""}`;
  const prev = view === "month" ? new Date(current.getFullYear(), current.getMonth() - 1, 1) : addDays(current, view === "week" ? -7 : -1);
  const next = view === "month" ? new Date(current.getFullYear(), current.getMonth() + 1, 1) : addDays(current, view === "week" ? 7 : 1);
  const title =
    view === "month"
      ? current.toLocaleDateString("en-NZ", { month: "long", year: "numeric" })
      : view === "day"
        ? current.toLocaleDateString("en-NZ", { weekday: "long", day: "numeric", month: "long" })
        : `${startOfWeek(current).toLocaleDateString("en-NZ", { day: "numeric", month: "short" })} – ${addDays(startOfWeek(current), 6).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" })}`;

  const visible = techFilter ? events.filter((e) => e.assignedToId === techFilter) : events;

  function onDragStart(e: DragStartEvent) {
    const data = e.active.data.current as { type: "event"; event: CalendarEvent } | { type: "job"; job: UnassignedJob };
    setActive(data);
  }
  function onDragEnd(e: DragEndEvent) {
    const data = active;
    setActive(null);
    suppressUntil.current = Date.now() + 150;
    const over = e.over?.data.current as { day: string; slot: number; lane?: string } | undefined;
    if (!data || !over) return;
    const [y, m, d] = over.day.split("-").map(Number);
    const startsAt = new Date(y, m - 1, d, hours.start, over.slot * SLOT_MIN);
    setError(null);
    if (data.type === "event") {
      const durationMs = new Date(data.event.endsAt).getTime() - new Date(data.event.startsAt).getTime();
      const endsAt = new Date(startsAt.getTime() + durationMs);
      const assignedToId = over.lane === undefined ? undefined : over.lane === "" ? null : over.lane;
      startTransition(async () => {
        const res = await moveEvent(data.event.id, { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), assignedToId });
        if (!res.ok) setError(res.error);
        router.refresh();
      });
    } else {
      const endsAt = new Date(startsAt.getTime() + DEFAULT_JOB_MIN * 60_000);
      const assignedToId = over.lane === undefined ? undefined : over.lane === "" ? null : over.lane;
      startTransition(async () => {
        const res = await scheduleJob(data.job.id, { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), assignedToId });
        if (!res.ok) setError(res.error);
        router.refresh();
      });
    }
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      autoScroll={false} // the grid scrolls horizontally; auto-scroll would move the drop target under the pointer
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => {
        setActive(null);
        suppressUntil.current = Date.now() + 150;
      }}
    >
      <SuppressClick.Provider value={suppressUntil}>
      <HoursCtx.Provider value={hours}>
      <div className="space-y-3">
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
          <div className="flex flex-wrap items-center gap-2">
            {view !== "day" ? (
              <select
                aria-label="Technician"
                className="h-9 rounded-md border border-gray-300 bg-white px-2 text-sm"
                value={techFilter ?? ""}
                onChange={(e) => router.push(href(view, current, e.target.value || null))}
              >
                <option value="">All technicians</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            ) : null}
            <div className="flex rounded-md border border-gray-300 bg-white p-0.5">
              {(["day", "week", "month"] as View[]).map((v) => (
                <Link key={v} href={href(v, current)} className={cn("rounded px-2.5 py-1 text-sm font-medium capitalize", view === v ? "bg-brand-600 text-white" : "text-gray-700 hover:bg-gray-100")}>
                  {v}
                </Link>
              ))}
            </div>
            <Button onClick={() => setDialog({ mode: "create", date })}>
              <Plus className="h-4 w-4" /> New event
            </Button>
          </div>
        </div>
        {error ? <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}

        <div className="flex gap-3">
          <div className="min-w-0 flex-1">
            {view === "month" ? (
              <MonthGrid current={current} events={visible} users={users} todayStr={todayStr} onNew={(d) => setDialog({ mode: "create", date: d })} onOpen={(ev) => setDialog({ mode: "edit", event: ev })} />
            ) : view === "week" ? (
              <TimeGrid columns={Array.from({ length: 7 }, (_, i) => ({ key: fmt(addDays(startOfWeek(current), i)), day: fmt(addDays(startOfWeek(current), i)), label: `${DAY_NAMES[i]} ${addDays(startOfWeek(current), i).getDate()}`, lane: undefined }))} events={visible} users={users} todayStr={todayStr} onNew={(d, t) => setDialog({ mode: "create", date: d, time: t })} onOpen={(ev) => setDialog({ mode: "edit", event: ev })} />
            ) : (
              <TimeGrid columns={lanes.map((l) => ({ key: l.id || "unassigned", day: date, label: l.name, lane: l.id }))} events={visible} users={users} todayStr={todayStr} onNew={(d, t) => setDialog({ mode: "create", date: d, time: t })} onOpen={(ev) => setDialog({ mode: "edit", event: ev })} />
            )}
          </div>
          {view !== "month" ? <UnassignedTray jobs={unassigned} /> : null}
        </div>

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
      </HoursCtx.Provider>
      </SuppressClick.Provider>
      <DragOverlay>
        {active?.type === "event" ? <div className="w-48 rounded border border-gray-300 bg-white px-2 py-1 text-xs shadow-lg">{active.event.title}</div> : null}
        {active?.type === "job" ? <div className="w-48 rounded border border-gray-300 bg-white px-2 py-1 text-xs shadow-lg">J-{active.job.number} {active.job.title}</div> : null}
      </DragOverlay>
    </DndContext>
  );
}

// ---------- Time grid (day lanes / week days) ----------

type Column = { key: string; day: string; label: string; lane: string | undefined };

function TimeGrid({ columns, events, users, todayStr, onNew, onOpen }: { columns: Column[]; events: CalendarEvent[]; users: UserOption[]; todayStr: string; onNew: (day: string, time: string) => void; onOpen: (ev: CalendarEvent) => void }) {
  const { start: START_HOUR, end: END_HOUR, slots: SLOTS } = React.useContext(HoursCtx);
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <div className="grid" style={{ gridTemplateColumns: `56px repeat(${columns.length}, minmax(140px, 1fr))` }}>
        <div className="border-b border-gray-200" />
        {columns.map((c) => (
          <div key={c.key} className={cn("border-b border-l border-gray-200 px-2 py-1.5 text-xs font-medium text-gray-700", c.day === todayStr && c.lane === undefined && "bg-brand-50")}>
            {c.label}
          </div>
        ))}
        <div className="relative" style={{ height: SLOTS * SLOT_PX }}>
          {Array.from({ length: END_HOUR - START_HOUR }, (_, i) => (
            <div key={i} className="absolute right-1 text-[10px] text-gray-400" style={{ top: i * SLOT_PX * 2 - 6 }}>
              {String(START_HOUR + i).padStart(2, "0")}:00
            </div>
          ))}
        </div>
        {columns.map((c) => (
          <DayColumn key={c.key} column={c} events={events.filter((e) => onDay(e, c.day) && (c.lane === undefined || (e.assignedToId ?? "") === c.lane))} users={users} onNew={onNew} onOpen={onOpen} />
        ))}
      </div>
    </div>
  );
}

function onDay(e: CalendarEvent, day: string) {
  const s = new Date(e.startsAt);
  const en = new Date(e.endsAt);
  const [y, m, d] = day.split("-").map(Number);
  const dayStart = new Date(y, m - 1, d, 0, 0, 0);
  const dayEnd = new Date(y, m - 1, d + 1, 0, 0, 0);
  return s < dayEnd && en > dayStart;
}

/** Side-by-side lanes for events that overlap in time (interval partitioning per cluster). */
function layoutOverlaps(events: CalendarEvent[]): Map<string, { lane: number; lanes: number }> {
  const out = new Map<string, { lane: number; lanes: number }>();
  const sorted = [...events].sort((a, b) => a.startsAt.localeCompare(b.startsAt) || b.endsAt.localeCompare(a.endsAt));
  let cluster: CalendarEvent[] = [];
  let clusterEnd = 0;
  const flush = () => {
    const laneEnds: number[] = [];
    const placed: { id: string; lane: number }[] = [];
    for (const e of cluster) {
      const s = new Date(e.startsAt).getTime();
      let lane = laneEnds.findIndex((end) => end <= s);
      if (lane === -1) lane = laneEnds.length;
      laneEnds[lane] = new Date(e.endsAt).getTime();
      placed.push({ id: e.id, lane });
    }
    for (const p of placed) out.set(p.id, { lane: p.lane, lanes: laneEnds.length });
    cluster = [];
  };
  for (const e of sorted) {
    const s = new Date(e.startsAt).getTime();
    if (cluster.length && s >= clusterEnd) flush();
    cluster.push(e);
    clusterEnd = Math.max(clusterEnd, new Date(e.endsAt).getTime());
  }
  if (cluster.length) flush();
  return out;
}

function DayColumn({ column, events, users, onNew, onOpen }: { column: Column; events: CalendarEvent[]; users: UserOption[]; onNew: (day: string, time: string) => void; onOpen: (ev: CalendarEvent) => void }) {
  const { slots: SLOTS } = React.useContext(HoursCtx);
  const layout = React.useMemo(() => layoutOverlaps(events), [events]);
  const ref = React.useRef<HTMLDivElement>(null);
  const [width, setWidth] = React.useState(140);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} className="relative border-l border-gray-200" style={{ height: SLOTS * SLOT_PX }} data-testid={`col-${column.key}`}>
      {Array.from({ length: SLOTS }, (_, i) => (
        <Slot key={i} column={column} slot={i} onNew={onNew} />
      ))}
      {events.map((e) => (
        <PositionedEvent key={e.id} event={e} users={users} onOpen={onOpen} placement={layout.get(e.id) ?? { lane: 0, lanes: 1 }} colWidth={width} />
      ))}
    </div>
  );
}

function Slot({ column, slot, onNew }: { column: Column; slot: number; onNew: (day: string, time: string) => void }) {
  const { start: START_HOUR } = React.useContext(HoursCtx);
  const { setNodeRef, isOver } = useDroppable({ id: `${column.key}:${slot}`, data: { day: column.day, slot, lane: column.lane } });
  const hour = START_HOUR + Math.floor((slot * SLOT_MIN) / 60);
  const min = (slot * SLOT_MIN) % 60;
  return (
    <div
      ref={setNodeRef}
      onDoubleClick={() => onNew(column.day, `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}`)}
      className={cn("absolute left-0 right-0 border-b", min === 0 ? "border-gray-100" : "border-dashed border-gray-50", isOver && "bg-brand-100")}
      style={{ top: slot * SLOT_PX, height: SLOT_PX }}
      data-testid={`slot-${column.key}-${slot}`}
      title="Double-click to add"
    />
  );
}

function PositionedEvent({ event, users, onOpen, placement, colWidth }: { event: CalendarEvent; users: UserOption[]; onOpen: (ev: CalendarEvent) => void; placement: { lane: number; lanes: number }; colWidth: number }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `event:${event.id}`, data: { type: "event", event } });
  const noClickAfterDrag = useNoClickAfterDrag();
  const { start: START_HOUR, slots: SLOTS } = React.useContext(HoursCtx);
  const s = new Date(event.startsAt);
  const en = new Date(event.endsAt);
  const top = Math.max(0, minutesFromStart(s, START_HOUR)) * (SLOT_PX / SLOT_MIN);
  const bottom = Math.min(SLOTS * SLOT_MIN, minutesFromStart(en, START_HOUR)) * (SLOT_PX / SLOT_MIN);
  const height = Math.max(SLOT_PX, bottom - top);
  const color = event.job ? JOB_STATUS_META[event.job.status].color : event.kind === "site_visit" ? "#ff9900" : techColor(event.assignedToId, users);
  const label = event.job ? `J-${event.job.number} ${event.job.contactName}` : event.lead ? `Site visit: ${event.lead.name}` : event.title;
  const where = event.job?.siteAddress ?? event.lead?.site ?? event.location;
  const href = event.job ? `/jobs/${event.job.id}` : event.lead ? `/leads/${event.lead.id}` : null;
  const body = (
    <>
      <p className="truncate text-[11px] font-semibold leading-4 text-gray-900">{label}</p>
      <p className="truncate text-[10px] leading-4 text-gray-600">
        {timeLabel(event.startsAt)}–{timeLabel(event.endsAt)}
        {event.assignedToName ? ` · ${event.assignedToName}` : ""}
      </p>
      {height > SLOT_PX * 1.5 && where ? <p className="truncate text-[10px] leading-4 text-gray-500">{where}</p> : null}
      {event.job && height > SLOT_PX * 2 ? <Badge className={`${JOB_STATUS_META[event.job.status].bg} ${JOB_STATUS_META[event.job.status].text} mt-0.5 text-[9px] leading-4`}>{JOB_STATUS_META[event.job.status].label}</Badge> : null}
    </>
  );
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={cn("absolute cursor-grab overflow-hidden rounded border-l-4 bg-white px-1.5 py-0.5 shadow-sm ring-1 ring-gray-200 hover:z-30 hover:ring-brand-400", isDragging && "opacity-40")}
      style={{
        top,
        height,
        borderLeftColor: color,
        // Overlapping events share the column side by side while they fit; beyond that they
        // cascade with a small offset so every chip keeps a clickable strip (later lanes on top).
        ...chipGeometry(placement, colWidth),
        zIndex: placement.lane + 1,
      }}
      data-testid={`event-${event.id}`}
    >
      {href ? (
        <Link href={href} onClick={noClickAfterDrag} className="block">
          {body}
        </Link>
      ) : (
        <button
          type="button"
          onClick={(e) => {
            noClickAfterDrag(e);
            if (!e.defaultPrevented) onOpen(event);
          }}
          className="block w-full text-left"
        >
          {body}
        </button>
      )}
    </div>
  );
}

// ---------- Unassigned jobs tray ----------

function UnassignedTray({ jobs }: { jobs: UnassignedJob[] }) {
  return (
    <aside className="w-56 shrink-0 rounded-lg border border-gray-200 bg-white" data-testid="unassigned-tray">
      <div className="border-b border-gray-200 px-3 py-2 text-xs font-semibold text-gray-700">Unscheduled jobs ({jobs.length})</div>
      <div className="max-h-[560px] space-y-2 overflow-y-auto p-2">
        {jobs.length === 0 ? <p className="text-xs text-gray-400">Nothing waiting. Drag jobs here onto the grid to schedule them.</p> : null}
        {jobs.map((j) => (
          <TrayJob key={j.id} job={j} />
        ))}
      </div>
    </aside>
  );
}

function TrayJob({ job }: { job: UnassignedJob }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `job:${job.id}`, data: { type: "job", job } });
  const noClickAfterDrag = useNoClickAfterDrag();
  return (
    <div ref={setNodeRef} {...attributes} {...listeners} className={cn("cursor-grab rounded border border-gray-200 bg-gray-50 px-2 py-1.5 text-xs", isDragging && "opacity-40")} data-testid={`tray-job-${job.id}`}>
      <Link href={`/jobs/${job.id}`} onClick={noClickAfterDrag} className="block font-medium text-gray-900 hover:underline">
        J-{job.number} {job.title}
      </Link>
      <p className="truncate text-gray-600">{job.contactName}</p>
      {job.siteAddress ? <p className="truncate text-gray-500">{job.siteAddress}</p> : null}
    </div>
  );
}

// ---------- Month grid ----------

function MonthGrid({ current, events, users, todayStr, onNew, onOpen }: { current: Date; events: CalendarEvent[]; users: UserOption[]; todayStr: string; onNew: (d: string) => void; onOpen: (ev: CalendarEvent) => void }) {
  const first = new Date(current.getFullYear(), current.getMonth(), 1);
  const gridStart = startOfWeek(first);
  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) cells.push(addDays(gridStart, i));
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
          const list = events.filter((e) => onDay(e, key)).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
          return (
            <div key={key} className={cn("min-h-28 border-b border-r border-gray-100 p-1", !inMonth && "bg-gray-50/70")} data-testid={`day-${key}`}>
              <button type="button" onClick={() => onNew(key)} className={cn("flex h-6 w-6 items-center justify-center rounded-full text-xs hover:bg-gray-200", key === todayStr ? "bg-brand-600 font-semibold text-white hover:bg-brand-700" : inMonth ? "text-gray-800" : "text-gray-400")} title="Add event">
                {day.getDate()}
              </button>
              <div className="mt-1 space-y-0.5">
                {list.slice(0, 4).map((ev) => {
                  const color = ev.job ? JOB_STATUS_META[ev.job.status].color : ev.kind === "site_visit" ? "#ff9900" : techColor(ev.assignedToId, users);
                  const label = ev.job ? `J-${ev.job.number} ${ev.job.contactName}` : ev.lead ? `Visit: ${ev.lead.name}` : ev.title;
                  const inner = (
                    <>
                      <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                      <span className="shrink-0 text-gray-500">{timeLabel(ev.startsAt)}</span>
                      <span className="truncate font-medium text-gray-900">{label}</span>
                    </>
                  );
                  const cls = "flex w-full items-center gap-1.5 rounded px-1.5 text-left text-xs leading-6 hover:bg-gray-100";
                  return ev.job || ev.lead ? (
                    <Link key={ev.id} href={ev.job ? `/jobs/${ev.job.id}` : `/leads/${ev.lead!.id}`} className={cls} data-testid={`event-${ev.id}`}>
                      {inner}
                    </Link>
                  ) : (
                    <button key={ev.id} type="button" onClick={() => onOpen(ev)} className={cls} data-testid={`event-${ev.id}`}>
                      {inner}
                    </button>
                  );
                })}
                {list.length > 4 ? (
                  <Link href={`/calendar?view=day&date=${key}`} className="block px-1.5 text-xs text-gray-500 hover:underline">
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
