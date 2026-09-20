"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { LEAD_SOURCES, LEAD_SOURCE_LABELS, LEAD_STATUSES, LEAD_STATUS_META, type LeadStatus } from "@/lib/constants";

export type UserOption = { id: string; name: string };

const cellBase = "h-9 w-full truncate px-2 text-left text-sm leading-9 text-gray-800";

/** Click to edit text. Commits on blur / Enter, cancels on Escape. */
export function EditableText({
  value,
  onCommit,
  placeholder = "—",
  type = "text",
  className,
  ariaLabel,
}: {
  value: string | null;
  onCommit: (v: string | null) => void;
  placeholder?: string;
  type?: "text" | "email" | "tel";
  className?: string;
  ariaLabel: string;
}) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(value ?? "");
  React.useEffect(() => {
    if (!editing) setDraft(value ?? "");
  }, [value, editing]);

  function commit() {
    setEditing(false);
    const next = draft.trim() === "" ? null : draft.trim();
    if (next !== (value ?? null)) onCommit(next);
  }

  if (editing) {
    return (
      <input
        autoFocus
        type={type}
        aria-label={ariaLabel}
        className={cn("h-9 w-full border-2 border-brand-500 bg-white px-2 text-sm text-gray-900 outline-none", className)}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            setDraft(value ?? "");
            setEditing(false);
          }
        }}
      />
    );
  }
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={() => setEditing(true)}
      className={cn(cellBase, "hover:bg-gray-50", !value && "text-gray-400", className)}
      title={value ?? undefined}
    >
      {value || placeholder}
    </button>
  );
}

/** Coloured status pill backed by a native select for accessibility. */
export function StatusCell({
  value,
  onChange,
  ariaLabel = "Status",
}: {
  value: LeadStatus;
  onChange: (v: LeadStatus) => void;
  ariaLabel?: string;
}) {
  const meta = LEAD_STATUS_META[value];
  return (
    <div className="relative h-9">
      <div
        className={cn(
          "flex h-full w-full items-center justify-center px-2 text-xs font-semibold",
          meta.bg,
          meta.text,
        )}
      >
        {meta.label}
      </div>
      <select
        aria-label={ariaLabel}
        className="absolute inset-0 cursor-pointer opacity-0"
        value={value}
        onChange={(e) => onChange(e.target.value as LeadStatus)}
      >
        {LEAD_STATUSES.map((s) => (
          <option key={s} value={s}>
            {LEAD_STATUS_META[s].label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function StatusPill({ value, className }: { value: LeadStatus; className?: string }) {
  const meta = LEAD_STATUS_META[value];
  return (
    <span className={cn("inline-flex items-center rounded px-2 py-0.5 text-xs font-semibold", meta.bg, meta.text, className)}>
      {meta.label}
    </span>
  );
}

export function PersonCell({
  value,
  users,
  onChange,
  ariaLabel = "Assigned to",
}: {
  value: string | null;
  users: UserOption[];
  onChange: (v: string | null) => void;
  ariaLabel?: string;
}) {
  return (
    <select
      aria-label={ariaLabel}
      className={cn(cellBase, "cursor-pointer appearance-none bg-transparent hover:bg-gray-50", !value && "text-gray-400")}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
    >
      <option value="">Unassigned</option>
      {users.map((u) => (
        <option key={u.id} value={u.id}>
          {u.name}
        </option>
      ))}
    </select>
  );
}

export function SourceCell({
  value,
  onChange,
  ariaLabel = "Source",
}: {
  value: string;
  onChange: (v: string) => void;
  ariaLabel?: string;
}) {
  return (
    <select
      aria-label={ariaLabel}
      className={cn(cellBase, "cursor-pointer appearance-none bg-transparent hover:bg-gray-50")}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {LEAD_SOURCES.map((s) => (
        <option key={s} value={s}>
          {LEAD_SOURCE_LABELS[s]}
        </option>
      ))}
    </select>
  );
}

export function DateCell({
  value,
  onChange,
  ariaLabel,
  highlightOverdue = false,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  ariaLabel: string;
  highlightOverdue?: boolean;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const overdue = highlightOverdue && value != null && value < today;
  return (
    <input
      type="date"
      aria-label={ariaLabel}
      className={cn(
        cellBase,
        "cursor-pointer bg-transparent hover:bg-gray-50",
        !value && "text-gray-400",
        overdue && "font-semibold text-red-600",
      )}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
    />
  );
}
