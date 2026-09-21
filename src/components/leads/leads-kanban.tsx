"use client";

import * as React from "react";
import Link from "next/link";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  KeyboardSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import type { LeadRow } from "@/queries";
import { LEAD_STATUSES, LEAD_STATUS_META, type LeadStatus } from "@/lib/constants";
import { cn, formatDateOnly } from "@/lib/utils";
import { Avatar } from "@/components/ui";

export function LeadsKanban({
  rows,
  onStatusChange,
}: {
  rows: LeadRow[];
  onStatusChange: (id: string, status: LeadStatus) => void;
}) {
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );
  const active = activeId ? rows.find((r) => r.id === activeId) : null;

  function onDragStart(e: DragStartEvent) {
    setActiveId(String(e.active.id));
  }
  function onDragEnd(e: DragEndEvent) {
    setActiveId(null);
    const over = e.over?.id;
    if (!over) return;
    const status = String(over) as LeadStatus;
    const lead = rows.find((r) => r.id === e.active.id);
    if (lead && lead.status !== status && LEAD_STATUSES.includes(status)) onStatusChange(lead.id, status);
  }

  return (
    <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setActiveId(null)}>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {LEAD_STATUSES.map((status) => (
          <Column key={status} status={status} rows={rows.filter((r) => r.status === status)} />
        ))}
      </div>
      <DragOverlay>{active ? <LeadCard row={active} overlay /> : null}</DragOverlay>
    </DndContext>
  );
}

function Column({ status, rows }: { status: LeadStatus; rows: LeadRow[] }) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const meta = LEAD_STATUS_META[status];
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex w-64 shrink-0 flex-col rounded-lg border bg-gray-50",
        isOver ? "border-brand-400 bg-brand-50" : "border-gray-200",
      )}
      data-testid={`kanban-column-${status}`}
    >
      <div className={cn("flex items-center justify-between rounded-t-lg px-3 py-2 text-sm font-semibold", meta.bg, meta.text)}>
        {meta.label}
        <span className="rounded bg-white/25 px-1.5 text-xs">{rows.length}</span>
      </div>
      <div className="flex min-h-24 flex-1 flex-col gap-2 p-2">
        {rows.map((r) => (
          <DraggableCard key={r.id} row={r} />
        ))}
      </div>
    </div>
  );
}

function DraggableCard({ row }: { row: LeadRow }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: row.id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform) }}
      className={cn(isDragging && "opacity-40")}
      {...attributes}
      {...listeners}
    >
      <LeadCard row={row} />
    </div>
  );
}

function LeadCard({ row, overlay }: { row: LeadRow; overlay?: boolean }) {
  return (
    <div
      className={cn(
        "cursor-grab rounded-md border border-gray-200 bg-white p-3 text-sm shadow-sm",
        overlay && "rotate-1 shadow-lg",
      )}
      data-testid={`kanban-card-${row.id}`}
    >
      <div className="flex items-start justify-between gap-2">
        <Link href={`/leads/${row.id}`} className="font-medium text-gray-900 hover:text-brand-700 hover:underline" onPointerDown={(e) => e.stopPropagation()}>
          {row.name}
        </Link>
        {row.assignedTo ? <Avatar name={row.assignedTo.name} className="h-6 w-6 text-[10px]" /> : null}
      </div>
      {row.company ? <p className="mt-0.5 truncate text-xs text-gray-500">{row.company}</p> : null}
      {row.service ? <p className="mt-1 text-xs text-gray-700">{row.service}</p> : null}
      {row.followUpAt ? <p className="mt-2 text-xs text-gray-500">Follow-up {formatDateOnly(row.followUpAt)}</p> : null}
    </div>
  );
}
